import { priceKey } from './pricing'

// One hue per family, mid-tones that read on light and dark themes; older versions a shade muted.
const SHADES: Record<string, string> = {
  'fable-5-1': '#a274e8',
  'fable-5': '#8c68c2',
  'opus-5-5': '#e2774c',
  'opus-5': '#cc7552',
  'opus-4-8': '#b9785e',
  'opus-4-7': '#b9785e',
  'opus-4-6': '#b9785e',
  'sonnet-5-5': '#3f9ee6',
  'sonnet-5': '#4c8fc8',
  'sonnet-4-6': '#5d86ab',
  'haiku-5-5': '#22b58a',
  'haiku-4-5': '#4c9c84',
}

const FAMILIES: Record<string, string> = {
  fable: '#9a70d8',
  opus: '#c97a5a',
  sonnet: '#4f8fc4',
  haiku: '#3fa386',
}

// Hues for families the mod has never heard of, picked by the family's name so each keeps its colour.
const SPARE = ['#d4a72c', '#d0609a', '#5fb0b7', '#8fa63a', '#b07fd0']

/** The model's own colour: its version's shade, else its family's, else a spare hue for a new family. */
export const modelColor = (id: string): string => {
  const key = priceKey(id)
  const family = /^([a-z]+)-\d/.exec(key)?.[1]

  if (SHADES[key] ?? (family && FAMILIES[family])) {
    return SHADES[key] ?? FAMILIES[family!]!
  }
  if (!family) {
    return 'subtle'
  }

  const hash = [...family].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

  return SPARE[hash % SPARE.length]!
}

/**
 * Splits `width` cells between models by their share of requests: every model
 * that answered gets at least one, and the cells always add up to `width`.
 */
export const shareBar = (list: { model: string; requests: number }[], width: number): { model: string; cells: number }[] => {
  const answered = list.filter(m => m.requests > 0)
  const total = answered.reduce((sum, m) => sum + m.requests, 0)

  if (total === 0 || answered.length > width) {
    return []
  }

  const exact = answered.map(m => (m.requests / total) * width)
  const cells = exact.map(x => Math.max(1, Math.floor(x)))
  let spare = width - cells.reduce((sum, c) => sum + c, 0)

  // Hand out what's left by largest remainder, or take back from the widest.
  const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  for (let k = 0; spare > 0; k = (k + 1) % byRemainder.length, spare--) {
    cells[byRemainder[k]!.i]! += 1
  }
  while (spare < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest]! -= 1
    spare++
  }

  return answered.map((m, i) => ({ model: m.model, cells: cells[i]! }))
}
