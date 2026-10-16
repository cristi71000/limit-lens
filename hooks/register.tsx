import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Breakdown, BreakdownRow, LimitTrack, ModelTally, PriceState, RequestUsage } from '../types'
import { cacheHealth } from './cache'
import {
  WINDOWS,
  formatDuration,
  formatPercent,
  formatResetIn,
  elapsedFraction,
  forecast,
  formatForecast,
  PACE_SLACK,
  meterRuns,
  meterSvg,
  METER_SIZE,
  paceColor,
  sessionDraw,
  shareOf,
  windowStart,
  trackLimits,
} from './limits'
import { modelColor, shareBar } from './palette'
import { BUILT_IN, PRICING_URL, parsePricingPage, priceKey, priceRequest, toRequest } from './pricing'
import { makeScanner } from './sessions'
import type { SessionWork } from './sessions'

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
const shares = atom({ plugin: 'limit-lens', key: 'shares' } as const, {})
const expanded = atom({ plugin: 'limit-lens', key: 'expanded' } as const, null)
const breakdown = atom({ plugin: 'limit-lens', key: 'breakdown' } as const, { sessions: [], projects: [] })

/** The details pane's id, and the command that opens it. */
const PANE = 'limit-lens'
const COMMAND = 'limits'

/** A session as the details pane names it: its title, else its folder's name, else the start of its id. */
const sessionName = (work: SessionWork): string =>
  work.title ?? (work.cwd ? `${work.cwd.split('/').pop()} session` : work.owner.slice(0, 8))

/** Every session's work in the 5-hour window, and the week's grouped by project folder. */
export const toBreakdown = (fiveHour: SessionWork[], week: SessionWork[]): Breakdown => {
  const projects = new Map<string, BreakdownRow>()
  for (const work of week) {
    const name = work.cwd?.split('/').pop() ?? 'other'
    const held = projects.get(name) ?? { name, cost: 0, isOwn: false }
    projects.set(name, { name, cost: held.cost + work.cost, isOwn: held.isOwn || work.isOwn })
  }

  return {
    sessions: fiveHour.map(work => ({ name: sessionName(work), cost: work.cost, isOwn: work.isOwn })),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost),
  }
}

/** Folds new readings in: each window's figure, reset time and when it was read. */
const takeReadings = async ($: EngineInterface, readings: Parameters<typeof trackLimits>[1], now: number) => {
  const tracks = trackLimits(await read($, limits), readings, now)
  await update($, limits, () => tracks)
}

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

export const register: Register = (on, options) => {
  // The settings: whether the panel starts as one line, whether it forecasts, and how wide the on-pace band is.
  const startCollapsed = options.startCollapsed !== false
  const showForecast = options.showForecast !== false
  const paceBand = typeof options.paceBand === 'number' && options.paceBand >= 0 ? options.paceBand : PACE_SLACK

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    const { cost, rateLimits } = usage
    const now = await $.clock.now()

    if (cost) {
      await update($, usd, () => cost.usd)
    }
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

    // Every session's log on this machine, read a piece at a time, to tell this session's share of each window.
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    const scanner = makeScanner($, `${configDir}/projects`, await $.session.id())

    let isMeasuring = false
    const measureShares = async () => {
      if (isMeasuring) {
        return
      }
      isMeasuring = true
      try {
        const at = await $.clock.now()
        const tracks = await read($, limits)
        // Each window from its start: the reset time less its length, or when tracking began.
        const starts = WINDOWS.flatMap(w => {
          const track = tracks.find(t => t.kind === w.kind)

          return track ? [{ kind: w.kind, from: windowStart(track, w.lengthMs) ?? track.since }] : []
        })
        if (starts.length === 0) {
          return
        }

        const earliest = Math.min(...starts.map(s => s.from))
        if (!(await scanner.refresh(earliest))) {
          return
        }

        const table = await read($, prices)
        const measured: Record<string, number> = {}
        for (const { kind, from } of starts) {
          const { own, all } = scanner.workSince(table.models, from)
          measured[kind] = shareOf(own, all)
        }
        await update($, shares, () => measured)

        const fromOf = (kind: string) => starts.find(s => s.kind === kind)?.from
        const fiveFrom = fromOf('five_hour')
        const weekFrom = fromOf('seven_day')
        await update($, breakdown, () =>
          toBreakdown(
            fiveFrom === undefined ? [] : scanner.workBySession(table.models, fiveFrom),
            weekFrom === undefined ? [] : scanner.workBySession(table.models, weekFrom),
          ),
        )
        scanner.forget(Math.min(earliest, at))
      } finally {
        isMeasuring = false
      }
    }

    // Local work only, no network and no model calls: this session's shares, then a redraw for the countdowns.
    const poll = async () => {
      await measureShares()
      $.ui.invalidate('ui.render')
    }
    $.clock.every(POLL_MS, () => void poll())

    // `/limits` opens the details pane. Last, and on its own: the panel works without it.
    try {
      await $.command.register({ name: COMMAND, description: 'Show limit-lens details: sessions, projects, cache, context' })
    } catch {
      // The pane stays reachable from the panel's Details button.
    }

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

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Only the remote surfaces (the desktop, the editor, mobile) have Svg; the terminal does not.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
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
      <Box key="models" flexDirection="row" flexWrap="wrap">
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

    // The controls: expand or collapse the panel, and open the details pane.
    const isOpen = (await read($, expanded)) ?? !startCollapsed
    // The panel's own control, in its top-right corner: ⌄ to expand it, ⌃ to collapse it.
    const toggle = (
      <Box key="corner">
        <Button key="toggle" label={isOpen ? '⌃' : '⌄'} plain dimColor onPress={() => update($, expanded, () => !isOpen)} />
      </Box>
    )
    const controls = (
      <Box key="controls" flexDirection="row">
        <Button key="details" label="Details" hotkey="d" dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Limits' })} />
      </Box>
    )
    /** The panel with the toggle in its top-right corner: the body takes the width the toggle leaves. */
    const framed = (body: RenderChildren) => (
      <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
        <Box key="frame" flexGrow={1}>
          {body}
        </Box>
        {toggle}
      </Box>
    )

    const panel = (left: RenderChildren, right: RenderChildren) =>
      framed(
      <Box key="body" flexDirection="column">
        <Box key="tables" flexDirection="row" flexWrap="wrap" columnGap={6}>
          {left}
          {right}
        </Box>
        <Box key="footer" flexDirection="row" flexWrap="wrap" columnGap={3} marginTop={1}>
          {modelsRow}
          {controls}
        </Box>
        {unpricedRow}
      </Box>,
      )

    const mark = [
      <Text key="mark" color="claude">
        ◆{' '}
      </Text>,
    ]

    if (isSubscription) {
      const known = await read($, shares)
      const draws = windows.map(w => sessionDraw(w.track, known[w.kind]))
      // How old the account figure is: it only moves when this session hears back from the API.
      const readAt = Math.max(...windows.map(w => w.track.readAt ?? w.track.since))
      const readingAge = now - readAt >= 60_000 ? formatDuration(now - readAt) : undefined
      const views = windows.map((w, i) => {
        const percent = w.track.percentUsed
        const elapsed = elapsedFraction(w.track.resetsAt, w.lengthMs, now)
        const course = showForecast ? forecast(percent, elapsed, w.lengthMs) : undefined

        return { ...w, percent, elapsed, color: paceColor(percent, elapsed, paceBand), draw: draws[i], course }
      })

      // The account's meter: the marker stands for the time gone by, so usage left of it is under pace.
      // Where the surface draws SVG it is a thin drawn line; in the terminal it takes one cell's place.
      const meter = (v: (typeof views)[number]): RenderChildren[] => [
        ...(Svg
          ? [
              <Svg
                key="meter"
                source={meterSvg(v.percent, v.elapsed, v.color)}
                alt={`${formatPercent(v.percent)} used${
                  v.elapsed === undefined ? '' : `, ${formatPercent(v.elapsed * 100)} of the window gone`
                }`}
                width={METER_SIZE.width}
                height={METER_SIZE.height}
              />,
            ]
          : meterRuns(v.percent, v.elapsed, METER_CELLS).map((run, i) =>
              run.kind === 'marker' ? (
                <Text key={`run-${i}`} bold color="text">
                  {run.text}
                </Text>
              ) : run.kind === 'filled' ? (
                <Text key={`run-${i}`} color={v.color}>
                  {run.text}
                </Text>
              ) : (
                <Text key={`run-${i}`} dimColor>
                  {run.text}
                </Text>
              ),
            )),
        <Text key="percent" bold color={v.color}>{` ${formatPercent(v.percent)}`}</Text>,
      ]
      const sessionText = (v: (typeof views)[number]) => (v.draw === undefined ? '—' : formatPercent(v.draw))
      const courseColor = (v: (typeof views)[number]) => (v.course?.kind === 'limit' ? 'error' : undefined)

      if (!isOpen) {
        // A row per window, in columns so the rows line up: the label, the meter, this session's
        // part, and where the window is heading; the controls beside them.
        return framed(
          <Box key="body" flexDirection="row" alignItems="flex-start" columnGap={3}>
            {table('compact', [
              column(
                'compact-labels',
                views.map((v, i) => cell(`compact-label-${v.kind}`, [...(i === 0 ? mark : [<Text key="gap">{'  '}</Text>]), label(v.label)])),
              ),
              column(
                'compact-meters',
                views.map(v => cell(`compact-meter-${v.kind}`, meter(v))),
              ),
              column(
                'compact-sessions',
                views.map(v =>
                  cell(`compact-session-${v.kind}`, [
                    <Text key="label" dimColor>
                      {'this session '}
                    </Text>,
                    <Text key="value" bold color="claude">
                      {sessionText(v)}
                    </Text>,
                  ]),
                ),
              ),
              ...(showForecast
                ? [
                    column(
                      'compact-forecasts',
                      views.map(v =>
                        cell(
                          `compact-forecast-${v.kind}`,
                          <Text dimColor={!courseColor(v)} color={courseColor(v)}>
                            {v.course ? formatForecast(v.course) : ''}
                          </Text>,
                        ),
                      ),
                    ),
                  ]
                : []),
            ])}
            {controls}
          </Box>,
        )
      }

      const limitsTable = table('limits', [
        column('limits-labels', [
          cell('limits-title', [
            ...mark,
            <Text key="title" bold>
              Limits
            </Text>,
          ]),
          cell('limits-session-label', label('This session')),
          cell('limits-account-label', label(readingAge ? `Account (${readingAge} ago)` : 'Account')),
          cell('limits-reset-label', label('Resets in')),
          ...(showForecast ? [cell('limits-forecast-label', label('Forecast'))] : []),
        ]),
        ...views.map(v =>
          column(`limits-${v.kind}`, [
            cell(`limits-head-${v.kind}`, header(v.label)),
            cell(
              `session-${v.kind}`,
              <Text bold color="claude">
                {sessionText(v)}
              </Text>,
            ),
            cell(`account-${v.kind}`, meter(v)),
            cell(`reset-${v.kind}`, <Text dimColor>{formatResetIn(v.track.resetsAt, now) ?? '—'}</Text>),
            ...(showForecast
              ? [
                  cell(
                    `forecast-${v.kind}`,
                    <Text dimColor={!courseColor(v)} color={courseColor(v)}>
                      {v.course ? formatForecast(v.course) : '—'}
                    </Text>,
                  ),
                ]
              : []),
          ]),
        ),
      ])

      return panel(
        limitsTable,
        whatIfTable(
          windows.map(w => w.label),
          i =>
            comparison.ratios.length > 0
              ? draws.map(d => (d === undefined ? '—' : formatPercent(d * (comparison.ratios[i] ?? 0))))
              : undefined,
        ),
      )
    }

    if (!isOpen) {
      return framed(
        <Box key="body" flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Box key="compact" flexDirection="row">
            {mark}
            <Text dimColor>{'This session '}</Text>
            <Text bold color="claude">
              {formatUsd(cost)}
            </Text>
          </Box>
          {controls}
        </Box>,
      )
    }

    const costTable = table('cost', [
      column('cost-labels', [
        cell('cost-title', [
          ...mark,
          <Text key="title" bold>
            Cost
          </Text>,
        ]),
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

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Limits' })

    return {}
  })

  // The details pane: what the panel has no room for.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const tracked = await read($, limits)
    const table$ = await read($, prices)
    const parts = await read($, breakdown)
    const { context } = await $.session.usage()
    const cache = cacheHealth(await read($, requests), table$.models, now)
    const cost = await read($, usd)

    const heading = (key: string, text: string) => (
      <Box key={key} marginTop={1}>
        <Text bold>{text}</Text>
      </Box>
    )
    const note = (key: string, text: string) => (
      <Box key={key}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    // A list's rows: each one's part of the window's account figure, or of the session's cost off a subscription.
    const rows = (key: string, list: BreakdownRow[], percentUsed: number | undefined) => {
      const total = list.reduce((sum, row) => sum + row.cost, 0)

      return (
        <Box key={key} flexDirection="row" columnGap={3}>
          <Box key={`${key}-names`} flexDirection="column">
            {list.map((row, i) => (
              <Box key={`${key}-name-${i}`} flexDirection="row">
                <Text color={row.isOwn ? 'claude' : undefined}>{row.isOwn ? '● ' : '○ '}</Text>
                <Text bold={row.isOwn}>{row.name}</Text>
              </Box>
            ))}
          </Box>
          <Box key={`${key}-values`} flexDirection="column">
            {list.map((row, i) => (
              <Box key={`${key}-value-${i}`}>
                <Text>
                  {percentUsed === undefined
                    ? formatUsd(row.cost)
                    : formatPercent(total > 0 ? (percentUsed * row.cost) / total : 0)}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    const fiveHour = tracked.find(t => t.kind === 'five_hour')?.percentUsed
    const week = tracked.find(t => t.kind === 'seven_day')?.percentUsed
    const contextColor = (context.percent ?? 0) >= 90 ? 'error' : (context.percent ?? 0) >= 80 ? 'warning' : undefined

    return (
      <Box flexDirection="column">
        {heading('sessions-head', fiveHour === undefined ? 'Sessions' : 'Sessions in this 5-hour window')}
        {parts.sessions.length > 0 ? rows('sessions', parts.sessions, fiveHour) : note('sessions-none', 'Reading the session logs…')}
        {heading('projects-head', week === undefined ? 'Projects' : 'Projects this week')}
        {parts.projects.length > 0 ? rows('projects', parts.projects, week) : note('projects-none', 'Reading the session logs…')}
        {heading('cache-head', 'Prompt cache, this session')}
        {cache ? (
          <Box key="cache" flexDirection="column">
            <Text>{`Hit rate ${formatPercent(cache.hitRate * 100)} over the last requests`}</Text>
            <Text color={cache.reReads > 0 ? 'warning' : undefined} dimColor={cache.reReads === 0}>
              {cache.reReads === 0
                ? 'No full re-reads in the last hour'
                : `${cache.reReads} full re-read${cache.reReads === 1 ? '' : 's'} in the last hour, ≈${formatUsd(cache.extraUsd)} more than cache hits${
                    cache.lastReReadAt === undefined ? '' : ` (last ${formatDuration(now - cache.lastReReadAt) ?? 'just now'} ago)`
                  }`}
            </Text>
          </Box>
        ) : (
          note('cache-none', 'No requests yet')
        )}
        {heading('context-head', 'Context window, this session')}
        <Box key="context">
          <Text color={contextColor}>
            {context.percent === undefined
              ? `${Math.round(context.window / 1000)}k tokens, fill not reported yet`
              : `${formatPercent(context.percent)} full: ${Math.round((context.tokens ?? 0) / 1000)}k of ${Math.round(context.window / 1000)}k tokens`}
          </Text>
        </Box>
        {fiveHour === undefined && cost !== null ? note('cost-note', `This session so far: ${formatUsd(cost)} at API prices`) : null}
      </Box>
    )
  })
}
