/**
 * GET /api/workbench-files?projectId=... — candidate source files for a project.
 * Returns paths only, never file contents.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { listProjectFiles } from '../../server/workbench-service'

export const Route = createFileRoute('/api/workbench-files')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const projectId = new URL(request.url).searchParams.get('projectId')?.trim()
        if (!projectId) {
          return json({ error: 'projectId is required' }, { status: 400 })
        }
        try {
          return json({ files: listProjectFiles(projectId) })
        } catch (error) {
          return json({ error: (error as Error).message }, { status: 400 })
        }
      },
    },
  },
})
