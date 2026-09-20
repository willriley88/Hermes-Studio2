import type { AgentDefinition } from './agent'

export type ConnectionId = 'chatgpt' | 'claude' | 'ollama'
export type WorkbenchConnection = {
  id: ConnectionId
  name: string
  available: boolean
  detail: string
  billing: 'subscription' | 'local'
  models: string[]
}
export type WorkbenchProject = {
  id: string
  name: string
  path: string
  description: string
  createdAt: number
}
export type WorkbenchTaskStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done'
export type WorkbenchTask = {
  id: string
  projectId: string
  title: string
  description: string
  status: WorkbenchTaskStatus
  createdAt: number
  updatedAt: number
}
export type WorkbenchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** analyze = read-only report. edit = model may modify files in an isolated worktree. */
export type WorkbenchRunMode = 'analyze' | 'edit'
/** Lifecycle of the worktree branch produced by an edit run. */
export type WorkbenchPatchState = 'none' | 'pending' | 'applied' | 'discarded'
export type WorkbenchRun = {
  id: string
  taskId: string
  projectId: string
  connectionId: ConnectionId
  model: string
  roleId: string
  roleName: string
  rolePrompt: string
  files: string[]
  mode: WorkbenchRunMode
  status: WorkbenchRunStatus
  output: string
  error: string | null
  actualModel: string | null
  /** Populated for edit runs: isolated worktree, its branch, and the diff. */
  worktreePath: string | null
  branch: string | null
  diff: string
  filesChanged: number
  patchState: WorkbenchPatchState
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}
export type WorkbenchState = {
  projects: WorkbenchProject[]
  tasks: WorkbenchTask[]
  runs: WorkbenchRun[]
  connections: WorkbenchConnection[]
  roles: AgentDefinition[]
}
export type AnalysisInput = {
  connectionId: ConnectionId
  model: string
  prompt: string
  signal: AbortSignal
  onOutput?: (text: string) => void
  /** Present for edit runs: the isolated worktree the model may modify. */
  workdir?: string
  mode?: WorkbenchRunMode
}
export type AnalysisResult = {
  output: string
  actualModel?: string
  usage?: Record<string, number>
}
