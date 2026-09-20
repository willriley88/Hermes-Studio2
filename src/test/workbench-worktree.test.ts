import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyWorktree,
  buildEditPrompt,
  captureDiff,
  createRunWorktree,
  discardWorktree,
  editCapableConnections,
} from '../server/workbench-worktree'

const dirs: string[] = []

function repoWithCommit() {
  const root = mkdtempSync(join(tmpdir(), 'wt-repo-'))
  dirs.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@test.test')
  git('config', 'user.name', 'test')
  writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => a - b\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('edit capability', () => {
  it('allows only runtimes that actually have a tool-use loop', () => {
    // Ollama via /api/generate has no tool loop — it cannot edit files.
    expect(editCapableConnections()).toEqual(['chatgpt', 'claude'])
  })
})

describe('createRunWorktree', () => {
  it('creates an isolated worktree on its own branch without touching the checkout', () => {
    const root = repoWithCommit()
    const before = readFileSync(join(root, 'math.js'), 'utf-8')

    const wt = createRunWorktree(root, 'run1234')
    dirs.push(wt.path)

    expect(existsSync(join(wt.path, 'math.js'))).toBe(true)
    expect(wt.branch).toContain('run1234')

    // Editing inside the worktree must not change the user's working tree.
    writeFileSync(join(wt.path, 'math.js'), 'export const add = (a, b) => a + b\n')
    expect(readFileSync(join(root, 'math.js'), 'utf-8')).toBe(before)
  })

  it('refuses a directory that is not a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'wt-plain-'))
    dirs.push(plain)
    expect(() => createRunWorktree(plain, 'runX')).toThrow(/git repository/i)
  })
})

describe('captureDiff', () => {
  it('reports the edits made inside the worktree', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'run5678')
    dirs.push(wt.path)
    writeFileSync(join(wt.path, 'math.js'), 'export const add = (a, b) => a + b\n')

    const diff = captureDiff(wt.path)
    expect(diff.filesChanged).toBe(1)
    expect(diff.patch).toContain('-export const add = (a, b) => a - b')
    expect(diff.patch).toContain('+export const add = (a, b) => a + b')
  })

  it('reports zero changes when the model edited nothing', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'run9999')
    dirs.push(wt.path)
    expect(captureDiff(wt.path).filesChanged).toBe(0)
  })

  it('includes newly created files', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'runNew')
    dirs.push(wt.path)
    writeFileSync(join(wt.path, 'added.js'), 'export const x = 1\n')
    const diff = captureDiff(wt.path)
    expect(diff.filesChanged).toBe(1)
    expect(diff.patch).toContain('added.js')
  })
})

describe('applyWorktree', () => {
  it('refuses to apply when the target working tree is dirty', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'runDirty')
    dirs.push(wt.path)
    writeFileSync(join(wt.path, 'math.js'), 'export const add = (a, b) => a + b\n')

    // User has uncommitted work — applying could clobber it.
    writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => a * b\n')
    expect(() => applyWorktree(root, wt.path)).toThrow(/uncommitted|dirty/i)
  })

  it('applies the patch to the real checkout when it is clean', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'runClean')
    dirs.push(wt.path)
    writeFileSync(join(wt.path, 'math.js'), 'export const add = (a, b) => a + b\n')

    applyWorktree(root, wt.path)
    expect(readFileSync(join(root, 'math.js'), 'utf-8')).toContain('a + b')
  })

  it('refuses to apply an empty diff', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'runEmpty')
    dirs.push(wt.path)
    expect(() => applyWorktree(root, wt.path)).toThrow(/no changes/i)
  })
})

describe('discardWorktree', () => {
  it('removes the worktree and leaves the checkout untouched', () => {
    const root = repoWithCommit()
    const before = readFileSync(join(root, 'math.js'), 'utf-8')
    const wt = createRunWorktree(root, 'runDiscard')
    writeFileSync(join(wt.path, 'math.js'), 'export const add = (a, b) => a + b\n')

    discardWorktree(root, wt.path, wt.branch)
    expect(existsSync(wt.path)).toBe(false)
    expect(readFileSync(join(root, 'math.js'), 'utf-8')).toBe(before)
  })

  it('leaves no temp directory behind', () => {
    const root = repoWithCommit()
    const wt = createRunWorktree(root, 'runLeak')
    const parent = join(wt.path, '..')

    discardWorktree(root, wt.path, wt.branch)
    // The mkdtemp parent must go too, or /tmp fills up run after run.
    expect(existsSync(parent)).toBe(false)
  })
})

describe('buildEditPrompt', () => {
  const prompt = buildEditPrompt({
    rolePrompt: 'You are Kai, a Full-Stack Engineer.',
    taskTitle: 'Fix the adder',
    taskDescription: 'add() subtracts',
    files: ['math.js'],
  })

  it('carries the role and the task', () => {
    expect(prompt).toContain('You are Kai, a Full-Stack Engineer.')
    expect(prompt).toContain('Fix the adder')
  })

  it('tells the model it may edit, and scopes it to the listed files', () => {
    expect(prompt.toLowerCase()).toMatch(/edit/)
    expect(prompt).toContain('math.js')
  })

  it('forbids committing, pushing and destructive git operations', () => {
    expect(prompt.toLowerCase()).toMatch(/do not (commit|run git)/)
  })
})
