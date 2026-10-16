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

/** One subscription limit window (`five_hour`, `seven_day`) as last read. */
export type LimitTrack = {
  kind: string
  percentUsed: number
  resetsAt?: string
  /** When tracking began, in `$.clock.now()`'s milliseconds. */
  since: number
  /** When the last reading arrived: the account figure is as of then. */
  readAt: number
}

/** One session's or one project's part of a window: what its work cost, and whether this session is in it. */
export type BreakdownRow = { name: string; cost: number; isOwn: boolean }

/** The details pane's lists, priciest first, each with the window's account figure to share out. */
export type Breakdown = {
  sessions: BreakdownRow[]
  projects: BreakdownRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'limit-lens': {
      usd: number | null
      models: ModelTally[]
      requests: RequestUsage[]
      prices: PriceState
      limits: LimitTrack[]
      /** This session's share of each window's work on this machine, by window kind, once the logs are read. */
      shares: Record<string, number>
      /** Whether the panel is expanded; null until the person toggles it, when the settings decide. */
      expanded: boolean | null
      /** Every local session's work in the 5-hour window, and every project's in the week, for the details pane. */
      breakdown: Breakdown
    }
  }
}
