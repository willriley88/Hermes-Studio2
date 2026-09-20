/**
 * GET  /api/workbench — full workbench state (projects, tasks, runs, connections, roles)
 * POST /api/workbench — scan | project | task | task-status | run | cancel
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { requireLocalOrAuth } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { getWorkbenchStore } from '../../server/workbench-store'
import {
  addCrewMember,
  applyRunPatch,
  cancelRun,
  createSchedule,
  discardRunPatch,
  dispatchCrew,
  getWorkbenchState,
  runScheduleNow,
  scanProjects,
  startRun,
} from '../../server/workbench-service'
import { startScheduler } from '../../server/workbench-scheduler'
import type { ConnectionId, WorkbenchRunMode, WorkbenchTaskStatus } from '../../types/workbench'
const CONNECTION_IDS: ConnectionId[] = ['chatgpt', 'claude', 'ollama']
const USER_SETTABLE_STATUSES: WorkbenchTaskStatus[] = ['backlog', 'ready', 'done']

// Route modules load when the server boots; the unref'd timer survives without
// requiring somebody to open /projects after every restart.
startScheduler()

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function limited(value: unknown, max: number, label: string): string {
  const text = str(value)
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`)
  return text
}

function files(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('files must be an array.')
  if (value.length > 8) throw new Error('Select at most eight files.')
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('Every file must be a non-empty path.')
    const path = entry.trim().replaceAll('\\', '/')
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error('File paths must stay inside the project.')
    }
    return path
  })
}

export const Route = createFileRoute('/api/workbench')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          // Idempotent — ensures schedules resume firing after a server restart.
          startScheduler()
          return json(await getWorkbenchState())
        } catch (error) {
          return json({ error: (error as Error).message }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
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

            case 'crew': {
              const name = limited(body.name, 120, 'Crew name')
              const projectId = str(body.projectId)
              if (!name || !projectId) {
                return json({ error: 'name and projectId are required' }, { status: 400 })
              }
              return json({
                ok: true,
                crew: store.createCrew({
                  name,
                  projectId,
                  charter: limited(body.charter, 20_000, 'Crew charter'),
                }),
              })
            }

            case 'crew-update': {
              const crewId = str(body.crewId)
              if (!crewId) return json({ error: 'crewId is required' }, { status: 400 })
              store.updateCrew(crewId, {
                name: body.name === undefined ? undefined : limited(body.name, 120, 'Crew name'),
                charter:
                  body.charter === undefined
                    ? undefined
                    : limited(body.charter, 20_000, 'Crew charter'),
              })
              return json({ ok: true })
            }

            case 'crew-delete': {
              const crewId = str(body.crewId)
              if (!crewId) return json({ error: 'crewId is required' }, { status: 400 })
              store.deleteCrew(crewId)
              return json({ ok: true })
            }

            case 'member': {
              const crewId = str(body.crewId)
              const roleId = str(body.roleId)
              const connectionId = str(body.connectionId) as ConnectionId
              const model = str(body.model)
              if (!crewId || !roleId || !model || !CONNECTION_IDS.includes(connectionId)) {
                return json(
                  { error: 'crewId, roleId, connectionId and model are required' },
                  { status: 400 },
                )
              }
              return json({
                ok: true,
                member: await addCrewMember({ crewId, roleId, connectionId, model }),
              })
            }

            case 'member-remove': {
              const memberId = str(body.memberId)
              if (!memberId) return json({ error: 'memberId is required' }, { status: 400 })
              store.removeCrewMember(memberId)
              return json({ ok: true })
            }

            case 'crew-dispatch': {
              const crewId = str(body.crewId)
              const task = limited(body.task, 10_000, 'Task')
              if (!crewId || !task) {
                return json({ error: 'crewId and task are required' }, { status: 400 })
              }
              const mode: WorkbenchRunMode = body.mode === 'edit' ? 'edit' : 'analyze'
              const selectedFiles = files(body.files)
              const result = await dispatchCrew({ crewId, task, mode, files: selectedFiles })
              return json({ ok: true, ...result })
            }

            case 'schedule': {
              const crewId = str(body.crewId)
              const taskTemplate = limited(body.taskTemplate, 10_000, 'Scheduled task')
              const schedule = str(body.schedule)
              if (!crewId || !taskTemplate || !schedule) {
                return json(
                  { error: 'crewId, taskTemplate and schedule are required' },
                  { status: 400 },
                )
              }
              const created = createSchedule({
                crewId,
                taskTemplate,
                mode: body.mode === 'edit' ? 'edit' : 'analyze',
                files: files(body.files),
                schedule,
              })
              startScheduler()
              return json({ ok: true, schedule: created })
            }

            case 'schedule-toggle': {
              const scheduleId = str(body.scheduleId)
              if (!scheduleId) return json({ error: 'scheduleId is required' }, { status: 400 })
              store.setScheduleEnabled(scheduleId, body.enabled !== false)
              return json({ ok: true })
            }

            case 'schedule-run-now': {
              const scheduleId = str(body.scheduleId)
              if (!scheduleId) return json({ error: 'scheduleId is required' }, { status: 400 })
              return json({ ok: true, ...(await runScheduleNow(scheduleId)) })
            }

            case 'schedule-delete': {
              const scheduleId = str(body.scheduleId)
              if (!scheduleId) return json({ error: 'scheduleId is required' }, { status: 400 })
              store.deleteSchedule(scheduleId)
              return json({ ok: true })
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
              const selectedFiles = files(body.files)

              if (!taskId || !CONNECTION_IDS.includes(connectionId) || !model || !roleId) {
                return json(
                  { error: 'taskId, connectionId, model and roleId are required' },
                  { status: 400 },
                )
              }
              const mode: WorkbenchRunMode = str(body.mode) === 'edit' ? 'edit' : 'analyze'
              return json({
                ok: true,
                run: await startRun({ taskId, connectionId, model, roleId, files: selectedFiles, mode }),
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
