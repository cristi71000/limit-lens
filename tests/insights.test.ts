import { expect, test } from 'claude-code/testing'

import { cacheHealth } from '../hooks/cache'
import { forecast, formatForecast, paceColor } from '../hooks/limits'
import { BUILT_IN } from '../hooks/pricing'
import { toBreakdown } from '../hooks/register'
import { parseLogMeta } from '../hooks/sessions'

const FIVE_HOURS = 5 * 60 * 60_000

test('the forecast follows the pace so far: the limit before the reset, or the share by then', async () => {
  // 30% used halfway through: on course for 60% at the reset.
  expect(formatForecast(forecast(30, 0.5, FIVE_HOURS)!)).toBe('≈60% at reset')
  // 60% used halfway through: 40 points left at 24 an hour runs out in 1h 40m, before the reset.
  expect(formatForecast(forecast(60, 0.5, FIVE_HOURS)!)).toBe('limit in ~1h 40m')
  expect(formatForecast(forecast(99.9, 0.5, FIVE_HOURS)!)).toBe('limit any minute')
  // Too early in the window, nothing used yet, or no timing: no forecast.
  expect(forecast(10, 0.02, FIVE_HOURS)).toBeUndefined()
  expect(forecast(0, 0.5, FIVE_HOURS)).toBeUndefined()
  expect(forecast(10, undefined, FIVE_HOURS)).toBeUndefined()
})

test('the on-pace band is a setting', async () => {
  // 60% used with half the window gone: 10 points ahead.
  expect(paceColor(60, 0.5)).toBe('error')
  expect(paceColor(60, 0.5, 15)).toBe('warning')
})

test("a log's title and folder rows name its session", async () => {
  expect(parseLogMeta(JSON.stringify({ type: 'custom-title', customTitle: 'Game issue', cwd: '/x/fabricam' }))).toEqual({
    title: 'Game issue',
    cwd: '/x/fabricam',
  })
  expect(parseLogMeta(JSON.stringify({ type: 'user', cwd: '/x/claudemod' }))).toEqual({ title: undefined, cwd: '/x/claudemod' })
  expect(parseLogMeta(JSON.stringify({ type: 'user' }))).toBeNull()
})

test('the details pane lists sessions by name and the week by project folder', async () => {
  const game = { owner: 'a', cost: 3, title: 'Game issue', cwd: '/x/fabricam', isOwn: false }
  const me = { owner: 'me', cost: 1, cwd: '/x/claudemod', isOwn: true }
  const parts = toBreakdown([game, me], [game, me, { owner: 'b', cost: 2, cwd: '/x/fabricam', isOwn: false }, { owner: 'c', cost: 1, isOwn: false }])
  expect(parts.sessions).toEqual([
    { name: 'Game issue', cost: 3, isOwn: false },
    { name: 'claudemod session', cost: 1, isOwn: true },
  ])
  expect(parts.projects).toEqual([
    { name: 'fabricam', cost: 5, isOwn: false },
    { name: 'claudemod', cost: 1, isOwn: true },
    { name: 'other', cost: 1, isOwn: false },
  ])
})

test('projects are told apart by their whole folder, and named with as much of it as it takes', async () => {
  const work = (owner: string, cwd: string, cost: number, isOwn = false) => ({ owner, cost, cwd, isOwn })
  const parts = toBreakdown(
    [work('a', '/home/u/work/api', 1), work('b', '/home/u/personal/api', 1)],
    [
      work('a', '/home/u/work/api', 4),
      // The same folder spelled with a trailing slash is the same project.
      work('a2', '/home/u/work/api/', 1),
      work('b', '/home/u/personal/api', 2, true),
      work('c', '/home/u/site', 1),
      // A folder whose parent shares a name with the one above still gets a name of its own.
      work('d', '/srv/work/api', 1),
    ],
  )
  expect(parts.projects).toEqual([
    { name: 'u/work/api', cost: 5, isOwn: false },
    { name: 'personal/api', cost: 2, isOwn: true },
    { name: 'site', cost: 1, isOwn: false },
    { name: 'srv/work/api', cost: 1, isOwn: false },
  ])
  // A session with no title is named by its folder the same way.
  expect(parts.sessions.map(s => s.name)).toEqual(['u/work/api session', 'personal/api session'])
})

test('cache health: the hit rate, and what full re-reads in the last hour cost over cache hits', async () => {
  const now = 10 * 60 * 60_000
  const at = (minutesAgo: number) => now - minutesAgo * 60_000
  const request = (minutesAgo: number, input: number, cacheRead: number, cacheWrite1h: number) => ({
    model: 'claude-opus-5-5',
    input,
    output: 0,
    cacheRead,
    cacheWrite: 0,
    cacheWrite1h,
    at: at(minutesAgo),
  })
  const health = cacheHealth(
    [request(120, 0, 0, 100_000), request(10, 0, 0, 100_000), request(5, 100, 100_000, 0)],
    BUILT_IN.models,
    now,
  )!
  // Of the last requests' 300,100 prompt tokens, the cache served 100,000.
  expect(Math.round(health.hitRate * 1000)).toBe(333)
  // Only the re-read ten minutes ago is in the last hour: 100k written at $8 instead of read at $0.20.
  expect(health.reReads).toBe(1)
  expect(Math.round(health.extraUsd * 100)).toBe(78)
  expect(health.lastReReadAt).toBe(at(10))
  expect(cacheHealth([], BUILT_IN.models, now)).toBeUndefined()
})
