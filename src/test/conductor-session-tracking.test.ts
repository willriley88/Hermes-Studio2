import { describe, expect, it } from 'vitest'
import {
  buildConductorSessionPollingOptions,
  buildConductorSessionsQueryKey,
  deriveWorkerStatus,
} from '@/screens/conductor/hooks/use-conductor-gateway'

describe('Conductor session tracking', () => {
  it('invalidates the session query when a placeholder resolves to a real key', () => {
    const pending = buildConductorSessionsQueryKey(
      new Set(['cron_abc_pending']),
      new Set(),
      '2026-09-19T21:56:11.734Z',
    )
    const resolved = buildConductorSessionsQueryKey(
      new Set(['cron_abc_20260919_175654']),
      new Set(),
      '2026-09-19T21:56:11.734Z',
    )

    expect(resolved).not.toEqual(pending)
  })

  it('treats an ended Hermes session as complete immediately', () => {
    expect(
      deriveWorkerStatus(
        { key: 'cron_abc_20260919_175654', status: 'ended', totalTokens: 10 },
        new Date().toISOString(),
      ),
    ).toBe('complete')
  })

  it('keeps polling while the Conductor tab is in the background', () => {
    expect(buildConductorSessionPollingOptions('running', {})).toEqual({
      refetchInterval: 3_000,
      refetchIntervalInBackground: true,
    })
  })
})
