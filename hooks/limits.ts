import type { SessionRateLimit } from 'claude-code'

import type { LimitTick, LimitTrack } from '../types'

/** The subscription windows the band shows, in display order. */
export const WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: 'week' },
] as const

/**
 * Folds the latest readings into the tracks, and turns each rise into a tick to
 * be split between the sessions that ran meanwhile. A reading below the last one
 * means the window reset: everything in the new window counts as the rise.
 */
export const trackLimits = (
  tracks: LimitTrack[],
  readings: readonly SessionRateLimit[],
  now: number,
): { tracks: LimitTrack[]; ticks: LimitTick[] } => {
  const next = [...tracks]
  const ticks: LimitTick[] = []

  for (const reading of readings) {
    if (!WINDOWS.some(w => w.kind === reading.kind)) {
      continue
    }

    const at = next.findIndex(t => t.kind === reading.kind)
    const old = next[at]
    const { kind, percentUsed, resetsAt } = reading

    if (!old) {
      next.push({ kind, percentUsed, resetsAt, since: now, readAt: now, mine: 0 })
      continue
    }

    const points = percentUsed < old.percentUsed ? percentUsed : percentUsed - old.percentUsed
    if (points > 0) {
      ticks.push({ kind, points, from: old.readAt ?? old.since, to: now })
    }
    next[at] = { ...old, percentUsed, resetsAt, readAt: now, mine: old.mine ?? 0 }
  }

  return { tracks: next, ticks }
}

/** Puts a tick's share down to this session: `share` from 0 (none of it) to 1 (all of it). */
export const settleTick = (tracks: LimitTrack[], tick: LimitTick, share: number): LimitTrack[] =>
  tracks.map(t => (t.kind === tick.kind ? { ...t, mine: (t.mine ?? 0) + tick.points * share } : t))

/** Points of the window put down to this session, rises not yet split counted whole until they are. */
export const sessionDraw = (track: LimitTrack, pending: readonly LimitTick[] = []): number =>
  (track.mine ?? 0) + pending.filter(t => t.kind === track.kind).reduce((sum, t) => sum + t.points, 0)

/** `23.46` → `23.5%`; a sliver above zero → `<0.1%`. */
export const formatPercent = (value: number): string =>
  value > 0 && value < 0.05 ? '<0.1%' : `${Number(value.toFixed(1))}%`

/** A span of time: `3d 4h`, `2h 10m`, `35m`; undefined when not a positive number of minutes. */
export const formatDuration = (ms: number): string | undefined => {
  const minutes = Math.round(ms / 60_000)

  if (!Number.isFinite(minutes) || minutes <= 0) {
    return undefined
  }

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** Time until `resetsAt`; undefined when unknown or past. */
export const formatResetIn = (resetsAt: string | undefined, now: number): string | undefined =>
  resetsAt === undefined ? undefined : formatDuration(Date.parse(resetsAt) - now)

/**
 * How long tracking has run, when it began well after the session did (a mod
 * loaded or a session resumed midway); undefined when it covers the session.
 */
export const trackedFor = (startedAt: number | null, since: number, now: number): string | undefined =>
  startedAt !== null && since - startedAt > 2 * 60_000 ? (formatDuration(now - since) ?? '<1m') : undefined

/** The meter's colour: calm under half, a warning past it, an alarm near the limit. */
export const levelColor = (percent: number): string => (percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success')
