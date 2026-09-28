/**
 * vault-config.ts
 *
 * Persists which folder Studio treats as the knowledge vault. Pointing this at
 * an Obsidian vault lets Studio's Knowledge tab and Obsidian share the same
 * notes: Studio reads/writes plain markdown with [[wikilinks]] and YAML
 * frontmatter, which Obsidian renders natively.
 *
 * Precedence for the vault root (see getKnowledgeRoot):
 *   1. vaultPath saved here from the UI
 *   2. OBSIDIAN_VAULT_DIR env
 *   3. KNOWLEDGE_DIR env
 *   4. ~/.hermes/knowledge, ~/knowledge/wiki
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type VaultConfig = {
  vaultPath?: string
  lastSync?: {
    at: string
    notes: number
    sessions: number
    memoryEntries: number
    removed: number
  }
}

const DATA_DIR = path.join(process.cwd(), '.runtime')
const CONFIG_FILE = path.join(DATA_DIR, 'vault-config.json')

export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

export function readVaultConfig(): VaultConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as VaultConfig) : {}
  } catch {
    return {}
  }
}

export function writeVaultConfig(patch: Partial<VaultConfig>): VaultConfig {
  const next = { ...readVaultConfig(), ...patch }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2))
  return next
}

/** Absolute vault path configured from the UI or env, if any. */
export function getConfiguredVaultPath(): string | null {
  const fromConfig = readVaultConfig().vaultPath?.trim()
  if (fromConfig) return path.resolve(expandHome(fromConfig))
  const fromEnv = process.env.OBSIDIAN_VAULT_DIR?.trim()
  if (fromEnv) return path.resolve(expandHome(fromEnv))
  return null
}

/** True when the folder has Obsidian's `.obsidian/` settings directory. */
export function isObsidianVault(root: string): boolean {
  try {
    return fs.statSync(path.join(root, '.obsidian')).isDirectory()
  } catch {
    return false
  }
}
