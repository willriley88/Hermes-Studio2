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
import type { ConnectionId, WorkbenchRunMode, WorkbenchState } from '../types/workbench'

const MAX_CONCURRENT_RUNS = 2
const MAX_CONCURRENT_LOCAL_RUNS = 1

/** In-flight abort controllers, keyed by run id. Lost on restart — by design. */
const inFlight = new Map<string, AbortController>()

export async function getWorkbenchState(): Promise<WorkbenchState> {
  const store = getWorkbenchStore()
  const { projects, tasks, runs } = store.state()
  return { projects, tasks, runs, connections: await listConnections(), roles: listAgents() }
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
  const connections = await listConnections()
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

  if (store.activeRunCount() >= MAX_CONCURRENT_RUNS) {
    throw new Error(`At most ${MAX_CONCURRENT_RUNS} runs can be in flight at once.`)
  }
  if (
    connection.billing === 'local' &&
    store.activeRunCountForConnection(input.connectionId) >= MAX_CONCURRENT_LOCAL_RUNS
  ) {
    throw new Error('Only one local model run can be in flight at a time.')
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

  let workdir: string | undefined
  if (mode === 'edit') {
    try {
      const worktree = createRunWorktree(project.path, run.id)
      workdir = worktree.path
      store.attachWorktree(run.id, worktree.path, worktree.branch)
    } catch (error) {
      store.failRun(run.id, (error as Error).message)
      throw error
    }
  }

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

  const controller = new AbortController()
  inFlight.set(run.id, controller)
  store.markRunning(run.id)

  void (async () => {
    try {
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
        } catch {
          // worktree may be gone — nothing to salvage
        }
      }
    } finally {
      inFlight.delete(run.id)
    }
  })()

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
  return store.getRun(runId)
}

export function cancelRun(runId: string) {
  const store = getWorkbenchStore()
  const run = store.getRun(runId)
  if (!run) throw new Error('Unknown run.')

  // Mark cancelled first so a late completion cannot overwrite it.
  store.cancelRun(runId)
  inFlight.get(runId)?.abort()
  inFlight.delete(runId)
  return store.getRun(runId)
}
