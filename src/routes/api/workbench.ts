/**
 * GET  /api/workbench — full workbench state (projects, tasks, runs, connections, roles)
 * POST /api/workbench — scan | project | task | task-status | run | cancel
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { getWorkbenchStore } from '../../server/workbench-store'
import {
  applyRunPatch,
  cancelRun,
  discardRunPatch,
  getWorkbenchState,
  scanProjects,
  startRun,
} from '../../server/workbench-service'
import type { ConnectionId, WorkbenchRunMode, WorkbenchTaskStatus } from '../../types/workbench'

const CONNECTION_IDS: ConnectionId[] = ['chatgpt', 'claude', 'ollama']
const USER_SETTABLE_STATUSES: WorkbenchTaskStatus[] = ['backlog', 'ready', 'done']

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const Route = createFileRoute('/api/workbench')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          return json(await getWorkbenchState())
        } catch (error) {
          return json({ error: (error as Error).message }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const action = str(body.action)
        const store = getWorkbenchStore()

        try {
          switch (action) {
            case 'scan': {
              return json({ ok: true, ...scanProjects() })
            }

            case 'project': {
              const name = str(body.name)
              const path = str(body.path)
              if (!name || !path) {
                return json({ error: 'name and path are required' }, { status: 400 })
              }
              if (store.findProjectByPath(path)) {
                return json({ error: 'That project is already registered.' }, { status: 409 })
              }
              return json({
                ok: true,
                project: store.createProject({ name, path, description: str(body.description) }),
              })
            }

            case 'task': {
              const projectId = str(body.projectId)
              const title = str(body.title)
              if (!projectId || !title) {
                return json({ error: 'projectId and title are required' }, { status: 400 })
              }
              return json({
                ok: true,
                task: store.createTask({
                  projectId,
                  title,
                  description: str(body.description),
                }),
              })
            }

            case 'task-status': {
              const taskId = str(body.taskId)
              const status = str(body.status) as WorkbenchTaskStatus
              if (!taskId || !USER_SETTABLE_STATUSES.includes(status)) {
                return json(
                  { error: 'taskId and a status of backlog, ready or done are required' },
                  { status: 400 },
                )
              }
              return json({ ok: true, task: store.setTaskStatus(taskId, status) })
            }

            case 'run': {
              const taskId = str(body.taskId)
              const connectionId = str(body.connectionId) as ConnectionId
              const model = str(body.model)
              const roleId = str(body.roleId)
              const files = Array.isArray(body.files)
                ? (body.files as unknown[]).filter((f): f is string => typeof f === 'string')
                : []

              if (!taskId || !CONNECTION_IDS.includes(connectionId) || !model || !roleId) {
                return json(
                  { error: 'taskId, connectionId, model and roleId are required' },
                  { status: 400 },
                )
              }
              const mode: WorkbenchRunMode = str(body.mode) === 'edit' ? 'edit' : 'analyze'
              return json({
                ok: true,
                run: await startRun({ taskId, connectionId, model, roleId, files, mode }),
              })
            }

            case 'apply-patch': {
              const runId = str(body.runId)
              if (!runId) return json({ error: 'runId is required' }, { status: 400 })
              return json({ ok: true, run: applyRunPatch(runId) })
            }

            case 'discard-patch': {
              const runId = str(body.runId)
              if (!runId) return json({ error: 'runId is required' }, { status: 400 })
              return json({ ok: true, run: discardRunPatch(runId) })
            }

            case 'cancel': {
              const runId = str(body.runId)
              if (!runId) return json({ error: 'runId is required' }, { status: 400 })
              return json({ ok: true, run: cancelRun(runId) })
            }

            default:
              return json({ error: `Unknown action: ${action || '(none)'}` }, { status: 400 })
          }
        } catch (error) {
          return json({ error: (error as Error).message }, { status: 400 })
        }
      },
    },
  },
})
