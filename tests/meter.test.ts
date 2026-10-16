import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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

test('the band shows the cost and each model that answered', async ($, on) => {
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
    const ui = await $.ui.mount({ plugin: 'limit-lens', surface, ...BAND })
    expect(await textOf(ui, 'session-cost')).toBe('$0.42')
    expect(await textOf(ui, 'models')).toBe(`Models  ${BARS}   ● Opus 5.5 2 req   ○ Haiku 5.5 1 req`)
    expect(await whatIf(ui, 1)).toEqual([['$1.56'], ['$0.62'], ['$0.31'], ['$0.02']])
    await ui.unmount()
  }
})

test('before any request the band shows the current model', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))

  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  expect(await whatIf(ui, 1)).toEqual([['—'], ['—'], ['—'], ['—']])
  await ui.unmount()
})

test('on a subscription the band shows the limits and each tier projected draw', async ($, on) => {
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
    const ui = await $.ui.mount({ plugin: 'limit-lens', surface, ...BAND })
    expect(await textOf(ui, 'limits-labels')).toBe('◆ LimitsThis sessionAccountResets in')
    expect([await textOf(ui, 'session-five_hour'), await textOf(ui, 'session-seven_day')]).toEqual(['3%', '0.6%'])
    expect(await textOf(ui, 'account-five_hour')).toBe(`${'█'.repeat(2)}${'░'.repeat(8)} 23%`)
    expect(await textOf(ui, 'account-seven_day')).toBe(`${'█'.repeat(4)}${'░'.repeat(6)} 40.6%`)
    expect([await textOf(ui, 'reset-five_hour'), await textOf(ui, 'reset-seven_day')]).toEqual(['2h 10m', '3d 4h'])
    expect(await textOf(ui, 'models')).toBe(`Models  ${BARS}   ● Opus 5.5 2 req   ○ Haiku 5.5 1 req`)
    expect(await whatIf(ui, 2)).toEqual([
      ['11.1%', '2.2%'],
      ['4.4%', '0.9%'],
      ['2.2%', '0.4%'],
      ['0.1%', '<0.1%'],
    ])
    await ui.unmount()
  }
})

test('limit readings count even when no window moved a whole point', async ($, on) => {
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

  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' 20.4%' })).toBeDefined()
  expect([await textOf(ui, 'session-five_hour'), await textOf(ui, 'session-seven_day')]).toEqual(['0.4%', '0.1%'])
  expect(await whatIf(ui, 2)).toEqual([
    ['1.5%', '0.4%'],
    ['0.6%', '0.1%'],
    ['0.3%', '0.1%'],
    ['<0.1%', '<0.1%'],
  ])
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

test('a model without a price is left out of the comparison, and the band says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.model', async () => ({ value: 'claude-opus-6' }))
  answerSteps(on)

  for (const model of ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-6']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1 })) {
      // drain
    }
  }
  await $.session.measure({ context: { window: 200000 } as never, rateLimits: [], cost: { usd: 0.4213 }, changed: ['cost'] })

  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'desktop', ...BAND })
  expect(await textOf(ui, 'unpriced')).toBe('Opus 6 not priced yet: comparison covers 2 of 3 requests')
  // Priced from the two Opus 5.5 requests alone: Fable 2.5x, Sonnet 0.5x, Haiku 0.025x of them.
  expect(await whatIf(ui, 1)).toEqual([['$1.05'], ['$0.42'], ['$0.21'], ['$0.01']])
  expect(await textOf(ui, 'models')).toContain('● Opus 6 1 req')
  await ui.unmount()
})

test('prices are fetched in the background and a new model joins the comparison', async ($, on) => {
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

  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'desktop', ...BAND })
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

test('every 10 seconds the band re-reads the figures and its countdown moves, with no request', async ($, on) => {
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
  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'terminal', ...BAND })
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

test("a rise is split with the machine's other sessions by their share of the work", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  on('session.id', async () => ({ value: 'me' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: PRICING_PAGE } }))
  answerSteps(on)

  // Another session's log, which grows between the two rises; this session's own log is passed over.
  const iso = (ms: number) => new Date(NOW + ms).toISOString()
  const entry = (id: string, ms: number) =>
    `${JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`
  // Each response is logged once per content block: the repeat must count once.
  let other = entry('msg_a', 1000) + entry('msg_a', 1000)
  const reads: string[] = []
  const files = () => [
    { name: 'other.jsonl', kind: 'file' as const, size: other.length, mtimeMs: NOW + 1000, isLink: false },
    { name: 'me.jsonl', kind: 'file' as const, size: 999, mtimeMs: NOW + 1000, isLink: false },
  ]
  on('fs.list', async (_$, e) => ({
    value: e.path === '/home/u/.claude/projects' ? [{ name: 'p', kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false }] : files(),
  }))
  on('fs.exists', async () => ({ value: false }))
  on('process.run', async (_$, e) => {
    const from = Number(String(e.argv[2]).slice(1)) - 1
    reads.push(`${String(e.argv[3]).split('/').pop()}@${from}`)

    return { value: { exitCode: 0, stdout: other.slice(from), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000 } as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 20 },
        { kind: 'seven_day', percentUsed: 40 },
      ],
    },
  }))
  const measure = (fiveHour: number) =>
    $.session.measure({
      context: { window: 200000 } as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour },
        { kind: 'seven_day', percentUsed: 40 },
      ],
      cost: { usd: 0.1 },
      changed: ['cost'],
    })
  const step = async () => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      // drain
    }
  }

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true })
  // This session does two requests' work, the other session one, and the account rises two points.
  await step()
  await step()
  await clock.advance(2000)
  await measure(22)

  const ui = await $.ui.mount({ plugin: 'limit-lens', surface: 'desktop', ...BAND })
  // Until the poll splits it, the rise counts whole.
  expect(await textOf(ui, 'session-five_hour')).toBe('2%')
  await clock.advance(20_000)
  // Two thirds of two points.
  expect(await textOf(ui, 'session-five_hour')).toBe('1.3%')

  // The other session does all the work behind the next rise: none of it is this session's.
  other += entry('msg_b', 25_000)
  await clock.advance(5000)
  await measure(23)
  await clock.advance(20_000)
  expect(await textOf(ui, 'session-five_hour')).toBe('1.3%')
  expect(await textOf(ui, 'session-seven_day')).toBe('0%')

  // The other log was read from the start once, then only from where it stopped; this session's never.
  expect(reads).toEqual([`other.jsonl@0`, `other.jsonl@${(entry('msg_a', 1000) + entry('msg_a', 1000)).length}`])
  await ui.unmount()
})
