import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConductorHome } from '@/screens/conductor/components/conductor-home'

const conductor = {
  selectedHistoryEntry: null,
  missionHistory: [],
  recentSessions: [],
  hasPersistedMission: false,
  isSending: false,
}

describe('ConductorHome server rendering', () => {
  it('renders without accessing browser-only globals', () => {
    expect(() =>
      renderToString(
        <ConductorHome
          conductor={conductor as never}
          goalDraft=""
          setGoalDraft={() => undefined}
          onSubmit={() => undefined}
          onSettingsOpen={() => undefined}
        />,
      ),
    ).not.toThrow()
  })
})
