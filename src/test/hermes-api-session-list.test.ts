import { describe, expect, it } from 'vitest'
import { normalizeSessionListResponse } from '@/server/hermes-api'

const session = {
  id: 'cron_abc_20260919_174917',
  source: 'cron',
  model: 'gpt-5.6-sol',
}

describe('normalizeSessionListResponse', () => {
  it('accepts the current Hermes object/data list shape', () => {
    expect(
      normalizeSessionListResponse({
        object: 'list',
        data: [session],
      }),
    ).toEqual([session])
  })

  it('keeps compatibility with the legacy items/total list shape', () => {
    expect(
      normalizeSessionListResponse({
        items: [session],
        total: 1,
      }),
    ).toEqual([session])
  })

  it('returns an empty list for an unknown payload instead of throwing', () => {
    expect(normalizeSessionListResponse({ object: 'list' })).toEqual([])
  })
})
