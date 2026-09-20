# Projects Workbench Implementation Plan

> For Hermes: use subagent-driven-development with test-first implementation and spec then quality review.

Goal: make Studio the user's project-oriented delegation cockpit, separating subscription/local runtime, model, and reusable agent role/personality. Ship a usable, safe read-only first slice rather than pretend unrestricted coding delegation is safe.

Architecture: add /projects with server-persisted projects, work items and run records. Reuse existing Agent Library for roles/personality. Use a runtime adapter for explicit Hermes openai-codex OAuth, Claude subscription, and local Ollama. No fallback to paid API providers. Runs consume an explicitly selected, bounded text source snapshot and have no tools. Reports are analysis of those inputs, not autonomous whole-repo audits. Browser reloads recover state from SQLite. Interrupted server runs become interrupted, never silently re-executed.

Tech: existing React/TanStack routes, better-sqlite3, Node spawn without shell, existing pnpm/Vitest. No new dependencies. Other projects remain unmodified.

## Contract

Shared types: src/types/workbench.ts. Endpoint /api/workbench:
GET returns {projects,tasks,runs,connections,roles}; roles are existing AgentDefinition[] from listAgents().
POST discriminated action:
- scan: discover direct child git projects of ~/projects (register metadata only)
- project: {name,path,description?} register a canonical path beneath configured project root
- task: {projectId,title,description?} create work item
- task-status: {taskId,status:'backlog'|'ready'|'done'}; reject changes during an active run
- run: {taskId,connectionId,model,roleId,files:string[]} submit exactly one analysis run, with task/project lookup and explicit file scope
- cancel: {runId} cancel process/fetch and persist cancelled status
Response is {ok:true, ...} or HTTP error {error:string}. GET catalog detection must not start models.

Task status and run status are separate. Successful model generation yields task status review, not done. User manually marks done. Role/model choices are immutable snapshots on each run. A rerun on a different model requires explicit action. Duplicate simultaneous runs on a task are rejected atomically.

GET /api/workbench-files?projectId=... lists safe tracked text candidates (no content) for explicit user selection.

## Implementation areas (disjoint ownership)

1. runtime: src/server/workbench-runtime.ts and src/test/workbench-runtime.test.ts. Write and run failing tests for exact runtime/model routing, tool-free mode, auth-type checks, no paid fallback, bounded output, timeout/cancel, error responses. Implement then test. Export listConnections(), executeAnalysis({connectionId,model,prompt,signal,onOutput?}) returning {output,actualModel?,usage?}. All requests explicit provider/model; CLI stdin, shell:false. Detect auth using supported CLI metadata, never print/store tokens. Use installed CLI help and Hermes source to verify no tools or fallback. If strict isolation cannot be proven fail closed.
2. persistence/service/routes: src/server/workbench-store.ts, workbench-service.ts, src/routes/api/workbench.ts, workbench-files.ts, corresponding tests. SQLite WAL synchronous writes, foreign-key safety, schema checks, atomic duplicate claim, context path bounds using canonical paths/no symlinks, only selected git-tracked text files, no secrets/binary/huge files. Snapshot up to 60k chars total and 8 files, line-numbered. Read-only root operations must never execute project code/git hooks. Server records retain output/errors after reload; cancellation wins races. Enforce app auth, JSON CSRF and same-origin mutating requests; do not expose filesystem to unauthenticated remote requests. Scope discovery to ~/projects. Bound concurrency (2 cloud, 1 local or simply 2 total and 1 local). Read-only first slice rejects write mode. Reuse listAgents() for role prompts.
3. frontend: src/screens/projects/projects-screen.tsx, src/routes/projects.tsx, appropriate tests and navigation. Render project list with selected-project task queue, task creation/status, connection/model/role selectors, explicitly selected context files, run button (disabled when disconnected/pending/no scope), persistent run detail/status/output/errors/cancel. Explain snapshot-only read-only, subscription allowance vs estimated price, server interrupted behavior. Link Agent Library for creating roles; do not duplicate its persistence. SSR safe, keyboard accessible, responsive with existing dark design conventions. Empty/loading/error states.
4. parent: fix legacy Conductor reload behavior test-first without fabricating mission success; preserve persisted running/decomposing keys and hydrate client storage before any idle-state deletion. Document root/roles/runtime behavior and actual limitations. Integrate contract; verify all areas.

## Acceptance / real verification

Run pnpm test and pnpm run build, retain output/exit codes. Review changes spec-first, then security/quality. Start rebuilt Studio and perform real UI project scan, task create, file selection, role selection, run and refresh; verify record survives and returns real provider output. Run tiny model checks on all three connections, label failures accurately and never silently switch providers. Test cross-root/symlink/secret selections and duplicate dispatch rejection. Verify task repos git state unchanged; no blanket byte-identical claims without hash baselines. Report exactly what works and what needs user auth or future editing permission. Do not commit/push without review; do not modify unrelated projects, gateway configuration, or profiles.
