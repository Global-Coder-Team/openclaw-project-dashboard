# OpenClaw Project Dashboard

Local-first project dashboard plugin for OpenClaw.

This plugin runs a small local web server (default **http://127.0.0.1:5178/**) backed by a SQLite file and shows:
- **Projects** (with per-project tabs)
- **Work Queue** (what the agent/human should do next)
- **Cron Health** (reads OpenClaw cron state locally)
- **Recent Activity / Updates**

The goal: *one place to see what’s moving across all projects, automation, research, and ideas.*

---

## Quick start (local dev install)

### 1) Ensure the plugin is loaded
In `~/.openclaw/openclaw.json`, add the plugin repo path:

```jsonc
{
  "plugins": {
    "load": {
      "paths": [
        "C:/Users/<you>/.openclaw/workspace/plugin-repos/openclaw-project-dashboard"
      ]
    }
  }
}
```

### 2) Fix `plugins.allow` (recommended)
If you use a plugin allowlist, include at least:

```jsonc
{
  "plugins": {
    "allow": [
      "whatsapp",
      "memory-lancedb",
      "openclaw-project-dashboard"
    ]
  }
}
```

### 3) Restart the gateway
```bash
openclaw gateway restart
```

### 4) Open the dashboard
By default the dashboard server **auto-starts** with the gateway.

- Dashboard UI: **http://127.0.0.1:5178/**
- API: **http://127.0.0.1:5178/api/state**

If you ever disable auto-start, you can still run:
```
/project-dashboard open
```

---

## How it stays populated (important)

### Auto-seeding projects
On refresh, the plugin **ensures baseline projects exist** and also tries to infer core projects from your workspace memory files and cron names.

Baseline buckets:
- `Inbox / Triage`
- `Research / Opportunities`
- `Ideas / Backlog`

### Cron Health (local-first)
Cron jobs are loaded from OpenClaw state (no RPC):
- `~/.openclaw/cron/jobs.json`

The dashboard maps cron jobs → projects by name prefix:
- `church-*` → `OCI - Church Outreach (Harvest Week 2026)`
- `burundi-*` → `OCI - Burundi Medical Camp / Harvest Week 2026 Ops`
- `goatport*` → `GoatPort (SaaS)`
- `globalcoder*` → `Global Coder (...)`
- `nightly-learning-*` → `OpenClaw Automation System`

---

## Configuration

Configuration keys (plugin config):
- `port` (default `5178`)
- `dbPath` (default `project-dashboard.sqlite`)
  - If relative, it is stored under the OpenClaw **state directory**.
- `bootstrapOnEmpty` (default `true`) — auto-seed projects
- `autoStart` (default `true`) — start the web server when the plugin loads

---

## Commands

- `/project-dashboard open`
- `/project-dashboard add-project <name>`
- `/project-dashboard add-update <projectName> <type> <text...>`

Types: `note | progress | decision | blocker | request`

---

## Suggested onboarding for new users (planned)

A good onboarding flow should:
- Verify OpenClaw state directory access
- Verify cron state file exists (`cron/jobs.json`)
- Verify chosen port is free
- Confirm plugin allowlist includes required ids
- Seed baseline projects and show “next actions”

(We’ll keep tightening this as we learn what breaks in real installs.)

---

## License
MIT
