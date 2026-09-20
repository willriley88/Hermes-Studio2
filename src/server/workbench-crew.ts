/**
 * Crew assignment and schedule arithmetic.
 *
 * A crew is a standing set of roles bound to one project, where each seat
 * carries its own runtime. Dispatching a crew task fans it out to every
 * member on the runtime that member is configured for.
 */
import type {
  ConnectionId,
  SchedulePreset,
  WorkbenchRunMode,
  WorkbenchSchedule,
} from '../types/workbench'

/** Runtimes with a real tool-use loop. Ollama's /api/generate has none. */
const EDIT_CAPABLE: ConnectionId[] = ['chatgpt', 'claude']

export function canEdit(connectionId: ConnectionId): boolean {
  return EDIT_CAPABLE.includes(connectionId)
}

const CONTEXT_PRIORITY = ['CLAUDE.md', 'AGENTS.md', 'README.md', 'package.json']

/** Pick useful high-level context when a crew mission did not name files. */
export function selectCrewContextFiles(candidates: string[], limit: number = 8): string[] {
  const picked: string[] = []
  for (const preferred of CONTEXT_PRIORITY) {
    const found = candidates.find((path) => path === preferred || path.endsWith(`/${preferred}`))
    if (found && !picked.includes(found)) picked.push(found)
  }
  for (const path of candidates) {
    if (picked.length >= limit) break
    if (!picked.includes(path)) picked.push(path)
  }
  return picked.slice(0, limit)
}

type MemberLike = {
  id: string
  roleId: string
  roleName: string
  connectionId: ConnectionId
  model: string
}

export type CrewAssignment = MemberLike & { mode: WorkbenchRunMode }
export type SkippedMember = { roleName: string; reason: string }

/**
 * Expand a crew into one assignment per member.
 *
 * Members that cannot edit are dropped from edit tasks rather than being
 * handed work they will silently fail at.
 */
export function buildCrewAssignments(
  members: MemberLike[],
  options: { mode: WorkbenchRunMode; withReasons?: true },
): CrewAssignment[] & { skipped: SkippedMember[] } {
  const assignments: CrewAssignment[] = []
  const skipped: SkippedMember[] = []

  for (const member of members) {
    if (options.mode === 'edit' && !canEdit(member.connectionId)) {
      skipped.push({
        roleName: member.roleName,
        reason: `${member.connectionId} has no tool loop and cannot edit files`,
      })
      continue
    }
    assignments.push({ ...member, mode: options.mode })
  }

  // Callers read `.skipped` off the array so the common path stays a plain list.
  return Object.assign(assignments, { skipped })
}

const PRESETS: Record<SchedulePreset, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

export function parseSchedule(value: string): SchedulePreset {
  if (value in PRESETS) return value as SchedulePreset
  throw new Error(
    `Unknown schedule "${value}". Use one of: ${Object.keys(PRESETS).join(', ')}.`,
  )
}

export function nextRunAt(schedule: string, from: number = Date.now()): number {
  return from + PRESETS[parseSchedule(schedule)]
}

/** Schedules that are enabled and whose time has come. */
export function dueSchedules<T extends Pick<WorkbenchSchedule, 'enabled' | 'nextRunAt'>>(
  schedules: T[],
  now: number = Date.now(),
): T[] {
  return schedules.filter((s) => s.enabled && s.nextRunAt <= now)
}
