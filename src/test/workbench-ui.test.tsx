// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ProjectsScreen } from '@/screens/projects/projects-screen'
import type { WorkbenchState } from '@/types/workbench'

const STATE: WorkbenchState = {
  projects: [
    { id: 'p1', name: 'clubhouse', path: '/home/willr/projects/clubhouse', description: '', createdAt: 1 },
    { id: 'p2', name: 'golf-db-product', path: '/home/willr/projects/golf-db-product', description: '', createdAt: 2 },
  ],
  tasks: [
    {
      id: 't1', projectId: 'p1', title: 'Audit login flow', description: 'check secrets',
      status: 'ready', createdAt: 1, updatedAt: 1,
    },
  ],
  runs: [
    {
      id: 'r1', taskId: 't1', projectId: 'p1', connectionId: 'claude', model: 'haiku',
      roleId: 'builtin-nova', roleName: 'Nova', rolePrompt: 'You are Nova.',
      files: ['app/login.tsx'], status: 'completed', output: 'Found a logged verification code.',
      error: null, actualModel: 'claude-haiku-4-5', createdAt: 5, startedAt: 6, finishedAt: 7,
    },
  ],
  connections: [
    { id: 'chatgpt', name: 'ChatGPT (Codex)', available: true, detail: 'Signed in via Hermes OAuth', billing: 'subscription', models: ['gpt-5.6-sol'] },
    { id: 'claude', name: 'Claude', available: true, detail: 'claude.ai subscription', billing: 'subscription', models: ['haiku', 'sonnet'] },
    { id: 'ollama', name: 'Local (Ollama)', available: false, detail: 'Local Ollama daemon is not running', billing: 'local', models: [] },
  ],
  roles: [
    {
      id: 'builtin-nova', name: 'Nova', emoji: '🛡️', color: 'text-cyan-400',
      roleLabel: 'Security Specialist', systemPrompt: 'You are Nova.', model: null,
      tags: [], isBuiltIn: true, createdAt: 0, updatedAt: 0,
    },
  ],
}

function mockFetch(state: WorkbenchState = STATE) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/workbench-files')) {
      return new Response(JSON.stringify({ files: ['app/login.tsx', 'app/profile.tsx'] }), { status: 200 })
    }
    if (url.startsWith('/api/workbench') && (!init || init.method !== 'POST')) {
      return new Response(JSON.stringify(state), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProjectsScreen', () => {
  it('lists the discovered projects', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    expect(await screen.findByText('clubhouse')).toBeTruthy()
    expect(screen.getByText('golf-db-product')).toBeTruthy()
  })

  it('offers each runtime separately so a model can be picked per run', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    expect(screen.getByRole('option', { name: /ChatGPT \(Codex\)/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Claude/ })).toBeTruthy()
  })

  it('marks an unavailable runtime instead of pretending it works', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    const option = screen.getByRole('option', { name: /Local \(Ollama\)/ }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
  })

  it('shows the role library so a personality can be attached to a run', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    expect(screen.getByRole('option', { name: /Nova/ })).toBeTruthy()
  })

  it('states that runs are read-only', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    expect(screen.getAllByText(/read-only/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/no tools and no filesystem access/i)).toBeTruthy()
  })

  it('renders a completed run output recovered from the server, not local state', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    expect(await screen.findByText(/Found a logged verification code/)).toBeTruthy()
  })

  it('surfaces an interrupted run honestly rather than as a success', async () => {
    const interrupted: WorkbenchState = {
      ...STATE,
      runs: [
        {
          ...STATE.runs[0], id: 'r2', status: 'interrupted', output: '',
          error: 'The server stopped while this run was in progress.',
        },
      ],
    }
    mockFetch(interrupted)
    render(<ProjectsScreen />)
    expect(await screen.findByText(/server stopped while this run was in progress/i)).toBeTruthy()
  })

  it('does not show a fabricated dollar charge for subscription runs', async () => {
    mockFetch()
    const { container } = render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    expect(container.textContent).not.toMatch(/\$\d/)
  })

  it('scans for projects on request', async () => {
    const fetchMock = mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    fireEvent.click(screen.getByRole('button', { name: /scan/i }))
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      )
      expect(String((posted?.[1] as RequestInit).body)).toContain('"action":"scan"')
    })
  })
})
