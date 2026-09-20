/**
 * Workbench context gathering.
 *
 * The model never touches the filesystem — this module is the ONLY way source
 * code reaches a run, and every path is validated before it is read.
 */

import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'

export const MAX_CONTEXT_FILES = 8
export const MAX_CONTEXT_CHARS = 60_000

/** The only tree Studio will look at. */
export function projectRoot(): string {
  return process.env.WORKBENCH_ROOT?.trim() || join(homedir(), 'projects')
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage',
  '.venv', 'venv', '__pycache__', '.runtime', 'vendor', 'target', '.turbo',
])

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css',
  '.scss', '.html', '.py', '.sql', '.yml', '.yaml', '.toml', '.sh', '.rs', '.go',
])

/** Filenames/patterns that may hold credentials — never sent to a model. */
const SECRET_PATTERNS = [
  /^\.env/i, /\.env$/i, /secrets?\./i, /credentials?/i, /\.pem$/i, /\.key$/i,
  /id_rsa/i, /id_ed25519/i, /\.p12$/i, /\.pfx$/i, /\.netrc$/i,
]

function isSecretPath(relPath: string): boolean {
  const name = basename(relPath)
  return SECRET_PATTERNS.some((pattern) => pattern.test(name) || pattern.test(relPath))
}

/** Resolve a path and guarantee it stays inside `root` (symlinks included). */
function safeResolve(root: string, relPath: string): string {
  if (isAbsolute(relPath) || relPath.includes('\0')) {
    throw new Error(`Invalid file path: ${relPath}`)
  }

  const canonicalRoot = realpathSync(root)
  const target = resolve(canonicalRoot, relPath)
  const rel = relative(canonicalRoot, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path is outside the project: ${relPath}`)
  }

  if (!existsSync(target)) throw new Error(`File not found: ${relPath}`)

  // lstat (not stat) so we catch the symlink itself.
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to read a symlink: ${relPath}`)
  }

  // Belt and braces: the realpath must also stay inside the root.
  const canonicalTarget = realpathSync(target)
  const canonicalRel = relative(canonicalRoot, canonicalTarget)
  if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
    throw new Error(`Path resolves outside the project: ${relPath}`)
  }

  return canonicalTarget
}

/** True when the buffer contains NUL bytes — a reliable binary signal. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_000).includes(0)
}

/**
 * List text files a user may choose from. Returns paths only — never content.
 * `root` must sit beneath the configured project root.
 */
export function listCandidateFiles(projectPath: string, allowedRoot = projectRoot()): string[] {
  const canonicalRoot = realpathSync(allowedRoot)
  const canonicalProject = realpathSync(projectPath)
  const rel = relative(canonicalRoot, canonicalProject)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Project is outside the configured project root.')
  }

  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || found.length >= 2_000) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 2_000) return
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relPath = relative(canonicalProject, full)
      if (isSecretPath(relPath)) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0 || !TEXT_EXTENSIONS.has(entry.name.slice(dot))) continue
      found.push(relPath)
    }
  }

  walk(canonicalProject, 0)
  return found.sort()
}

/** Read the explicitly selected files, enforcing every safety bound. */
export function collectContextFiles(
  projectPath: string,
  relPaths: string[],
): { path: string; content: string }[] {
  if (relPaths.length > MAX_CONTEXT_FILES) {
    throw new Error(`Select at most 8 files for one run (got ${relPaths.length}).`)
  }

  const files: { path: string; content: string }[] = []
  let total = 0

  for (const relPath of relPaths) {
    if (isSecretPath(relPath)) {
      throw new Error(`Refusing to send a possible secret file to a model: ${relPath}`)
    }

    const target = safeResolve(projectPath, relPath)
    const buffer = readFileSync(target)
    if (looksBinary(buffer)) {
      throw new Error(`Not a text file: ${relPath}`)
    }

    const content = buffer.toString('utf-8')
    total += content.length
    if (total > MAX_CONTEXT_CHARS) {
      throw new Error(
        `Selected files are too large (over the 60,000 character limit). Pick fewer files.`,
      )
    }
    files.push({ path: relPath, content })
  }

  return files
}

/** Discover direct child git repositories of the project root. */
export function discoverProjects(allowedRoot = projectRoot()): { name: string; path: string }[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(allowedRoot, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(allowedRoot, entry.name) }))
    // A project is a git repo. We only read the marker — never execute git.
    .filter((candidate) => existsSync(join(candidate.path, '.git')))
    .sort((a, b) => a.name.localeCompare(b.name))
}
