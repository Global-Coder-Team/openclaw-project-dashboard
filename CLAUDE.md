# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An OpenClaw plugin that provides a local-first project dashboard with a web UI and agent-friendly commands. It uses an in-process SQLite database (via sql.js/WASM) and a built-in HTTP server. There is no build step and no test suite.

## Commands

```bash
npm install          # Install dependencies (openclaw, sql.js)
```

There is no build or test command — `package.json` scripts are stubs. The plugin is loaded directly by the OpenClaw runtime via the `openclaw.extensions` field in `package.json`.

## Architecture

This is a single-plugin codebase with four files that matter:

- **`index.ts`** — Plugin entry point. Exports a `register(api)` function called by OpenClaw. Registers the `/project-dashboard` command and spins up an HTTP server (default port 5178) with a REST API. All API routes are defined inline here.
- **`db.ts`** — SQLite layer. Uses sql.js (WASM, no native bindings). Handles schema migration, persistence (export full DB to file on every write), and exposes a repository via `makeRepo(db)` with CRUD for projects, updates, and tasks.
- **`bootstrap.ts`** — Seed data logic. Reads workspace files (MEMORY.md, SOUL.md, USER.md) and OpenClaw cron state to infer initial projects. Also provides `loadCronJobsFromStateDir()` used by the API to map cron jobs to projects.
- **`ui.html`** — Single-file SPA (vanilla JS, no framework). Fetches `/api/state` and renders everything client-side. Dark theme with tab-based project detail views (overview, tasks, schedules, strategy, updates).

### Data Flow

1. OpenClaw loads the plugin → `register()` in `index.ts`
2. On first API call, `openDb()` lazily initializes sql.js and opens/creates the SQLite file
3. The HTTP server serves `ui.html` at `/` and JSON API at `/api/*`
4. Every DB write calls `persist()` which exports the entire database to disk via `writeFileSync`

### Key Types

- `Project` — has traffic-light status (`green`/`yellow`/`red`), strategy fields (strategy, hypothesis, constraints, success), objective, nextAction, dueDate
- `Update` — typed journal entries per project (`note`/`progress`/`decision`/`blocker`/`request`)
- `Task` — simple kanban (`todo`/`doing`/`done`) per project
- `CronJob` — read-only from OpenClaw state directory, mapped to projects by name prefix heuristics

### API Routes (all on the HTTP server)

- `GET /` — serves `ui.html`
- `GET /api/state` — full state dump (projects, updates, schedules, tasks, active pulse)
- `POST /api/projects` — create project (`{name}`)
- `POST /api/projects/update` — patch project (`{id, ...fields}`)
- `POST /api/updates` — add update (`{projectId, type, text, status?}`)
- `POST /api/tasks` — add task (`{projectId, title, status?}`)
- `POST /api/tasks/update` — update task (`{id, status?, title?}`)

### Plugin Configuration

Defined in `openclaw.plugin.json` configSchema:
- `port` (default 5178) — HTTP server port
- `dbPath` (default `"project-dashboard.sqlite"`) — SQLite file path, resolved relative to OpenClaw state directory

## Conventions

- ESM only (`"type": "module"` in package.json)
- TypeScript files are executed directly by the OpenClaw runtime (no transpilation step)
- IDs are generated as random strings with type prefixes: `p_` (project), `u_` (update), `t_` (task)
- DB migrations are additive — new columns use `ALTER TABLE ... ADD COLUMN` with existence checks
- The `persist()` pattern exports the full sql.js database to a Buffer and writes the entire file on every mutation
