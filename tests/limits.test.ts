import { expect, test } from 'claude-code/testing'

import {
  elapsedFraction,
  formatPercent,
  formatResetIn,
  meterRuns,
  meterSvg,
  paceColor,
  sessionDraw,
  settleTick,
  trackedFor,
  trackLimits,
} from '../hooks/limits'

const reading = (kind: string, percentUsed: number) => ({ kind, percentUsed })

test('the first reading starts tracking, and each rise waits as a tick to be split', async () => {
  let { tracks, ticks } = trackLimits([], [reading('five_hour', 20), reading('seven_day', 40), reading('spend_limit', 5)], 0)
  expect(tracks.map(t => t.kind)).toEqual(['five_hour', 'seven_day'])
  expect(ticks).toEqual([])
  expect(tracks.map(t => sessionDraw(t))).toEqual([0, 0])

  ;({ tracks, ticks } = trackLimits(tracks, [reading('five_hour', 26.5)], 1000))
  expect(ticks).toEqual([{ kind: 'five_hour', points: 6.5, from: 0, to: 1000, epoch: 0 }])
  // Until it is split, a rise counts as this session's.
  expect(sessionDraw(tracks[0]!, ticks)).toBe(6.5)
  expect(sessionDraw(tracks[1]!, ticks)).toBe(0)

  const settled = settleTick(tracks, ticks[0]!, 0.5)
  expect(sessionDraw(settled[0]!)).toBe(3.25)
})

test('a window that resets counts its new reading as the rise', async () => {
  let state = trackLimits([], [reading('five_hour', 90)], 0)
  const rises = []
  for (const [percent, at] of [[95, 1], [2, 2]] as const) {
    state = trackLimits(state.tracks, [reading('five_hour', percent)], at)
    rises.push(...state.ticks)
  }
  expect(rises.map(t => t.points)).toEqual([5, 2])
})

test('formats percentages and time left', async () => {
  expect(formatPercent(23)).toBe('23%')
  expect(formatPercent(11.111)).toBe('11.1%')
  expect(formatPercent(0.02)).toBe('<0.1%')
  expect(formatPercent(0)).toBe('0%')
  const now = Date.parse('2026-10-16T12:00:00Z')
  expect(formatResetIn('2026-10-16T12:35:00Z', now)).toBe('35m')
  expect(formatResetIn('2026-10-16T14:10:00Z', now)).toBe('2h 10m')
  expect(formatResetIn('2026-10-19T16:00:00Z', now)).toBe('3d 4h')
  expect(formatResetIn('2026-10-16T11:00:00Z', now)).toBeUndefined()
  expect(formatResetIn(undefined, now)).toBeUndefined()
})

test('notes how long tracking has run only when it began after the session', async () => {
  const start = Date.parse('2026-10-16T10:00:00Z')
  const now = Date.parse('2026-10-16T12:00:00Z')
  expect(trackedFor(start, start + 30_000, now)).toBeUndefined()
  expect(trackedFor(null, start + 3_600_000, now)).toBeUndefined()
  expect(trackedFor(start, now - 12 * 60_000, now)).toBe('12m')
  expect(trackedFor(start, now - 10_000, now)).toBe('<1m')
})

const FIVE_HOURS = 5 * 60 * 60_000

test('the marker sits at the share of the window gone by: 2.5 of 5 hours is halfway', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  expect(elapsedFraction('2026-10-16T14:30:00Z', FIVE_HOURS, now)).toBe(0.5)
  // In the terminal the marker takes the place of the cell the time falls in: the meter keeps its ten cells.
  expect(meterRuns(30, 0.5, 10)).toEqual([
    { kind: 'filled', text: '███' },
    { kind: 'empty', text: '░░' },
    { kind: 'marker', text: '┃' },
    { kind: 'empty', text: '░░░░' },
  ])
  // At the start and the end of the window, the marker sits in the meter's end cells.
  expect(meterRuns(0, 0, 4).map(r => r.text).join('')).toBe('┃░░░')
  expect(meterRuns(100, 1, 4).map(r => r.text).join('')).toBe('███┃')

  // Drawn, the marker is a 2-pixel line centred on the halfway point of a 104-pixel bar, taller than the bar.
  const svg = meterSvg(30, 0.5, 'success')
  expect(svg).toContain('<rect x="51.0" y="0.5" width="2" height="15"')
  expect(svg).toContain('width="31.2" height="10" rx="2" fill="#43a047"')
  // A reset time already past, or further off than the window, is held to its ends.
  expect(elapsedFraction('2026-10-16T11:00:00Z', FIVE_HOURS, now)).toBe(1)
  expect(elapsedFraction('2026-10-16T20:00:00Z', FIVE_HOURS, now)).toBe(0)
})

test('without the window timing there is no marker', async () => {
  expect(elapsedFraction(undefined, FIVE_HOURS, 0)).toBeUndefined()
  expect(meterRuns(30, undefined, 10).some(r => r.kind === 'marker')).toBe(false)
  expect(meterSvg(30, undefined, 'success')).not.toContain('height="15"')
})

test('pace colours: over 5 points under green, within 5 yellow, over 5 above red', async () => {
  expect(paceColor(40, 0.5)).toBe('success')
  expect(paceColor(45, 0.5)).toBe('warning')
  expect(paceColor(50, 0.5)).toBe('warning')
  expect(paceColor(55, 0.5)).toBe('warning')
  expect(paceColor(56, 0.5)).toBe('error')
  // Early in a window, even a little use runs ahead.
  expect(paceColor(10, 0.02)).toBe('error')
  // Without timing, the plain level decides.
  expect(paceColor(40, undefined)).toBe('success')
  expect(paceColor(85, undefined)).toBe('error')
})

test('this session never shows more than the account has used', async () => {
  const track = { kind: 'five_hour', percentUsed: 5, since: 0, readAt: 0, mine: 3 }
  const waiting = [{ kind: 'five_hour', points: 4, from: 0, to: 1 }]
  expect(sessionDraw(track, waiting)).toBe(5)
})

test('a reset starts the share over, and rises from the old window no longer count', async () => {
  let state = trackLimits([], [reading('five_hour', 40)], 0)
  state = trackLimits(state.tracks, [reading('five_hour', 50)], 1)
  const oldRise = state.ticks[0]!
  let tracks = settleTick(state.tracks, oldRise, 1)
  expect(sessionDraw(tracks[0]!)).toBe(10)

  // The window resets: 2% of the new one used, all of it new.
  state = trackLimits(tracks, [reading('five_hour', 2)], 2)
  tracks = state.tracks
  expect(sessionDraw(tracks[0]!)).toBe(0)
  expect(sessionDraw(tracks[0]!, [oldRise, ...state.ticks])).toBe(2)

  // A rise from before the reset, settled late, is not added to the new window.
  expect(sessionDraw(settleTick(tracks, oldRise, 1)[0]!)).toBe(0)
  expect(sessionDraw(settleTick(tracks, state.ticks[0]!, 1)[0]!)).toBe(2)
})
