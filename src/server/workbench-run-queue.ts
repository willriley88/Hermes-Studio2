import type { ConnectionId } from '../types/workbench'

type QueueJob = {
  id: string
  connectionId: ConnectionId
  launch: () => Promise<void>
}

/**
 * Small in-process queue for subscription/local runs.
 *
 * It bounds fan-out without losing crew seats: extra members remain queued and
 * start as earlier members finish. A restart does not replay this volatile
 * queue; the durable store marks its queued/running records interrupted.
 */
export class RunQueue {
  private readonly pending: QueueJob[] = []
  private readonly running = new Map<string, ConnectionId>()

  constructor(
    private readonly limits: { maxRunning: number; maxLocal: number; maxPending: number },
  ) {}

  get pendingCount(): number {
    return this.pending.length
  }

  get runningCount(): number {
    return this.running.size
  }

  enqueue(id: string, connectionId: ConnectionId, launch: () => Promise<void>): void {
    if (this.pending.length >= this.limits.maxPending) {
      throw new Error('The run queue is full. Wait for an active run to finish.')
    }
    if (this.pending.some((job) => job.id === id) || this.running.has(id)) {
      throw new Error('This run is already queued.')
    }
    this.pending.push({ id, connectionId, launch })
    this.drain()
  }

  cancelPending(id: string): boolean {
    const index = this.pending.findIndex((job) => job.id === id)
    if (index < 0) return false
    this.pending.splice(index, 1)
    return true
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  private localRunning(): number {
    let count = 0
    for (const connectionId of this.running.values()) {
      if (connectionId === 'ollama') count += 1
    }
    return count
  }

  private drain(): void {
    while (this.running.size < this.limits.maxRunning) {
      const localAtCapacity = this.localRunning() >= this.limits.maxLocal
      const index = this.pending.findIndex(
        (job) => job.connectionId !== 'ollama' || !localAtCapacity,
      )
      if (index < 0) return

      const [job] = this.pending.splice(index, 1)
      this.running.set(job.id, job.connectionId)
      void Promise.resolve()
        .then(job.launch)
        // Launchers persist their own error state. The queue only owns capacity.
        .catch(() => undefined)
        .finally(() => {
          this.running.delete(job.id)
          this.drain()
        })
    }
  }
}
