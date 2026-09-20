import { useEffect, useMemo, useState } from 'react'
import type {
  ConnectionId,
  WorkbenchCrew,
  WorkbenchRunMode,
  WorkbenchState,
} from '@/types/workbench'

type Props = {
  state: WorkbenchState
  projectId: string | null
  busy: boolean
  post: (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function fmtTime(value: number | null): string {
  if (!value) return 'never'
  return new Date(value).toLocaleString()
}

export function CrewAutomationPanel({ state, projectId, busy, post }: Props) {
  const crews = useMemo(
    () => state.crews.filter((crew) => crew.projectId === projectId),
    [state.crews, projectId],
  )
  const [crewId, setCrewId] = useState('')
  const crew: WorkbenchCrew | null = crews.find((item) => item.id === crewId) ?? crews[0] ?? null

  const [newName, setNewName] = useState('')
  const [newCharter, setNewCharter] = useState('')
  const [charter, setCharter] = useState('')
  const [agenda, setAgenda] = useState('')
  const [mode, setMode] = useState<WorkbenchRunMode>('analyze')
  const [frequency, setFrequency] = useState('daily')
  const [memberRoleId, setMemberRoleId] = useState('')
  const [memberConnectionId, setMemberConnectionId] = useState<ConnectionId>('claude')
  const [memberModel, setMemberModel] = useState('')

  useEffect(() => {
    if (crew && crew.id !== crewId) setCrewId(crew.id)
  }, [crew, crewId])

  useEffect(() => {
    setCharter(crew?.charter ?? '')
  }, [crew?.id, crew?.charter])

  useEffect(() => {
    if (!memberRoleId && state.roles.length > 0) setMemberRoleId(state.roles[0].id)
  }, [memberRoleId, state.roles])

  const connection = state.connections.find((item) => item.id === memberConnectionId) ?? null
  useEffect(() => {
    if (!connection) return
    if (!connection.models.includes(memberModel)) setMemberModel(connection.models[0] ?? '')
  }, [connection, memberModel])

  const members = crew ? state.members.filter((member) => member.crewId === crew.id) : []
  const schedules = crew ? state.schedules.filter((schedule) => schedule.crewId === crew.id) : []
  const role = state.roles.find((item) => item.id === memberRoleId)
  const hasEditMember = members.some(
    (member) => member.connectionId === 'chatgpt' || member.connectionId === 'claude',
  )

  if (!projectId) return null

  if (!crew) {
    return (
      <section className="rounded-lg border border-cyan-500/20 bg-zinc-900/50 p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-zinc-100">Standing crew</h2>
          <p className="text-xs text-zinc-500">
            Bind a permanent charter and a set of subscription-backed roles to this project.
          </p>
        </div>
        <form
          className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newName.trim()) return
            void post({
              action: 'crew',
              projectId,
              name: newName.trim(),
              charter: newCharter.trim(),
            }).then((payload) => {
              const created = payload?.crew as { id?: string } | undefined
              if (created?.id) setCrewId(created.id)
              setNewName('')
              setNewCharter('')
            })
          }}
        >
          <input
            aria-label="Crew name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Clubhouse crew"
            className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          />
          <textarea
            aria-label="Crew charter"
            value={newCharter}
            onChange={(event) => setNewCharter(event.target.value)}
            placeholder="What this project is, who it serves, and what done looks like…"
            rows={3}
            className="resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="self-end rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-40"
          >
            Create crew
          </button>
        </form>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-cyan-500/20 bg-zinc-900/50 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Crew automation</h2>
          <p className="text-xs text-zinc-500">
            Each seat runs on its own subscription or local model. Scheduled edits stop at a pending diff.
          </p>
        </div>
        <select
          aria-label="Active crew"
          value={crew.id}
          onChange={(event) => setCrewId(event.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
        >
          {crews.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Standing charter</label>
            <textarea
              aria-label="Standing charter"
              value={charter}
              onChange={(event) => setCharter(event.target.value)}
              rows={7}
              className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs leading-relaxed outline-none focus:border-cyan-500"
            />
            <button
              type="button"
              disabled={busy || charter === crew.charter}
              onClick={() => void post({ action: 'crew-update', crewId: crew.id, charter })}
              className="mt-2 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40"
            >
              Save charter
            </button>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Seats</h3>
              <span className="text-[11px] text-zinc-600">{members.length} member{members.length === 1 ? '' : 's'}</span>
            </div>
            <div className="mb-3 space-y-2">
              {members.map((member) => (
                <div key={member.id} className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <div>
                    <p className="text-sm text-zinc-200">{member.roleName}</p>
                    <p className="text-[11px] uppercase tracking-wide text-cyan-400">
                      {member.connectionId} · {member.model}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void post({ action: 'member-remove', memberId: member.id })}
                    className="text-xs text-zinc-500 hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {members.length === 0 ? (
                <p className="rounded-md border border-dashed border-zinc-800 px-3 py-3 text-xs text-zinc-500">
                  Add a seat before launching a mission.
                </p>
              ) : null}
            </div>

            <form
              className="grid gap-2 sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (!role || !memberModel) return
                void post({
                  action: 'member',
                  crewId: crew.id,
                  roleId: role.id,
                  roleName: role.name,
                  connectionId: memberConnectionId,
                  model: memberModel,
                })
              }}
            >
              <select
                aria-label="Member role"
                value={memberRoleId}
                onChange={(event) => setMemberRoleId(event.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs"
              >
                {state.roles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.roleLabel}</option>)}
              </select>
              <select
                aria-label="Member runtime"
                value={memberConnectionId}
                onChange={(event) => setMemberConnectionId(event.target.value as ConnectionId)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs"
              >
                {state.connections.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.available}>{item.name}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <select
                  aria-label="Member model"
                  value={memberModel}
                  onChange={(event) => setMemberModel(event.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs"
                >
                  {(connection?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button
                  type="submit"
                  disabled={busy || !memberModel || !role}
                  className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs text-cyan-300 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Mission or meeting agenda</label>
            <textarea
              aria-label="Crew task"
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
              rows={6}
              placeholder="What should the crew investigate, decide, or change?"
              className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !agenda.trim() || members.length === 0}
                onClick={() => void post({
                  action: 'crew-dispatch', crewId: crew.id,
                  task: `Crew meeting agenda:\n${agenda.trim()}`, mode: 'analyze', files: [],
                })}
                className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-300 disabled:opacity-40"
              >
                Start meeting
              </button>
              <button
                type="button"
                disabled={busy || !agenda.trim() || members.length === 0 || (mode === 'edit' && !hasEditMember)}
                onClick={() => void post({
                  action: 'crew-dispatch', crewId: crew.id,
                  task: agenda.trim(), mode, files: [],
                })}
                className="rounded-md bg-cyan-500 px-3 py-2 text-xs font-medium text-zinc-950 disabled:opacity-40"
              >
                Launch mission
              </button>
              <div className="flex rounded-md border border-zinc-700 p-0.5">
                {(['analyze', 'edit'] as WorkbenchRunMode[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-label={`Crew ${item} mode`}
                    onClick={() => setMode(item)}
                    className={`rounded px-2 py-1 text-[11px] capitalize ${mode === item ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500'}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'edit' && !hasEditMember ? (
              <p className="mt-2 text-xs text-amber-400">Add a Claude or ChatGPT seat to run edit missions.</p>
            ) : null}
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Schedule this mission</h3>
            <p className="mb-3 text-[11px] text-zinc-600">
              Runs while this Studio server is online. Edit schedules produce reviewable patches and never auto-apply.
            </p>
            <div className="flex gap-2">
              <select
                aria-label="Schedule frequency"
                value={frequency}
                onChange={(event) => setFrequency(event.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-xs"
              >
                <option value="hourly">Every hour</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
              <button
                type="button"
                disabled={busy || !agenda.trim() || members.length === 0 || (mode === 'edit' && !hasEditMember)}
                onClick={() => void post({
                  action: 'schedule', crewId: crew.id, taskTemplate: agenda.trim(),
                  mode, files: [], schedule: frequency,
                })}
                className="rounded-md border border-cyan-500/40 px-3 py-2 text-xs text-cyan-300 disabled:opacity-40"
              >
                Add schedule
              </button>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Schedules</h3>
            <div className="space-y-2">
              {schedules.map((schedule) => (
                <div key={schedule.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-zinc-200">{schedule.taskTemplate}</p>
                      <p className="mt-1 text-[11px] uppercase tracking-wide text-zinc-500">
                        {schedule.schedule} · {schedule.mode} · next {fmtTime(schedule.nextRunAt)}
                      </p>
                      {schedule.lastError ? (
                        <p className="mt-1 text-[11px] text-red-400">Last occurrence: {schedule.lastError}</p>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void post({ action: 'schedule-run-now', scheduleId: schedule.id })}
                        className="text-xs text-cyan-400 disabled:opacity-40"
                      >
                        Run now
                      </button>
                      <button
                        type="button"
                        onClick={() => void post({ action: 'schedule-toggle', scheduleId: schedule.id, enabled: !schedule.enabled })}
                        className={`text-xs ${schedule.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}
                      >
                        {schedule.enabled ? 'On' : 'Off'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void post({ action: 'schedule-delete', scheduleId: schedule.id })}
                        className="text-xs text-zinc-500 hover:text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {schedules.length === 0 ? <p className="text-xs text-zinc-600">No recurring missions yet.</p> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
