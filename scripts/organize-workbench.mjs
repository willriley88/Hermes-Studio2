#!/usr/bin/env node
/**
 * Organize the workbench down to the projects that are actually active.
 *
 * Active: golf-db-product (revenue), clubhouse (maintenance), hermes-studio2
 * (the cockpit itself). Everything else is archived — Mission Control and
 * Control Center are dead by decision, the rest are demos or stalled work.
 *
 * Archives rather than deletes, for two reasons:
 *   1. Every directory under ~/projects is a git repo, so discoverProjects()
 *      re-adds anything deleted on the next scan. Archiving is the only
 *      removal that survives.
 *   2. Runs and tasks carry foreign keys to projects. Deleting a project
 *      cascades away its history; archiving keeps the audit trail intact.
 *
 * Also clears smoke-test tasks left in review ("reply with exactly
 * CREW_SCHEDULE_OK" and friends) so the review column shows real work.
 *
 * Usage:  node scripts/organize-workbench.mjs [--apply]
 */
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dbPath = join(here, '..', '.runtime', 'workbench.sqlite')
const apply = process.argv.includes('--apply')

const ACTIVE = new Set(['golf-db-product', 'clubhouse', 'hermes-studio2'])

// Tasks whose title matches these are agent smoke tests, not work.
const SMOKE_PATTERNS = [
  /reply with exactly/i,
  /^\s*smoke\b/i,
  /read package\.json and reply/i,
  /CREW_SCHEDULE_OK/,
  /^\s*ping\s*$/i,
]

const db = new Database(dbPath)

// The server applies this migration on boot; do it here too so the script can
// run against a database that has not been opened by the new build yet.
const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name))
if (!projectColumns.has('archived')) {
  if (apply) {
    db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
    console.log('migrated: added projects.archived')
  } else {
    console.log('would migrate: add projects.archived  (re-run with --apply)')
    console.log('\nNothing else can be planned until the column exists. Exiting.')
    process.exit(0)
  }
}

const projects = db.prepare('SELECT id, name, path, archived FROM projects ORDER BY name').all()

console.log(`=== projects (${apply ? 'APPLY' : 'DRY RUN'}) ===\n`)
let archivedCount = 0
let keptCount = 0

for (const project of projects) {
  const keep = ACTIVE.has(project.name)
  const counts = {
    crews: db.prepare('SELECT count(*) n FROM crews WHERE projectId = ?').get(project.id).n,
    tasks: db.prepare('SELECT count(*) n FROM tasks WHERE projectId = ?').get(project.id).n,
    runs: db.prepare('SELECT count(*) n FROM runs WHERE projectId = ?').get(project.id).n,
  }
  const detail = `crews=${counts.crews} tasks=${counts.tasks} runs=${counts.runs}`

  if (keep) {
    keptCount += 1
    console.log(`  KEEP     ${project.name.padEnd(22)} ${detail}`)
    if (project.archived && apply) {
      db.prepare('UPDATE projects SET archived = 0 WHERE id = ?').run(project.id)
      console.log(`           (un-archived)`)
    }
  } else {
    archivedCount += 1
    console.log(`  ARCHIVE  ${project.name.padEnd(22)} ${detail}`)
    if (apply) db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id)
  }
}

// ── Smoke-test tasks ────────────────────────────────────────────────────────
const openTasks = db
  .prepare("SELECT id, title, status FROM tasks WHERE status NOT IN ('done')")
  .all()
const smoke = openTasks.filter((t) => SMOKE_PATTERNS.some((p) => p.test(t.title)))

console.log(`\n=== smoke-test tasks in the board ===\n`)
if (!smoke.length) {
  console.log('  none')
} else {
  for (const task of smoke) {
    console.log(`  DONE     [${task.status}] ${task.title.slice(0, 70)}`)
    if (apply) {
      db.prepare("UPDATE tasks SET status = 'done', updatedAt = ? WHERE id = ?").run(
        Date.now(),
        task.id,
      )
    }
  }
}

// ── Crews on archived projects ──────────────────────────────────────────────
const orphanCrews = db
  .prepare(
    `SELECT c.id, c.name, p.name AS project FROM crews c
     JOIN projects p ON p.id = c.projectId
     WHERE p.archived = 1`,
  )
  .all()

console.log(`\n=== crews on archived projects ===\n`)
if (!orphanCrews.length) {
  console.log('  none')
} else {
  for (const crew of orphanCrews) {
    // Disable schedules so an archived project cannot burn subscription quota.
    const scheduleCount = db
      .prepare('SELECT count(*) n FROM schedules WHERE crewId = ? AND enabled = 1')
      .get(crew.id).n
    console.log(`  DISABLE  ${crew.project}/${crew.name}  (${scheduleCount} active schedules)`)
    if (apply) {
      db.prepare('UPDATE schedules SET enabled = 0 WHERE crewId = ?').run(crew.id)
    }
  }
}

console.log(
  `\n${apply ? 'applied' : 'planned'}: kept=${keptCount} archived=${archivedCount} ` +
    `smokeTasks=${smoke.length} crewsDisabled=${orphanCrews.length}`,
)
if (!apply) console.log('\nDry run. Re-run with --apply to commit.')
db.close()
