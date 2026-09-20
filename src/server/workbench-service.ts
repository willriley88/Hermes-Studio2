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
import type { ConnectionId, WorkbenchState } from '../types/workbench'

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
}) {
  const store = getWorkbenchStore()

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

  if (store.activeRunCount() >= MAX_CONCURRENT_RUNS) {
    throw new Error(`At most ${MAX_CONCURRENT_RUNS} runs can be in flight at once.`)
  }
  if (
    connection.billing === 'local' &&
    store.activeRunCountForConnection(input.connectionId) >= MAX_CONCURRENT_LOCAL_RUNS
  ) {
    throw new Error('Only one local model run can be in flight at a time.')
  }

  // Read the selected source BEFORE creating the run so a bad selection fails fast.
  const files = collectContextFiles(project.path, input.files)
  if (files.length === 0) {
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
  })

  const prompt = buildAnalysisPrompt({
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
      })
      store.completeRun(run.id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        store.cancelRun(run.id)
      } else {
        store.failRun(run.id, message)
      }
    } finally {
      inFlight.delete(run.id)
    }
  })()

  return store.getRun(run.id)
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
