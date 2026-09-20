/**
 * Worktree isolation for edit runs.
 *
 * A model that writes code never touches the user's checkout. Every edit run
 * gets its own `git worktree` on a throwaway branch; the user reviews the diff
 * and explicitly applies or discards it.
 *
 * All git calls use execFileSync with an argument array — never a shell string.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ConnectionId } from '../types/workbench'

const GIT_TIMEOUT_MS = 60_000

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Runtimes that can actually edit files.
 *
 * Ollama is driven through /api/generate, which has no tool-calling loop — it
 * can only produce text. Offering it as an editor would be a lie.
 */
export function editCapableConnections(): ConnectionId[] {
  return ['chatgpt', 'claude']
}

export function isEditCapable(connectionId: ConnectionId): boolean {
  return editCapableConnections().includes(connectionId)
}

function assertGitRepo(root: string): void {
  if (!existsSync(join(root, '.git'))) {
    throw new Error('Edit runs need a git repository — this project is not one.')
  }
}

/** Create an isolated worktree for a run, branched from the current HEAD. */
export function createRunWorktree(
  projectPath: string,
  runId: string,
): { path: string; branch: string } {
  assertGitRepo(projectPath)

  const short = runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'run'
  const branch = `hermes/run-${short}`
  const path = join(mkdtempSync(join(tmpdir(), 'hermes-wt-')), short)

  try {
    git(projectPath, ['worktree', 'add', '-q', '--detach', path])
    git(path, ['checkout', '-q', '-b', branch])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not create an isolated worktree: ${message}`)
  }

  return { path, branch }
}

/** Capture everything the model changed inside the worktree. */
export function captureDiff(worktreePath: string): { patch: string; filesChanged: number } {
  // Stage new files too, so untracked additions appear in the diff.
  git(worktreePath, ['add', '-A'])
  const patch = git(worktreePath, ['diff', '--cached'])
  const stat = git(worktreePath, ['diff', '--cached', '--name-only']).trim()
  const filesChanged = stat ? stat.split('\n').filter(Boolean).length : 0
  return { patch, filesChanged }
}

function isDirty(root: string): boolean {
  return git(root, ['status', '--porcelain']).trim().length > 0
}

/**
 * Apply the worktree's changes to the real checkout.
 * Refuses if the user has uncommitted work — we will not clobber it.
 */
export function applyWorktree(projectPath: string, worktreePath: string): { filesChanged: number } {
  assertGitRepo(projectPath)

  const { patch, filesChanged } = captureDiff(worktreePath)
  if (filesChanged === 0) {
    throw new Error('This run made no changes — there is nothing to apply.')
  }
  if (isDirty(projectPath)) {
    throw new Error(
      'Your working tree has uncommitted changes. Commit or stash them first so this patch cannot clobber your work.',
    )
  }

  try {
    execFileSync('git', ['-C', projectPath, 'apply', '--index', '-'], {
      input: patch,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`The patch did not apply cleanly: ${message}`)
  }

  return { filesChanged }
}

/** Remove the worktree and its branch. The checkout is never touched. */
export function discardWorktree(projectPath: string, worktreePath: string, branch: string | null): void {
  try {
    git(projectPath, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    rmSync(worktreePath, { recursive: true, force: true })
    try {
      git(projectPath, ['worktree', 'prune'])
    } catch {
      // best effort
    }
  }
  // createRunWorktree nests the worktree inside its own mkdtemp parent;
  // remove that too or /tmp slowly fills with empty directories.
  const parent = dirname(worktreePath)
  if (basename(parent).startsWith('hermes-wt-')) {
    rmSync(parent, { recursive: true, force: true })
  }
  if (branch) {
    try {
      git(projectPath, ['branch', '-D', branch])
    } catch {
      // branch may not exist — fine
    }
  }
}

/** Prompt for an edit run. The model works in the worktree, not the checkout. */
export function buildEditPrompt(input: {
  rolePrompt: string
  taskTitle: string
  taskDescription: string
  files: string[]
}): string {
  const scope = input.files.length
    ? `Focus on these files:\n${input.files.map((f) => `  - ${f}`).join('\n')}`
    : 'Find the relevant files yourself.'

  return `${input.rolePrompt}

You are working in an isolated git worktree — a scratch copy of the repository.
Edit files directly here. Your changes will be shown to the user as a diff for
review before they are applied anywhere real.

TASK: ${input.taskTitle}
${input.taskDescription ? `DETAILS: ${input.taskDescription}` : ''}

${scope}

Rules:
- Make the smallest change that does the job.
- Do not commit, do not run git commands, and do not push anything.
- Do not delete files you were not asked to remove.
- When you are done, briefly summarise what you changed and why.`
}
