import { expect, test } from 'claude-code/testing'

import { BUILT_IN } from '../hooks/pricing'
import { makeScanner, parseLogLine } from '../hooks/sessions'

// The shape of a response line in a session log, as seen in this machine's logs.
const line = (id: string, at: string, usage: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', timestamp: at, sessionId: 's', message: { id, model: 'claude-opus-5-5', usage } })

test('a response line gives its tokens, with cache writes split by lifetime', async () => {
  const parsed = parseLogLine(
    line('msg_1', '2026-10-16T17:20:01.864Z', {
      input_tokens: 2,
      cache_creation_input_tokens: 42904,
      cache_read_input_tokens: 52060,
      output_tokens: 464,
      cache_creation: { ephemeral_1h_input_tokens: 42904, ephemeral_5m_input_tokens: 0 },
    }),
  )
  expect(parsed).toEqual({
    id: 'msg_1',
    request: {
      model: 'claude-opus-5-5',
      input: 2,
      output: 464,
      cacheRead: 52060,
      cacheWrite: 0,
      cacheWrite1h: 42904,
      at: Date.parse('2026-10-16T17:20:01.864Z'),
    },
  })
})

test('lines that are not responses, or not whole, are passed over', async () => {
  expect(parseLogLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull()
  expect(parseLogLine('{"type":"assistant","usage":')).toBeNull()
  expect(parseLogLine('')).toBeNull()
})


// What one read of a log returns at most: `tail` through `$.process.run` gives its first 4 MiB.
const READ = 4_194_304
const NOW = Date.parse('2026-10-16T12:00:00Z')

/** A user row of exactly `chars` characters before its newline, as a big paste leaves in a log. */
const userRow = (chars: number) => {
  const base = JSON.stringify({ type: 'user', message: { content: '' } })

  return `${base.replace('""', JSON.stringify('x'.repeat(chars - base.length)))}\n`
}

/** A response row, padded with reply text to at least `chars` characters. */
const responseRow = (id: string, chars = 0) => {
  const row = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW).toISOString(),
      message: { id, model: 'claude-opus-5-5', content: text, usage: { input_tokens: 10, output_tokens: 20 } },
    })

  return `${row('x'.repeat(Math.max(0, chars - row('').length)))}\n`
}

/** A scanner over one project folder whose logs are `logs`, read the way the mod reads them. */
const scannerOver = (logs: Record<string, string>) =>
  makeScanner(
    {
      list: async path =>
        path === '/p'
          ? [{ name: 'proj', kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }]
          : Object.entries(logs).map(([name, text]) => ({ name, kind: 'file', size: text.length, mtimeMs: NOW, isLink: false })),
      exists: async () => false,
      readFrom: async (path, offset) => (logs[path.replace('/p/proj/', '')] ?? '').slice(offset, offset + READ),
    },
    '/p',
    'me',
  )

/** What the scanner counts as the work of every session since the start. */
const counted = async (logs: Record<string, string>) => {
  const scanner = scannerOver(logs)
  expect(await scanner.refresh(0)).toBe(true)

  return scanner.workSince(BUILT_IN.models, 0).all
}

test('a row longer than one read is passed over, and the responses after it still count', async () => {
  const one = await counted({ 'me.jsonl': userRow(64) + responseRow('r1') })
  expect(one).toBeGreaterThan(0)
  // Just over a read, as in the review, and over two reads: the response after it counts the same.
  expect(await counted({ 'me.jsonl': userRow(4_000_100) + responseRow('r1') })).toBe(one)
  expect(await counted({ 'me.jsonl': userRow(9_000_000) + responseRow('r1') })).toBe(one)
})

test('a row that a read cuts short is read again whole, also right after a passed-over row', async () => {
  const one = await counted({ 'me.jsonl': responseRow('r1') })
  // The long row ends early in the second read; the 3.95 MB response after it runs past that read's end.
  const logs = { 'me.jsonl': userRow(4_100_000) + responseRow('r2', 3_950_000) + responseRow('r3') }
  expect(await counted(logs)).toBe(2 * one)
})

test('an over-long row still being written is passed over once it ends, and counts nothing twice', async () => {
  const one = await counted({ 'me.jsonl': responseRow('r1') })
  const whole = userRow(5_000_000)
  const logs = { 'me.jsonl': whole.slice(0, 4_500_000) }
  const scanner = scannerOver(logs)
  expect(await scanner.refresh(0)).toBe(true)
  expect(scanner.workSince(BUILT_IN.models, 0).all).toBe(0)

  logs['me.jsonl'] = whole + responseRow('r1')
  expect(await scanner.refresh(0)).toBe(true)
  expect(scanner.workSince(BUILT_IN.models, 0).all).toBe(one)
  expect(await scanner.refresh(0)).toBe(true)
  expect(scanner.workSince(BUILT_IN.models, 0).all).toBe(one)
})
