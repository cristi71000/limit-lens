import type { FsEntry } from 'claude-code'

import type { Price, RequestUsage } from '../types'
import { priceRequest } from './pricing'

/** How much of a log one read takes; the rest is read on the next pass. */
const CHUNK_BYTES = 4_000_000

/**
 * Where a log has been read to. `isSkipping` while the reader is inside a row longer than one read:
 * such rows hold pasted or tool content, never a response's usage, so they are passed over whole.
 */
type Log = { offset: number; size: number; isSkipping: boolean }

/** One response from the logs, and the session it belongs to. */
type Response = { request: RequestUsage; owner: string }

/**
 * How the scanner reaches the logs: list a folder, check one exists, and read a
 * log from a byte offset on (the rest of the file, or null when it cannot be read).
 */
export type LogAccess = {
  list: (path: string) => Promise<FsEntry[]>
  exists: (path: string) => Promise<boolean>
  readFrom: (path: string, offset: number) => Promise<string | null>
}

/** What a session's log says about it: its title as last set, and the folder it runs in. */
export type SessionInfo = { title?: string; cwd?: string }

/** A session's work in a window, at the table's rates, with what its log says about it. */
export type SessionWork = SessionInfo & { owner: string; cost: number; isOwn: boolean }

/**
 * What a log line says about its session: a title the session was given
 * (`custom-title` rows), and the folder it runs in (`cwd`, on most rows).
 */
export const parseLogMeta = (line: string): SessionInfo | null => {
  if (!line.includes('"customTitle"') && !line.includes('"cwd"')) {
    return null
  }

  try {
    const row = JSON.parse(line) as { type?: string; customTitle?: unknown; cwd?: unknown }
    const title = row.type === 'custom-title' && typeof row.customTitle === 'string' ? row.customTitle : undefined
    const cwd = typeof row.cwd === 'string' ? row.cwd : undefined

    return title || cwd ? { title, cwd } : null
  } catch {
    return null
  }
}

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
export const makeScanner = (access: LogAccess, projectsDir: string, ownId: string) => {
  const logs = new Map<string, Log>()
  const responses = new Map<string, Response>()
  const infos = new Map<string, SessionInfo>()
  const encoder = new TextEncoder()

  /** The text from `offset` on, up to a chunk; null when the file cannot be read. */
  const readFrom = async (path: string, offset: number): Promise<string | null> => {
    try {
      const text = await access.readFrom(path, offset)

      return text === null ? null : text.slice(0, CHUNK_BYTES)
    } catch {
      return null
    }
  }

  /** Reads what the log added since the last pass; false when it could not be read. */
  const readLog = async (path: string, size: number, owner: string): Promise<boolean> => {
    const log = logs.get(path) ?? { offset: 0, size: 0, isSkipping: false }
    logs.set(path, log)

    if (size < log.offset) {
      // Rewritten from the start: read it afresh.
      log.offset = 0
      log.isSkipping = false
    }

    while (log.offset < size) {
      const text = await readFrom(path, log.offset)

      if (text === null) {
        return false
      }

      const read = encoder.encode(text).length
      if (read === 0) {
        break
      }
      // The read stopped short of the end the listing saw: the log goes on past it.
      const goesOn = log.offset + read < size

      // Inside an over-long row: pass over the rest of it, up to its newline.
      let from = 0
      if (log.isSkipping) {
        const stop = text.indexOf('\n')
        if (stop < 0) {
          // All of it is the over-long row: none of it needs reading again.
          log.offset += read
          if (!goesOn) {
            break
          }
          continue
        }
        from = stop + 1
        log.isSkipping = false
      }

      const end = text.lastIndexOf('\n')
      if (end < from) {
        // No whole row after `from`. One that starts later in this read is read again from its start.
        const head = encoder.encode(text.slice(0, from)).length
        if (head > 0) {
          log.offset += head
          if (goesOn) {
            continue
          }
          break
        }
        // One still being written waits for the next pass; one that fills a whole read is longer
        // than a read can take, and is passed over.
        if (!goesOn) {
          break
        }
        log.offset += read
        log.isSkipping = true
        continue
      }

      for (const line of text.slice(from, end).split('\n')) {
        // A subagent's log speaks for its session only through its responses; a folder is read once.
        const wantsMeta = !path.includes('/subagents/') && (line.includes('"custom-title"') || !infos.get(owner)?.cwd)
        const meta = wantsMeta ? parseLogMeta(line) : null
        if (meta) {
          const held = infos.get(owner) ?? {}
          infos.set(owner, { title: meta.title ?? held.title, cwd: held.cwd ?? meta.cwd })
        }

        const parsed = parseLogLine(line)
        const held = parsed && responses.get(parsed.id)
        if (parsed && (!held || (owner === ownId && held.owner !== ownId))) {
          responses.set(parsed.id, { request: parsed.request, owner })
        }
      }
      // Only whole rows are taken; a row still being written waits for the next pass.
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
      for (const project of await access.list(projectsDir)) {
        if (project.kind !== 'dir') {
          continue
        }

        const dir = `${projectsDir}/${project.name}`
        for (const entry of await access.list(dir)) {
          if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.mtimeMs >= after) {
            isWhole = (await readLog(`${dir}/${entry.name}`, entry.size, entry.name.replace(/\.jsonl$/, ''))) && isWhole
          }
          // A folder's own time does not move when a subagent log in it grows: check each log's.
          if (entry.kind === 'dir') {
            const subagents = `${dir}/${entry.name}/subagents`
            if (await access.exists(subagents)) {
              for (const log of await access.list(subagents)) {
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

  /** Each session's work since `from`, priciest first: this session's, and every other one on this machine. */
  const workBySession = (models: Record<string, Price>, from: number): SessionWork[] => {
    const costs = new Map<string, number>()
    for (const { request, owner } of responses.values()) {
      if (request.at >= from) {
        costs.set(owner, (costs.get(owner) ?? 0) + (priceRequest(models, request.model, request) ?? 0))
      }
    }

    return [...costs]
      .filter(([, cost]) => cost > 0)
      .map(([owner, cost]) => ({ owner, cost, isOwn: owner === ownId, ...infos.get(owner) }))
      .sort((a, b) => b.cost - a.cost)
  }

  /** Drops responses older than any window can ask about. */
  const forget = (before: number) => {
    for (const [id, { request }] of responses) {
      if (request.at < before) {
        responses.delete(id)
      }
    }
  }

  return { refresh, workSince, workBySession, forget }
}
