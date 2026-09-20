import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWorktree, captureDiff, createRunWorktree, discardWorktree } from '../src/server/workbench-worktree.ts'

/**
 * Live check of the dirty-tree guard against a real repository.
 * Run with: pnpm exec tsx scripts/verify-dirty-guard.ts
 */
const root = mkdtempSync(join(tmpdir(), 'guard-'))
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' })

git('init', '-q')
git('config', 'user.email', 'test@test.test')
git('config', 'user.name', 'test')
writeFileSync(join(root, 'app.js'), 'export const value = 1\n')
git('add', '-A')
git('commit', '-qm', 'init')

const wt = createRunWorktree(root, 'guardcheck')
writeFileSync(join(wt.path, 'app.js'), 'export const value = 2\n')
console.log('diff files changed:', captureDiff(wt.path).filesChanged)

// Simulate the user having uncommitted work in their checkout.
const precious = 'export const value = 1\n// my unsaved work\n'
writeFileSync(join(root, 'app.js'), precious)

let refused = false
try {
  applyWorktree(root, wt.path)
} catch (error) {
  refused = true
  console.log('REFUSED:', (error as Error).message)
}

const after = readFileSync(join(root, 'app.js'), 'utf-8')
console.log('guard refused          :', refused)
console.log('uncommitted work intact:', after === precious)

discardWorktree(root, wt.path, wt.branch)
rmSync(root, { recursive: true, force: true })

if (!refused || after !== precious) {
  console.error('FAIL: the guard did not protect uncommitted work')
  process.exit(1)
}
console.log('PASS')
