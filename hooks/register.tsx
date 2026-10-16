import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { LimitTick, LimitTrack, ModelTally, PriceState, RequestUsage } from '../types'
import {
  WINDOWS,
  formatDuration,
  formatPercent,
  formatResetIn,
  levelColor,
  sessionDraw,
  settleTick,
  trackedFor,
  trackLimits,
} from './limits'
import { modelColor, shareBar } from './palette'
import { BUILT_IN, PRICING_URL, parsePricingPage, priceKey, priceRequest, toRequest } from './pricing'
import { makeScanner } from './sessions'

const BAR_CELLS = 12
const METER_CELLS = 10
/** How many requests' token counts a session keeps; the oldest go first. */
const MAX_REQUESTS = 5000
/** Prices older than this are fetched again. */
const STALE_MS = 12 * 60 * 60_000
/** A failed fetch, or one a new model prompted, is not tried again sooner than this. */
const RETRY_MS = 30 * 60_000
/** How often the background price check runs. */
const CHECK_MS = 5 * 60_000
/** How often the band re-reads the session's figures and redraws, so countdowns keep moving while idle. */
const POLL_MS = 10_000
/** The `$.store` key the last good prices are kept under, across sessions. */
const PRICES_KEY = 'prices'

const usd = atom({ plugin: 'limit-lens', key: 'usd' } as const, null)
const models = atom({ plugin: 'limit-lens', key: 'models' } as const, [])
const requests = atom({ plugin: 'limit-lens', key: 'requests' } as const, [])
const prices = atom({ plugin: 'limit-lens', key: 'prices' } as const, BUILT_IN)
const limits = atom({ plugin: 'limit-lens', key: 'limits' } as const, [])
const startedAt = atom({ plugin: 'limit-lens', key: 'startedAt' } as const, null)
const ticks = atom({ plugin: 'limit-lens', key: 'ticks' } as const, [])

/** A rise is split once the other sessions' logs have had this long to record the requests behind it. */
const SETTLE_MS = 5000

/** Folds new readings in: the tracks move on, and each rise waits as a tick to be split. */
const takeReadings = async ($: EngineInterface, readings: Parameters<typeof trackLimits>[1], now: number) => {
  const { tracks, ticks: rises } = trackLimits(await read($, limits), readings, now)
  await update($, limits, () => tracks)
  if (rises.length > 0) {
    await update($, ticks, held => [...held, ...rises])
  }
}

/** What this session's own requests answered from `from` to `to` cost at the table's rates. */
const ownCost = (list: RequestUsage[], table: PriceState, from: number, to: number): number =>
  list
    .filter(r => r.at !== undefined && r.at >= from && r.at <= to)
    .reduce((sum, r) => sum + (priceRequest(table.models, r.model, r) ?? 0), 0)

/**
 * This session's share of a rise: its own work against every session's on this
 * machine over the same span. Work no local session did (claude.ai, another
 * device) is not this session's; when the logs cannot be read, all of it is.
 */
export const shareOf = (own: number, others: number | null): number =>
  others === null ? 1 : own + others > 0 ? own / (own + others) : 0

/** `claude-opus-5-5[1m]` → `Opus 5.5 (1M)`, `opus-6` → `Opus 6`; anything unrecognised stays as given. */
export const modelLabel = (id: string): string => {
  const isLong = /\[1m\]$/i.test(id)
  const bare = id.replace(/\[1m\]$/i, '')
  const match = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
  const family = match?.[1]
  const name = family
    ? `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
    : bare.replace(/^claude-/, '')

  return isLong ? `${name} (1M)` : name
}

export const formatUsd = (value: number | null): string => {
  if (value === null) {
    return '—'
  }

  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

const tally = (list: ModelTally[], model: string): ModelTally[] =>
  list.some(m => m.model === model)
    ? list.map(m => (m.model === model ? { ...m, requests: m.requests + 1 } : m))
    : [...list, { model, requests: 1 }]

/**
 * Every request priced at the current table: `actual` on the models that ran
 * them, `ratios` how each comparison model prices the same work relative to
 * that. Requests whose model has no price yet are counted apart, in `unpriced`.
 */
export const compare = (list: RequestUsage[], table: PriceState) => {
  let actual = 0
  let priced = 0
  const totals = table.candidates.map(() => 0)
  const unpriced = new Map<string, number>()

  for (const request of list) {
    const cost = priceRequest(table.models, request.model, request)

    if (cost === null) {
      unpriced.set(request.model, (unpriced.get(request.model) ?? 0) + 1)
      continue
    }

    actual += cost
    priced += 1
    table.candidates.forEach((key, i) => {
      totals[i]! += priceRequest(table.models, key, request) ?? 0
    })
  }

  return {
    priced,
    unpriced: [...unpriced.keys()],
    unpricedCount: [...unpriced.values()].reduce((n, c) => n + c, 0),
    ratios: actual > 0 ? totals.map(total => total / actual) : [],
  }
}

/** Fetches the pricing page and, when it reads, puts its table in use and keeps it for later sessions. */
const refreshPrices = async ($: EngineInterface) => {
  const now = await $.clock.now()

  try {
    const { ok, status, text } = await $.http.fetch(PRICING_URL)
    const table = ok ? parsePricingPage(text) : null

    if (!table) {
      throw new Error(ok ? 'no readable pricing table' : `HTTP ${status}`)
    }

    const fresh: PriceState = { source: 'page', fetchedAt: now, ...table }
    await update($, prices, () => fresh)
    await $.store.set(PRICES_KEY, fresh)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    await update($, prices, held => ({ ...held, failedAt: now, failure }))
  }
}

/** Whether to fetch now: the prices are old, or a model answered that they don't price, and no try failed lately. */
export const isRefreshDue = (table: PriceState, list: RequestUsage[], now: number): boolean => {
  const isRecentFailure = table.failedAt !== undefined && now - table.failedAt < RETRY_MS
  const age = table.fetchedAt === null ? Infinity : now - table.fetchedAt
  const isMissingModel = list.some(r => table.models[priceKey(r.model)] === undefined)

  return !isRecentFailure && (age > STALE_MS || (isMissingModel && age > RETRY_MS))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    const { cost, rateLimits } = usage
    const now = await $.clock.now()

    if (cost) {
      await update($, usd, () => cost.usd)
    }
    await update($, startedAt, () => usage.startedAt)
    await takeReadings($, rateLimits, now)

    // Start from the last good prices any session fetched, then keep them current in the background.
    const kept = (await $.store.get(PRICES_KEY)) as PriceState | undefined
    if (kept?.source === 'page' && (kept.fetchedAt ?? 0) > ((await read($, prices)).fetchedAt ?? 0)) {
      await update($, prices, () => kept)
    }

    let isFetching = false
    const check = async () => {
      if (isFetching || !isRefreshDue(await read($, prices), await read($, requests), await $.clock.now())) {
        return
      }
      isFetching = true
      try {
        await refreshPrices($)
      } finally {
        isFetching = false
      }
    }
    $.clock.after(1000, () => void check())
    $.clock.every(CHECK_MS, () => void check())

    // The other sessions' logs, read a piece at a time, to split each rise of the account's usage.
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    const scanner = makeScanner($, `${configDir}/projects`, await $.session.id())

    let isSettling = false
    const settle = async () => {
      const at = await $.clock.now()
      const ready = (await read($, ticks)).filter(t => t.to <= at - SETTLE_MS)

      if (isSettling || ready.length === 0) {
        return
      }
      isSettling = true
      try {
        const earliest = Math.min(...ready.map(t => t.from))
        const isRead = await scanner.refresh(earliest - 60_000)
        const table = await read($, prices)
        const own = await read($, requests)

        let tracks = await read($, limits)
        for (const tick of ready) {
          const others = isRead ? scanner.costBetween(table.models, tick.from, tick.to) : null
          tracks = settleTick(tracks, tick, shareOf(ownCost(own, table, tick.from, tick.to), others))
        }
        await update($, limits, () => tracks)
        const isSame = (a: LimitTick, b: LimitTick) =>
          a.kind === b.kind && a.from === b.from && a.to === b.to && a.points === b.points
        await update($, ticks, held => held.filter(t => !ready.some(r => isSame(r, t))))
        scanner.forget(Math.min(at - 60 * 60_000, ...(await read($, ticks)).map(t => t.from)))
      } finally {
        isSettling = false
      }
    }

    // Local work only, no network and no model calls: split waiting rises, then redraw for the countdowns.
    const poll = async () => {
      await settle()
      $.ui.invalidate('ui.render')
    }
    $.clock.every(POLL_MS, () => void poll())

    return result
  })

  on('session.measure', async ($, e, next) => {
    const { cost, rateLimits } = e

    if (cost) {
      await update($, usd, () => cost.usd)
    }
    // Every measurement carries the readings to a tenth of a point; `changed` only
    // names rateLimits on a whole-point move, which would hide smaller draws.
    if (rateLimits.length > 0) {
      await takeReadings($, rateLimits, await $.clock.now())
    }

    return next(e)
  })

  // Every request, the main loop's and each subagent's, reports the model that answered it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (result.usage) {
      const { model } = result.usage
      const request = toRequest(model, result.usage, await $.clock.now(), e.agentId === undefined)
      await update($, models, list => tally(list, model))
      await update($, requests, list => [...list, request].slice(-MAX_REQUESTS))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const cost = await read($, usd)
    const used = await read($, models)
    const table$ = await read($, prices)
    const comparison = compare(await read($, requests), table$)
    const candidates = table$.candidates
    const tracked = await read($, limits)
    const windows = WINDOWS.flatMap(w => {
      const track = tracked.find(t => t.kind === w.kind)

      return track ? [{ ...w, track }] : []
    })
    const isSubscription = windows.length > 0
    const now = await $.clock.now()
    const current = modelLabel(await $.session.model())
    const shown: ModelTally[] = used.some(m => modelLabel(m.model) === current)
      ? used
      : [{ model: current, requests: 0 }, ...used]
    const bar = shareBar(used, BAR_CELLS)

    // A table is a row of columns, so each column lines up whatever the font; every cell is one line.
    const cell = (key: string, content: RenderChildren) => (
      <Box key={key} flexDirection="row">
        {content}
      </Box>
    )
    const column = (key: string, cells: RenderChildren[]) => (
      <Box key={key} flexDirection="column">
        {cells}
      </Box>
    )
    const table = (key: string, columns: RenderChildren[]) => (
      <Box key={key} flexDirection="row" columnGap={2}>
        {columns}
      </Box>
    )
    const header = (text: string) => <Text dimColor>{text}</Text>
    const label = (text: string) => <Text dimColor>{text}</Text>

    const modelsRow = (
      <Box key="models" flexDirection="row" flexWrap="wrap" marginTop={1}>
        {label('Models  ')}
        {bar.map(segment => (
          <Text key={`bar-${segment.model}`} color={modelColor(segment.model)}>
            {'█'.repeat(segment.cells)}
          </Text>
        ))}
        {shown.map(m => {
          const name = modelLabel(m.model)
          const isCurrent = name === current
          const color = modelColor(m.model)

          return (
            <Box key={`model-${m.model}`} flexDirection="row">
              <Text>{'   '}</Text>
              <Text color={color}>{isCurrent ? '● ' : '○ '}</Text>
              <Text bold={isCurrent} color={color}>
                {name}
              </Text>
              {m.requests > 0 ? <Text dimColor>{` ${m.requests} req`}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )

    // One row per comparison model; `values` gives its cells, `undefined` until a request is priced.
    const whatIfTable = (headers: string[], values: (i: number) => string[] | undefined) =>
      table('what-if', [
        column('what-if-names', [
          cell('what-if-title', header('If all on')),
          ...candidates.map(model => {
            const name = modelLabel(model)
            const isCurrent = name === current

            return cell(
              `what-if-name-${model}`,
              [
                <Text key="dot" color={modelColor(model)}>
                  {isCurrent ? '● ' : '○ '}
                </Text>,
                <Text key="name" bold={isCurrent} color={modelColor(model)}>
                  {name}
                </Text>,
              ],
            )
          }),
        ]),
        ...headers.map((title, col) =>
          column(`what-if-col-${col}`, [
            cell(`what-if-head-${col}`, header(title)),
            ...candidates.map((model, i) =>
              cell(`what-if-${model}-${col}`, <Text>{values(i)?.[col] ?? '—'}</Text>),
            ),
          ]),
        ),
      ])

    // Only when a model has no price yet: what the comparison leaves out for want of one.
    const unpricedNames = comparison.unpriced.map(modelLabel)
    const unpricedRow =
      unpricedNames.length > 0 ? (
        <Box key="unpriced" flexDirection="row" flexWrap="wrap">
          <Text color="warning">
            {`${unpricedNames.join(', ')} not priced yet: comparison covers ${comparison.priced} of ${
              comparison.priced + comparison.unpricedCount
            } requests`}
          </Text>
        </Box>
      ) : null

    const panel = (left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="column">
        <Box key="tables" flexDirection="row" flexWrap="wrap" columnGap={6}>
          {left}
          {right}
        </Box>
        {modelsRow}
        {unpricedRow}
      </Box>
    )

    if (isSubscription) {
      const pending = await read($, ticks)
      const draws = windows.map(w => sessionDraw(w.track, pending))
      // How old the account figure is: it only moves when this session hears back from the API.
      const readAt = Math.max(...windows.map(w => w.track.readAt ?? w.track.since))
      const readingAge = now - readAt >= 60_000 ? formatDuration(now - readAt) : undefined
      const since = Math.min(...windows.map(w => w.track.since))
      const trackedSpan = trackedFor(await read($, startedAt), since, now)

      const limitsTable = table('limits', [
        column('limits-labels', [
          cell(
            'limits-title',
            [
              <Text key="mark" color="claude">
                ◆{' '}
              </Text>,
              <Text key="title" bold>
                Limits
              </Text>,
            ],
          ),
          cell('limits-session-label', label(trackedSpan ? `This session (${trackedSpan})` : 'This session')),
          cell('limits-account-label', label(readingAge ? `Account (${readingAge} ago)` : 'Account')),
          cell('limits-reset-label', label('Resets in')),
        ]),
        ...windows.map(w => {
          const percent = w.track.percentUsed
          const filled = Math.min(METER_CELLS, Math.round((percent / 100) * METER_CELLS))
          const color = levelColor(percent)

          return column(`limits-${w.kind}`, [
            cell(`limits-head-${w.kind}`, header(w.label)),
            cell(
              `session-${w.kind}`,
              <Text bold color="claude">
                {formatPercent(sessionDraw(w.track, pending))}
              </Text>,
            ),
            cell(
              `account-${w.kind}`,
              [
                <Text key="filled" color={color}>
                  {'█'.repeat(filled)}
                </Text>,
                <Text key="empty" dimColor>
                  {'░'.repeat(METER_CELLS - filled)}
                </Text>,
                <Text key="percent" bold color={color}>{` ${formatPercent(percent)}`}</Text>,
              ],
            ),
            cell(`reset-${w.kind}`, <Text dimColor>{formatResetIn(w.track.resetsAt, now) ?? '—'}</Text>),
          ])
        }),
      ])

      return panel(
        limitsTable,
        whatIfTable(
          windows.map(w => w.label),
          i => (comparison.ratios.length > 0 ? draws.map(d => formatPercent(d * (comparison.ratios[i] ?? 0))) : undefined),
        ),
      )
    }


    const costTable = table('cost', [
      column('cost-labels', [
        cell(
          'cost-title',
          [
            <Text key="mark" color="claude">
              ◆{' '}
            </Text>,
            <Text key="title" bold>
              Cost
            </Text>,
          ],
        ),
        cell('cost-session-label', label('This session')),
      ]),
      column('cost-values', [
        cell('cost-head', header('API price')),
        cell(
          'session-cost',
          <Text bold color="claude">
            {formatUsd(cost)}
          </Text>,
        ),
      ]),
    ])

    return panel(
      costTable,
      whatIfTable(['≈ cost'], i =>
        cost !== null && comparison.ratios.length > 0 ? [formatUsd(cost * (comparison.ratios[i] ?? 0))] : undefined,
      ),
    )
  })
}
