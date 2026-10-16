import type { ModelUsage } from 'claude-code'

import type { Price, PriceState, Rates, RequestUsage } from '../types'

const haiku55: Price = {
  input: 0.1,
  cacheWrite: 0.125,
  cacheWrite1h: 0.2,
  cacheRead: 0.01,
  output: 0.5,
  long: { input: 0.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
  longAbove: 100_000,
}

/** The page's table as read on 2026-10-16: used until a fetch succeeds, and whenever none can. */
export const BUILT_IN: PriceState = {
  source: 'built-in',
  fetchedAt: null,
  models: {
    'fable-5-1': { input: 10, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
    'fable-5': { input: 10, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
    'opus-5-5': { input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    'opus-5': { input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    'opus-4-8': { input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    'opus-4-7': { input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    'opus-4-6': { input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
    'sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
    'sonnet-5': { input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
    'sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
    'haiku-5-5': haiku55,
    'haiku-4-5': { input: 1, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  },
  candidates: ['fable-5-1', 'opus-5-5', 'sonnet-5-5', 'haiku-5-5'],
}

/** `claude-opus-5-5[1m]` and `claude-haiku-4-5-20251001` → `opus-5-5`, `haiku-4-5`. */
export const priceKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')

/**
 * One request's token counts, as the mod keeps them for pricing later. The
 * engine reports cache writes as one number: the main loop writes for an hour,
 * a subagent for five minutes, as their session logs show.
 */
export const toRequest = (model: string, usage: ModelUsage, at: number, isMainLoop: boolean): RequestUsage => ({
  model,
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: isMainLoop ? 0 : usage.cache_creation_input_tokens,
  cacheWrite1h: isMainLoop ? usage.cache_creation_input_tokens : 0,
  at,
})

/** What one request's tokens cost on `model` at the table's rates, or null for a model it has no price for. */
export const priceRequest = (models: Record<string, Price>, model: string, request: RequestUsage): number | null => {
  const price = models[priceKey(model)]

  if (!price) {
    return null
  }

  const prompt = request.input + request.cacheRead + request.cacheWrite + (request.cacheWrite1h ?? 0)
  const rates: Rates = price.long && price.longAbove !== undefined && prompt > price.longAbove ? price.long : price

  return (
    (request.input * rates.input +
      request.cacheWrite * rates.cacheWrite +
      (request.cacheWrite1h ?? 0) * (rates.cacheWrite1h ?? rates.input * 2) +
      request.cacheRead * rates.cacheRead +
      request.output * rates.output) /
    1_000_000
  )
}

const money = (cell: string): number | null => {
  const match = /\$\s*([\d,]*\.?\d+)/.exec(cell)
  const value = match ? Number(match[1]!.replace(/,/g, '')) : NaN

  return Number.isFinite(value) ? value : null
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

const versionOf = (key: string): number[] => key.split('-').slice(1).map(Number)

const isNewer = (a: string, b: string): boolean => {
  const [x, y] = [versionOf(a), versionOf(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) > (y[i] ?? 0)
    }
  }

  return false
}

/**
 * Reads the "Model pricing" table off the pricing page. Columns are found by
 * their headings, so a reordered or widened table still reads. The comparison
 * models are the newest generally available model of each family, priciest
 * first. Null when the page holds no table the mod can read.
 */
export const parsePricingPage = (page: string): Pick<PriceState, 'models' | 'candidates'> | null => {
  const lines = page.split('\n')
  const section = lines.findIndex(l => /^#+\s*Model pricing\s*$/i.test(l.trim()))
  const start = lines.findIndex((l, i) => i > section && l.trim().startsWith('|'))

  if (section < 0 || start < 0) {
    return null
  }

  const rows: string[][] = []
  for (let i = start; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
    rows.push(cells(lines[i]!))
  }

  const [head = [], , ...body] = rows
  const col = (pattern: RegExp) => head.findIndex(h => pattern.test(h))
  const at = {
    model: col(/model/i),
    input: col(/base input/i),
    cacheWrite: col(/5m cache write/i),
    cacheWrite1h: col(/1h cache write/i),
    cacheRead: col(/cache hit/i),
    output: col(/output/i),
  }

  if (Object.values(at).some(i => i < 0)) {
    return null
  }

  const models: Record<string, Price> = {}
  const available: string[] = []

  for (const row of body) {
    const raw = row[at.model] ?? ''
    const name = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)*)/.exec(raw.replace(/\[[^\]]*\]\([^)]*\)/g, ''))
    const input = money(row[at.input] ?? '')
    const cacheWrite = money(row[at.cacheWrite] ?? '')
    const cacheWrite1h = money(row[at.cacheWrite1h] ?? '')
    const cacheRead = money(row[at.cacheRead] ?? '')
    const output = money(row[at.output] ?? '')

    if (!name || input === null || cacheWrite === null || cacheWrite1h === null || cacheRead === null || output === null) {
      continue
    }

    const key = `${name[1]!.toLowerCase()}-${name[2]!.replace(/\./g, '-')}`
    const rates: Rates = { input, cacheWrite, cacheWrite1h, cacheRead, output }
    const tier = /prompts\s+(up to|over)\s+([\d,]+)\s+tokens/i.exec(raw)
    const held = models[key]

    if (tier?.[1]?.toLowerCase() === 'over') {
      if (held) {
        models[key] = { ...held, long: rates, longAbove: Number(tier[2]!.replace(/,/g, '')) }
      }
    } else {
      models[key] = { ...rates, ...(held?.long ? { long: held.long, longAbove: held.longAbove } : {}) }
    }

    if (!/limited availability|retired/i.test(raw) && !available.includes(key)) {
      available.push(key)
    }
  }

  const newest = new Map<string, string>()
  for (const key of available) {
    const family = key.split('-')[0]!
    const current = newest.get(family)
    if (current === undefined || isNewer(key, current)) {
      newest.set(family, key)
    }
  }

  const candidates = [...newest.values()].sort((a, b) => (models[b]?.output ?? 0) - (models[a]?.output ?? 0))

  return Object.keys(models).length >= 3 && candidates.length > 0 ? { models, candidates } : null
}
