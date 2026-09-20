import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { ProjectsScreen } from '@/screens/projects/projects-screen'

type ProjectsSearch = {
  projectId?: string
  taskId?: string
}

export const Route = createFileRoute('/projects')({
  validateSearch: (search: Record<string, unknown>): ProjectsSearch => ({
    projectId: typeof search.projectId === 'string' ? search.projectId : undefined,
    taskId: typeof search.taskId === 'string' ? search.taskId : undefined,
  }),
  component: function ProjectsRoute() {
    usePageTitle('Projects')
    const search = Route.useSearch()
    return <ProjectsScreen initialProjectId={search.projectId} initialTaskId={search.taskId} />
  },
})
