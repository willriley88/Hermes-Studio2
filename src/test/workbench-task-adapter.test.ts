import { describe, expect, it } from 'vitest'
import {
  isWorkbenchBoardTask,
  mapWorkbenchTasksToBoard,
  workbenchTaskId,
} from '@/lib/workbench-task-adapter'
import type { WorkbenchState } from '@/types/workbench'

const STATE = {
  projects: [{ id: 'p1', name: 'clubhouse', path: '/tmp/clubhouse', description: '', createdAt: 1 }],
  tasks: [{
    id: 't1', projectId: 'p1', title: 'Review login', description: '',
    status: 'review', createdAt: 2, updatedAt: 3,
  }],
  runs: [], connections: [], roles: [], crews: [], members: [], schedules: [],
} satisfies WorkbenchState

describe('workbench task board adapter', () => {
  it('surfaces project tasks in the shared task board with matching progression', () => {
    const [task] = mapWorkbenchTasksToBoard(STATE)

    expect(task.id).toBe('workbench:t1')
    expect(task.column).toBe('review')
    expect(task.assignee).toBe('clubhouse')
    expect(task.sourceType).toBe('crew')
    expect(isWorkbenchBoardTask(task)).toBe(true)
    expect(workbenchTaskId(task)).toBe('t1')
  })

  it('maps running and ready project states into the board columns', () => {
    const running = mapWorkbenchTasksToBoard({
      ...STATE,
      tasks: [
        { ...STATE.tasks[0], id: 'ready', status: 'ready' },
        { ...STATE.tasks[0], id: 'running', status: 'running' },
      ],
    })

    expect(running.map((task) => task.column)).toEqual(['todo', 'in_progress'])
  })
})