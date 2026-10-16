import type { SessionRateLimit } from 'claude-code'

import type { LimitTrack } from '../types'

/** The subscription windows the band shows, in display order. */
export const WINDOWS = [
  { kind: 'five_hour', label: '5h', lengthMs: 5 * 60 * 60_000 },
  { kind: 'seven_day', label: 'week', lengthMs: 7 * 24 * 60 * 60_000 },
] as const

/** Folds the latest readings into the tracks: each window's figure, its reset time, and when it was read. */
export const trackLimits = (tracks: LimitTrack[], readings: readonly SessionRateLimit[], now: number): LimitTrack[] => {
  const next = [...tracks]

  for (const reading of readings) {
    if (!WINDOWS.some(w => w.kind === reading.kind)) {
      continue
    }

    const at = next.findIndex(t => t.kind === reading.kind)
    const { kind, percentUsed, resetsAt } = reading
    const track = { kind, percentUsed, resetsAt, since: next[at]?.since ?? now, readAt: now }

    if (at < 0) {
      next.push(track)
    } else {
      next[at] = track
    }
  }

  return next
}

/** When a window began: its reset time less its length; undefined when the reset time is unknown. */
export const windowStart = (track: LimitTrack, lengthMs: number): number | undefined => {
  const resets = track.resetsAt === undefined ? NaN : Date.parse(track.resetsAt)

  return Number.isFinite(resets) ? resets - lengthMs : undefined
}

/**
 * This session's part of the window: the account's usage times this session's
 * share of all the work done on this machine in the window. Shares of all the
 * sessions add up to one, so their parts add up to the account's usage, and no
 * part is ever more than it. Undefined until the share is known.
 */
export const sessionDraw = (track: LimitTrack, share: number | undefined): number | undefined =>
  share === undefined ? undefined : track.percentUsed * Math.min(1, Math.max(0, share))

/**
 * A share from the work done in a window: this session's against every
 * session's on this machine. Work no local session did (claude.ai, another
 * device) cannot be placed, so it is shared out in the same proportions.
 */
export const shareOf = (own: number, all: number): number => (all > 0 ? own / all : 0)

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

/** The meter's colour when the window's timing is unknown: calm under half, a warning past it, an alarm near the limit. */
export const levelColor = (percent: number): string => (percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success')

/** How far through its window the account is, 0 to 1, from when the window resets; undefined when that is unknown. */
export const elapsedFraction = (resetsAt: string | undefined, lengthMs: number, now: number): number | undefined => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)

  return Number.isFinite(at) ? Math.min(1, Math.max(0, 1 - (at - now) / lengthMs)) : undefined
}

/** How many points either side of an even pace still reads as on pace. */
const PACE_SLACK = 5

/**
 * The meter's colour by pace: usage against the share of the window gone by.
 * More than 5 points under is green, within 5 either way yellow, more than 5
 * over red. Without the window's timing, the plain level decides.
 */
export const paceColor = (percent: number, elapsed: number | undefined): string => {
  if (elapsed === undefined) {
    return levelColor(percent)
  }

  const ahead = percent - elapsed * 100

  return ahead < -PACE_SLACK ? 'success' : ahead > PACE_SLACK ? 'error' : 'warning'
}

/** One run of the meter: filled cells, empty cells, or the marker for the time gone by. */
export type MeterRun = { kind: 'filled' | 'empty' | 'marker'; text: string }

/**
 * The meter as runs of text cells, for the terminal. The marker takes the place
 * of the cell the time gone by falls in, so the meter keeps its width: after
 * 2.5 of 5 hours, the sixth of ten cells, which starts at the halfway point.
 */
export const meterRuns = (percent: number, elapsed: number | undefined, cells: number): MeterRun[] => {
  const filled = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))
  const marker = elapsed === undefined ? -1 : Math.min(cells - 1, Math.floor(elapsed * cells))
  const runs: MeterRun[] = []

  for (let i = 0; i < cells; i++) {
    const kind = i === marker ? 'marker' : i < filled ? 'filled' : 'empty'
    const text = kind === 'marker' ? '┃' : kind === 'filled' ? '█' : '░'
    const last = runs[runs.length - 1]
    if (last?.kind === kind) {
      last.text += text
    } else {
      runs.push({ kind, text })
    }
  }

  return runs
}

/** The pace colours as the drawn meter paints them: an image takes no theme, so these suit light and dark alike. */
const METER_HEX: Record<string, string> = { success: '#43a047', warning: '#d99a0b', error: '#e5534b' }

/** The drawn meter's size, in CSS pixels: the marker stands 3 pixels proud of the bar at each end. */
export const METER_SIZE = { width: 104, height: 16, bar: 10 }

/**
 * The meter drawn as SVG, for the surfaces that draw it: a bar filled to the
 * share used, and a thin line, a little taller than the bar, at the share of
 * the window gone by. The line is light with a dark edge, to show on either theme.
 */
export const meterSvg = (percent: number, elapsed: number | undefined, color: string): string => {
  const { width, height, bar } = METER_SIZE
  const top = (height - bar) / 2
  const fill = (Math.min(100, Math.max(0, percent)) / 100) * width
  const line =
    elapsed === undefined
      ? ''
      : `<rect x="${Math.min(width - 2, Math.max(0, elapsed * width - 1)).toFixed(1)}" y="0.5" width="2" height="${height - 1}" fill="#f2f2f2" stroke="#1b1b1b" stroke-width="0.75"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="${top}" width="${width}" height="${bar}" rx="2" fill="#8b8b8b" fill-opacity="0.3"/>` +
    `<rect x="0" y="${top}" width="${fill.toFixed(1)}" height="${bar}" rx="2" fill="${METER_HEX[color] ?? '#8b8b8b'}"/>` +
    line +
    `</svg>`
  )
}
