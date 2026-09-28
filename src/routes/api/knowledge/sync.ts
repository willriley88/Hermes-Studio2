import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { syncMemoryVault } from '../../../server/memory-vault-sync'
import { requireJsonContentType } from '../../../server/rate-limit'

export const Route = createFileRoute('/api/knowledge/sync')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as {
          maxSessions?: unknown
        }
        const maxSessions =
          typeof body.maxSessions === 'number' ? body.maxSessions : undefined

        try {
          return json({ ok: true, ...(await syncMemoryVault({ maxSessions })) })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error ? error.message : 'Memory sync failed',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
