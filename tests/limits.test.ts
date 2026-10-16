import { expect, test } from 'claude-code/testing'

import {
  elapsedFraction,
  formatPercent,
  formatResetIn,
  meterRuns,
  meterSvg,
  paceColor,
  sessionDraw,
  shareOf,
  trackLimits,
  windowStart,
} from '../hooks/limits'

const reading = (kind: string, percentUsed: number) => ({ kind, percentUsed })

test('the tracks keep the latest reading of each window, and when tracking began', async () => {
  let tracks = trackLimits([], [reading('five_hour', 20), reading('seven_day', 40), reading('spend_limit', 5)], 0)
  expect(tracks.map(t => t.kind)).toEqual(['five_hour', 'seven_day'])
  tracks = trackLimits(tracks, [reading('five_hour', 26.5)], 1000)
  expect(tracks[0]).toEqual({ kind: 'five_hour', percentUsed: 26.5, resetsAt: undefined, since: 0, readAt: 1000 })
})

test('a window starts its length before it resets', async () => {
  const track = { kind: 'five_hour', percentUsed: 6, resetsAt: '2026-10-16T17:00:00Z', since: 0, readAt: 0 }
  expect(windowStart(track, 5 * 60 * 60_000)).toBe(Date.parse('2026-10-16T12:00:00Z'))
  expect(windowStart({ ...track, resetsAt: undefined }, 5 * 60 * 60_000)).toBeUndefined()
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

test("this session's part is the account's usage times its share, never more than the account", async () => {
  const track = { kind: 'five_hour', percentUsed: 6, since: 0, readAt: 0 }
  expect(sessionDraw(track, 0.5)).toBe(3)
  expect(sessionDraw(track, 1.4)).toBe(6)
  expect(sessionDraw(track, undefined)).toBeUndefined()
})

test('shares of all the sessions add up to the whole', async () => {
  const work = [2, 3, 5]
  const all = work.reduce((a, b) => a + b, 0)
  expect(work.map(w => shareOf(w, all)).reduce((a, b) => a + b, 0)).toBe(1)
  expect(shareOf(0, 0)).toBe(0)
})
