/**
 * Conductor mission spawn — creates a one-shot Hermes job for orchestration.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  HERMES_API,
  BEARER_TOKEN,
  ensureGatewayProbed,
} from '../../server/gateway-capabilities'

/**
 * The gateway caps cron-job prompts at 5000 characters
 * (api_server.py::_MAX_PROMPT_LENGTH). Inlining the whole dispatch SKILL.md
 * blew that cap and every spawn came back 400 "Prompt must be ≤ 5000
 * characters". Instead we attach the skill BY NAME via the job's `skills`
 * field — the gateway loads it into the orchestrator's context itself — and
 * only inline the skill text as a fallback when it isn't installed.
 */
const DISPATCH_SKILL_NAME = 'workspace-dispatch'
const MAX_PROMPT_CHARS = 5000

let cachedSkill: string | null = null
let cachedSkillInstalled: boolean | null = null

type ConductorSpawnBody = {
  goal?: unknown
  orchestratorModel?: unknown
  workerModel?: unknown
  projectsDir?: unknown
  maxParallel?: unknown
  supervised?: unknown
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return resolve(here, '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

function loadDispatchSkill(): string {
  if (cachedSkill !== null) return cachedSkill
  const candidates = [
    resolve(repoRoot(), 'skills/workspace-dispatch/SKILL.md'),
    resolve(process.cwd(), 'skills/workspace-dispatch/SKILL.md'),
    resolve(process.env.HOME ?? '~', '.hermes/skills/workspace-dispatch/SKILL.md'),
    resolve(
      process.env.HOME ?? '~',
      '.ocplatform/workspace/skills/workspace-dispatch/SKILL.md',
    ),
  ]
  for (const p of candidates) {
    try {
      cachedSkill = readFileSync(p, 'utf-8')
      return cachedSkill
    } catch {
      continue
    }
  }
  cachedSkill = ''
  return cachedSkill
}

/** True when the skill is installed in the agent's own skill dir, so the
 *  gateway can load it by name instead of us inlining it. */
function dispatchSkillInstalled(): boolean {
  if (cachedSkillInstalled !== null) return cachedSkillInstalled
  const home = process.env.HOME ?? '~'
  const profile = process.env.HERMES_PROFILE
  const candidates = [
    resolve(home, '.hermes/skills', DISPATCH_SKILL_NAME, 'SKILL.md'),
    ...(profile
      ? [
          resolve(
            home,
            '.hermes/profiles',
            profile,
            'skills',
            DISPATCH_SKILL_NAME,
            'SKILL.md',
          ),
        ]
      : []),
  ]
  cachedSkillInstalled = candidates.some((p) => {
    try {
      readFileSync(p, 'utf-8')
      return true
    } catch {
      return false
    }
  })
  return cachedSkillInstalled
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readMaxParallel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(5, Math.max(1, Math.round(value)))
}

function buildOrchestratorPrompt(
  goal: string,
  skill: string,
  options: {
    orchestratorModel: string
    workerModel: string
    projectsDir: string
    maxParallel: number
    supervised: boolean
    skillAttached: boolean
  },
): string {
  const outputBase = options.projectsDir || '/tmp'
  const outputPrefix =
    outputBase === '/tmp' ? '/tmp/dispatch-<slug>' : `${outputBase}/dispatch-<slug>`

  return [
    'You are a mission orchestrator. Execute this mission autonomously.',
    '',
    '## Dispatch Skill Instructions',
    '',
    skill ||
      (options.skillAttached
        ? `Load the \`${DISPATCH_SKILL_NAME}\` skill (attached to this job) and follow it.`
        : `(${DISPATCH_SKILL_NAME} skill not found locally; proceed using the delegate_task tool to spawn workers)`),
    '',
    '## Mission',
    '',
    `Goal: ${goal}`,
    ...(options.orchestratorModel
      ? ['', `Use model: ${options.orchestratorModel} for the orchestrator`]
      : []),
    ...(options.workerModel
      ? ['', `Use model: ${options.workerModel} for all workers`]
      : []),
    ...(options.maxParallel > 1
      ? [
          '',
          `Run up to ${options.maxParallel} workers in parallel when tasks are independent`,
        ]
      : [
          '',
          'Spawn workers one at a time. Do NOT wait for workers to finish — the UI handles tracking.',
        ]),
    ...(options.supervised
      ? ['', 'Supervised mode is enabled. Require approval before each task.']
      : []),
    '',
    '## Critical Rules',
    '- Use the `delegate_task` tool to spawn a worker for each task. Hermes has no `sessions_spawn`, `sessions_yield`, or `create_task` tool — calling those fails silently and stalls the mission.',
    '- Subagents are isolated: repeat every path, constraint and piece of background in each task\'s `context` field.',
    '- Do NOT do the work yourself — spawn workers',
    '- For simple tasks (single file, quick mockup), use ONLY 1 task with 1 worker — do not over-decompose',
    '- Do NOT ask for confirmation — start immediately',
    '- Label workers as "worker-<task-slug>" so the UI can track them',
    '- Each worker gets a self-contained prompt with the task + exit criteria',
    `- Workers should write output to ${outputPrefix} directories`,
    '- After spawning all workers, report your plan summary and finish. The UI tracks worker completion automatically.',
    '- Report a summary when all tasks are done',
  ].join('\n')
}

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

function nowPlusSecondsIso(seconds: number): string {
  const t = new Date(Date.now() + seconds * 1000)
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function createHermesJob(payload: {
  name: string
  schedule: string
  prompt: string
  deliver?: string
  skills?: Array<string>
}): Promise<{ id?: string; name?: string; error?: string }> {
  const body = JSON.stringify({
    name: payload.name,
    schedule: payload.schedule,
    prompt: payload.prompt,
    deliver: payload.deliver ?? 'local',
    ...(payload.skills && payload.skills.length
      ? { skills: payload.skills }
      : {}),
  })
  await ensureGatewayProbed()
  const res = await fetch(`${HERMES_API}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body,
  })
  const text = await res.text()
  let data: { job?: { id?: string; name?: string }; error?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    return { error: text || `HTTP ${res.status}` }
  }
  if (!res.ok || data.error) {
    return { error: data.error || `HTTP ${res.status}` }
  }
  return { id: data.job?.id, name: data.job?.name }
}

export const Route = createFileRoute('/api/conductor-spawn')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request
            .json()
            .catch(() => ({}))) as ConductorSpawnBody
          const goal = readOptionalString(body.goal)
          const orchestratorModel = readOptionalString(body.orchestratorModel)
          const workerModel = readOptionalString(body.workerModel)
          const projectsDir = readOptionalString(body.projectsDir)
          const maxParallel = readMaxParallel(body.maxParallel)
          const supervised = body.supervised === true

          if (!goal) {
            return new Response(
              JSON.stringify({ ok: false, error: 'goal required' }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }

          // Prefer attaching the skill by name (no prompt-budget cost).
          // Only inline its text when the agent can't load it itself.
          const useSkillRef = dispatchSkillInstalled()
          const skill = useSkillRef ? '' : loadDispatchSkill()
          let prompt = buildOrchestratorPrompt(goal, skill, {
            orchestratorModel,
            workerModel,
            projectsDir,
            maxParallel,
            supervised,
            skillAttached: useSkillRef,
          })

          if (prompt.length > MAX_PROMPT_CHARS) {
            // Last resort: drop the inlined skill body rather than let the
            // gateway reject the whole mission with a 400.
            prompt = buildOrchestratorPrompt(goal, '', {
              orchestratorModel,
              workerModel,
              projectsDir,
              maxParallel,
              supervised,
              skillAttached: useSkillRef,
            })
          }
          if (prompt.length > MAX_PROMPT_CHARS) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: `Mission prompt is ${prompt.length} chars; the gateway caps job prompts at ${MAX_PROMPT_CHARS}. Shorten the goal.`,
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }

          const jobName = `conductor-${Date.now()}`
          const result = await createHermesJob({
            name: jobName,
            schedule: nowPlusSecondsIso(5),
            prompt,
            deliver: 'local',
            skills: useSkillRef ? [DISPATCH_SKILL_NAME] : undefined,
          })

          if (result.error) {
            return new Response(
              JSON.stringify({ ok: false, error: result.error }),
              { status: 502, headers: { 'Content-Type': 'application/json' } },
            )
          }

          const jobId = result.id ?? jobName
          return new Response(
            JSON.stringify({
              ok: true,
              sessionKey: `cron_${jobId}_pending`,
              sessionKeyPrefix: `cron_${jobId}_`,
              jobId,
              jobName: result.name ?? jobName,
              runId: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        } catch (error) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }
      },
    },
  },
})
