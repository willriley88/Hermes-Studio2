import { describe, expect, it } from 'vitest'
import { RunQueue } from '../server/workbench-run-queue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('RunQueue', () => {
  it('starts only the configured number of runs at once', async () => {
    const queue = new RunQueue({ maxRunning: 2, maxLocal: 1, maxPending: 8 })
    const gates = [deferred(), deferred(), deferred()]
    const started: string[] = []

    gates.forEach((gate, index) => {
      queue.enqueue(`r${index}`, 'claude', async () => {
        started.push(`r${index}`)
        await gate.promise
      })
    })
    await tick()
    expect(started).toEqual(['r0', 'r1'])
    expect(queue.pendingCount).toBe(1)

    gates[0].resolve()
    await tick()
    expect(started).toEqual(['r0', 'r1', 'r2'])
    gates[1].resolve()
    gates[2].resolve()
  })

  it('runs at most one local model while subscription work uses the other slots', async () => {
    const queue = new RunQueue({ maxRunning: 3, maxLocal: 1, maxPending: 8 })
    const localOne = deferred()
    const localTwo = deferred()
    const remote = deferred()
    const started: string[] = []

    queue.enqueue('local-1', 'ollama', async () => { started.push('local-1'); await localOne.promise })
    queue.enqueue('local-2', 'ollama', async () => { started.push('local-2'); await localTwo.promise })
    queue.enqueue('remote', 'claude', async () => { started.push('remote'); await remote.promise })
    await tick()

    expect(started).toEqual(['local-1', 'remote'])
    localOne.resolve()
    await tick()
    expect(started).toContain('local-2')
    localTwo.resolve()
    remote.resolve()
  })

  it('cancels a pending run without launching it', async () => {
    const queue = new RunQueue({ maxRunning: 1, maxLocal: 1, maxPending: 8 })
    const gate = deferred()
    let launched = false
    queue.enqueue('running', 'claude', () => gate.promise)
    queue.enqueue('pending', 'claude', async () => { launched = true })
    expect(queue.cancelPending('pending')).toBe(true)
    gate.resolve()
    await tick()
    expect(launched).toBe(false)
  })

  it('rejects an unbounded backlog', () => {
    const queue = new RunQueue({ maxRunning: 1, maxLocal: 1, maxPending: 1 })
    const never = new Promise<void>(() => {})
    queue.enqueue('running', 'claude', () => never)
    queue.enqueue('pending', 'claude', () => never)
    expect(() => queue.enqueue('too-many', 'claude', () => never)).toThrow(/queue|pending|full/i)
  })
})
