/**
 * Workbench store — durable SQLite persistence for projects, tasks and runs.
 *
 * Durability is the point: a browser refresh, a dropped websocket, or a server
 * restart must never lose a run. Anything that was running when the process
 * died becomes `interrupted` — it is never silently replayed.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ConnectionId,
  WorkbenchPatchState,
  WorkbenchProject,
  WorkbenchRun,
  WorkbenchRunMode,
  WorkbenchRunStatus,
  WorkbenchTask,
  WorkbenchTaskStatus,
} from '../types/workbench'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  createdAt   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  projectId   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'backlog',
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  taskId       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  projectId    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connectionId TEXT NOT NULL,
  model        TEXT NOT NULL,
  roleId       TEXT NOT NULL,
  roleName     TEXT NOT NULL,
  rolePrompt   TEXT NOT NULL,
  files        TEXT NOT NULL DEFAULT '[]',
  mode         TEXT NOT NULL DEFAULT 'analyze',
  status       TEXT NOT NULL DEFAULT 'queued',
  output       TEXT NOT NULL DEFAULT '',
  error        TEXT,
  actualModel  TEXT,
  worktreePath TEXT,
  branch       TEXT,
  diff         TEXT NOT NULL DEFAULT '',
  filesChanged INTEGER NOT NULL DEFAULT 0,
  patchState   TEXT NOT NULL DEFAULT 'none',
  createdAt    INTEGER NOT NULL,
  startedAt    INTEGER,
  finishedAt   INTEGER
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId);
`

/** Statuses that mean "this run is not finished". */
const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const

type RunRow = Omit<WorkbenchRun, 'files'> & { files: string }

export type CreateRunInput = {
  taskId: string
  projectId: string
  connectionId: ConnectionId
  model: string
  roleId: string
  roleName: string
  rolePrompt: string
  files: string[]
  mode?: WorkbenchRunMode
}

export function defaultStorePath(): string {
  return join(process.cwd(), '.runtime', 'workbench.sqlite')
}

export class WorkbenchStore {
  private db: Database.Database

  constructor(path: string = defaultStorePath()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** Additive migrations for databases created by an earlier version. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name),
    )
    const additions: [string, string][] = [
      ['mode', "TEXT NOT NULL DEFAULT 'analyze'"],
      ['worktreePath', 'TEXT'],
      ['branch', 'TEXT'],
      ['diff', "TEXT NOT NULL DEFAULT ''"],
      ['filesChanged', 'INTEGER NOT NULL DEFAULT 0'],
      ['patchState', "TEXT NOT NULL DEFAULT 'none'"],
    ]
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`)
      }
    }
  }

  close(): void {
    this.db.close()
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(input: { name: string; path: string; description?: string }): WorkbenchProject {
    const project: WorkbenchProject = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      description: input.description ?? '',
      createdAt: Date.now(),
    }
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, description, createdAt) VALUES (@id, @name, @path, @description, @createdAt)',
      )
      .run(project)
    return project
  }

  findProjectByPath(path: string): WorkbenchProject | null {
    return (
      (this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as WorkbenchProject) ?? null
    )
  }

  getProject(id: string): WorkbenchProject | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as WorkbenchProject) ?? null
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  createTask(input: { projectId: string; title: string; description?: string }): WorkbenchTask {
    if (!this.getProject(input.projectId)) {
      throw new Error('Unknown project.')
    }
    const now = Date.now()
    const task: WorkbenchTask = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      status: 'backlog',
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO tasks (id, projectId, title, description, status, createdAt, updatedAt)
         VALUES (@id, @projectId, @title, @description, @status, @createdAt, @updatedAt)`,
      )
      .run(task)
    return task
  }

  getTask(id: string): WorkbenchTask | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as WorkbenchTask) ?? null
  }

  setTaskStatus(id: string, status: WorkbenchTaskStatus): WorkbenchTask {
    const task = this.getTask(id)
    if (!task) throw new Error('Unknown task.')
    if (this.activeRunForTask(id)) {
      throw new Error('This task has a run in progress — cancel it before changing the status.')
    }
    this.db
      .prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?')
      .run(status, Date.now(), id)
    return this.getTask(id) as WorkbenchTask
  }

  private setTaskStatusInternal(id: string, status: WorkbenchTaskStatus): void {
    this.db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?').run(status, Date.now(), id)
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  private hydrate(row: RunRow): WorkbenchRun {
    let files: string[] = []
    try {
      const parsed = JSON.parse(row.files) as unknown
      if (Array.isArray(parsed)) files = parsed.filter((f): f is string => typeof f === 'string')
    } catch {
      files = []
    }
    return { ...row, files }
  }

  activeRunForTask(taskId: string): WorkbenchRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE taskId = ? AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`,
      )
      .get(taskId, ...ACTIVE_RUN_STATUSES) as RunRow | undefined
    return row ? this.hydrate(row) : null
  }

  activeRunCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`,
      )
      .get(...ACTIVE_RUN_STATUSES) as { n: number }
    return row.n
  }

  activeRunCountForConnection(connectionId: ConnectionId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE connectionId = ? AND status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`,
      )
      .get(connectionId, ...ACTIVE_RUN_STATUSES) as { n: number }
    return row.n
  }

  /**
   * Create a run. The duplicate check and the insert share one transaction so
   * two simultaneous dispatches cannot both claim the same task.
   */
  createRun(input: CreateRunInput): WorkbenchRun {
    const claim = this.db.transaction((payload: CreateRunInput): WorkbenchRun => {
      if (this.activeRunForTask(payload.taskId)) {
        throw new Error('This task already has a run in progress.')
      }
      const run: WorkbenchRun = {
        id: randomUUID(),
        taskId: payload.taskId,
        projectId: payload.projectId,
        connectionId: payload.connectionId,
        model: payload.model,
        roleId: payload.roleId,
        roleName: payload.roleName,
        rolePrompt: payload.rolePrompt,
        files: payload.files,
        mode: payload.mode ?? 'analyze',
        status: 'queued',
        output: '',
        error: null,
        actualModel: null,
        worktreePath: null,
        branch: null,
        diff: '',
        filesChanged: 0,
        patchState: 'none',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      this.db
        .prepare(
          `INSERT INTO runs (id, taskId, projectId, connectionId, model, roleId, roleName, rolePrompt,
                             files, mode, status, output, error, actualModel, worktreePath, branch,
                             diff, filesChanged, patchState, createdAt, startedAt, finishedAt)
           VALUES (@id, @taskId, @projectId, @connectionId, @model, @roleId, @roleName, @rolePrompt,
                   @files, @mode, @status, @output, @error, @actualModel, @worktreePath, @branch,
                   @diff, @filesChanged, @patchState, @createdAt, @startedAt, @finishedAt)`,
        )
        .run({ ...run, files: JSON.stringify(run.files) })
      return run
    })

    return claim(input)
  }

  getRun(id: string): WorkbenchRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? this.hydrate(row) : null
  }

  markRunning(id: string): void {
    const run = this.getRun(id)
    if (!run || run.status !== 'queued') return
    this.db.prepare('UPDATE runs SET status = ?, startedAt = ? WHERE id = ?').run('running', Date.now(), id)
    this.setTaskStatusInternal(run.taskId, 'running')
  }

  /**
   * Finish a run successfully. The task moves to `review`, NOT `done` —
   * a model producing a report is not the same as the work being accepted.
   */
  completeRun(id: string, result: { output: string; actualModel?: string }): void {
    const run = this.getRun(id)
    if (!run) return
    // A cancelled run stays cancelled even if the runtime answers late.
    if (run.status !== 'running' && run.status !== 'queued') return

    this.db
      .prepare('UPDATE runs SET status = ?, output = ?, actualModel = ?, finishedAt = ? WHERE id = ?')
      .run('completed', result.output, result.actualModel ?? null, Date.now(), id)
    this.setTaskStatusInternal(run.taskId, 'review')
  }

  failRun(id: string, message: string): void {
    const run = this.getRun(id)
    if (!run) return
    if (run.status === 'cancelled') return

    this.db
      .prepare('UPDATE runs SET status = ?, error = ?, finishedAt = ? WHERE id = ?')
      .run('failed', message, Date.now(), id)
    this.setTaskStatusInternal(run.taskId, 'ready')
  }

  cancelRun(id: string): void {
    const run = this.getRun(id)
    if (!run) return
    if (run.status === 'completed' || run.status === 'failed') return

    this.db
      .prepare('UPDATE runs SET status = ?, finishedAt = ? WHERE id = ?')
      .run('cancelled', Date.now(), id)
    this.setTaskStatusInternal(run.taskId, 'ready')
  }

  /**
   * Called on startup: anything still marked active belongs to a process that
   * no longer exists. Mark it interrupted so the user can decide to re-run.
   */
  recoverInterruptedRuns(): number {
    const stale = this.db
      .prepare(
        `SELECT id, taskId FROM runs WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => '?').join(',')})`,
      )
      .all(...ACTIVE_RUN_STATUSES) as { id: string; taskId: string }[]

    const recover = this.db.transaction(() => {
      for (const row of stale) {
        this.db
          .prepare('UPDATE runs SET status = ?, error = ?, finishedAt = ? WHERE id = ?')
          .run(
            'interrupted' satisfies WorkbenchRunStatus,
            'The server stopped while this run was in progress. Nothing was re-run automatically.',
            Date.now(),
            row.id,
          )
        this.setTaskStatusInternal(row.taskId, 'ready')
      }
    })
    recover()
    return stale.length
  }

  appendOutput(id: string, chunk: string): void {
    this.db.prepare('UPDATE runs SET output = output || ? WHERE id = ?').run(chunk, id)
  }

  /** Record the isolated worktree an edit run is using. */
  attachWorktree(id: string, worktreePath: string, branch: string): void {
    this.db
      .prepare('UPDATE runs SET worktreePath = ?, branch = ? WHERE id = ?')
      .run(worktreePath, branch, id)
  }

  /** Store the diff an edit run produced; pending means "awaiting your review". */
  recordDiff(id: string, patch: string, filesChanged: number): void {
    this.db
      .prepare('UPDATE runs SET diff = ?, filesChanged = ?, patchState = ? WHERE id = ?')
      .run(patch, filesChanged, filesChanged > 0 ? 'pending' : 'none', id)
  }

  setPatchState(id: string, state: WorkbenchPatchState): void {
    this.db.prepare('UPDATE runs SET patchState = ? WHERE id = ?').run(state, id)
  }

  /** Every edit run still holding a worktree — used to clean up on shutdown. */
  runsWithWorktrees(): WorkbenchRun[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE worktreePath IS NOT NULL AND worktreePath != ''")
      .all() as RunRow[]
    return rows.map((row) => this.hydrate(row))
  }

  // ─── Read model ────────────────────────────────────────────────────────────

  state(): { projects: WorkbenchProject[]; tasks: WorkbenchTask[]; runs: WorkbenchRun[] } {
    const projects = this.db
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as WorkbenchProject[]
    const tasks = this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all() as WorkbenchTask[]
    const runs = (this.db.prepare('SELECT * FROM runs ORDER BY createdAt DESC').all() as RunRow[]).map(
      (row) => this.hydrate(row),
    )
    return { projects, tasks, runs }
  }
}

let singleton: WorkbenchStore | null = null

export function getWorkbenchStore(): WorkbenchStore {
  if (!singleton) {
    singleton = new WorkbenchStore()
    // Reconcile crashed runs exactly once, at first use after startup.
    singleton.recoverInterruptedRuns()
  }
  return singleton
}
