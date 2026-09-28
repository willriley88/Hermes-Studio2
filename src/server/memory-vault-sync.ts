/**
 * memory-vault-sync.ts
 *
 * Gathers Hermes memory, context files and session history from this machine
 * and writes the organized vault (see memory-vault.ts) into the knowledge root.
 */
import { ensureGatewayProbed, getCapabilities } from './gateway-capabilities'
import { getMessages, listSessions } from './hermes-api'
import { getKnowledgeRoot } from './knowledge-browser'
import { getLocalMessages, listLocalSessions } from './local-session-store'
import { listMemoryFiles, readMemoryFile } from './memory-browser'
import {
  buildMemoryVault,
  readHermesContextFiles,
  writeMemoryVault,
} from './memory-vault'
import { writeVaultConfig } from './vault-config'
import type { VaultMemoryFile, VaultSession } from './memory-vault'
import type { HermesSession } from './hermes-api'

const PAGE_SIZE = 100
const FETCH_CONCURRENCY = 4

export type MemoryVaultSyncResult = {
  vaultRoot: string
  notes: number
  written: number
  removed: number
  skipped: Array<string>
  sessions: number
  memoryEntries: number
  sessionSource: 'hermes' | 'local' | 'none'
  warnings: Array<string>
}

async function mapLimit<T, TResult>(
  items: Array<T>,
  limit: number,
  fn: (item: T) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results: Array<TResult> = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  return results
}

async function loadHermesSessions(
  maxSessions: number,
  warnings: Array<string>,
): Promise<Array<VaultSession> | null> {
  await ensureGatewayProbed()
  if (!getCapabilities().sessions) return null

  const summaries: Array<HermesSession> = []
  try {
    for (let offset = 0; summaries.length < maxSessions; offset += PAGE_SIZE) {
      const page = await listSessions(PAGE_SIZE, offset)
      summaries.push(...page)
      if (page.length < PAGE_SIZE) break
    }
  } catch (err) {
    warnings.push(
      `Could not list Hermes sessions: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  return mapLimit(
    summaries.slice(0, maxSessions),
    FETCH_CONCURRENCY,
    async (summary) => {
      let messages: VaultSession['messages'] = []
      try {
        messages = (await getMessages(summary.id)).map((m) => ({
          role: m.role,
          content: m.content ?? '',
          timestamp: m.timestamp,
        }))
      } catch (err) {
        warnings.push(
          `Messages for ${summary.id} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return {
        id: summary.id,
        title: summary.title,
        source: summary.source,
        model: summary.model,
        startedAt: summary.started_at ?? summary.last_active ?? null,
        messageCount: summary.message_count ?? messages.length,
        parentSessionId: summary.parent_session_id,
        messages,
      }
    },
  )
}

function loadLocalSessions(maxSessions: number): Array<VaultSession> {
  return listLocalSessions()
    .slice(0, maxSessions)
    .map((session) => ({
      id: session.id,
      title: session.title,
      source: 'studio',
      model: session.model,
      startedAt: session.createdAt,
      messageCount: session.messageCount,
      messages: getLocalMessages(session.id).map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    }))
}

function loadMemoryFiles(warnings: Array<string>): Array<VaultMemoryFile> {
  const files: Array<VaultMemoryFile> = []
  for (const meta of listMemoryFiles()) {
    try {
      files.push({ path: meta.path, content: readMemoryFile(meta.path) })
    } catch (err) {
      warnings.push(
        `Could not read ${meta.path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return files
}

export async function syncMemoryVault(options?: {
  maxSessions?: number
}): Promise<MemoryVaultSyncResult> {
  const maxSessions = Math.max(1, Math.min(options?.maxSessions ?? 500, 5000))
  const warnings: Array<string> = []

  const memoryFiles = loadMemoryFiles(warnings)
  const contextFiles = readHermesContextFiles()

  let sessionSource: MemoryVaultSyncResult['sessionSource'] = 'none'
  let sessions = await loadHermesSessions(maxSessions, warnings)
  if (sessions) {
    sessionSource = 'hermes'
  } else {
    sessions = loadLocalSessions(maxSessions)
    if (sessions.length) sessionSource = 'local'
    warnings.push(
      'Hermes session API unavailable — used Studio’s local session history instead.',
    )
  }

  const notes = buildMemoryVault({
    memoryFiles,
    contextFiles,
    sessions,
    generatedAt: new Date().toISOString(),
  })

  const vaultRoot = getKnowledgeRoot()
  const result = writeMemoryVault(vaultRoot, notes)

  const memoryEntries = notes
    .filter((note) => note.path.includes('/Memory/') && !note.path.includes('/Notes/'))
    .reduce((count, note) => count + (note.content.match(/^- /gm)?.length ?? 0), 0)

  writeVaultConfig({
    lastSync: {
      at: new Date().toISOString(),
      notes: notes.length,
      sessions: sessions.length,
      memoryEntries,
      removed: result.removed,
    },
  })

  return {
    vaultRoot,
    notes: notes.length,
    written: result.written,
    removed: result.removed,
    skipped: result.skipped,
    sessions: sessions.length,
    memoryEntries,
    sessionSource,
    warnings: warnings.slice(0, 20),
  }
}
