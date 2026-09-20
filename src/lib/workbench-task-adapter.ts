import type { HermesTask, TaskColumn } from '@/types/task'
import type { WorkbenchState, WorkbenchTaskStatus } from '@/types/workbench'

const WORKBENCH_PREFIX = 'workbench:'

const COLUMN_BY_STATUS: Record<WorkbenchTaskStatus, TaskColumn> = {
  backlog: 'backlog',
  ready: 'todo',
  running: 'in_progress',
  review: 'review',
  done: 'done',
}

/** Present project-bound crew work alongside legacy tasks without merging their stores. */
export function mapWorkbenchTasksToBoard(state: WorkbenchState): HermesTask[] {
  const projectNames = new Map(state.projects.map((project) => [project.id, project.name]))
  return state.tasks.map((task) => {
    const projectName = projectNames.get(task.projectId) ?? 'Project'
    return {
      id: `${WORKBENCH_PREFIX}${task.id}`,
      title: task.title,
      description: task.description || `Project task for ${projectName}`,
      column: COLUMN_BY_STATUS[task.status],
      priority: 'medium',
      assignee: projectName,
      tags: ['project-workbench'],
      dueDate: null,
      position: task.createdAt,
      sourceType: 'crew',
      sourceId: task.id,
      createdBy: 'Projects workbench',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
  })
}

export function isWorkbenchBoardTask(task: HermesTask): boolean {
  return task.id.startsWith(WORKBENCH_PREFIX)
}

export function workbenchTaskId(task: HermesTask): string | null {
  return isWorkbenchBoardTask(task) ? task.id.slice(WORKBENCH_PREFIX.length) : null
}
