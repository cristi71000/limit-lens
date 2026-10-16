import { expect, test } from 'claude-code/testing'

import { modelColor, shareBar } from '../hooks/palette'

const CURRENT = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

test('each compared model has its own colour', async () => {
  const colors = CURRENT.map(modelColor)
  expect(new Set(colors).size).toBe(CURRENT.length)
  expect(modelColor('claude-opus-5-5[1m]')).toBe(modelColor('claude-opus-5-5'))
})

test('an unlisted version takes its family colour, a new family a steady colour of its own', async () => {
  expect(modelColor('claude-sonnet-9-9')).toBe('#4f8fc4')
  expect(modelColor('claude-newname-1')).toBe(modelColor('claude-newname-2'))
  expect(modelColor('claude-newname-1')).not.toBe('subtle')
  expect(modelColor('mystery-model')).toBe('subtle')
})

test('the share bar fills its width and shows every model that answered', async () => {
  const bar = shareBar(
    [
      { model: 'claude-opus-5-5', requests: 97 },
      { model: 'claude-haiku-5-5', requests: 2 },
      { model: 'claude-sonnet-5-5', requests: 1 },
      { model: 'claude-fable-5-1', requests: 0 },
    ],
    12,
  )
  expect(bar.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
  expect(bar.reduce((sum, s) => sum + s.cells, 0)).toBe(12)
  expect(bar.every(s => s.cells >= 1)).toBe(true)
  expect(shareBar([], 12)).toEqual([])
})
