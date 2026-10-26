import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { formatUsd, modelLabel } from '../hooks/register'
import { PRICING_PAGE } from './pricing-page'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/**
 * What sits beneath limit-lens in the band in a session (the engine, other plugins), answered here
 * as drawing nothing: an empty box. A test registers it first, as hooks beneath come before any call.
 */
const nothingBeneath = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', props: {}, children: [] }) as never)

/** The band as a session mounts it. */
const mountBand = ($: Engine, surface: 'terminal' | 'desktop') => $.ui.mount({ plugin: 'limit-lens', surface, ...BAND })

const usage = (model: string) => ({
  model,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

test('labels models and money', async () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)')
  expect(modelLabel('gpt-x')).toBe('gpt-x')
  expect(formatUsd(null)).toBe('—')
  expect(formatUsd(0.0042)).toBe('$0.0042')
  expect(formatUsd(1.234)).toBe('$1.23')
})

const NOW = Date.parse('2026-10-16T12:00:00Z')

/** The panel drawn expanded, as a person who turned off "Start collapsed" sees it. */
const EXPANDED = { options: { startCollapsed: false } } as const

type Drawing = { find: (query: { key: string }) => Promise<{ text: string } | undefined> }
const textOf = async (ui: Drawing, key: string) => (await ui.find({ key }))?.text

/** The comparison table's cells, model by model, column by column. */
const whatIf = async (ui: Drawing, columns: number, keys = ['fable-5-1', 'opus-5-5', 'sonnet-5-5', 'haiku-5-5']) => {
  const rows: string[][] = []
  for (const model of keys) {
    const row: string[] = []
    for (let h = 0; h < columns; h++) {
      row.push((await textOf(ui, `what-if-${model}-${h}`)) ?? '')
    }
    rows.push(row)
  }

  return rows
}

const BARS = `${'█'.repeat(8)}${'█'.repeat(4)}`

/** A machine with no other Claude Code session: an empty projects folder. */
const noOtherSessions = (on: On) => {
  mock.env(on, { HOME: '/home/u' })
  on('session.id', async () => ({ value: 'me' }))
  on('fs.list', async () => ({ value: [] }))
}

test('the band shows the cost and each model that answered', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.model),
    }
  })

  for (const model of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })
    for await (const _ of stream) {
      // drain
    }
  }
  await $.session.measure({
    context: { window: 200000 } as never,
    rateLimits: [],
    cost: { usd: 0.4213 },
    changed: ['cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    expect(await textOf(ui, 'session-cost')).toBe('$0.42')
    expect(await textOf(ui, 'models')).toBe(`Models  ${BARS}   ● Opus 5.5 2 req   ○ Haiku 5.5 1 req`)
    expect(await whatIf(ui, 1)).toEqual([['$1.56'], ['$0.62'], ['$0.31'], ['$0.02']])
    await ui.unmount()
  }
})

test('before any request the band shows the current model', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))

  const ui = await mountBand($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  expect(await whatIf(ui, 1)).toEqual([['—'], ['—'], ['—'], ['—']])
  await ui.unmount()
})

test('on a subscription the band shows the limits and each tier projected draw', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.model),
    }
  })
  const measure = (fiveHour: number, week: number) =>
    $.session.measure({
      context: { window: 200000 } as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-16T14:10:00Z' },
        { kind: 'seven_day', percentUsed: week, resetsAt: '2026-10-19T16:00:00Z' },
      ],
      cost: { usd: 0.1 },
      changed: ['rateLimits', 'cost'],
    })

  await measure(20, 40)
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })) {
      // drain
    }
  }
  await measure(23, 40.6)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    expect(await textOf(ui, 'limits-labels')).toBe('◆ LimitsThis sessionAccountResets inForecast')
    // No session logs have been read in this test: the share is not known yet.
    expect([await textOf(ui, 'session-five_hour'), await textOf(ui, 'session-seven_day')]).toEqual(['—', '—'])
    // 2h 50m of 5h gone by (57%) and 3d 20h of a week (55%) both fall in the sixth of ten cells.
    if (surface === 'terminal') {
      expect(await textOf(ui, 'account-five_hour')).toBe(`██░░░┃░░░░ 23%`)
      expect(await textOf(ui, 'account-seven_day')).toBe(`████░┃░░░░ 40.6%`)
    } else {
      // Drawn: the marker line at 57% of 104 pixels, the fill at 23%.
      const svg = (await ui.find({ type: 'Svg' } as never)) as { props?: { source?: string; alt?: string } } | undefined
      expect(svg?.props?.source).toContain('<rect x="57.9"')
      expect(svg?.props?.source).toContain('width="23.9" height="10"')
      expect(svg?.props?.alt).toBe('23% used, 56.7% of the window gone')
    }
    // 23% used with 57% of the window gone, and 40.6% with 55%: both well under pace.
    const colorOf = async (text: string) =>
      ((await ui.find({ type: 'Text', text } as never)) as { props?: { color?: string } } | undefined)?.props?.color
    expect(await colorOf(' 23%')).toBe('success')
    expect(await colorOf(' 40.6%')).toBe('success')
    expect([await textOf(ui, 'reset-five_hour'), await textOf(ui, 'reset-seven_day')]).toEqual(['2h 10m', '3d 4h'])
    expect(await textOf(ui, 'models')).toBe(`Models  ${BARS}   ● Opus 5.5 2 req   ○ Haiku 5.5 1 req`)
    expect(await whatIf(ui, 2)).toEqual([
      ['—', '—'],
      ['—', '—'],
      ['—', '—'],
      ['—', '—'],
    ])
    await ui.unmount()
  }
})

test('limit readings count even when no window moved a whole point', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.model),
    }
  })
  const measure = (fiveHour: number, week: number, changed: ('rateLimits' | 'cost')[]) =>
    $.session.measure({
      context: { window: 200000 } as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour },
        { kind: 'seven_day', percentUsed: week },
      ],
      cost: { usd: 0.1 },
      changed,
    })

  await measure(20, 40, ['rateLimits', 'cost'])
  for (const model of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })) {
      // drain
    }
  }
  // The engine flags rateLimits only on a whole-point move; these readings move less.
  await measure(20.4, 40.1, ['cost'])

  const ui = await mountBand($, 'desktop')
  expect(await ui.find({ type: 'Text', text: ' 20.4%' })).toBeDefined()
  expect(await textOf(ui, 'account-five_hour')).toContain(' 20.4%')
  await ui.unmount()
})

const answerSteps = (on: On) => {
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.model),
    }
  })
}

test('a model without a price is left out of the comparison, and the band says so', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-6' }))
  answerSteps(on)

  for (const model of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-6']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })) {
      // drain
    }
  }
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [], cost: { usd: 0.4213 }, changed: ['cost'] })

  const ui = await mountBand($, 'desktop')
  expect(await textOf(ui, 'unpriced')).toBe('Opus 6 not priced yet: comparison covers 2 of 3 requests')
  // Priced from the two Opus 5.5 requests alone: Fable 2.5x, Sonnet 0.5x, Haiku 0.025x of them.
  expect(await whatIf(ui, 1)).toEqual([['$1.05'], ['$0.42'], ['$0.21'], ['$0.01']])
  expect(await textOf(ui, 'models')).toContain('● Opus 6 1 req')
  await ui.unmount()
})

test('prices are fetched in the background and a new model joins the comparison', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const fetched: string[] = []
  const page = PRICING_PAGE.replace(
    /\| :-+[^\n]*\n/,
    // A function, so the row's dollar signs are not read as replacement patterns.
    separator => `${separator}| Claude Opus 6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.25 / MTok | $25 / MTok |\n`,
  )
  on('http.fetch', async (_$, e) => {
    fetched.push(e.url)

    return { value: { status: 200, ok: true, headers: {}, text: page } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  noOtherSessions(on)
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { window: 200000 } as never, rateLimits: [] } }))
  on('session.model', async () => ({ value: 'claude-opus-6' }))
  answerSteps(on)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await clock.advance(1000)
  expect(fetched).toEqual(['https://platform.claude.com/docs/en/about-claude/pricing.md'])

  for (const model of ['claude-opus-6', 'claude-opus-6']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })) {
      // drain
    }
  }
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [], cost: { usd: 0.5 }, changed: ['cost'] })

  const ui = await mountBand($, 'desktop')
  expect(await textOf(ui, 'unpriced')).toBeUndefined()
  expect(await textOf(ui, 'what-if-name-opus-6')).toBe('● Opus 6')
  // Opus 6 ran it all: Fable 2x its price, Sonnet 0.4x, Haiku 0.02x (a hair under a cent, so shown to four places).
  expect(await whatIf(ui, 1, ['fable-5-1', 'opus-6', 'sonnet-5-5', 'haiku-5-5'])).toEqual([
    ['$1.00'],
    ['$0.50'],
    ['$0.20'],
    ['$0.0100'],
  ])
  await ui.unmount()

  // Fresh prices are not fetched again on the next checks.
  await clock.advance(10 * 60_000)
  expect(fetched.length).toBe(1)
})

test('every 10 seconds the band re-reads the figures and its countdown moves, with no request', EXPANDED, async ($, on) => {
  nothingBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const fiveHour = 20
  const sent: string[] = []
  on('http.fetch', async (_$, e) => {
    sent.push(e.url)

    return { value: { status: 200, ok: true, headers: {}, text: PRICING_PAGE } }
  })
  on('model.complete', async () => {
    sent.push('model')

    return { deny: 'no model calls in this test' }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  noOtherSessions(on)
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000 } as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-16T14:10:00Z' },
        { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-19T16:00:00Z' },
      ],
      cost: { usd: 0.1 },
    },
  }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  const ui = await mountBand($, 'terminal')
  expect(await textOf(ui, 'reset-five_hour')).toBe('2h 10m')

  // Ten minutes idle: the countdown has moved without any turn running.
  await clock.advance(10 * 60_000)
  expect(await textOf(ui, 'reset-five_hour')).toBe('2h 0m')

  // No response has brought a new reading in those ten minutes, and the band says how old it is.
  expect(await textOf(ui, 'limits-account-label')).toBe('Account (10m ago)')

  // The only thing sent anywhere was the one price fetch at start.
  expect(sent).toEqual(['https://platform.claude.com/docs/en/about-claude/pricing.md'])
  await ui.unmount()
})

/**
 * A machine whose projects folder holds this session's log ("me", with a subagent's), another
 * session's ("other"), and an older copy of one of this session's responses ("old"), as a
 * conversation moved to a new session leaves behind.
 */
const fakeMachine = (on: On, logs: Record<string, string>) => {
  mock.env(on, { HOME: '/home/u' })
  on('session.id', async () => ({ value: 'me' }))
  const root = '/home/u/.claude/projects'
  const file = (name: string, text: string) => ({ name, kind: 'file' as const, size: text.length, mtimeMs: NOW, isLink: false })
  on('fs.list', async (_$, e) => {
    if (e.path === root) {
      return { value: [{ name: 'p', kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false }] }
    }
    if (e.path === `${root}/p`) {
      return {
        value: [
          ...['me.jsonl', 'other.jsonl', 'old.jsonl'].map(name => file(name, logs[name] ?? '')),
          { name: 'me', kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false },
        ],
      }
    }

    return { value: [file('agent-1.jsonl', logs['me/subagents/agent-1.jsonl'] ?? '')] }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path === `${root}/p/me/subagents` }))
  on('process.run', async (_$, e) => {
    const from = Number(String(e.argv[2]).slice(1)) - 1
    const path = String(e.argv[3]).replace(`${root}/p/`, '')

    return { value: { exitCode: 0, stdout: (logs[path] ?? '').slice(from), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const logLine = (id: string, msAgo: number) =>
  `${JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - msAgo).toISOString(), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`

test("this session's share is its part of all local work in the window, so sessions add up to the account", EXPANDED, async ($, on) => {
  nothingBeneath(on)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: PRICING_PAGE } }))
  answerSteps(on)
  const minute = 60_000
  fakeMachine(on, {
    // This session: two responses of its own and one from its subagent, interleaved with the other's.
    'me.jsonl': logLine('m1', 50 * minute) + logLine('m1', 50 * minute) + logLine('m2', 10 * minute),
    'me/subagents/agent-1.jsonl': logLine('s1', 30 * minute),
    'other.jsonl': logLine('o0', 120 * minute) + logLine('o1', 40 * minute) + logLine('o2', 20 * minute) + logLine('o3', 1 * minute),
    // A copy of this session's own response, left in an older log: counted once, as this session's.
    'old.jsonl': logLine('m1', 50 * minute),
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000 } as never,
      rateLimits: [
        // The 5-hour window began an hour ago; the week, four days ago.
        { kind: 'five_hour', percentUsed: 6, resetsAt: new Date(NOW + 4 * 60 * minute).toISOString() },
        { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3 * 24 * 60 * minute).toISOString() },
      ],
    },
  }))

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  for (const _ of [1, 2]) {
    for await (const _step of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      // drain
    }
  }
  await clock.advance(10_000)

  const ui = await mountBand($, 'terminal')
  // On Fable the same work would cost 2.5 times as much: 7.5% of the 5 hours, 42.9% of the week.
  expect((await whatIf(ui, 2))[0]).toEqual(['7.5%', '42.9%'])
  // 5 hours: three of six responses in the window are this session's, half of 6%.
  expect(await textOf(ui, 'session-five_hour')).toBe('3%')
  // The week also holds the other session's response from two hours ago: 3 of 7, of 40%.
  expect(await textOf(ui, 'session-seven_day')).toBe('17.1%')
  await ui.unmount()
})

const subscriptionReadings = (fiveHour: number) => [
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-16T14:10:00Z' },
  { kind: 'seven_day', percentUsed: 40.6, resetsAt: '2026-10-19T16:00:00Z' },
]

/** Another plugin's line in the band, beneath limit-lens. */
const neighbour = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: ['neighbour band'] }) as never)

type Tree = { type?: string; text?: string; children?: Tree[]; props?: { key?: string } }

/** The band's top-level parts, in order: limit-lens's panel, then what the others drew. */
const parts = async (ui: { findAll: (query: never) => Promise<unknown[]> }) => {
  const [root] = (await ui.findAll({} as never)) as Tree[]

  return (root?.children ?? []).map(child => child.props?.key)
}

test("the band keeps what other plugins draw there, collapsed and expanded, on every surface", async ($, on) => {
  neighbour(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  answerSteps(on)
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: subscriptionReadings(23), cost: { usd: 0.1 }, changed: ['rateLimits'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    // Collapsed: the limits line, and the other plugin's line below it.
    expect(await ui.find({ key: 'compact-label-five_hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'neighbour band' } as never)).toBeDefined()
    expect(await parts(ui)).toEqual(['limit-lens', 'others'])

    await ui.press({ key: 'toggle' })
    expect(await ui.find({ key: 'limits' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'neighbour band' } as never)).toBeDefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('on API billing the cost line keeps what other plugins draw there too', async ($, on) => {
  neighbour(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  answerSteps(on)
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [], cost: { usd: 0.1 }, changed: ['cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'neighbour band' } as never)).toBeDefined()
    await ui.unmount()
  }
})

test('the panel starts as one line, expands and collapses, and opens the details pane', async ($, on) => {
  nothingBeneath(on)
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  answerSteps(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: subscriptionReadings(23), cost: { usd: 0.1 }, changed: ['rateLimits'] })

  const ui = await mountBand($, 'terminal')
  // 23% used with 57% of the 5 hours gone: on course for 41%. The week, 40.6% at 55%: 74%.
  // Each window a row, its parts in columns that line up.
  const row = async (kind: string) =>
    Promise.all(['label', 'meter', 'session', 'forecast'].map(part => textOf(ui, `compact-${part}-${kind}`)))
  expect(await row('five_hour')).toEqual(['◆ 5h', '██░░░┃░░░░ 23%', 'this session —', '≈41% at reset'])
  expect(await row('seven_day')).toEqual(['  week', '████░┃░░░░ 40.6%', 'this session —', '≈74% at reset'])
  expect(await ui.find({ key: 'limits' })).toBeUndefined()
  // The toggle is a down arrow while collapsed and an up arrow once open, in the top-right corner:
  // the last element of the panel's top row.
  type Node = { children?: Node[]; props?: { key?: string } }
  const corner = async () => {
    const panel = (await ui.find({ key: 'limit-lens' })) as Node | undefined
    const top = panel?.children?.[0]

    return top?.children?.[top.children.length - 1]?.props?.key
  }
  expect(await textOf(ui, 'toggle')).toBe('⌄')
  expect(await corner()).toBe('corner')

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'limits' })).toBeDefined()
  expect(await textOf(ui, 'toggle')).toBe('⌃')
  // No keyboard shortcut, so no letter drawn beside it.
  expect(((await ui.find({ key: 'toggle' })) as { props?: { hotkey?: string } } | undefined)?.props?.hotkey).toBeUndefined()
  expect(await corner()).toBe('corner')
  expect([await textOf(ui, 'forecast-five_hour'), await textOf(ui, 'forecast-seven_day')]).toEqual(['≈41% at reset', '≈74% at reset'])
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'limits' })).toBeUndefined()

  await ui.press({ key: 'details' })
  expect(opened).toEqual(['limit-lens'])
  await ui.unmount()

  // On the desktop the one line carries the drawn meter in place of the cells.
  const desktop = await mountBand($, 'desktop')
  expect(await textOf(desktop, 'compact-meter-five_hour')).toBe(' 23%')
  expect(await textOf(desktop, 'compact-forecast-five_hour')).toBe('≈41% at reset')
  expect(await desktop.find({ type: 'Svg' } as never)).toBeDefined()
  await desktop.unmount()
})

test(
  'the settings set the on-pace band and turn the forecast off',
  { options: { startCollapsed: false, paceBand: 2, showForecast: false } },
  async ($, on) => {
  nothingBeneath(on)
    mock.clock(on, { now: NOW })
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    answerSteps(on)
    // 60% used with 57% of the window gone: 3 points ahead, past a 2-point band.
    await $.session.measure({ context: { window: 200000 } as never, rateLimits: subscriptionReadings(60), cost: { usd: 0.1 }, changed: ['rateLimits'] })

    const ui = await mountBand($, 'terminal')
    const color = ((await ui.find({ type: 'Text', text: ' 60%' } as never)) as { props?: { color?: string } } | undefined)?.props?.color
    expect(color).toBe('error')
    expect(await textOf(ui, 'limits-labels')).toBe('◆ LimitsThis sessionAccountResets in')
    await ui.unmount()
  },
)

test('the details pane shows sessions, projects, the cache and the context window', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: PRICING_PAGE } }))
  answerSteps(on)
  const minute = 60_000
  const meta = (row: object) => `${JSON.stringify(row)}\n`
  fakeMachine(on, {
    'me.jsonl': meta({ type: 'user', cwd: '/x/claudemod' }) + logLine('m1', 50 * minute) + logLine('m2', 10 * minute),
    'me/subagents/agent-1.jsonl': logLine('s1', 30 * minute),
    'other.jsonl':
      meta({ type: 'custom-title', customTitle: 'Game issue', cwd: '/x/fabricam' }) +
      logLine('o0', 120 * minute) +
      logLine('o1', 40 * minute) +
      logLine('o2', 20 * minute) +
      logLine('o3', 1 * minute) +
      logLine('o4', 2 * minute),
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { window: 1_000_000, tokens: 620_000, percent: 62 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 7, resetsAt: new Date(NOW + 4 * 60 * minute).toISOString() },
        { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 3 * 24 * 60 * minute).toISOString() },
      ],
    },
  }))

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  await clock.advance(10_000)

  const pane = await $.ui.mount({
    plugin: 'limit-lens',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'limit-lens',
    props: { title: 'Limits', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  // The 5 hours: Game issue did 4 of 7 responses, this session 3, of the account's 7%.
  expect([await textOf(pane, 'sessions-name-0'), await textOf(pane, 'sessions-value-0')]).toEqual(['○ Game issue', '4%'])
  expect([await textOf(pane, 'sessions-name-1'), await textOf(pane, 'sessions-value-1')]).toEqual(['● claudemod session', '3%'])
  // The week adds Game issue's response from two hours ago: 5 of 8 to fabricam, of 40%.
  expect([await textOf(pane, 'projects-name-0'), await textOf(pane, 'projects-value-0')]).toEqual(['○ fabricam', '25%'])
  expect([await textOf(pane, 'projects-name-1'), await textOf(pane, 'projects-value-1')]).toEqual(['● claudemod', '15%'])
  expect(await textOf(pane, 'context')).toBe('62% full: 620k of 1000k tokens')
  expect(await textOf(pane, 'cache-none')).toBe('No requests yet')
  await pane.unmount()
})
