/**
 * memory-vault.ts
 *
 * Turns Hermes' memory files, context files and session history into an
 * Obsidian-compatible, interlinked set of markdown notes under `Hermes/` in
 * the knowledge vault. Studio's Knowledge tab renders the same notes (graph,
 * backlinks, tags), so one sync makes the memory readable in both places.
 *
 * Layout (all generated notes carry `generated_by: hermes-studio`):
 *
 *   Hermes/
 *     Home.md                         map of everything below
 *     Memory/Agent Memory.md          MEMORY.md entries, grouped by topic
 *     Memory/User Profile.md          USER.md entries
 *     Memory/Corrections.md           CORRECTION: entries
 *     Memory/Notes/<file>.md          other memory markdown files
 *     Topics/<Topic>.md               memory + sessions per topic
 *     Sessions/Sessions Index.md      every session, newest first
 *     Sessions/<YYYY-MM>/<date> <title> (<id>).md
 *     Sources/<source>.md             sessions per source (cli, cron, …)
 *     Daily/<YYYY-MM-DD>.md           sessions + daily memory notes per day
 *     Context/<file>.md               SOUL.md, AGENTS.md, …
 *
 * Sync only rewrites or deletes files that still carry the generated marker,
 * so notes a person has edited (marker removed) or written by hand are kept.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEntries } from '../lib/memory-parser'

export const VAULT_FOLDER = 'Hermes'
export const GENERATED_MARKER = 'hermes-studio'

// ── Input types ──────────────────────────────────────────────────

export type VaultMemoryFile = {
  /** Path relative to ~/.hermes, e.g. `memories/MEMORY.md` */
  path: string
  content: string
}

export type VaultMessage = {
  role: string
  content: string
  timestamp?: number
}

export type VaultSession = {
  id: string
  title?: string | null
  source?: string | null
  model?: string | null
  /** Seconds or milliseconds since epoch */
  startedAt?: number | null
  messageCount?: number | null
  parentSessionId?: string | null
  messages: Array<VaultMessage>
}

export type VaultInput = {
  memoryFiles: Array<VaultMemoryFile>
  contextFiles: Array<VaultMemoryFile>
  sessions: Array<VaultSession>
  /** ISO timestamp used for `updated` frontmatter */
  generatedAt: string
}

export type VaultNote = {
  /** Path relative to the vault root, always under `Hermes/` */
  path: string
  content: string
}

// ── Topics ───────────────────────────────────────────────────────

type TopicRule = { name: string; keywords: Array<string> }

export const TOPICS: Array<TopicRule> = [
  {
    name: 'Preferences',
    keywords: ['prefer', 'prefers', 'preference', 'likes', 'dislike', 'dislikes', 'style', 'tone', 'always', 'never', 'wants', 'favorite', 'favourite'],
  },
  {
    name: 'Projects',
    keywords: ['project', 'projects', 'repo', 'repository', 'app', 'feature', 'release', 'roadmap', 'studio', 'launch', 'mvp'],
  },
  {
    name: 'Code and Dev',
    keywords: ['code', 'bug', 'fix', 'test', 'tests', 'typescript', 'python', 'javascript', 'react', 'refactor', 'api', 'function', 'error', 'lint', 'build', 'git', 'commit', 'pr'],
  },
  {
    name: 'Infrastructure',
    keywords: ['server', 'docker', 'deploy', 'deployment', 'ssh', 'linux', 'nginx', 'systemd', 'cloud', 'vps', 'port', 'database', 'postgres', 'redis', 'kubernetes'],
  },
  {
    name: 'Tools and Setup',
    keywords: ['install', 'config', 'configure', 'setting', 'settings', 'cli', 'tool', 'tools', 'plugin', 'extension', 'obsidian', 'vscode', 'model', 'provider', 'mcp', 'skill', 'skills'],
  },
  {
    name: 'Automation',
    keywords: ['cron', 'schedule', 'scheduled', 'job', 'jobs', 'automation', 'automate', 'workflow', 'pipeline', 'trigger', 'daily', 'weekly', 'reminder'],
  },
  {
    name: 'Research',
    keywords: ['research', 'compare', 'comparison', 'analysis', 'analyze', 'summarize', 'summary', 'article', 'paper', 'learn', 'explain', 'news'],
  },
  {
    name: 'Communication',
    keywords: ['email', 'emails', 'message', 'telegram', 'discord', 'slack', 'meeting', 'call', 'whatsapp', 'reply'],
  },
  {
    name: 'Personal',
    keywords: ['family', 'health', 'travel', 'birthday', 'home', 'personal', 'fitness', 'finance', 'budget', 'trip'],
  },
]

const GENERAL_TOPIC = 'General'

const topicMatchers = TOPICS.map((topic) => ({
  name: topic.name,
  regex: new RegExp(`\\b(${topic.keywords.join('|')})\\b`, 'gi'),
}))

/** Topics whose keywords appear in `text`, strongest first. */
export function classifyTopics(text: string, max = 3): Array<string> {
  const scored = topicMatchers
    .map(({ name, regex }) => ({ name, hits: text.match(regex)?.length ?? 0 }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((entry) => entry.name)
  return scored.length ? scored : [GENERAL_TOPIC]
}

// ── Formatting helpers ───────────────────────────────────────────

/** Strip characters Obsidian disallows in file names. */
export function safeFileName(input: string, maxLength = 80): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
  return cleaned || 'Untitled'
}

function toMs(value?: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? value * 1000 : value
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function link(notePath: string, label?: string): string {
  const target = notePath.replace(/\.md$/i, '')
  return label ? `[[${target}|${label.replace(/[|\]]/g, ' ')}]]` : `[[${target}]]`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Keep transcript text from creating accidental wikilinks. */
function neutralizeWikilinks(text: string): string {
  return text.replace(/\[\[/g, '[\\[')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      if (!value.length) continue
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${yamlString(String(item))}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${yamlString(String(value))}`)
    }
  }
  lines.push(`generated_by: ${GENERATED_MARKER}`, '---', '')
  return lines.join('\n')
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`
}

function tagSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ── Paths ────────────────────────────────────────────────────────

const P = {
  home: `${VAULT_FOLDER}/Home.md`,
  agentMemory: `${VAULT_FOLDER}/Memory/Agent Memory.md`,
  userProfile: `${VAULT_FOLDER}/Memory/User Profile.md`,
  corrections: `${VAULT_FOLDER}/Memory/Corrections.md`,
  memoryNote: (name: string) => `${VAULT_FOLDER}/Memory/Notes/${safeFileName(name)}.md`,
  topic: (name: string) => `${VAULT_FOLDER}/Topics/${safeFileName(name)}.md`,
  sessionsIndex: `${VAULT_FOLDER}/Sessions/Sessions Index.md`,
  source: (name: string) => `${VAULT_FOLDER}/Sources/${safeFileName(name)}.md`,
  daily: (date: string) => `${VAULT_FOLDER}/Daily/${date}.md`,
  context: (name: string) => `${VAULT_FOLDER}/Context/${safeFileName(name)}.md`,
}

// ── Builder ──────────────────────────────────────────────────────

type MemoryItem = {
  text: string
  topics: Array<string>
  file: string
}

type SessionItem = {
  session: VaultSession
  path: string
  title: string
  date: string | null
  source: string
  topics: Array<string>
  summary: string
}

const MAX_TRANSCRIPT_MESSAGES = 60
const MAX_MESSAGE_CHARS = 2000
const DAILY_NOTE_RE = /(\d{4}-\d{2}-\d{2})\.md$/

function sessionTitle(session: VaultSession): string {
  const explicit = session.title?.trim()
  if (explicit) return oneLine(explicit, 70)
  const firstUser = session.messages.find(
    (message) => message.role === 'user' && message.content.trim(),
  )
  if (firstUser) return oneLine(firstUser.content, 60)
  return `Session ${session.id.slice(0, 8)}`
}

function describeSession(session: VaultSession): SessionItem {
  const title = sessionTitle(session)
  const startedMs =
    toMs(session.startedAt) ?? toMs(session.messages[0]?.timestamp) ?? null
  const date = startedMs ? isoDate(startedMs) : null
  const month = date ? date.slice(0, 7) : 'Undated'
  const shortId = safeFileName(session.id, 12)
  const fileName = safeFileName(`${date ?? 'undated'} ${title} (${shortId})`, 110)
  const firstUser =
    session.messages.find((m) => m.role === 'user' && m.content.trim())
      ?.content ?? ''
  const firstAssistant =
    session.messages.find((m) => m.role === 'assistant' && m.content.trim())
      ?.content ?? ''
  return {
    session,
    path: `${VAULT_FOLDER}/Sessions/${month}/${fileName}.md`,
    title,
    date,
    source: session.source?.trim() || 'unknown',
    topics: classifyTopics(
      `${title}\n${firstUser.slice(0, 2000)}\n${firstAssistant.slice(0, 1000)}`,
    ),
    summary: oneLine(firstUser || title, 280),
  }
}

function collectMemory(memoryFiles: Array<VaultMemoryFile>) {
  const agent: Array<MemoryItem> = []
  const user: Array<MemoryItem> = []
  const corrections: Array<MemoryItem> = []
  const dailyNotes = new Map<string, VaultMemoryFile>()
  const otherNotes: Array<VaultMemoryFile> = []

  for (const file of memoryFiles) {
    const base = path.posix.basename(file.path)
    const upper = base.toUpperCase()
    if (upper === 'MEMORY.MD' || upper === 'USER.MD') {
      for (const entry of parseEntries(file.content)) {
        const item: MemoryItem = {
          text: entry.body,
          topics: classifyTopics(entry.body, 2),
          file: file.path,
        }
        if (entry.isCorrection) corrections.push(item)
        else if (upper === 'USER.MD') user.push(item)
        else agent.push(item)
      }
      continue
    }
    const daily = base.match(DAILY_NOTE_RE)
    if (daily) {
      dailyNotes.set(daily[1], file)
      continue
    }
    otherNotes.push(file)
  }

  return { agent, user, corrections, dailyNotes, otherNotes }
}

function groupByTopic(items: Array<MemoryItem>): Map<string, Array<MemoryItem>> {
  const groups = new Map<string, Array<MemoryItem>>()
  for (const item of items) {
    const topic = item.topics[0] ?? GENERAL_TOPIC
    const bucket = groups.get(topic) ?? []
    bucket.push(item)
    groups.set(topic, bucket)
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function memoryBullet(item: MemoryItem): string {
  const topicLinks = item.topics.map((t) => link(P.topic(t), t)).join(' ')
  return `- ${neutralizeWikilinks(oneLine(item.text, 600))} — ${topicLinks}`
}

function sessionBullet(item: SessionItem): string {
  const date = item.date ?? 'undated'
  return `- ${date} · ${link(item.path, item.title)} · _${item.source}_`
}

function renderTranscript(session: VaultSession): string {
  const visible = session.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim(),
  )
  const shown = visible.slice(0, MAX_TRANSCRIPT_MESSAGES)
  const blocks = shown.map((message) => {
    const label = message.role === 'user' ? '**User**' : '**Hermes**'
    let body = message.content.trim()
    if (body.length > MAX_MESSAGE_CHARS) {
      body = `${body.slice(0, MAX_MESSAGE_CHARS)}\n\n_…truncated_`
    }
    return `${label}\n\n${neutralizeWikilinks(body)}`
  })
  if (visible.length > shown.length) {
    blocks.push(
      `_${visible.length - shown.length} more messages not shown — open the session in Studio for the full transcript._`,
    )
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : '_No messages stored._'
}

export function buildMemoryVault(input: VaultInput): Array<VaultNote> {
  const notes: Array<VaultNote> = []
  const updated = input.generatedAt
  const memory = collectMemory(input.memoryFiles)
  const sessions = input.sessions
    .map(describeSession)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title))

  // Index sessions by topic, source and day.
  const sessionsByTopic = new Map<string, Array<SessionItem>>()
  const sessionsBySource = new Map<string, Array<SessionItem>>()
  const sessionsByDay = new Map<string, Array<SessionItem>>()
  const sessionById = new Map<string, SessionItem>()
  for (const item of sessions) {
    sessionById.set(item.session.id, item)
    for (const topic of item.topics) {
      sessionsByTopic.set(topic, [...(sessionsByTopic.get(topic) ?? []), item])
    }
    sessionsBySource.set(item.source, [
      ...(sessionsBySource.get(item.source) ?? []),
      item,
    ])
    if (item.date) {
      sessionsByDay.set(item.date, [...(sessionsByDay.get(item.date) ?? []), item])
    }
  }

  const memoryByTopic = new Map<string, Array<MemoryItem>>()
  for (const item of [...memory.agent, ...memory.user, ...memory.corrections]) {
    for (const topic of item.topics) {
      memoryByTopic.set(topic, [...(memoryByTopic.get(topic) ?? []), item])
    }
  }

  const topicNames = Array.from(
    new Set([...sessionsByTopic.keys(), ...memoryByTopic.keys()]),
  ).sort()
  const days = Array.from(
    new Set([...sessionsByDay.keys(), ...memory.dailyNotes.keys()]),
  ).sort((a, b) => b.localeCompare(a))

  // ── Sessions ──
  for (const item of sessions) {
    const { session } = item
    const parent = session.parentSessionId
      ? sessionById.get(session.parentSessionId)
      : undefined
    const related = [
      ...item.topics.map((t) => link(P.topic(t), t)),
      link(P.source(item.source), `source: ${item.source}`),
      ...(item.date ? [link(P.daily(item.date), item.date)] : []),
      ...(parent ? [link(parent.path, `forked from: ${parent.title}`)] : []),
    ]
    notes.push({
      path: item.path,
      content:
        frontmatter({
          title: item.title,
          type: 'session',
          tags: ['hermes/session', ...item.topics.map((t) => `topic/${tagSlug(t)}`), `source/${tagSlug(item.source)}`],
          summary: item.summary,
          created: item.date ?? undefined,
          updated,
          session_id: session.id,
          source: item.source,
          model: session.model ?? undefined,
          messages: session.messageCount ?? session.messages.length,
        }) +
        [
          `# ${item.title}`,
          '',
          `> ${neutralizeWikilinks(item.summary)}`,
          '',
          `**Related:** ${related.join(' · ')}`,
          '',
          `Open in Studio: \`/chat/${session.id}\``,
          '',
          '## Transcript',
          '',
          renderTranscript(session),
          '',
        ].join('\n'),
    })
  }

  // ── Sessions index ──
  const byMonth = new Map<string, Array<SessionItem>>()
  for (const item of sessions) {
    const month = item.date?.slice(0, 7) ?? 'Undated'
    byMonth.set(month, [...(byMonth.get(month) ?? []), item])
  }
  notes.push({
    path: P.sessionsIndex,
    content:
      frontmatter({
        title: 'Sessions Index',
        type: 'index',
        tags: ['hermes/index'],
        summary: `${plural(sessions.length, 'Hermes session')}, newest first.`,
        updated,
      }) +
      [
        '# Sessions Index',
        '',
        `Back to ${link(P.home, 'Hermes Home')}. ${plural(sessions.length, 'session')}.`,
        '',
        ...(sessions.length
          ? [...byMonth.entries()].flatMap(([month, items]) => [
              `## ${month}`,
              '',
              ...items.map(sessionBullet),
              '',
            ])
          : ['_No sessions found yet._', '']),
      ].join('\n'),
  })

  // ── Sources ──
  for (const [source, items] of sessionsBySource) {
    notes.push({
      path: P.source(source),
      content:
        frontmatter({
          title: `Source: ${source}`,
          type: 'source',
          tags: ['hermes/source', `source/${tagSlug(source)}`],
          summary: `${plural(items.length, 'session')} from ${source}.`,
          updated,
        }) +
        [
          `# Source: ${source}`,
          '',
          `Sessions started from **${source}**. Back to ${link(P.home, 'Hermes Home')}.`,
          '',
          ...items.map(sessionBullet),
          '',
        ].join('\n'),
    })
  }

  // ── Memory ──
  const memorySection = (items: Array<MemoryItem>, empty: string) =>
    items.length
      ? [...groupByTopic(items).entries()].flatMap(([topic, group]) => [
          `## ${topic}`,
          '',
          ...group.map(memoryBullet),
          '',
        ])
      : [empty, '']

  notes.push({
    path: P.agentMemory,
    content:
      frontmatter({
        title: 'Agent Memory',
        type: 'memory',
        tags: ['hermes/memory'],
        summary: `${plural(memory.agent.length, 'thing')} Hermes has learned, grouped by topic.`,
        updated,
      }) +
      [
        '# Agent Memory',
        '',
        `What Hermes remembers across sessions (from \`MEMORY.md\`). See also ${link(P.userProfile, 'User Profile')} and ${link(P.corrections, 'Corrections')}.`,
        '',
        ...memorySection(memory.agent, '_MEMORY.md is empty or missing._'),
      ].join('\n'),
  })

  notes.push({
    path: P.userProfile,
    content:
      frontmatter({
        title: 'User Profile',
        type: 'memory',
        tags: ['hermes/memory', 'hermes/user'],
        summary: `${plural(memory.user.length, 'fact')} Hermes keeps about you.`,
        updated,
      }) +
      [
        '# User Profile',
        '',
        `What Hermes knows about you (from \`USER.md\`). Back to ${link(P.agentMemory, 'Agent Memory')}.`,
        '',
        ...memorySection(memory.user, '_USER.md is empty or missing._'),
      ].join('\n'),
  })

  notes.push({
    path: P.corrections,
    content:
      frontmatter({
        title: 'Corrections',
        type: 'memory',
        tags: ['hermes/memory', 'hermes/correction'],
        summary: `${plural(memory.corrections.length, 'self-correction')} Hermes has recorded.`,
        updated,
      }) +
      [
        '# Corrections',
        '',
        `Mistakes Hermes noted so it does not repeat them. Back to ${link(P.agentMemory, 'Agent Memory')}.`,
        '',
        ...(memory.corrections.length
          ? memory.corrections.map(memoryBullet)
          : ['_No corrections recorded._']),
        '',
      ].join('\n'),
  })

  for (const file of memory.otherNotes) {
    const name = path.posix.basename(file.path, '.md')
    notes.push({
      path: P.memoryNote(name),
      content:
        frontmatter({
          title: name,
          type: 'memory-note',
          tags: ['hermes/memory', ...classifyTopics(file.content, 2).map((t) => `topic/${tagSlug(t)}`)],
          summary: `Copy of ~/.hermes/${file.path}`,
          updated,
        }) +
        `> Mirrored from \`~/.hermes/${file.path}\` — edit the original; this copy is replaced on sync.\n\n` +
        `Topics: ${classifyTopics(file.content, 2).map((t) => link(P.topic(t), t)).join(' · ')}\n\n` +
        neutralizeWikilinks(file.content.trim()) +
        '\n',
    })
  }

  // ── Context ──
  for (const file of input.contextFiles) {
    const name = path.posix.basename(file.path, '.md')
    notes.push({
      path: P.context(name),
      content:
        frontmatter({
          title: name,
          type: 'context',
          tags: ['hermes/context'],
          summary: `Copy of ~/.hermes/${file.path}`,
          updated,
        }) +
        `> Mirrored from \`~/.hermes/${file.path}\` — edit the original; this copy is replaced on sync. Back to ${link(P.home, 'Hermes Home')}.\n\n` +
        neutralizeWikilinks(file.content.trim()) +
        '\n',
    })
  }

  // ── Topics ──
  for (const topic of topicNames) {
    const topicSessions = sessionsByTopic.get(topic) ?? []
    const topicMemory = memoryByTopic.get(topic) ?? []
    notes.push({
      path: P.topic(topic),
      content:
        frontmatter({
          title: topic,
          type: 'topic',
          tags: ['hermes/topic', `topic/${tagSlug(topic)}`],
          summary: `${plural(topicMemory.length, 'memory', 'memories')} and ${plural(topicSessions.length, 'session')} about ${topic.toLowerCase()}.`,
          updated,
        }) +
        [
          `# ${topic}`,
          '',
          `Back to ${link(P.home, 'Hermes Home')}.`,
          '',
          '## What Hermes remembers',
          '',
          ...(topicMemory.length
            ? topicMemory.map((item) => `- ${neutralizeWikilinks(oneLine(item.text, 600))}`)
            : ['_Nothing in memory for this topic yet._']),
          '',
          '## Sessions',
          '',
          ...(topicSessions.length
            ? topicSessions.map(sessionBullet)
            : ['_No sessions about this topic yet._']),
          '',
        ].join('\n'),
    })
  }

  // ── Daily ──
  for (const day of days) {
    const daySessions = sessionsByDay.get(day) ?? []
    const dailyNote = memory.dailyNotes.get(day)
    notes.push({
      path: P.daily(day),
      content:
        frontmatter({
          title: day,
          type: 'daily',
          tags: ['hermes/daily'],
          summary: `${plural(daySessions.length, 'session')}${dailyNote ? ' and a memory note' : ''} on ${day}.`,
          created: day,
          updated,
        }) +
        [
          `# ${day}`,
          '',
          `Back to ${link(P.home, 'Hermes Home')}.`,
          '',
          '## Sessions',
          '',
          ...(daySessions.length ? daySessions.map(sessionBullet) : ['_No sessions._']),
          '',
          ...(dailyNote
            ? [
                '## Memory note',
                '',
                `_From \`~/.hermes/${dailyNote.path}\`_`,
                '',
                neutralizeWikilinks(dailyNote.content.trim()),
                '',
              ]
            : []),
        ].join('\n'),
    })
  }

  // ── Home ──
  const topicCounts = topicNames.map((topic) => {
    const s = sessionsByTopic.get(topic)?.length ?? 0
    const m = memoryByTopic.get(topic)?.length ?? 0
    return `- ${link(P.topic(topic), topic)} — ${plural(m, 'memory', 'memories')}, ${plural(s, 'session')}`
  })
  notes.push({
    path: P.home,
    content:
      frontmatter({
        title: 'Hermes Home',
        type: 'home',
        tags: ['hermes/index'],
        summary: 'Start here: how Hermes memory and history are organized.',
        updated,
      }) +
      [
        '# Hermes Home',
        '',
        `Generated by Hermes Studio on ${updated.slice(0, 10)}. Everything under \`${VAULT_FOLDER}/\` is rebuilt on each sync; to keep a note as hand-edited, delete its \`generated_by\` line.`,
        '',
        '## Memory',
        '',
        `- ${link(P.agentMemory, 'Agent Memory')} — ${plural(memory.agent.length, 'entry', 'entries')}`,
        `- ${link(P.userProfile, 'User Profile')} — ${plural(memory.user.length, 'entry', 'entries')}`,
        `- ${link(P.corrections, 'Corrections')} — ${plural(memory.corrections.length, 'entry', 'entries')}`,
        ...memory.otherNotes.map((file) => {
          const name = path.posix.basename(file.path, '.md')
          return `- ${link(P.memoryNote(name), name)}`
        }),
        '',
        '## Topics',
        '',
        ...(topicCounts.length ? topicCounts : ['_No topics yet._']),
        '',
        '## History',
        '',
        `- ${link(P.sessionsIndex, 'All sessions')} — ${sessions.length} total`,
        ...[...sessionsBySource.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([source, items]) => `- ${link(P.source(source), `From ${source}`)} — ${items.length}`),
        '',
        '### Recent sessions',
        '',
        ...(sessions.length ? sessions.slice(0, 10).map(sessionBullet) : ['_None yet._']),
        '',
        '### Recent days',
        '',
        ...(days.length ? days.slice(0, 14).map((day) => `- ${link(P.daily(day), day)}`) : ['_None yet._']),
        '',
        ...(input.contextFiles.length
          ? [
              '## Context files',
              '',
              ...input.contextFiles.map((file) => {
                const name = path.posix.basename(file.path, '.md')
                return `- ${link(P.context(name), name)}`
              }),
              '',
            ]
          : []),
      ].join('\n'),
  })

  return notes
}

// ── Writing to disk ──────────────────────────────────────────────

function isGeneratedFile(fullPath: string): boolean {
  try {
    const head = fs.readFileSync(fullPath, 'utf-8').slice(0, 4000)
    if (!head.startsWith('---')) return false
    const end = head.indexOf('\n---', 3)
    const fm = end === -1 ? head : head.slice(0, end)
    return new RegExp(`^generated_by:\\s*${GENERATED_MARKER}\\s*$`, 'm').test(fm)
  } catch {
    return false
  }
}

function listMarkdownFiles(dir: string): Array<string> {
  const out: Array<string> = []
  let entries: Array<fs.Dirent>
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full))
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

export type VaultWriteResult = {
  written: number
  skipped: Array<string>
  removed: number
}

/**
 * Write notes under `vaultRoot`. Existing files are only overwritten or
 * deleted when they still carry the generated marker.
 */
export function writeMemoryVault(
  vaultRoot: string,
  notes: Array<VaultNote>,
): VaultWriteResult {
  const root = path.resolve(vaultRoot)
  const hermesDir = path.join(root, VAULT_FOLDER)
  const wanted = new Set<string>()
  const skipped: Array<string> = []
  let written = 0

  for (const note of notes) {
    const full = path.resolve(root, note.path)
    if (!full.startsWith(hermesDir + path.sep)) {
      throw new Error(`Refusing to write outside ${VAULT_FOLDER}/: ${note.path}`)
    }
    wanted.add(full)
    if (fs.existsSync(full) && !isGeneratedFile(full)) {
      skipped.push(note.path)
      continue
    }
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, note.content)
    written += 1
  }

  let removed = 0
  for (const full of listMarkdownFiles(hermesDir)) {
    if (wanted.has(full) || !isGeneratedFile(full)) continue
    fs.unlinkSync(full)
    removed += 1
  }

  return { written, skipped, removed }
}

// ── Gathering inputs from the machine ────────────────────────────

const CONTEXT_FILE_NAMES = ['SOUL.md', 'AGENTS.md', 'CONTEXT.md', 'PROFILE.md']

export function readHermesContextFiles(
  hermesHome = path.join(os.homedir(), '.hermes'),
): Array<VaultMemoryFile> {
  const files: Array<VaultMemoryFile> = []
  for (const name of CONTEXT_FILE_NAMES) {
    const full = path.join(hermesHome, name)
    try {
      if (fs.statSync(full).isFile()) {
        files.push({ path: name, content: fs.readFileSync(full, 'utf-8') })
      }
    } catch {
      // not present
    }
  }
  return files
}
