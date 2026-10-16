import { expect, test } from 'claude-code/testing'

import { shareOf } from '../hooks/register'
import { parseLogLine } from '../hooks/sessions'

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

test("a rise is this session's in proportion to its share of the work", async () => {
  expect(Math.round(shareOf(2, 1) * 1000)).toBe(667)
  expect(shareOf(1, 0)).toBe(1)
  // Nobody on this machine worked: claude.ai or another device did it.
  expect(shareOf(0, 0)).toBe(0)
  // The other logs could not be read: count it all as this session's.
  expect(shareOf(0, null)).toBe(1)
})
