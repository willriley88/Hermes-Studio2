/**
 * Edit-run sandbox.
 *
 * An edit run hands a model real write tools and, on a schedule, does it with
 * nobody watching. A worktree `cwd` is not a boundary — an absolute path still
 * lands wherever the user can write. This module compiles and applies a Linux
 * Landlock launcher so durable writes are only possible beneath the run's own
 * worktree and temp directory.
 *
 * Fails closed: if the sandbox cannot be built or verified, edit runs are
 * refused rather than executed unconfined.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUILD_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']
/** The launcher exits with this before exec when it cannot enforce the policy. */
export const SANDBOX_SETUP_FAILURE = 125

function repoRoot(): string {
  // src/server/… → repo root. Falls back to cwd when bundled.
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  } catch {
    return process.cwd()
  }
}

function sourcePath(): string {
  const candidates = [
    join(repoRoot(), 'native', 'landlock-write-sandbox.c'),
    join(process.cwd(), 'native', 'landlock-write-sandbox.c'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error('The edit sandbox source (native/landlock-write-sandbox.c) is missing.')
  return found
}

/**
 * Roots that must never be handed to the sandbox as writable. Allowing any of
 * these would make the ruleset decorative.
 */
function tooBroad(path: string): boolean {
  const normalized = resolve(path).replace(/\/+$/, '')
  if (normalized === '' || normalized === '/') return true
  const forbidden = [tmpdir(), homedir(), '/home', '/usr', '/etc', '/var', process.cwd()]
  return forbidden.some((root) => resolve(root).replace(/\/+$/, '') === normalized)
}

export type SandboxOptions = {
  launcher: string
  /** Absolute, server-generated directories the run may write to. Empty = no sandbox. */
  allow: string[]
}

/**
 * Turn (command, args) into a sandboxed invocation.
 * An empty allow list means "not an edit run" and passes through untouched.
 */
export function wrapSandboxed(
  command: string,
  args: string[],
  options: SandboxOptions,
): { command: string; args: string[] } {
  if (options.allow.length === 0) return { command, args }

  const prefix: string[] = []
  for (const path of options.allow) {
    if (!path.startsWith('/')) {
      throw new Error(`Sandbox allow paths must be absolute: ${path}`)
    }
    if (tooBroad(path)) {
      throw new Error(`Sandbox allow path is too broad to be meaningful: ${path}`)
    }
    prefix.push('--allow', path)
  }
  return { command: options.launcher, args: [...prefix, '--', command, ...args] }
}

let cachedLauncher: string | null = null

/** Compile the launcher (content-hashed, so a source change rebuilds it). */
export function buildSandboxLauncher(): string {
  if (cachedLauncher && existsSync(cachedLauncher)) return cachedLauncher

  const source = sourcePath()
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16)
  const binDir = join(process.cwd(), '.runtime', 'bin')
  const target = join(binDir, `landlock-write-sandbox-${hash}`)
  mkdirSync(binDir, { recursive: true })

  if (!existsSync(target)) {
    // Build to a unique temp path, then rename — concurrent builders cannot
    // observe a half-written binary.
    const staging = mkdtempSync(join(tmpdir(), 'hermes-sandbox-build-'))
    const stagedBinary = join(staging, 'sandbox')
    try {
      execFileSync('gcc', [...BUILD_FLAGS, source, '-o', stagedBinary], {
        stdio: 'pipe',
        timeout: 120_000,
      })
      chmodSync(stagedBinary, 0o700)
      renameSync(stagedBinary, target)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not build the edit sandbox: ${detail}`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  // Prove it actually enforces on THIS kernel before trusting it.
  const probe = mkdtempSync(join(tmpdir(), 'hermes-sandbox-probe-'))
  try {
    execFileSync(target, ['--allow', probe, '--', '/bin/true'], { stdio: 'pipe', timeout: 30_000 })
  } catch (error) {
    const status = (error as { status?: number }).status
    throw new Error(
      status === SANDBOX_SETUP_FAILURE
        ? 'This kernel cannot enforce the edit sandbox (Landlock ABI 3+ required).'
        : `The edit sandbox failed its self-check: ${(error as Error).message}`,
    )
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }

  cachedLauncher = target
  return target
}

/** True when edit runs can be confined on this host. Never throws. */
export function sandboxAvailable(): boolean {
  if (process.platform !== 'linux') return false
  try {
    buildSandboxLauncher()
    return true
  } catch {
    return false
  }
}

/** Validate a server-generated directory before it becomes a writable root. */
export function assertSafeAllowRoot(path: string): string {
  const real = resolve(path)
  if (!existsSync(real) || !statSync(real).isDirectory()) {
    throw new Error(`Sandbox allow path is not a directory: ${real}`)
  }
  if (tooBroad(real)) throw new Error(`Sandbox allow path is too broad: ${real}`)
  return real
}
