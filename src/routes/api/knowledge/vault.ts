import fs from 'node:fs'
import path from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { getKnowledgeRoot } from '../../../server/knowledge-browser'
import { requireJsonContentType } from '../../../server/rate-limit'
import {
  expandHome,
  isObsidianVault,
  readVaultConfig,
  writeVaultConfig,
} from '../../../server/vault-config'

function vaultStatus() {
  const root = getKnowledgeRoot()
  const config = readVaultConfig()
  return {
    vaultRoot: root,
    exists: fs.existsSync(root),
    isObsidianVault: isObsidianVault(root),
    obsidianVaultName: path.basename(root),
    configuredPath: config.vaultPath ?? null,
    envPath: process.env.OBSIDIAN_VAULT_DIR ?? null,
    lastSync: config.lastSync ?? null,
  }
}

export const Route = createFileRoute('/api/knowledge/vault')({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        return json(vaultStatus())
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as {
          vaultPath?: unknown
        }
        const raw = typeof body.vaultPath === 'string' ? body.vaultPath.trim() : ''

        if (!raw) {
          // Empty clears the override and falls back to env/defaults.
          writeVaultConfig({ vaultPath: undefined })
          return json(vaultStatus())
        }

        const resolved = path.resolve(expandHome(raw))
        if (!path.isAbsolute(expandHome(raw))) {
          return json(
            { error: 'Use an absolute path (or ~/…) to your vault folder' },
            { status: 400 },
          )
        }
        try {
          if (!fs.statSync(resolved).isDirectory()) {
            return json({ error: 'That path is not a folder' }, { status: 400 })
          }
        } catch {
          return json({ error: `Folder not found: ${resolved}` }, { status: 400 })
        }

        writeVaultConfig({ vaultPath: resolved })
        return json(vaultStatus())
      },
    },
  },
})
