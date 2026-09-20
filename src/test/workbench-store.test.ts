import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { WorkbenchStore } from '../server/workbench-store'
import { collectContextFiles, listCandidateFiles } from '../server/workbench-context'

const roots: string[] = []
const stores: WorkbenchStore[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-store-'))
  roots.push(root)
  const path = join(root, 'workbench.sqlite')
  const store = new WorkbenchStore(path)
  stores.push(store)
  return { store, path }
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-repo-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkbenchStore', () => {
  it('persists projects and tasks across reopen using WAL and foreign keys', () => {
    const { store, path } = fixture()
    const project = store.createProject({ name: 'Studio', path: '/projects/studio', description: 'App' })
    const task = store.createTask({ projectId: project.id, title: 'Review API', description: 'Read only' })
    store.close()

    const reopened = new WorkbenchStore(path)
    stores.push(reopened)
    expect(reopened.state()).toEqual({ projects: [project], tasks: [task], runs: [] })
    expect(() => reopened.createTask({ projectId: 'missing', title: 'No', description: '' })).toThrow()

    const db = new Database(path)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })

  it('survives a refresh: a running run is still there when the store is reopened', () => {
    const { store, path } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const run = store.createRun({
      taskId: task.id,
      projectId: project.id,
      connectionId: 'claude',
      model: 'haiku',
      roleId: 'builtin-nova',
      roleName: 'Nova',
      rolePrompt: 'You are Nova.',
      files: ['a.ts'],
    })
    store.markRunning(run.id)
    store.close()

    const reopened = new WorkbenchStore(path)
    stores.push(reopened)
    const found = reopened.state().runs.find((r) => r.id === run.id)
    expect(found?.model).toBe('haiku')
    expect(found?.files).toEqual(['a.ts'])
  })

  it('marks orphaned runs interrupted on startup instead of silently re-running them', () => {
    const { store, path } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const run = store.createRun({
      taskId: task.id,
      projectId: project.id,
      connectionId: 'ollama',
      model: 'qwen3:4b',
      roleId: 'builtin-ada',
      roleName: 'Ada',
      rolePrompt: 'You are Ada.',
      files: [],
    })
    store.markRunning(run.id)
    store.close()

    const reopened = new WorkbenchStore(path)
    stores.push(reopened)
    reopened.recoverInterruptedRuns()
    expect(reopened.state().runs.find((r) => r.id === run.id)?.status).toBe('interrupted')
  })

  it('rejects a second concurrent run on the same task', () => {
    const { store } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const base = {
      taskId: task.id,
      projectId: project.id,
      connectionId: 'claude' as const,
      model: 'haiku',
      roleId: 'builtin-nova',
      roleName: 'Nova',
      rolePrompt: 'p',
      files: [],
    }
    store.createRun(base)
    expect(() => store.createRun(base)).toThrow(/already/i)
  })

  it('completing a run moves the task to review, never straight to done', () => {
    const { store } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const run = store.createRun({
      taskId: task.id,
      projectId: project.id,
      connectionId: 'claude',
      model: 'haiku',
      roleId: 'builtin-nova',
      roleName: 'Nova',
      rolePrompt: 'p',
      files: [],
    })
    store.markRunning(run.id)
    store.completeRun(run.id, { output: 'report', actualModel: 'claude-haiku-4-5' })

    const state = store.state()
    expect(state.runs[0].status).toBe('completed')
    expect(state.tasks[0].status).toBe('review')
    expect(state.tasks[0].status).not.toBe('done')
  })

  it('keeps a cancelled run cancelled even if a late completion arrives', () => {
    const { store } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const run = store.createRun({
      taskId: task.id,
      projectId: project.id,
      connectionId: 'ollama',
      model: 'qwen3:4b',
      roleId: 'builtin-ada',
      roleName: 'Ada',
      rolePrompt: 'p',
      files: [],
    })
    store.markRunning(run.id)
    store.cancelRun(run.id)
    store.completeRun(run.id, { output: 'late answer' })
    expect(store.state().runs[0].status).toBe('cancelled')
  })

  it('records a failure message rather than an empty success', () => {
    const { store } = fixture()
    const project = store.createProject({ name: 'P', path: '/p', description: '' })
    const task = store.createTask({ projectId: project.id, title: 'T', description: '' })
    const run = store.createRun({
      taskId: task.id,
      projectId: project.id,
      connectionId: 'chatgpt',
      model: 'gpt-5.6-sol',
      roleId: 'builtin-luna',
      roleName: 'Luna',
      rolePrompt: 'p',
      files: [],
    })
    store.failRun(run.id, 'Hermes exited with exit code 1')
    const stored = store.state().runs[0]
    expect(stored.status).toBe('failed')
    expect(stored.error).toMatch(/exit code 1/)
  })
})

describe('workbench context gathering', () => {
  it('refuses paths outside the configured project root', () => {
    const root = repo()
    expect(() => listCandidateFiles('/etc', root)).toThrow(/outside/i)
  })

  it('refuses a symlink that escapes the project', () => {
    const root = repo()
    const outside = mkdtempSync(join(tmpdir(), 'workbench-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    expect(() => collectContextFiles(root, ['link.txt'])).toThrow(/symlink|outside/i)
  })

  it('refuses traversal in a requested file path', () => {
    const root = repo()
    expect(() => collectContextFiles(root, ['../../etc/passwd'])).toThrow(/outside|invalid/i)
  })

  it('refuses secret-bearing files even when explicitly requested', () => {
    const root = repo()
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-real-secret')
    expect(() => collectContextFiles(root, ['.env'])).toThrow(/secret|not allowed/i)
  })

  it('refuses binary files', () => {
    const root = repo()
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    expect(() => collectContextFiles(root, ['logo.png'])).toThrow(/binary|text/i)
  })

  it('caps the number of files in one run', () => {
    const root = repo()
    const names: string[] = []
    for (let i = 0; i < 12; i += 1) {
      const name = `f${i}.ts`
      writeFileSync(join(root, name), 'const x = 1')
      names.push(name)
    }
    expect(() => collectContextFiles(root, names)).toThrow(/at most 8/i)
  })

  it('caps total characters so a huge file cannot blow the context', () => {
    const root = repo()
    writeFileSync(join(root, 'huge.ts'), 'x'.repeat(70_000))
    expect(() => collectContextFiles(root, ['huge.ts'])).toThrow(/too large|60/i)
  })

  it('reads an ordinary source file successfully', () => {
    const root = repo()
    writeFileSync(join(root, 'app.ts'), 'export const a = 1')
    expect(collectContextFiles(root, ['app.ts'])).toEqual([
      { path: 'app.ts', content: 'export const a = 1' },
    ])
  })
})
