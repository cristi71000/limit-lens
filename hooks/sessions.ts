import type { EngineInterface } from 'claude-code'

import type { Price, RequestUsage } from '../types'
import { priceRequest } from './pricing'

/** How much of a log one read takes; the rest is read on the next pass. */
const CHUNK_BYTES = 4_000_000

type Log = { offset: number; size: number }

/** One response from the logs, and the session it belongs to. */
type Response = { request: RequestUsage; owner: string }

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
 * Reads every Claude Code session's log on this machine, this session's own
 * included, a piece at a time: each log is read from where the last pass
 * stopped, so a long session is read once. A response is counted once however
 * many logs hold it (a conversation that moved to a new session leaves copies
 * behind), and belongs to this session (`ownId`) whenever one of its copies does.
 */
export function makeScanner($: EngineInterface, projectsDir: string, ownId: string) {
  const logs = new Map<string, Log>()
  const responses = new Map<string, Response>()
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

  /** Reads what the log added since the last pass; false when it could not be read. */
  const readLog = async (path: string, size: number, owner: string): Promise<boolean> => {
    const log = logs.get(path) ?? { offset: 0, size: 0 }
    logs.set(path, log)

    if (size < log.offset) {
      // Rewritten from the start: read it afresh.
      log.offset = 0
    }

    while (log.offset < size) {
      const text = await readFrom(path, log.offset)

      if (text === null) {
        return false
      }

      const end = text.lastIndexOf('\n')
      if (end < 0) {
        break
      }

      for (const line of text.slice(0, end).split('\n')) {
        const parsed = parseLogLine(line)
        const held = parsed && responses.get(parsed.id)
        if (parsed && (!held || (owner === ownId && held.owner !== ownId))) {
          responses.set(parsed.id, { request: parsed.request, owner })
        }
      }
      // Only whole lines are taken; a line still being written waits for the next pass.
      log.offset += encoder.encode(text.slice(0, end + 1)).length
    }
    log.size = size

    return true
  }

  /**
   * Brings every log changed since `after` up to date. False when the logs
   * could not all be read: then nobody's share can be told.
   */
  const refresh = async (after: number): Promise<boolean> => {
    try {
      let isWhole = true
      for (const project of await $.fs.list(projectsDir)) {
        if (project.kind !== 'dir') {
          continue
        }

        const dir = `${projectsDir}/${project.name}`
        for (const entry of await $.fs.list(dir)) {
          if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.mtimeMs >= after) {
            isWhole = (await readLog(`${dir}/${entry.name}`, entry.size, entry.name.replace(/\.jsonl$/, ''))) && isWhole
          }
          // A folder's own time does not move when a subagent log in it grows: check each log's.
          if (entry.kind === 'dir') {
            const subagents = `${dir}/${entry.name}/subagents`
            if (await $.fs.exists(subagents)) {
              for (const log of await $.fs.list(subagents)) {
                if (log.kind === 'file' && log.name.endsWith('.jsonl') && log.mtimeMs >= after) {
                  isWhole = (await readLog(`${subagents}/${log.name}`, log.size, entry.name)) && isWhole
                }
              }
            }
          }
        }
      }

      return isWhole
    } catch {
      return false
    }
  }

  /** What this session's responses since `from` cost, and every session's, at the table's rates. */
  const workSince = (models: Record<string, Price>, from: number): { own: number; all: number } => {
    let own = 0
    let all = 0
    for (const { request, owner } of responses.values()) {
      if (request.at >= from) {
        const cost = priceRequest(models, request.model, request) ?? 0
        all += cost
        own += owner === ownId ? cost : 0
      }
    }

    return { own, all }
  }

  /** Drops responses older than any window can ask about. */
  const forget = (before: number) => {
    for (const [id, { request }] of responses) {
      if (request.at < before) {
        responses.delete(id)
      }
    }
  }

  return { refresh, workSince, forget }
}
