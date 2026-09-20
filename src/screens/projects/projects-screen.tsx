/**
 * Projects — the delegation cockpit.
 *
 * Every project, every task, and a run dispatcher where the runtime
 * (ChatGPT sub / Claude sub / local model) and the role are chosen
 * independently of each other.
 *
 * Runs are read-only: the model sees only the files selected here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConnectionId,
  WorkbenchRun,
  WorkbenchRunMode,
  WorkbenchState,
  WorkbenchTask,
} from '@/types/workbench'
import { CrewAutomationPanel } from './crew-automation-panel'

const EMPTY: WorkbenchState = {
  projects: [],
  tasks: [],
  runs: [],
  connections: [],
  roles: [],
  crews: [],
  members: [],
  schedules: [],
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'text-amber-400 border-amber-400/40 bg-amber-400/10',
  running: 'text-cyan-400 border-cyan-400/40 bg-cyan-400/10',
  completed: 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10',
  failed: 'text-red-400 border-red-400/40 bg-red-400/10',
  cancelled: 'text-zinc-400 border-zinc-400/40 bg-zinc-400/10',
  interrupted: 'text-orange-400 border-orange-400/40 bg-orange-400/10',
}

function isActive(run: WorkbenchRun): boolean {
  return run.status === 'queued' || run.status === 'running'
}

type ProjectsScreenProps = {
  initialProjectId?: string
  initialTaskId?: string
}

export function ProjectsScreen({ initialProjectId, initialTaskId }: ProjectsScreenProps = {}) {
  const [state, setState] = useState<WorkbenchState>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null)
  const [taskId, setTaskId] = useState<string | null>(initialTaskId ?? null)
  const [connectionId, setConnectionId] = useState<ConnectionId>('claude')
  const [model, setModel] = useState('')
  const [roleId, setRoleId] = useState('')
  const [candidateFiles, setCandidateFiles] = useState<string[]>([])
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [taskTitle, setTaskTitle] = useState('')
  const [mode, setMode] = useState<WorkbenchRunMode>('analyze')
  const reviewRef = useRef<HTMLElement | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/workbench')
      if (!response.ok) throw new Error(`Workbench API returned ${response.status}`)
      setState((await response.json()) as WorkbenchState)
      setError(null)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const activeRuns = state.runs.filter(isActive)

  // Poll only while something is actually running.
  useEffect(() => {
    if (activeRuns.length === 0) return
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => window.clearInterval(timer)
  }, [activeRuns.length, refresh])

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true)
      try {
        const response = await fetch('/api/workbench', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
        if (!response.ok) throw new Error(String(payload.error ?? `Request failed (${response.status})`))
        const failures = Array.isArray(payload.failures)
          ? payload.failures.filter(
              (entry): entry is { roleName: string; error: string } =>
                Boolean(entry) &&
                typeof entry === 'object' &&
                typeof (entry as { roleName?: unknown }).roleName === 'string' &&
                typeof (entry as { error?: unknown }).error === 'string',
            )
          : []
        setError(
          failures.length
            ? `Started the available seats, but ${failures.length} failed: ${failures
                .map((failure) => `${failure.roleName}: ${failure.error}`)
                .join('; ')}`
            : null,
        )
        await refresh()
        return payload
      } catch (caught) {
        setError((caught as Error).message)
        return null
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const selectedProject = state.projects.find((p) => p.id === projectId) ?? state.projects[0] ?? null
  const projectTasks = useMemo(
    () => state.tasks.filter((t) => t.projectId === selectedProject?.id),
    [state.tasks, selectedProject?.id],
  )
  const selectedTask: WorkbenchTask | null =
    projectTasks.find((t) => t.id === taskId) ?? projectTasks[0] ?? null

  const connection = state.connections.find((c) => c.id === connectionId) ?? null

  // Keep the model valid for whichever runtime is selected.
  useEffect(() => {
    if (!connection) return
    if (!connection.models.includes(model)) setModel(connection.models[0] ?? '')
  }, [connection, model])

  useEffect(() => {
    if (!roleId && state.roles.length > 0) setRoleId(state.roles[0].id)
  }, [state.roles, roleId])

  // Load the candidate file list for the selected project.
  useEffect(() => {
    if (!selectedProject) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/workbench-files?projectId=${encodeURIComponent(selectedProject.id)}`)
        const payload = (await response.json()) as { files?: string[]; error?: string }
        if (cancelled) return
        setCandidateFiles(Array.isArray(payload.files) ? payload.files : [])
        setSelectedFiles([])
      } catch {
        if (!cancelled) setCandidateFiles([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedProject?.id])

  const taskRuns = state.runs.filter((run) => run.taskId === selectedTask?.id)
  const runInFlight = taskRuns.find(isActive) ?? null

  useEffect(() => {
    if (!initialTaskId || selectedTask?.id !== initialTaskId || loading) return
    const frame = window.requestAnimationFrame(() =>
      reviewRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' }),
    )
    return () => window.cancelAnimationFrame(frame)
  }, [initialTaskId, loading, selectedTask?.id])

  const toggleFile = (path: string) => {
    setSelectedFiles((current) =>
      current.includes(path)
        ? current.filter((f) => f !== path)
        : current.length >= 8
          ? current
          : [...current, path],
    )
  }

  const canEdit = connectionId === 'chatgpt' || connectionId === 'claude'

  // Ollama can't edit — fall back to analysis rather than offering a lie.
  useEffect(() => {
    if (!canEdit && mode === 'edit') setMode('analyze')
  }, [canEdit, mode])

  const canRun =
    Boolean(selectedTask) &&
    Boolean(connection?.available) &&
    Boolean(model) &&
    Boolean(roleId) &&
    (mode === 'edit' || selectedFiles.length > 0) &&
    !runInFlight &&
    !busy

  if (loading) {
    return <div className="p-8 text-sm text-zinc-400">Loading workbench…</div>
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4 text-zinc-200 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Projects</h1>
          <p className="text-xs text-zinc-400">
            Pick a project, assign a role and runtime, or launch a standing crew mission.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void post({ action: 'scan' })}
          disabled={busy}
          className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-sm text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
        >
          Scan ~/projects
        </button>
      </header>

      {error ? (
        <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      <p className="rounded-md border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        Analysis runs only see the files you select. Edit runs work in isolated git worktrees and stop at a
        reviewable diff — nothing is applied automatically. Subscription runs use your ChatGPT/Claude plan
        allowance; Ollama stays local. Interrupted runs are marked and never replayed silently.
      </p>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
        {/* Projects rail */}
        <aside className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Projects</h2>
          {state.projects.length === 0 ? (
            <p className="px-2 py-3 text-xs text-zinc-500">
              No projects yet — hit “Scan ~/projects”.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {state.projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setProjectId(project.id)
                      setTaskId(null)
                    }}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition ${
                      selectedProject?.id === project.id
                        ? 'bg-cyan-500/15 text-cyan-300'
                        : 'text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Tasks */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {selectedProject ? `${selectedProject.name} — tasks` : 'Tasks'}
          </h2>

          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!selectedProject || !taskTitle.trim()) return
              void post({ action: 'task', projectId: selectedProject.id, title: taskTitle.trim() })
              setTaskTitle('')
            }}
          >
            <input
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="New task…"
              aria-label="New task title"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              type="submit"
              disabled={busy || !selectedProject}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Add
            </button>
          </form>

          {projectTasks.length === 0 ? (
            <p className="text-xs text-zinc-500">No tasks for this project yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {projectTasks.map((task) => {
                const runs = state.runs.filter((run) => run.taskId === task.id)
                const latest = runs[0] ?? null
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setTaskId(task.id)
                        window.requestAnimationFrame(() =>
                          reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                        )
                      }}
                      className={`w-full rounded-md border px-3 py-2 text-left transition ${
                        selectedTask?.id === task.id
                          ? 'border-cyan-500/40 bg-cyan-500/10'
                          : 'border-zinc-800 hover:bg-zinc-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-zinc-200">{task.title}</span>
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                          {task.status}
                        </span>
                      </div>
                      {latest ? (
                        <span
                          className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                            STATUS_STYLES[latest.status] ?? 'text-zinc-400 border-zinc-700'
                          }`}
                        >
                          {latest.status} · {latest.roleName} · {latest.model}
                        </span>
                      ) : null}
                      {runs.length > 0 ? (
                        <span className="mt-1 block text-[11px] text-cyan-400">
                          Review {runs.length} result{runs.length === 1 ? '' : 's'} →
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Dispatcher */}
        <aside className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Dispatch</h2>

          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            Mode
            <div className="flex gap-1" role="group" aria-label="Run mode">
              <button
                type="button"
                onClick={() => setMode('analyze')}
                aria-pressed={mode === 'analyze'}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition ${
                  mode === 'analyze'
                    ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                    : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800/60'
                }`}
              >
                Analyze
              </button>
              <button
                type="button"
                onClick={() => setMode('edit')}
                disabled={!canEdit}
                aria-pressed={mode === 'edit'}
                title={canEdit ? undefined : 'Local models have no tool loop, so they cannot edit files.'}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition disabled:opacity-40 ${
                  mode === 'edit'
                    ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                    : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800/60'
                }`}
              >
                Edit
              </button>
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-zinc-500">
            {mode === 'edit'
              ? 'Edits happen in an isolated git worktree. Your checkout is untouched until you apply the diff.'
              : 'Read-only. The model only sees the files you tick.'}
          </p>

          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Runtime
            <select
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value as ConnectionId)}
              className="rounded-md border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-sm text-zinc-200"
            >
              {state.connections.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={!entry.available}>
                  {entry.name}
                  {entry.available ? '' : ' — unavailable'}
                </option>
              ))}
            </select>
          </label>
          {connection ? <p className="-mt-1 text-[11px] text-zinc-500">{connection.detail}</p> : null}

          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Model
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-sm text-zinc-200"
            >
              {(connection?.models ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Role
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-sm text-zinc-200"
            >
              {state.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.emoji} {role.name} — {role.roleLabel}
                </option>
              ))}
            </select>
          </label>
          <a href="/agents" className="-mt-1 text-[11px] text-cyan-400 hover:underline">
            Edit roles in the Agent Library →
          </a>

          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            <span>
              {mode === 'edit'
                ? `Files to focus on (optional, ${selectedFiles.length}/8)`
                : `Files to analyse (${selectedFiles.length}/8)`}
            </span>
            <div className="max-h-48 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              {candidateFiles.length === 0 ? (
                <p className="text-[11px] text-zinc-600">No readable source files found.</p>
              ) : (
                candidateFiles.slice(0, 400).map((file) => (
                  <label key={file} className="flex items-center gap-2 py-0.5 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      checked={selectedFiles.includes(file)}
                      onChange={() => toggleFile(file)}
                    />
                    <span className="truncate">{file}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          {runInFlight ? (
            <button
              type="button"
              onClick={() => void post({ action: 'cancel', runId: runInFlight.id })}
              className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 hover:bg-red-500/20"
            >
              Cancel run
            </button>
          ) : (
            <button
              type="button"
              disabled={!canRun}
              onClick={() =>
                void post({
                  action: 'run',
                  taskId: selectedTask?.id,
                  connectionId,
                  model,
                  roleId,
                  files: selectedFiles,
                  mode,
                })
              }
              className={`rounded-md border px-3 py-2 text-sm disabled:opacity-40 ${
                mode === 'edit'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                  : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
              }`}
            >
              {mode === 'edit' ? 'Run edit' : 'Run analysis'}
            </button>
          )}
        </aside>
      </div>

      {/* Selected task review */}
      <section ref={reviewRef} className="scroll-mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Task review</h2>
            <p className="mt-1 text-sm text-zinc-200">
              {selectedTask?.title ?? 'Select a task to review its results'}
            </p>
          </div>
          {selectedTask?.status === 'review' ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void post({ action: 'task-status', taskId: selectedTask.id, status: 'ready' })}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Return to ready
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void post({ action: 'task-status', taskId: selectedTask.id, status: 'done' })}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                Mark done
              </button>
            </div>
          ) : selectedTask?.status === 'done' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ action: 'task-status', taskId: selectedTask.id, status: 'ready' })}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Reopen task
            </button>
          ) : null}
        </div>
        {taskRuns.length === 0 ? (
          <p className="text-xs text-zinc-500">No runs for this task yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {taskRuns.map((run) => (
              <li key={run.id} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`rounded border px-1.5 py-0.5 uppercase ${
                      STATUS_STYLES[run.status] ?? 'text-zinc-400 border-zinc-700'
                    }`}
                  >
                    {run.status}
                  </span>
                  <span className="text-zinc-400">
                    {run.roleName} · {run.actualModel ?? run.model} · {run.files.length} file(s)
                  </span>
                </div>
                {run.error ? (
                  <p className="mt-2 whitespace-pre-wrap text-xs text-red-300">{run.error}</p>
                ) : null}
                {run.output ? (
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-zinc-300">
                    {run.output}
                  </pre>
                ) : null}

                {run.mode === 'edit' && run.diff ? (
                  <div className="mt-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-zinc-400">
                        {run.filesChanged} file(s) changed
                      </span>
                      {run.patchState === 'applied' ? (
                        <span className="rounded border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] uppercase text-emerald-400">
                          applied to your checkout
                        </span>
                      ) : null}
                      {run.patchState === 'discarded' ? (
                        <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                          discarded
                        </span>
                      ) : null}
                      {run.patchState === 'pending' ? (
                        <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-400">
                          awaiting your review
                        </span>
                      ) : null}
                    </div>

                    <pre className="max-h-80 overflow-auto rounded-md border border-zinc-800 bg-black/40 p-2 text-[11px] leading-relaxed">
                      {run.diff.split('\n').map((line, index) => (
                        <div
                          key={index}
                          className={
                            line.startsWith('+') && !line.startsWith('+++')
                              ? 'text-emerald-400'
                              : line.startsWith('-') && !line.startsWith('---')
                                ? 'text-red-400'
                                : line.startsWith('@@')
                                  ? 'text-cyan-400'
                                  : 'text-zinc-500'
                          }
                        >
                          {line || ' '}
                        </div>
                      ))}
                    </pre>

                    {run.patchState === 'pending' ? (
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void post({ action: 'apply-patch', runId: run.id })}
                          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          Apply to my checkout
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void post({ action: 'discard-patch', runId: run.id })}
                          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          Discard
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CrewAutomationPanel
        state={state}
        projectId={selectedProject?.id ?? null}
        busy={busy}
        post={post}
      />
    </div>
  )
}
