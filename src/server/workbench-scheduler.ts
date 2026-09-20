/**
 * Scheduler tick.
 *
 * Checks for due crew schedules once a minute, in-process. This runs as long
 * as the Studio server is up — there is no external cron involved, so a
 * schedule only fires while the machine and server are running. That is a
 * deliberate limit: the runtimes are box-local subscriptions anyway.
 */
import { runDueSchedules } from './workbench-service'

const TICK_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null
let tickInProgress = false

async function tick(): Promise<void> {
  if (tickInProgress) return
  tickInProgress = true
  try {
    await runDueSchedules()
  } catch (error) {
    console.error('[workbench] scheduler tick failed:', error)
  } finally {
    tickInProgress = false
  }
}

export function startScheduler(): void {
  if (timer) return
  // Reconcile missed local occurrences as soon as Studio boots.
  void tick()
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  // Never hold the process open just for the scheduler.
  timer.unref?.()
}

export function stopScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
