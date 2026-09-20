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
      files: ['app/login.tsx'], mode: 'analyze', status: 'completed',
      output: 'Found a logged verification code.',
      error: null, actualModel: 'claude-haiku-4-5',
      worktreePath: null, branch: null, diff: '', filesChanged: 0, patchState: 'none',
      createdAt: 5, startedAt: 6, finishedAt: 7,
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

describe('ProjectsScreen — edit mode', () => {
  it('offers an edit mode alongside analysis', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Analyze$/ })).toBeTruthy()
  })

  it('promises the checkout is untouched until the diff is applied', async () => {
    mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    expect(screen.getByText(/isolated git worktree/i)).toBeTruthy()
    expect(screen.getByText(/checkout is untouched/i)).toBeTruthy()
  })

  it('sends mode=edit when dispatching an edit run', async () => {
    const fetchMock = mockFetch()
    render(<ProjectsScreen />)
    await screen.findByText('clubhouse')
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Run edit/i }))
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([, init]) =>
        String((init as RequestInit | undefined)?.body ?? '').includes('"action":"run"'),
      )
      expect(String((posted?.[1] as RequestInit).body)).toContain('"mode":"edit"')
    })
  })

  it('renders the diff with apply and discard controls when a patch is pending', async () => {
    mockFetch({
      ...STATE,
      runs: [
        {
          ...STATE.runs[0], id: 'r9', mode: 'edit', status: 'completed',
          output: 'Fixed the adder.', filesChanged: 1, patchState: 'pending',
          worktreePath: '/tmp/wt', branch: 'hermes/run-r9',
          diff: 'diff --git a/math.js b/math.js\n@@ -1 +1 @@\n-a - b\n+a + b\n',
        },
      ],
    })
    render(<ProjectsScreen />)
    expect(await screen.findByText(/awaiting your review/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Apply to my checkout/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Discard/i })).toBeTruthy()
  })

  it('does not offer apply once a patch has been applied', async () => {
    mockFetch({
      ...STATE,
      runs: [
        {
          ...STATE.runs[0], id: 'r10', mode: 'edit', status: 'completed',
          filesChanged: 1, patchState: 'applied',
          diff: 'diff --git a/math.js b/math.js\n+a + b\n',
        },
      ],
    })
    render(<ProjectsScreen />)
    expect(await screen.findByText(/applied to your checkout/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Apply to my checkout/i })).toBeNull()
  })
})
