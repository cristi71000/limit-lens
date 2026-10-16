import type { EngineInterface } from 'claude-code'

import type { Price, RequestUsage } from '../types'
import { priceRequest } from './pricing'

/** How much of a log one read takes; the rest is read on the next pass. */
const CHUNK_BYTES = 4_000_000

type Log = { offset: number; size: number; ids: Set<string>; requests: RequestUsage[] }

/**
 * One line of a session log, when it records a model's response: the logs
 * write a response once per content block, so `id` tells repeats apart.
 */
export const parseLogLine = (line: string): { id: string; request: RequestUsage } | null => {
  if (!line.includes('"usage"')) {
    return null
  }

  try {
    const row = JSON.parse(line) as {
      type?: string
      timestamp?: string
      message?: {
        id?: string
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
        }
      }
    }
    const message = row.message
    const usage = message?.usage
    const at = Date.parse(row.timestamp ?? '')

    if (row.type !== 'assistant' || !message?.id || !message.model || !usage || !Number.isFinite(at)) {
      return null
    }

    const split = usage.cache_creation
    const written = usage.cache_creation_input_tokens ?? 0

    return {
      id: message.id,
      request: {
        model: message.model,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: split ? (split.ephemeral_5m_input_tokens ?? 0) : written,
        cacheWrite1h: split ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
        at,
      },
    }
  } catch {
    return null
  }
}

/**
 * Reads the other Claude Code sessions' logs on this machine, a piece at a
 * time: each log is read from where the last pass stopped, so a long session
 * is read once. `ownId` is this session's: its requests are counted from the
 * engine directly, so its log and its subagents' are passed over.
 */
export function makeScanner($: EngineInterface, projectsDir: string, ownId: string) {
  const logs = new Map<string, Log>()
  const encoder = new TextEncoder()

  /** The text from `offset` on, up to a chunk; null when the file cannot be read. */
  const readFrom = async (path: string, offset: number): Promise<string | null> => {
    try {
      const { exitCode, stdout } = await $.process.run(['tail', '-c', `+${offset + 1}`, path], { timeoutMs: 10_000 })

      return exitCode === 0 ? stdout.slice(0, CHUNK_BYTES) : null
    } catch {
      return null
    }
  }

  const readLog = async (path: string, size: number) => {
    const log = logs.get(path) ?? { offset: 0, size: 0, ids: new Set<string>(), requests: [] }
    logs.set(path, log)

    if (size < log.offset) {
      // Rewritten from the start: read it afresh.
      Object.assign(log, { offset: 0, ids: new Set<string>(), requests: [] })
    }

    while (log.offset < size) {
      const text = await readFrom(path, log.offset)
      const end = text?.lastIndexOf('\n') ?? -1

      if (text === null || end < 0) {
        break
      }

      for (const line of text.slice(0, end).split('\n')) {
        const parsed = parseLogLine(line)
        if (parsed && !log.ids.has(parsed.id)) {
          log.ids.add(parsed.id)
          log.requests.push(parsed.request)
        }
      }
      // Only whole lines are taken; a line still being written waits for the next pass.
      log.offset += encoder.encode(text.slice(0, end + 1)).length
    }
    log.size = size
  }

  /** Brings every log changed since `after` up to date; false when the logs cannot be listed. */
  const refresh = async (after: number): Promise<boolean> => {
    try {
      for (const project of await $.fs.list(projectsDir)) {
        if (project.kind !== 'dir') {
          continue
        }

        const dir = `${projectsDir}/${project.name}`
        for (const entry of await $.fs.list(dir)) {
          if (entry.name.startsWith(ownId)) {
            continue
          }
          if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.mtimeMs >= after) {
            await readLog(`${dir}/${entry.name}`, entry.size)
          }
          // A folder's own time does not move when a subagent log in it grows: check each log's.
          if (entry.kind === 'dir') {
            const subagents = `${dir}/${entry.name}/subagents`
            if (await $.fs.exists(subagents)) {
              for (const log of await $.fs.list(subagents)) {
                if (log.kind === 'file' && log.name.endsWith('.jsonl') && log.mtimeMs >= after) {
                  await readLog(`${subagents}/${log.name}`, log.size)
                }
              }
            }
          }
        }
      }

      return true
    } catch {
      return false
    }
  }

  /** What the other sessions' requests answered from `from` to `to` cost at the table's rates. */
  const costBetween = (models: Record<string, Price>, from: number, to: number): number => {
    let total = 0
    for (const log of logs.values()) {
      for (const request of log.requests) {
        if (request.at >= from && request.at <= to) {
          total += priceRequest(models, request.model, request) ?? 0
        }
      }
    }

    return total
  }

  /** Drops what no tick can ask about any more. */
  const forget = (before: number) => {
    for (const log of logs.values()) {
      log.requests = log.requests.filter(r => r.at >= before)
    }
  }

  return { refresh, costBetween, forget }
}
