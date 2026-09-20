import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchStore } from '../server/workbench-store'
import {
  buildCrewAssignments,
  dueSchedules,
  nextRunAt,
  parseSchedule,
  selectCrewContextFiles,
} from '../server/workbench-crew'

const roots: string[] = []
const stores: WorkbenchStore[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-store-'))
  roots.push(root)
  const store = new WorkbenchStore(join(root, 'wb.sqlite'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('crew persistence', () => {
  it('binds a crew to a project so members know where the code is', () => {
    const store = fixture()
    const project = store.createProject({ name: 'clubhouse', path: '/home/willr/projects/clubhouse' })
    const crew = store.createCrew({
      name: 'Clubhouse',
      charter: 'Club tier for private golf clubs.',
      projectId: project.id,
    })
    expect(crew.projectId).toBe(project.id)
    expect(store.listCrews()[0].name).toBe('Clubhouse')
  })

  it('gives each member its own runtime, model and role', () => {
    const store = fixture()
    const project = store.createProject({ name: 'p', path: '/p' })
    const crew = store.createCrew({ name: 'C', charter: '', projectId: project.id })

    store.addCrewMember(crew.id, {
      roleId: 'builtin-nova', roleName: 'Nova',
      connectionId: 'claude', model: 'sonnet',
    })
    store.addCrewMember(crew.id, {
      roleId: 'builtin-luna', roleName: 'Luna',
      connectionId: 'ollama', model: 'qwen3:4b',
    })

    const members = store.listCrewMembers(crew.id)
    expect(members).toHaveLength(2)
    expect(members[0].connectionId).toBe('claude')
    expect(members[1].connectionId).toBe('ollama')
  })

  it('survives a reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-reopen-'))
    roots.push(root)
    const path = join(root, 'wb.sqlite')

    const first = new WorkbenchStore(path)
    const project = first.createProject({ name: 'p', path: '/p' })
    const crew = first.createCrew({ name: 'Persisted', charter: 'x', projectId: project.id })
    first.addCrewMember(crew.id, {
      roleId: 'r', roleName: 'R', connectionId: 'claude', model: 'haiku',
    })
    first.close()

    const second = new WorkbenchStore(path)
    stores.push(second)
    expect(second.listCrews()[0].name).toBe('Persisted')
    expect(second.listCrewMembers(crew.id)).toHaveLength(1)
  })

  it('caps a crew at eight seats so the persistent queue stays bounded', () => {
    const store = fixture()
    const project = store.createProject({ name: 'p', path: '/p' })
    const crew = store.createCrew({ name: 'C', charter: '', projectId: project.id })
    for (let index = 0; index < 8; index += 1) {
      store.addCrewMember(crew.id, {
        roleId: `r${index}`, roleName: `R${index}`, connectionId: 'claude', model: 'haiku',
      })
    }
    expect(() => store.addCrewMember(crew.id, {
      roleId: 'r9', roleName: 'R9', connectionId: 'claude', model: 'haiku',
    })).toThrow(/eight|8|limit/i)
  })

  it('refuses a second seat for the same role, which dispatch would reject anyway', () => {
    const store = fixture()
    const project = store.createProject({ name: 'p', path: '/p' })
    const crew = store.createCrew({ name: 'C', charter: '', projectId: project.id })
    store.addCrewMember(crew.id, {
      roleId: 'builtin-kai', roleName: 'Kai', connectionId: 'claude', model: 'sonnet',
    })
    expect(() => store.addCrewMember(crew.id, {
      roleId: 'builtin-kai', roleName: 'Kai', connectionId: 'chatgpt', model: 'gpt-5.6-sol',
    })).toThrow(/already has a seat/i)
  })

  it('deletes members along with the crew', () => {
    const store = fixture()
    const project = store.createProject({ name: 'p', path: '/p' })
    const crew = store.createCrew({ name: 'C', charter: '', projectId: project.id })
    store.addCrewMember(crew.id, {
      roleId: 'r', roleName: 'R', connectionId: 'claude', model: 'haiku',
    })
    store.deleteCrew(crew.id)
    expect(store.listCrews()).toHaveLength(0)
    expect(store.listCrewMembers(crew.id)).toHaveLength(0)
  })
})

describe('buildCrewAssignments', () => {
  const members = [
    { id: 'm1', roleId: 'builtin-nova', roleName: 'Nova', connectionId: 'claude' as const, model: 'sonnet' },
    { id: 'm2', roleId: 'builtin-luna', roleName: 'Luna', connectionId: 'ollama' as const, model: 'qwen3:4b' },
  ]

  it('fans a task out to every member on its own runtime', () => {
    const assignments = buildCrewAssignments(members, { mode: 'analyze' })
    expect(assignments).toHaveLength(2)
    expect(assignments.map((a) => a.connectionId)).toEqual(['claude', 'ollama'])
  })

  it('skips members that cannot edit when the task is an edit task', () => {
    // Ollama has no tool loop — it must not be handed an edit assignment.
    const assignments = buildCrewAssignments(members, { mode: 'edit' })
    expect(assignments).toHaveLength(1)
    expect(assignments[0].roleName).toBe('Nova')
  })

  it('reports which members were skipped and why', () => {
    const { skipped } = buildCrewAssignments(members, { mode: 'edit', withReasons: true })
    expect(skipped[0].roleName).toBe('Luna')
    expect(skipped[0].reason).toMatch(/cannot edit|tool/i)
  })
  it('chooses project docs before arbitrary source for a context-free crew run', () => {
    const picked = selectCrewContextFiles([
      'app/page.tsx', 'package.json', 'README.md', 'lib/a.ts', 'CLAUDE.md',
    ])
    expect(picked.slice(0, 3)).toEqual(['CLAUDE.md', 'README.md', 'package.json'])
    expect(picked).toContain('app/page.tsx')
  })

  it('caps automatic context at eight files', () => {
    const picked = selectCrewContextFiles(Array.from({ length: 20 }, (_, index) => `src/${index}.ts`))
    expect(picked).toHaveLength(8)
  })
})

describe('schedule parsing', () => {
  it('accepts the presets', () => {
    expect(parseSchedule('hourly')).toBeTruthy()
    expect(parseSchedule('daily')).toBeTruthy()
    expect(parseSchedule('weekly')).toBeTruthy()
  })

  it('rejects anything else rather than silently never running', () => {
    expect(() => parseSchedule('whenever')).toThrow(/schedule/i)
  })

  it('computes the next run in the future', () => {
    const now = Date.parse('2026-09-20T10:00:00Z')
    expect(nextRunAt('hourly', now)).toBeGreaterThan(now)
    expect(nextRunAt('daily', now)).toBeGreaterThan(now)
  })
})

describe('dueSchedules', () => {
  const base = {
    id: 's1', crewId: 'c1', taskTemplate: 'Audit auth', mode: 'analyze' as const,
    files: [], enabled: true,
  }

  it('returns a schedule whose time has passed', () => {
    const now = Date.now()
    expect(dueSchedules([{ ...base, schedule: 'daily', nextRunAt: now - 1_000 }], now)).toHaveLength(1)
  })

  it('leaves future schedules alone', () => {
    const now = Date.now()
    expect(dueSchedules([{ ...base, schedule: 'daily', nextRunAt: now + 60_000 }], now)).toHaveLength(0)
  })

  it('never runs a disabled schedule', () => {
    const now = Date.now()
    expect(
      dueSchedules([{ ...base, schedule: 'daily', nextRunAt: now - 1_000, enabled: false }], now),
    ).toHaveLength(0)
  })
})
