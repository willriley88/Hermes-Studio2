import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMemoryVault,
  classifyTopics,
  safeFileName,
  writeMemoryVault,
} from '../server/memory-vault'
import { buildKnowledgeGraph, listKnowledgePages } from '../server/knowledge-browser'
import type { VaultInput } from '../server/memory-vault'

const roots: Array<string> = []
const savedKnowledgeDir = process.env.KNOWLEDGE_DIR

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedKnowledgeDir === undefined) delete process.env.KNOWLEDGE_DIR
  else process.env.KNOWLEDGE_DIR = savedKnowledgeDir
})

function sampleInput(): VaultInput {
  return {
    generatedAt: '2026-09-26T12:00:00.000Z',
    memoryFiles: [
      {
        path: 'memories/MEMORY.md',
        content: [
          'User prefers concise answers and a friendly tone.',
          'Studio project repo lives at ~/code/Hermes-Studio2.',
          'CORRECTION: do not restart the docker server without asking.',
        ].join('\n§\n'),
      },
      { path: 'memories/USER.md', content: 'Name is Will. Uses Obsidian for notes.' },
      { path: 'memory/2026-09-24.md', content: '# Notes\nWorked on [[vault]] sync.' },
      { path: 'memory/projects.md', content: 'Active project: Hermes Studio.' },
    ],
    contextFiles: [{ path: 'SOUL.md', content: 'You are Hermes.' }],
    sessions: [
      {
        id: 'sess_alpha_123456',
        title: 'Fix the login bug',
        source: 'cli',
        model: 'claude',
        startedAt: 1_758_700_000, // seconds
        messages: [
          { role: 'user', content: 'There is a bug in the login code, can you fix it?' },
          { role: 'tool', content: 'ignored tool output' },
          { role: 'assistant', content: 'Fixed the [[weird]] bug.' },
        ],
      },
      {
        id: 'cron_daily_digest',
        title: null,
        source: 'cron',
        startedAt: 1_758_786_400_000, // milliseconds
        parentSessionId: 'sess_alpha_123456',
        messages: [{ role: 'user', content: 'Summarize the daily news digest' }],
      },
      { id: 'empty', source: '', messages: [] },
    ],
  }
}

describe('classifyTopics', () => {
  it('ranks topics by keyword hits and falls back to General', () => {
    expect(classifyTopics('fix the bug in the typescript code')[0]).toBe('Code and Dev')
    expect(classifyTopics('nothing relevant here')).toEqual(['General'])
  })
})

describe('safeFileName', () => {
  it('removes characters Obsidian rejects in file names', () => {
    expect(safeFileName('a/b:c*d?"e<f>g|h#i^j[k]')).toBe('a b c d e f g h i j k')
    expect(safeFileName('   ')).toBe('Untitled')
  })
})

describe('buildMemoryVault', () => {
  it('produces the documented layout, all under Hermes/', () => {
    const notes = buildMemoryVault(sampleInput())
    const paths = notes.map((n) => n.path)
    expect(paths.every((p) => p.startsWith('Hermes/'))).toBe(true)
    expect(paths).toContain('Hermes/Home.md')
    expect(paths).toContain('Hermes/Memory/Agent Memory.md')
    expect(paths).toContain('Hermes/Memory/User Profile.md')
    expect(paths).toContain('Hermes/Memory/Corrections.md')
    expect(paths).toContain('Hermes/Memory/Notes/projects.md')
    expect(paths).toContain('Hermes/Context/SOUL.md')
    expect(paths).toContain('Hermes/Sessions/Sessions Index.md')
    expect(paths).toContain('Hermes/Sources/cli.md')
    expect(paths).toContain('Hermes/Sources/cron.md')
    expect(paths).toContain('Hermes/Sources/unknown.md')
    expect(paths).toContain('Hermes/Daily/2026-09-24.md')
    expect(paths.some((p) => p.startsWith('Hermes/Sessions/2025-09/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('Hermes/Sessions/Undated/'))).toBe(true)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('routes corrections, user facts and daily notes to the right notes', () => {
    const notes = buildMemoryVault(sampleInput())
    const byPath = new Map(notes.map((n) => [n.path, n.content]))
    expect(byPath.get('Hermes/Memory/Corrections.md')).toContain('do not restart the docker server')
    expect(byPath.get('Hermes/Memory/Agent Memory.md')).not.toContain('CORRECTION')
    expect(byPath.get('Hermes/Memory/User Profile.md')).toContain('Name is Will')
    expect(byPath.get('Hermes/Daily/2026-09-24.md')).toContain('Worked on')
  })

  it('keeps transcripts to user/assistant turns and neutralizes stray wikilinks', () => {
    const notes = buildMemoryVault(sampleInput())
    const session = notes.find((n) => n.content.includes('session_id: "sess_alpha_123456"'))
    expect(session).toBeDefined()
    expect(session!.content).not.toContain('ignored tool output')
    expect(session!.content).not.toContain('[[weird]]')
    expect(session!.content).toContain('generated_by: hermes-studio')
  })

  it('writes a vault where every wikilink resolves in Studio’s knowledge graph', () => {
    const vault = tempDir()
    const notes = buildMemoryVault(sampleInput())
    writeMemoryVault(vault, notes)
    process.env.KNOWLEDGE_DIR = vault

    const pages = listKnowledgePages()
    expect(pages.length).toBe(notes.length)
    const graph = buildKnowledgeGraph()
    const linkCount = pages.reduce((sum, page) => sum + page.wikilinks.length, 0)
    // Every distinct [[link]] on every page resolves to an edge.
    expect(graph.edges.length).toBe(linkCount)
    // The home note reaches the memory and topic hubs.
    const fromHome = graph.edges.filter((e) => e.source === 'Hermes/Home.md').map((e) => e.target)
    expect(fromHome).toContain('Hermes/Memory/Agent Memory.md')
    expect(fromHome).toContain('Hermes/Sessions/Sessions Index.md')
    // Frontmatter is parsed (title/type/tags) by the knowledge browser.
    const home = pages.find((p) => p.path === 'Hermes/Home.md')
    expect(home?.type).toBe('home')
    expect(home?.tags).toContain('hermes/index')
  })
})

describe('writeMemoryVault', () => {
  it('keeps hand-edited notes and removes stale generated ones', () => {
    const vault = tempDir()
    // A user note outside Hermes/ is never touched.
    writeFileSync(join(vault, 'My Note.md'), 'mine')
    // A hand-edited copy (marker removed) of a note the builder produces.
    mkdirSync(join(vault, 'Hermes/Memory'), { recursive: true })
    writeFileSync(join(vault, 'Hermes/Memory/User Profile.md'), '---\ntitle: mine\n---\nhand edited')
    // A stale generated note from an earlier sync.
    mkdirSync(join(vault, 'Hermes/Topics'), { recursive: true })
    writeFileSync(join(vault, 'Hermes/Topics/Old.md'), '---\ngenerated_by: hermes-studio\n---\nold')

    const result = writeMemoryVault(vault, buildMemoryVault(sampleInput()))

    expect(readFileSync(join(vault, 'My Note.md'), 'utf-8')).toBe('mine')
    expect(readFileSync(join(vault, 'Hermes/Memory/User Profile.md'), 'utf-8')).toContain('hand edited')
    expect(result.skipped).toContain('Hermes/Memory/User Profile.md')
    expect(existsSync(join(vault, 'Hermes/Topics/Old.md'))).toBe(false)
    expect(result.removed).toBe(1)
  })

  it('is idempotent across repeated syncs', () => {
    const vault = tempDir()
    const notes = buildMemoryVault(sampleInput())
    writeMemoryVault(vault, notes)
    const second = writeMemoryVault(vault, notes)
    expect(second.removed).toBe(0)
    expect(second.skipped).toEqual([])
    expect(second.written).toBe(notes.length)
  })
})
