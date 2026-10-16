import type { Price, RequestUsage } from '../types'
import { priceRequest } from './pricing'

/** How many of the latest requests the hit rate is taken over. */
const RECENT = 20
/** A request that writes at least this many tokens, most of its prompt, re-read the conversation in full. */
const RE_READ_TOKENS = 20_000

/**
 * How well this session's prompt cache is holding. The hit rate is the share
 * of the latest requests' prompts the cache served. A full re-read is a request
 * that had to write most of a large prompt afresh: after a pause longer than
 * the cache keeps, or a change early in the conversation. `extraUsd` is what
 * the last hour's re-reads cost over what cache hits would have.
 */
export type CacheHealth = { hitRate: number; reReads: number; extraUsd: number; lastReReadAt?: number }

const written = (r: RequestUsage) => r.cacheWrite + (r.cacheWrite1h ?? 0)
const promptOf = (r: RequestUsage) => r.input + r.cacheRead + written(r)

export const isReRead = (r: RequestUsage): boolean => written(r) >= RE_READ_TOKENS && written(r) >= promptOf(r) / 2

export const cacheHealth = (requests: readonly RequestUsage[], models: Record<string, Price>, now: number): CacheHealth | undefined => {
  const recent = requests.slice(-RECENT)
  const prompt = recent.reduce((sum, r) => sum + promptOf(r), 0)

  if (recent.length === 0 || prompt === 0) {
    return undefined
  }

  const lastHour = requests.filter(r => r.at !== undefined && r.at >= now - 60 * 60_000 && isReRead(r))
  // What each re-read would have cost had the cache served what it wrote.
  const extraUsd = lastHour.reduce((sum, r) => {
    const asHit = { ...r, cacheRead: r.cacheRead + written(r), cacheWrite: 0, cacheWrite1h: 0 }

    return sum + ((priceRequest(models, r.model, r) ?? 0) - (priceRequest(models, r.model, asHit) ?? 0))
  }, 0)

  return {
    hitRate: recent.reduce((sum, r) => sum + r.cacheRead, 0) / prompt,
    reReads: lastHour.length,
    extraUsd,
    lastReReadAt: lastHour[lastHour.length - 1]?.at,
  }
}
