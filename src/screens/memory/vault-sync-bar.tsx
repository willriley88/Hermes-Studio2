import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export type VaultStatus = {
  vaultRoot: string
  exists: boolean
  isObsidianVault: boolean
  obsidianVaultName: string
  configuredPath: string | null
  envPath: string | null
  lastSync: {
    at: string
    notes: number
    sessions: number
    memoryEntries: number
    removed: number
  } | null
}

type SyncResult = {
  ok: boolean
  error?: string
  notes?: number
  written?: number
  removed?: number
  skipped?: Array<string>
  sessions?: number
  sessionSource?: 'hermes' | 'local' | 'none'
  warnings?: Array<string>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

export function useVaultStatus() {
  return useQuery({
    queryKey: ['knowledge', 'vault'],
    queryFn: async () => {
      const response = await fetch('/api/knowledge/vault')
      if (!response.ok) throw new Error(`Vault status failed (${response.status})`)
      return (await response.json()) as VaultStatus
    },
  })
}

/** obsidian:// deep link for a page, when the vault is an Obsidian vault. */
export function obsidianUrl(
  status: VaultStatus | undefined,
  pagePath: string | null | undefined,
): string | null {
  if (!status?.isObsidianVault || !pagePath) return null
  return `obsidian://open?vault=${encodeURIComponent(status.obsidianVaultName)}&file=${encodeURIComponent(pagePath.replace(/\.md$/i, ''))}`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function VaultSyncBar() {
  const queryClient = useQueryClient()
  const statusQuery = useVaultStatus()
  const status = statusQuery.data
  const [editing, setEditing] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [lastResult, setLastResult] = useState<SyncResult | null>(null)

  const syncMutation = useMutation({
    mutationFn: () => postJson<SyncResult>('/api/knowledge/sync', {}),
    onSuccess: (result) => {
      setLastResult(result)
      void queryClient.invalidateQueries({ queryKey: ['knowledge'] })
    },
    onError: (error) =>
      setLastResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  })

  const pathMutation = useMutation({
    mutationFn: (vaultPath: string) =>
      postJson<VaultStatus>('/api/knowledge/vault', { vaultPath }),
    onSuccess: () => {
      setEditing(false)
      void queryClient.invalidateQueries({ queryKey: ['knowledge'] })
    },
  })

  const buttonClass =
    'inline-flex items-center gap-1.5 rounded-md border border-[var(--theme-border)] px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-[var(--theme-hover)] disabled:opacity-60'

  return (
    <div
      className="flex flex-col gap-2 px-3 py-2 text-xs md:px-4"
      style={{ borderBottom: '1px solid var(--theme-border)' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[var(--theme-text)]">Vault</span>
        <code className="max-w-full truncate rounded bg-[var(--theme-card)] px-1.5 py-0.5 text-[var(--theme-muted)]">
          {status?.vaultRoot ?? '…'}
        </code>
        {status ? (
          <span
            className="rounded-full px-2 py-0.5 font-medium"
            style={{
              border: '1px solid var(--theme-border)',
              color: status.isObsidianVault ? 'var(--theme-text)' : 'var(--theme-muted)',
            }}
          >
            {status.isObsidianVault
              ? 'Obsidian vault'
              : status.exists
                ? 'Plain folder (open it in Obsidian to link)'
                : 'Folder will be created on first sync'}
          </span>
        ) : null}
        {status?.lastSync ? (
          <span className="text-[var(--theme-muted)]">
            Last sync {formatWhen(status.lastSync.at)} · {status.lastSync.notes} notes ·{' '}
            {status.lastSync.sessions} sessions
          </span>
        ) : (
          <span className="text-[var(--theme-muted)]">Not synced yet</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setPathInput(status?.configuredPath ?? status?.vaultRoot ?? '')
              setEditing((value) => !value)
            }}
          >
            Change vault
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            {syncMutation.isPending ? 'Syncing…' : 'Sync from Hermes'}
          </button>
        </div>
      </div>

      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            pathMutation.mutate(pathInput)
          }}
        >
          <input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="~/Documents/Obsidian/MyVault"
            className="min-w-[240px] flex-1 rounded-md px-2 py-1 outline-none"
            style={{
              border: '1px solid var(--theme-border)',
              backgroundColor: 'var(--theme-card)',
              color: 'var(--theme-text)',
            }}
          />
          <button type="submit" className={buttonClass} disabled={pathMutation.isPending}>
            Save
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => pathMutation.mutate('')}
            title="Clear the override and use OBSIDIAN_VAULT_DIR / KNOWLEDGE_DIR / ~/.hermes/knowledge"
          >
            Use default
          </button>
          {pathMutation.error instanceof Error ? (
            <span className="text-red-500">{pathMutation.error.message}</span>
          ) : (
            <span className="text-[var(--theme-muted)]">
              Point this at your Obsidian vault folder. Hermes notes go in its <code>Hermes/</code> subfolder.
            </span>
          )}
        </form>
      ) : null}

      {lastResult ? (
        <div className={lastResult.ok ? 'text-[var(--theme-muted)]' : 'text-red-500'}>
          {lastResult.ok
            ? `Synced ${lastResult.notes} notes (${lastResult.written} written, ${lastResult.removed} removed) from ${lastResult.sessions} sessions via ${lastResult.sessionSource}.` +
              (lastResult.skipped?.length
                ? ` Kept ${lastResult.skipped.length} hand-edited notes.`
                : '') +
              (lastResult.warnings?.length ? ` ${lastResult.warnings[0]}` : '')
            : `Sync failed: ${lastResult.error}`}
        </div>
      ) : null}
    </div>
  )
}
