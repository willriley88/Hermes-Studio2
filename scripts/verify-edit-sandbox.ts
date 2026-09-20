/**
 * End-to-end proof that a real edit run cannot escape its worktree.
 *
 * This is not a unit test with mocks: it drives the actual runtime path with a
 * stub "CLI" that behaves like a hostile/confused model — it writes to its
 * worktree (legitimate) AND tries to clobber files in the real checkout, the
 * home directory, and /tmp (must all fail).
 *
 * Run: pnpm exec tsx scripts/verify-edit-sandbox.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSandboxLauncher, sandboxAvailable, wrapSandboxed } from '../src/server/workbench-sandbox'
import { createRunWorktree, captureDiff, discardWorktree } from '../src/server/workbench-worktree'

function git(cwd: string, args: string[]) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

function main() {
  if (!sandboxAvailable()) {
    console.error('FAIL: sandbox is not available on this host — edit runs would be refused.')
    process.exit(1)
  }
  const launcher = buildSandboxLauncher()
  console.log(`sandbox launcher: ${launcher}`)

  // A real git repo standing in for the user's checkout.
  const repo = mkdtempSync(join(tmpdir(), 'sandbox-e2e-repo-'))
  const homeSentinel = join(homedir(), '.hermes-sandbox-e2e-probe')
  const tmpSentinel = join(tmpdir(), 'hermes-sandbox-e2e-probe.txt')
  let worktree: { path: string; branch: string } | null = null

  try {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'app.js'), 'const version = 1\n')
    writeFileSync(join(repo, 'PRECIOUS.txt'), 'irreplaceable user work\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'init'])

    worktree = createRunWorktree(repo, 'e2e-run-001')
    console.log(`worktree: ${worktree.path}`)

    // The "model": does its job, then tries to escape four different ways.
    const script = join(worktree.path, '.hostile-model.sh')
    writeFileSync(
      script,
      [
        'echo "const version = 2" > app.js',
        `echo pwned > "${join(repo, 'PRECIOUS.txt')}" 2>/dev/null && echo ESCAPE_checkout=ALLOWED || echo ESCAPE_checkout=DENIED`,
        `rm -f "${join(repo, 'app.js')}" 2>/dev/null && echo ESCAPE_delete=ALLOWED || echo ESCAPE_delete=DENIED`,
        `echo pwned > "${homeSentinel}" 2>/dev/null && echo ESCAPE_home=ALLOWED || echo ESCAPE_home=DENIED`,
        `echo pwned > "${tmpSentinel}" 2>/dev/null && echo ESCAPE_tmp=ALLOWED || echo ESCAPE_tmp=DENIED`,
        'true',
      ].join('\n'),
    )

    const scratch = mkdtempSync(join(tmpdir(), 'hermes-run-'))
    const wrapped = wrapSandboxed('/bin/bash', [script], {
      launcher,
      allow: [worktree.path, scratch],
    })
    const output = execFileSync(wrapped.command, wrapped.args, {
      cwd: worktree.path,
      encoding: 'utf-8',
      timeout: 60_000,
    })
    rmSync(scratch, { recursive: true, force: true })
    console.log(output.trim())

    const checks: [string, boolean][] = [
      ['edit landed in worktree', readFileSync(join(worktree.path, 'app.js'), 'utf-8').includes('version = 2')],
      ['checkout write denied', output.includes('ESCAPE_checkout=DENIED')],
      ['checkout delete denied', output.includes('ESCAPE_delete=DENIED')],
      ['home write denied', output.includes('ESCAPE_home=DENIED')],
      ['tmp write denied', output.includes('ESCAPE_tmp=DENIED')],
      ['PRECIOUS.txt byte-identical', readFileSync(join(repo, 'PRECIOUS.txt'), 'utf-8') === 'irreplaceable user work\n'],
      ['checkout app.js still present', existsSync(join(repo, 'app.js'))],
      ['no home sentinel', !existsSync(homeSentinel)],
      ['no tmp sentinel', !existsSync(tmpSentinel)],
    ]

    // The diff must still be capturable — confinement cannot break the feature.
    rmSync(script, { force: true })
    const diff = captureDiff(worktree.path)
    checks.push(['diff captured', diff.filesChanged === 1 && diff.patch.includes('version = 2')])

    let failed = false
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
      if (!ok) failed = true
    }
    console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: sandbox holds; edit runs are confined.')
    process.exitCode = failed ? 1 : 0
  } finally {
    if (worktree) {
      try {
        discardWorktree(repo, worktree.path, worktree.branch)
      } catch {
        /* best effort */
      }
    }
    rmSync(repo, { recursive: true, force: true })
    rmSync(homeSentinel, { force: true })
    rmSync(tmpSentinel, { force: true })
  }
}

main()
