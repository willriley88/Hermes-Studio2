/**
 * Workbench service — orchestrates a run: validate, snapshot source, dispatch
 * to the chosen runtime, and persist the outcome.
 *
 * Concurrency is bounded and there is no provider fallback anywhere.
 */

import { listAgents } from './agent-definitions-store'
import {
  collectContextFiles,
  discoverProjects,
  listCandidateFiles,
  projectRoot,
} from './workbench-context'
import { getWorkbenchStore } from './workbench-store'
import { buildAnalysisPrompt, executeAnalysis, listConnections } from './workbench-runtime'
import {
  applyWorktree,
  buildEditPrompt,
  captureDiff,
  createRunWorktree,
  discardWorktree,
  isEditCapable,
} from './workbench-worktree'
import {
  buildCrewAssignments,
  dueSchedules,
  nextRunAt,
  parseSchedule,
  selectCrewContextFiles,
} from './workbench-crew'
import { RunQueue } from './workbench-run-queue'
import { sandboxAvailable } from './workbench-sandbox'
import type {
  ConnectionId,
  WorkbenchConnection,
  WorkbenchCrewMember,
  WorkbenchRunMode,
  WorkbenchState,
} from '../types/workbench'

const runQueue = new RunQueue({ maxRunning: 4, maxLocal: 1, maxPending: 32 })

/** In-flight abort controllers, keyed by run id. Lost on restart — by design. */
const inFlight = new Map<string, AbortController>()

export async function getWorkbenchState(): Promise<WorkbenchState> {
  const store = getWorkbenchStore()
  const { projects, tasks, runs } = store.state()
  return {
    projects,
    tasks,
    runs,
    connections: await listConnections(),
    roles: listAgents(),
    crews: store.listCrews(),
    members: store.listAllCrewMembers(),
    schedules: store.listSchedules(),
  }
}

export async function addCrewMember(input: {
  crewId: string
  roleId: string
  connectionId: ConnectionId
  model: string
}): Promise<WorkbenchCrewMember> {
  const store = getWorkbenchStore()
  if (!store.getCrew(input.crewId)) throw new Error('Unknown crew.')
  const role = listAgents().find((agent) => agent.id === input.roleId)
  if (!role) throw new Error('Unknown role.')
  const connection = (await listConnections()).find((entry) => entry.id === input.connectionId)
  if (!connection?.available) {
    throw new Error(`${connection?.name ?? input.connectionId} is not available${connection?.detail ? `: ${connection.detail}` : '.'}`)
  }
  if (!connection.models.includes(input.model)) {
    throw new Error(`${connection.name} does not offer the model "${input.model}".`)
  }
  return store.addCrewMember(input.crewId, {
    roleId: role.id,
    roleName: role.name,
    connectionId: input.connectionId,
    model: input.model,
  })
}

function assignmentProblem(
  assignment: { roleId: string; connectionId: ConnectionId; model: string },
  connections: WorkbenchConnection[],
): string | null {
  const role = listAgents().find((agent) => agent.id === assignment.roleId)
  if (!role) return 'Unknown role.'
  const connection = connections.find((entry) => entry.id === assignment.connectionId)
  if (!connection) return 'Unknown connection.'
  if (!connection.available) return `${connection.name} is not available: ${connection.detail}`
  if (!connection.models.includes(assignment.model)) {
    return `${connection.name} does not offer the model "${assignment.model}".`
  }
  return null
}

/**
 * Dispatch one task to every member of a crew, each on its own runtime.
 *
 * The crew's charter is prepended to the task so every member carries the
 * standing project context without it being retyped each time.
 */
export async function dispatchCrew(input: {
  crewId: string
  task: string
  mode?: WorkbenchRunMode
  files?: string[]
}) {
  const store = getWorkbenchStore()
  const crew = store.getCrew(input.crewId)
  if (!crew) throw new Error('Unknown crew.')

  const task = input.task.trim()
  if (!task) throw new Error('A task is required.')

  const members = store.listCrewMembers(crew.id)
  if (members.length === 0) throw new Error('This crew has no members yet.')

  const mode = input.mode ?? 'analyze'
  const assignments = buildCrewAssignments(members, { mode })
  if (assignments.length === 0) {
    throw new Error(
      `No member of ${crew.name} can run an edit task. Add a Claude or ChatGPT seat.`,
    )
  }

  const project = store.getProject(crew.projectId)
  if (!project) throw new Error('The crew project no longer exists.')
  const files =
    mode === 'analyze' && (input.files?.length ?? 0) === 0
      ? selectCrewContextFiles(listCandidateFiles(project.path, projectRoot()))
      : input.files ?? []

  const connections = await listConnections()
  const failures: Array<{ roleName: string; error: string }> = []
  const validAssignments = assignments.filter((assignment) => {
    const problem = assignmentProblem(assignment, connections)
    if (problem) failures.push({ roleName: assignment.roleName, error: problem })
    return !problem
  })
  if (validAssignments.length === 0) {
    throw new Error(failures.map((failure) => `${failure.roleName}: ${failure.error}`).join('; '))
  }

  // One task record shared by the whole crew, so the runs group together.
  const record = store.createTask({
    projectId: crew.projectId,
    title: task,
    description: crew.charter,
  })

  const runs = []
  for (const assignment of validAssignments) {
    try {
      const run = await startRun({
        taskId: record.id,
        connectionId: assignment.connectionId,
        model: assignment.model,
        roleId: assignment.roleId,
        files,
        mode,
        connections,
      })
      runs.push(run)
    } catch (error) {
      failures.push({
        roleName: assignment.roleName,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (runs.length === 0) {
    store.deleteTaskIfNoUsableRuns(record.id)
    throw new Error(failures.map((failure) => `${failure.roleName}: ${failure.error}`).join('; '))
  }
  return { taskId: record.id, runs, skipped: assignments.skipped, failures }
}

/**
 * Run every schedule whose time has come.
 *
 * Scheduled edit runs stop at a pending diff — nothing is ever applied
 * to the user's checkout without a human looking at it first.
 */
export async function runDueSchedules(now: number = Date.now()) {
  const store = getWorkbenchStore()
  const due = dueSchedules(store.listSchedules(), now)
  const fired: string[] = []

  for (const schedule of due) {
    const next = nextRunAt(schedule.schedule, now)
    // Compare-and-swap the due timestamp before any async work. Another tick or
    // Studio process that saw the same row will lose this claim and do nothing.
    if (!store.claimSchedule(schedule.id, schedule.nextRunAt, now, next)) continue

    try {
      const crew = store.getCrew(schedule.crewId)
      if (!crew) throw new Error('The scheduled crew no longer exists.')
      if (schedule.mode === 'edit' && store.hasPendingPatchForProject(crew.projectId)) {
        throw new Error('A previous edit patch is still pending review; this occurrence was skipped.')
      }
      const result = await dispatchCrew({
        crewId: schedule.crewId,
        task: schedule.taskTemplate,
        mode: schedule.mode,
        files: schedule.files,
      })
      if (result.failures.length > 0) {
        store.setScheduleError(
          schedule.id,
          result.failures.map((failure) => `${failure.roleName}: ${failure.error}`).join('; '),
        )
      }
      fired.push(schedule.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.setScheduleError(schedule.id, message)
      console.error(`[workbench] schedule ${schedule.id} failed:`, error)
    }
  }

  return { fired }
}

export async function runScheduleNow(scheduleId: string, now: number = Date.now()) {
  const store = getWorkbenchStore()
  const schedule = store.listSchedules().find((item) => item.id === scheduleId)
  if (!schedule) throw new Error('Unknown schedule.')
  if (!schedule.enabled) throw new Error('Enable this schedule before running it.')
  if (!store.claimSchedule(schedule.id, schedule.nextRunAt, now, nextRunAt(schedule.schedule, now))) {
    throw new Error('This schedule was already claimed by another runner. Refresh and try again.')
  }
  try {
    const crew = store.getCrew(schedule.crewId)
    if (!crew) throw new Error('The scheduled crew no longer exists.')
    if (schedule.mode === 'edit' && store.hasPendingPatchForProject(crew.projectId)) {
      throw new Error('A previous edit patch is still pending review; apply or discard it first.')
    }
    const result = await dispatchCrew({
      crewId: schedule.crewId,
      task: schedule.taskTemplate,
      mode: schedule.mode,
      files: schedule.files,
    })
    store.setScheduleError(
      schedule.id,
      result.failures.length
        ? result.failures.map((failure) => `${failure.roleName}: ${failure.error}`).join('; ')
        : null,
    )
    return result
  } catch (error) {
    store.setScheduleError(schedule.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}

export function createSchedule(input: {
  crewId: string
  taskTemplate: string
  mode: WorkbenchRunMode
  files: string[]
  schedule: string
}) {
  const store = getWorkbenchStore()
  if (!store.getCrew(input.crewId)) throw new Error('Unknown crew.')
  const preset = parseSchedule(input.schedule)
  return store.createSchedule({
    crewId: input.crewId,
    taskTemplate: input.taskTemplate,
    mode: input.mode,
    files: input.files,
    schedule: preset,
    nextRunAt: nextRunAt(preset),
  })
}

export function scanProjects(): { added: number; total: number } {
  const store = getWorkbenchStore()
  const discovered = discoverProjects()
  let added = 0
  for (const candidate of discovered) {
    if (store.findProjectByPath(candidate.path)) continue
    store.createProject({ name: candidate.name, path: candidate.path, description: '' })
    added += 1
  }
  return { added, total: discovered.length }
}

export function listProjectFiles(projectId: string): string[] {
  const store = getWorkbenchStore()
  const project = store.getProject(projectId)
  if (!project) throw new Error('Unknown project.')
  return listCandidateFiles(project.path, projectRoot())
}

/**
 * Start an analysis run. Validates everything up front, then executes in the
 * background so the HTTP response returns immediately with the run record.
 */
export async function startRun(input: {
  taskId: string
  connectionId: ConnectionId
  model: string
  roleId: string
  files: string[]
  mode?: WorkbenchRunMode
  /** Internal dispatch cache; HTTP callers cannot provide it. */
  connections?: WorkbenchConnection[]
}) {
  const store = getWorkbenchStore()
  const mode: WorkbenchRunMode = input.mode === 'edit' ? 'edit' : 'analyze'

  const task = store.getTask(input.taskId)
  if (!task) throw new Error('Unknown task.')
  const project = store.getProject(task.projectId)
  if (!project) throw new Error('Unknown project.')

  const role = listAgents().find((agent) => agent.id === input.roleId)
  if (!role) throw new Error('Unknown role.')

  // The model must be one this connection actually advertises.
  const connections = input.connections ?? (await listConnections())
  const connection = connections.find((entry) => entry.id === input.connectionId)
  if (!connection) throw new Error('Unknown connection.')
  if (!connection.available) {
    throw new Error(`${connection.name} is not available: ${connection.detail}`)
  }
  if (!connection.models.includes(input.model)) {
    throw new Error(`${connection.name} does not offer the model "${input.model}".`)
  }
  if (mode === 'edit' && !isEditCapable(input.connectionId)) {
    throw new Error(
      `${connection.name} has no tool-use loop, so it cannot edit files. Use it for analysis, or pick ChatGPT or Claude.`,
    )
  }
  // Refuse an edit run rather than letting a model write unconfined.
  if (mode === 'edit' && !sandboxAvailable()) {
    throw new Error(
      'Edit runs are disabled: this host cannot enforce the write sandbox (Linux with Landlock ABI 3+ and gcc required). Analysis runs still work.',
    )
  }

  // Analysis runs paste source into the prompt; edit runs work in a worktree.
  const files = mode === 'analyze' ? collectContextFiles(project.path, input.files) : []
  if (mode === 'analyze' && files.length === 0) {
    throw new Error('Select at least one file for the model to analyse.')
  }

  const run = store.createRun({
    taskId: task.id,
    projectId: project.id,
    connectionId: input.connectionId,
    model: input.model,
    roleId: role.id,
    roleName: role.name,
    // Snapshot the prompt: editing the role later must not rewrite history.
    rolePrompt: role.systemPrompt,
    files: input.files,
    mode,
  })

  const prompt =
    mode === 'edit'
      ? buildEditPrompt({
          rolePrompt: role.systemPrompt,
          taskTitle: task.title,
          taskDescription: task.description,
          files: input.files,
        })
      : buildAnalysisPrompt({
          rolePrompt: role.systemPrompt,
          taskTitle: task.title,
          taskDescription: task.description,
          files,
        })

  try {
    runQueue.enqueue(run.id, input.connectionId, async () => {
      const controller = new AbortController()
      let workdir: string | undefined
      inFlight.set(run.id, controller)
      store.markRunning(run.id)
      if (store.getRun(run.id)?.status !== 'running') {
        inFlight.delete(run.id)
        return
      }

      try {
        if (mode === 'edit') {
          const worktree = createRunWorktree(project.path, run.id)
          workdir = worktree.path
          store.attachWorktree(run.id, worktree.path, worktree.branch)
        }

        const result = await executeAnalysis({
          connectionId: input.connectionId,
          model: input.model,
          prompt,
          signal: controller.signal,
          workdir,
          mode,
        })

        // For an edit run the diff is the deliverable — capture it before finishing.
        if (mode === 'edit' && workdir) {
          const diff = captureDiff(workdir)
          store.recordDiff(run.id, diff.patch, diff.filesChanged)
          if (diff.filesChanged === 0) {
            const current = store.getRun(run.id)
            discardWorktree(project.path, workdir, current?.branch ?? null)
            store.clearWorktree(run.id)
            store.setPatchState(run.id, 'discarded')
          }
          store.completeRun(run.id, {
            output:
              result.output ||
              (diff.filesChanged > 0
                ? `Edited ${diff.filesChanged} file(s). Review the diff below.`
                : 'The model reported no changes.'),
            actualModel: result.actualModel,
          })
        } else {
          store.completeRun(run.id, result)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (controller.signal.aborted) {
          store.cancelRun(run.id)
        } else {
          store.failRun(run.id, message)
        }
        // Salvage any partial work so a failed run is still reviewable.
        if (mode === 'edit' && workdir) {
          try {
            const diff = captureDiff(workdir)
            store.recordDiff(run.id, diff.patch, diff.filesChanged)
            if (diff.filesChanged === 0) {
              const current = store.getRun(run.id)
              discardWorktree(project.path, workdir, current?.branch ?? null)
              store.clearWorktree(run.id)
              store.setPatchState(run.id, 'discarded')
            }
          } catch {
            // worktree may be gone — nothing to salvage
          }
        }
      } finally {
        inFlight.delete(run.id)
      }
    })
  } catch (error) {
    store.failRun(run.id, error instanceof Error ? error.message : String(error))
    throw error
  }

  return store.getRun(run.id)
}

/** Apply a reviewed edit run's diff to the real checkout. */
export function applyRunPatch(runId: string) {
  const store = getWorkbenchStore()
  const run = store.getRun(runId)
  if (!run) throw new Error('Unknown run.')
  if (run.mode !== 'edit') throw new Error('Only edit runs produce a patch.')
  if (run.patchState === 'applied') throw new Error('This patch has already been applied.')
  if (run.patchState === 'discarded') throw new Error('This patch was discarded.')
  if (!run.worktreePath) throw new Error('This run has no worktree.')

  const project = store.getProject(run.projectId)
  if (!project) throw new Error('Unknown project.')

  applyWorktree(project.path, run.worktreePath)
  store.setPatchState(runId, 'applied')

  // The worktree has served its purpose.
  discardWorktree(project.path, run.worktreePath, run.branch)
  store.clearWorktree(runId)
  return store.getRun(runId)
}

/** Throw away an edit run's worktree without touching the checkout. */
export function discardRunPatch(runId: string) {
  const store = getWorkbenchStore()
  const run = store.getRun(runId)
  if (!run) throw new Error('Unknown run.')
  if (run.patchState === 'applied') throw new Error('This patch has already been applied.')

  const project = store.getProject(run.projectId)
  if (run.worktreePath && project) {
    discardWorktree(project.path, run.worktreePath, run.branch)
  }
  store.setPatchState(runId, 'discarded')
  store.clearWorktree(runId)
  return store.getRun(runId)
}

export function cancelRun(runId: string) {
  const store = getWorkbenchStore()
  const run = store.getRun(runId)
  if (!run) throw new Error('Unknown run.')

  // A queued run has no process yet. A running run owns an AbortController.
  const wasPending = runQueue.cancelPending(runId)
  store.cancelRun(runId)
  if (!wasPending) inFlight.get(runId)?.abort()
  inFlight.delete(runId)
  return store.getRun(runId)
}
