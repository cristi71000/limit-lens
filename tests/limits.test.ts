import { expect, test } from 'claude-code/testing'

import { formatPercent, formatResetIn, sessionDraw, settleTick, trackedFor, trackLimits } from '../hooks/limits'

const reading = (kind: string, percentUsed: number) => ({ kind, percentUsed })

test('the first reading starts tracking, and each rise waits as a tick to be split', async () => {
  let { tracks, ticks } = trackLimits([], [reading('five_hour', 20), reading('seven_day', 40), reading('spend_limit', 5)], 0)
  expect(tracks.map(t => t.kind)).toEqual(['five_hour', 'seven_day'])
  expect(ticks).toEqual([])
  expect(tracks.map(t => sessionDraw(t))).toEqual([0, 0])

  ;({ tracks, ticks } = trackLimits(tracks, [reading('five_hour', 26.5)], 1000))
  expect(ticks).toEqual([{ kind: 'five_hour', points: 6.5, from: 0, to: 1000 }])
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
