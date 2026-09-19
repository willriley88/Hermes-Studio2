import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('getMessages response normalization', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.resetModules()
  })

  async function loadWithPayload(payload: unknown) {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const mod = await import('@/server/hermes-api')
    return mod.getMessages('cron_abc_20260919_190918')
  }

  it('reads the OpenAI-style { object, data, pagination } payload', async () => {
    const messages = await loadWithPayload({
      object: 'list',
      session_id: 'cron_abc_20260919_190918',
      data: [{ id: 1, role: 'assistant', content: 'studio_conductor_verified_ok' }],
      pagination: { limit: 500, offset: 0, returned: 1 },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('studio_conductor_verified_ok')
  })

  it('still reads the legacy { items, total } payload', async () => {
    const messages = await loadWithPayload({
      items: [{ id: 1, role: 'assistant', content: 'legacy' }],
      total: 1,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('legacy')
  })

  it('reads a { messages } payload', async () => {
    const messages = await loadWithPayload({
      messages: [{ id: 1, role: 'assistant', content: 'alt' }],
    })
    expect(messages[0].content).toBe('alt')
  })

  it('returns an empty array instead of throwing on an unknown payload', async () => {
    const messages = await loadWithPayload({ unexpected: true })
    expect(messages).toEqual([])
  })
})
