import { expect, test } from 'claude-code/testing'

import { BUILT_IN, parsePricingPage, priceRequest, toRequest } from '../hooks/pricing'
import { isRefreshDue } from '../hooks/register'
import { PRICING_PAGE } from './pricing-page'

const request = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0) => ({
  model,
  input,
  output,
  cacheRead,
  cacheWrite,
  cacheWrite1h,
  at: 0,
})

/** Rounds away floating-point noise: prices are compared to a millionth of a cent. */
const near = (received: number | null, expected: number) => {
  expect(received === null ? null : Math.round(received * 1e8)).toBe(Math.round(expected * 1e8))
}

const price = (model: string, r: ReturnType<typeof request>) => priceRequest(BUILT_IN.models, model, r)

test('prices each token kind at its own rate', async () => {
  // 1K input at $4, 1K cache write at $5, 1M cache read at $0.20, 1K output at $20
  near(price('claude-opus-5-5', request('x', 1000, 1000, 1_000_000, 1000)), 0.229)
  near(price('claude-opus-5-5[1m]', request('x', 1_000_000, 0)), 4)
  near(price('claude-haiku-4-5-20251001', request('x', 1_000_000, 0)), 1)
})

test('cache writes are priced by lifetime: the main loop writes for an hour, subagents for five minutes', async () => {
  // A million tokens written on Opus 5.5: $8 for an hour, $5 for five minutes.
  near(price('claude-opus-5-5', request('x', 0, 0, 0, 0, 1_000_000)), 8)
  near(price('claude-opus-5-5', request('x', 0, 0, 0, 1_000_000)), 5)

  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
  expect(toRequest('m', usage, 7, true)).toEqual({ model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 0, cacheWrite1h: 4, at: 7 })
  expect(toRequest('m', usage, 7, false)).toEqual({ model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 0, at: 7 })
})

test('Haiku 5.5 switches rate card above a 100K-token prompt', async () => {
  near(price('claude-haiku-5-5', request('x', 1000, 1000)), 0.0006)
  near(price('claude-haiku-5-5', request('x', 200_000, 1000)), 0.1025)
  near(price('claude-haiku-5-5', request('x', 1000, 1000, 150_000)), (500 + 2500 + 150_000 * 0.05) / 1_000_000)
})

test('a model with no known price is skipped', async () => {
  expect(price('claude-opus-6', request('x', 1000, 1000))).toBeNull()
})

test('reads the real pricing table', async () => {
  const table = parsePricingPage(PRICING_PAGE)!
  expect(table.models['sonnet-5-5']).toEqual({ input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 })
  expect(table.models['haiku-5-5']).toEqual(BUILT_IN.models['haiku-5-5'])
  expect(table.models['opus-4-1']?.output).toBe(75)
  // Mythos is limited and Opus 4.1 retired: priced, but not compared against.
  expect(table.candidates).toEqual(['fable-5-1', 'opus-5-5', 'sonnet-5-5', 'haiku-5-5'])
  // Every price the mod ships with matches the page it was taken from.
  for (const [key, held] of Object.entries(BUILT_IN.models)) {
    expect(table.models[key]).toEqual(held)
  }
})

test('a new model on the page is priced and replaces its family in the comparison', async () => {
  const page = PRICING_PAGE.replace(
    /\| :-+[^\n]*\n/,
    // A function, so the row's dollar signs are not read as replacement patterns.
    separator => `${separator}| Claude Opus 6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.25 / MTok | $25 / MTok |\n`,
  )
  const table = parsePricingPage(page)!
  expect(table.models['opus-6']).toEqual({ input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.25, output: 25 })
  expect(table.candidates).toEqual(['fable-5-1', 'opus-6', 'sonnet-5-5', 'haiku-5-5'])
})

test('a page without a readable table gives nothing', async () => {
  expect(parsePricingPage('<html>Service unavailable</html>')).toBeNull()
  expect(parsePricingPage(PRICING_PAGE.replace('Base input tokens', 'Input'))).toBeNull()
})

test('prices are fetched when old, or when a model has none, but not straight after a failure', async () => {
  const hour = 60 * 60_000
  const now = 100 * hour
  const page = { ...BUILT_IN, source: 'page' as const }
  const opus6 = [request('claude-opus-6', 1, 1)]

  expect(isRefreshDue(BUILT_IN, [], now)).toBe(true)
  expect(isRefreshDue({ ...page, fetchedAt: now - hour }, [], now)).toBe(false)
  expect(isRefreshDue({ ...page, fetchedAt: now - 13 * hour }, [], now)).toBe(true)
  expect(isRefreshDue({ ...page, fetchedAt: now - hour }, opus6, now)).toBe(true)
  expect(isRefreshDue({ ...page, fetchedAt: now - 10 * 60_000 }, opus6, now)).toBe(false)
  expect(isRefreshDue({ ...BUILT_IN, failedAt: now - 10 * 60_000 }, [], now)).toBe(false)
})
