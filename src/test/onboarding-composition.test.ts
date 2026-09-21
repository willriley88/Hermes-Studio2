import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function countOnboardingMounts(source: string): number {
  return source.match(/<HermesOnboarding\b/g)?.length ?? 0
}

describe('application onboarding composition', () => {
  it('mounts the onboarding dialog exactly once', () => {
    const root = readFileSync(resolve('src/routes/__root.tsx'), 'utf8')
    const shell = readFileSync(resolve('src/components/workspace-shell.tsx'), 'utf8')

    expect(countOnboardingMounts(root) + countOnboardingMounts(shell)).toBe(1)
  })
})
