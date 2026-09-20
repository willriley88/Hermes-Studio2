/**
 * Landlock sandbox tests — these exercise the REAL compiled launcher against
 * the REAL kernel. If the sandbox does not actually confine writes, these fail.
 *
 * Skipped automatically on non-Linux or a kernel without Landlock ABI >= 3,
 * because there is nothing meaningful to assert there.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSandboxLauncher, sandboxAvailable, wrapSandboxed } from '../server/workbench-sandbox'

const dirs: string[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const usable = sandboxAvailable()
const onLinux = usable ? describe : describe.skip

describe('wrapSandboxed', () => {
  it('leaves analysis runs completely alone', () => {
    const wrapped = wrapSandboxed('claude', ['-p'], { launcher: '/x/sandbox', allow: [] })
    expect(wrapped).toEqual({ command: 'claude', args: ['-p'] })
  })

  it('puts every allowed root in front of the real command', () => {
    const wrapped = wrapSandboxed('hermes', ['chat', '--in', '/w'], {
      launcher: '/x/sandbox',
      allow: ['/w', '/t'],
    })
    expect(wrapped.command).toBe('/x/sandbox')
    expect(wrapped.args).toEqual([
      '--allow', '/w', '--allow', '/t', '--', 'hermes', 'chat', '--in', '/w',
    ])
  })

  it('refuses a relative allow root rather than silently widening the sandbox', () => {
    expect(() =>
      wrapSandboxed('claude', [], { launcher: '/x/sandbox', allow: ['relative/path'] }),
    ).toThrow(/absolute/i)
  })

  it('refuses to allow the whole temp directory or the filesystem root', () => {
    for (const bad of ['/', tmpdir(), homedir()]) {
      expect(() => wrapSandboxed('claude', [], { launcher: '/x/sandbox', allow: [bad] })).toThrow(
        /too broad/i,
      )
    }
  })
})

onLinux('landlock launcher (real kernel enforcement)', () => {
  const launcher = usable ? buildSandboxLauncher() : ''

  function runProbe(script: string, allow: string[], env: Record<string, string>) {
    const dir = scratch('ll-script-')
    const path = join(dir, 'probe.sh')
    writeFileSync(path, script)
    const wrapped = wrapSandboxed('/bin/bash', [path], { launcher, allow })
    try {
      return {
        code: 0,
        out: execFileSync(wrapped.command, wrapped.args, {
          encoding: 'utf-8',
          env: { ...process.env, ...env },
          timeout: 30_000,
        }),
      }
    } catch (error) {
      const err = error as { status?: number; stdout?: string }
      return { code: err.status ?? -1, out: err.stdout ?? '' }
    }
  }

  it('compiles and reports a usable launcher', () => {
    expect(existsSync(launcher)).toBe(true)
  })

  it('allows writes inside the worktree but blocks every durable write outside it', () => {
    const allowed = scratch('ll-allowed-')
    const outside = scratch('ll-outside-')
    const precious = join(outside, 'precious.txt')
    writeFileSync(precious, 'user work')
    writeFileSync(join(outside, 'readme.txt'), 'readable')

    const { out } = runProbe(
      [
        'cat "$OUT/readme.txt" >/dev/null 2>&1 && echo read_outside=OK || echo read_outside=FAIL',
        'echo edited > "$ALLOW/new.txt" 2>/dev/null && echo write_inside=OK || echo write_inside=FAIL',
        'mkdir "$ALLOW/sub" 2>/dev/null && echo mkdir_inside=OK || echo mkdir_inside=FAIL',
        'echo pwned > "$OUT/evil.txt" 2>/dev/null && echo create_outside=ALLOWED || echo create_outside=DENIED',
        'echo pwned > "$OUT/precious.txt" 2>/dev/null && echo overwrite_outside=ALLOWED || echo overwrite_outside=DENIED',
        ': > "$OUT/precious.txt" 2>/dev/null && echo truncate_outside=ALLOWED || echo truncate_outside=DENIED',
        'rm -f "$OUT/precious.txt" 2>/dev/null && echo unlink_outside=ALLOWED || echo unlink_outside=DENIED',
        'echo x > "$HOME/hermes-sandbox-escape-probe" 2>/dev/null && echo write_home=ALLOWED || echo write_home=DENIED',
        'true',
      ].join('\n'),
      [allowed],
      { ALLOW: allowed, OUT: outside },
    )

    // The model must still be able to READ the repository and its config.
    expect(out).toContain('read_outside=OK')
    // ...and must be able to do real work in its own worktree.
    expect(out).toContain('write_inside=OK')
    expect(out).toContain('mkdir_inside=OK')
    // ...but nothing durable outside it.
    expect(out).toContain('create_outside=DENIED')
    expect(out).toContain('overwrite_outside=DENIED')
    expect(out).toContain('truncate_outside=DENIED')
    expect(out).toContain('unlink_outside=DENIED')
    expect(out).toContain('write_home=DENIED')

    // The strongest assertion: the user's file is byte-identical.
    expect(readFileSync(precious, 'utf-8')).toBe('user work')
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false)
    expect(existsSync(join(homedir(), 'hermes-sandbox-escape-probe'))).toBe(false)
  })

  it('confines a child process the CLI spawns, not just the CLI itself', () => {
    const allowed = scratch('ll-allowed-child-')
    const outside = scratch('ll-outside-child-')
    const { out } = runProbe(
      'bash -c \'echo pwned > "$OUT/via-child.txt"\' 2>/dev/null && echo child=ALLOWED || echo child=DENIED',
      [allowed],
      { ALLOW: allowed, OUT: outside },
    )
    expect(out).toContain('child=DENIED')
    expect(existsSync(join(outside, 'via-child.txt'))).toBe(false)
  })

  it('fails closed (125) instead of running unconfined when setup is impossible', () => {
    const allowed = scratch('ll-allowed-fail-')
    const sentinel = join(allowed, 'should-not-exist.txt')

    // A non-existent allow root must abort BEFORE the command runs.
    const wrapped = wrapSandboxed('/bin/bash', ['-c', `echo x > ${sentinel}`], {
      launcher,
      allow: [join(allowed, 'nope-not-here')],
    })
    let code = 0
    try {
      execFileSync(wrapped.command, wrapped.args, { stdio: 'pipe', timeout: 30_000 })
    } catch (error) {
      code = (error as { status?: number }).status ?? -1
    }
    expect(code).toBe(125)
    expect(existsSync(sentinel)).toBe(false)
  })

  it('reports exec failure distinctly from sandbox failure', () => {
    const allowed = scratch('ll-allowed-exec-')
    let code = 0
    try {
      execFileSync(launcher, ['--allow', allowed, '--', '/nonexistent-binary-xyz'], {
        stdio: 'pipe',
        timeout: 30_000,
      })
    } catch (error) {
      code = (error as { status?: number }).status ?? -1
    }
    expect(code).toBe(127)
  })
})
