/** One model that answered this session, and how many requests it served. */
export type ModelTally = { model: string; requests: number }

/**
 * One request's token counts and the model that answered it, kept so it can be
 * priced at any table's rates: cache writes split by lifetime (the main loop
 * writes for an hour, subagents for five minutes), `at` when it answered.
 */
export type RequestUsage = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  at: number
}

/** US dollars per million tokens: `cacheWrite` the 5-minute write rate, `cacheWrite1h` the 1-hour one. */
export type Rates = { input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; output: number }

/** A model's rates, and the dearer card a prompt over `longAbove` tokens pays. */
export type Price = Rates & { long?: Rates; longAbove?: number }

/**
 * The prices in use: read off Anthropic's pricing page (`page`, at `fetchedAt`)
 * or the table the mod ships with (`built-in`). `candidates` are the price keys
 * the band compares against; `failedAt` marks the last fetch that did not work.
 */
export type PriceState = {
  source: 'page' | 'built-in'
  fetchedAt: number | null
  models: Record<string, Price>
  candidates: string[]
  failedAt?: number
  /** Why that fetch did not work: an HTTP status, or the page no longer holding a readable table. */
  failure?: string
}

/**
 * One subscription limit window (`five_hour`, `seven_day`) as last read, and
 * the points of it put down to this session (`mine`).
 */
export type LimitTrack = {
  kind: string
  percentUsed: number
  resetsAt?: string
  /** When tracking began, in `$.clock.now()`'s milliseconds. */
  since: number
  /** When the last reading arrived: the account figure is as of then. */
  readAt: number
  /** Points of the window put down to this session, from the rises split so far. */
  mine: number
  /** How many times the window has reset while tracked; a rise counts only toward the window it happened in. */
  epoch?: number
}

/**
 * A rise of the account's reading, waiting to be split between this session and
 * the others that ran from `from` to `to` (milliseconds).
 */
export type LimitTick = { kind: string; points: number; from: number; to: number; epoch?: number }

declare module 'claude-code' {
  interface PluginState {
    'limit-lens': {
      usd: number | null
      models: ModelTally[]
      requests: RequestUsage[]
      prices: PriceState
      limits: LimitTrack[]
      /** Rises not yet split; counted as this session's until they are. */
      ticks: LimitTick[]
      /** When the session began, in `$.clock.now()`'s milliseconds. */
      startedAt: number | null
    }
  }
}
