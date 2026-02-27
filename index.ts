import http from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { makeRepo, openDb, resolveDbPath, type UpdateType } from "./db.js";

type Cfg = { port?: number; dbPath?: string };

function cfgOrDefault(cfg: Cfg | undefined) {
  return {
    port: cfg?.port ?? 5178,
    dbPath: cfg?.dbPath ?? "project-dashboard.sqlite",
  };
}

function buildHtml() {
  // MVP: single-file UI (no build step). Style focus: clean, calm, usable.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Project Dashboard</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: rgba(255,255,255,0.06);
      --panel2: rgba(255,255,255,0.09);
      --text: rgba(255,255,255,0.92);
      --muted: rgba(255,255,255,0.65);
      --line: rgba(255,255,255,0.10);
      --good: #39d98a;
      --warn: #ffcc66;
      --bad: #ff5c7a;
      --accent: #78a6ff;
      --shadow: 0 20px 60px rgba(0,0,0,0.55);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--text);
      background: radial-gradient(1200px 700px at 15% 20%, rgba(120,166,255,0.18), transparent 55%),
                  radial-gradient(900px 600px at 80% 10%, rgba(57,217,138,0.12), transparent 50%),
                  radial-gradient(1000px 700px at 70% 80%, rgba(255,92,122,0.10), transparent 55%),
                  var(--bg);
      min-height: 100vh;
    }
    header {
      position: sticky; top: 0; z-index: 10;
      backdrop-filter: blur(10px);
      background: rgba(11,16,32,0.75);
      border-bottom: 1px solid var(--line);
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 14px 16px; }
    .titlebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .title { display: flex; flex-direction: column; gap: 2px; }
    h1 { font-size: 15px; margin: 0; letter-spacing: 0.2px; }
    .subtitle { font-size: 12px; color: var(--muted); }
    .pill {
      display: inline-flex; gap: 8px; align-items: center;
      padding: 7px 10px; border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--panel);
      font-size: 12px; color: var(--muted);
    }
    main { max-width: 1200px; margin: 0 auto; padding: 16px; }
    .grid { display: grid; grid-template-columns: 420px 1fr; gap: 14px; }
    @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }

    .card {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, var(--panel), rgba(255,255,255,0.03));
      border-radius: 16px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .cardHeader { padding: 12px 12px; border-bottom: 1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
    .cardTitle { font-size: 13px; font-weight: 650; }
    .cardBody { padding: 12px; }

    .stack { display: grid; gap: 10px; }

    input, select, textarea, button {
      width: 100%;
      padding: 10px 11px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: rgba(0,0,0,0.18);
      color: var(--text);
      outline: none;
    }
    textarea { min-height: 96px; resize: vertical; }
    input::placeholder, textarea::placeholder { color: rgba(255,255,255,0.45); }
    button {
      cursor: pointer;
      background: linear-gradient(180deg, rgba(120,166,255,0.35), rgba(120,166,255,0.18));
      border: 1px solid rgba(120,166,255,0.45);
      font-weight: 650;
    }
    button.secondary {
      background: rgba(255,255,255,0.06);
      border-color: var(--line);
      font-weight: 600;
    }
    button:active { transform: translateY(1px); }

    .kpiRow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    @media (max-width: 980px) { .kpiRow { grid-template-columns: 1fr; } }
    .kpi { padding: 10px; border-radius: 14px; border: 1px solid var(--line); background: rgba(255,255,255,0.04); }
    .kpiLabel { font-size: 11px; color: var(--muted); }
    .kpiValue { font-size: 18px; font-weight: 750; margin-top: 4px; }

    .statusDot { width: 9px; height: 9px; border-radius: 999px; display:inline-block; margin-right: 8px; }
    .dot-green { background: var(--good); }
    .dot-yellow { background: var(--warn); }
    .dot-red { background: var(--bad); }

    .list { display: grid; gap: 8px; }
    .item {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.04);
      border-radius: 14px;
      padding: 10px;
      display: grid;
      gap: 4px;
    }
    .itemTop { display:flex; align-items:center; justify-content:space-between; gap: 10px; }
    .itemTitle { font-weight: 700; font-size: 13px; }
    .itemMeta { color: var(--muted); font-size: 11px; }
    .badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line); padding: 3px 8px; border-radius: 999px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .tabs { display:flex; gap: 8px; flex-wrap: wrap; }
    .tab { padding: 7px 10px; border-radius: 999px; border:1px solid var(--line); background: rgba(255,255,255,0.05); color: var(--muted); cursor:pointer; font-size: 12px; }
    .tab.active { border-color: rgba(120,166,255,0.55); color: var(--text); background: rgba(120,166,255,0.14); }

    a { color: var(--accent); text-decoration: none; }
    .error { color: #ffd1d8; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="wrap titlebar">
      <div class="title">
        <h1>Project Dashboard</h1>
        <div class="subtitle">Manual-first. Local-first. Designed for clarity.</div>
      </div>
      <div class="pill"><span class="mono" id="dbMeta">DB</span> <span id="nowMeta"></span></div>
    </div>
  </header>

  <main>
    <div class="grid">
      <section class="card">
        <div class="cardHeader">
          <div class="cardTitle">Quick capture</div>
          <button class="secondary" id="btnRefresh" style="width:auto; padding: 8px 10px; border-radius: 12px;">Refresh</button>
        </div>
        <div class="cardBody stack">
          <div class="kpiRow">
            <div class="kpi"><div class="kpiLabel">Projects</div><div class="kpiValue" id="kpiProjects">—</div></div>
            <div class="kpi"><div class="kpiLabel">Blockers</div><div class="kpiValue" id="kpiBlockers">—</div></div>
            <div class="kpi"><div class="kpiLabel">Updates (24h)</div><div class="kpiValue" id="kpiUpdates">—</div></div>
          </div>

          <div class="stack">
            <div class="cardTitle" style="margin-top:4px">Create project</div>
            <input id="projectName" placeholder="e.g. GoatPort – onboarding flow" />
            <button id="btnAddProject">Create</button>
          </div>

          <div class="stack" style="margin-top:4px">
            <div class="cardTitle">Add update</div>
            <select id="projectSelect"></select>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <select id="updateType">
                <option value="progress">progress</option>
                <option value="blocker">blocker</option>
                <option value="decision">decision</option>
                <option value="note">note</option>
                <option value="request">request</option>
              </select>
              <select id="statusHint">
                <option value="">status: (no change)</option>
                <option value="green">status: green</option>
                <option value="yellow">status: yellow</option>
                <option value="red">status: red</option>
              </select>
            </div>
            <textarea id="updateText" placeholder="One sentence: what changed, what’s next, or what’s blocked." ></textarea>
            <button id="btnAddUpdate">Add update</button>
            <div class="error" id="formError" style="display:none"></div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="cardHeader">
          <div class="tabs" id="tabs">
            <div class="tab active" data-tab="overview">Overview</div>
            <div class="tab" data-tab="projects">Projects</div>
            <div class="tab" data-tab="updates">Updates</div>
          </div>
          <div class="badge" id="metaBadge">—</div>
        </div>
        <div class="cardBody">
          <div id="view_overview" class="stack"></div>
          <div id="view_projects" class="stack" style="display:none"></div>
          <div id="view_updates" class="stack" style="display:none"></div>
        </div>
      </section>
    </div>
  </main>

<script>
const el = (id) => document.getElementById(id);

function fmtAge(ms){
  if (ms < 60_000) return `${Math.floor(ms/1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms/60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms/3_600_000)}h`;
  return `${Math.floor(ms/86_400_000)}d`;
}

function statusDot(status){
  const cls = status === 'red' ? 'dot-red' : status === 'yellow' ? 'dot-yellow' : 'dot-green';
  return `<span class="statusDot ${cls}"></span>`;
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  } : {});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function setError(msg){
  const box = el('formError');
  if (!msg) { box.style.display='none'; box.textContent=''; return; }
  box.style.display='block';
  box.textContent = msg;
}

let STATE = null;

async function refresh(){
  setError('');
  const data = await api('/api/state');
  STATE = data;

  el('dbMeta').textContent = `SQLite`;
  el('nowMeta').textContent = new Date().toLocaleString();

  el('kpiProjects').textContent = data.projects.length;

  const blockers = data.recentUpdates.filter(u => u.type === 'blocker').length;
  el('kpiBlockers').textContent = blockers;

  const since = Date.now() - 24*60*60*1000;
  const updates24 = data.recentUpdates.filter(u => u.createdAt >= since).length;
  el('kpiUpdates').textContent = updates24;

  el('projectSelect').innerHTML = data.projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('') || `<option value="">(no projects)</option>`;
  el('metaBadge').textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;

  renderOverview();
  renderProjects();
  renderUpdates();
}

function renderOverview(){
  const root = el('view_overview');
  const projects = STATE.projects;
  const recent = STATE.recentUpdates;

  const red = projects.filter(p=>p.status==='red').length;
  const yellow = projects.filter(p=>p.status==='yellow').length;
  const green = projects.filter(p=>p.status==='green').length;

  const top = projects.slice(0, 6).map(p => {
    const age = fmtAge(Date.now() - p.updatedAt);
    const line = p.nextAction ? p.nextAction : (p.objective || '');
    return `<div class="item">
      <div class="itemTop">
        <div class="itemTitle">${statusDot(p.status)}${escapeHtml(p.name)}</div>
        <div class="badge">updated ${age} ago</div>
      </div>
      <div class="itemMeta">${escapeHtml(line || 'No next action set.')}</div>
    </div>`;
  }).join('');

  const feed = recent.slice(0, 10).map(u => {
    const age = fmtAge(Date.now() - u.createdAt);
    return `<div class="item">
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(u.projectName)}</div>
        <div class="badge">${escapeHtml(u.type)} · ${age} ago</div>
      </div>
      <div class="itemMeta">${escapeHtml(u.text)}</div>
    </div>`;
  }).join('') || `<div class="item"><div class="itemMeta">No updates yet.</div></div>`;

  root.innerHTML = `
    <div class="kpiRow">
      <div class="kpi"><div class="kpiLabel">Green</div><div class="kpiValue">${green}</div></div>
      <div class="kpi"><div class="kpiLabel">Yellow</div><div class="kpiValue">${yellow}</div></div>
      <div class="kpi"><div class="kpiLabel">Red</div><div class="kpiValue">${red}</div></div>
    </div>
    <div class="cardTitle" style="margin-top:6px">Most recently touched</div>
    <div class="list">${top || ''}</div>
    <div class="cardTitle" style="margin-top:6px">Recent activity</div>
    <div class="list">${feed}</div>
  `;
}

function renderProjects(){
  const root = el('view_projects');
  const projects = STATE.projects;
  if (!projects.length) {
    root.innerHTML = `<div class="item"><div class="itemMeta">No projects yet.</div></div>`;
    return;
  }
  root.innerHTML = projects.map(p => {
    const line = p.nextAction || p.objective || '';
    return `<div class="item">
      <div class="itemTop">
        <div class="itemTitle">${statusDot(p.status)}${escapeHtml(p.name)}</div>
        <div class="badge mono">${p.id}</div>
      </div>
      <div class="itemMeta">${escapeHtml(line || '—')}</div>
    </div>`;
  }).join('');
}

function renderUpdates(){
  const root = el('view_updates');
  const recent = STATE.recentUpdates;
  root.innerHTML = recent.map(u => {
    const age = fmtAge(Date.now() - u.createdAt);
    return `<div class="item">
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(u.projectName)}</div>
        <div class="badge">${escapeHtml(u.type)} · ${age} ago</div>
      </div>
      <div class="itemMeta">${escapeHtml(u.text)}</div>
    </div>`;
  }).join('') || `<div class="item"><div class="itemMeta">No updates yet.</div></div>`;
}

function switchTab(tab){
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  el('view_overview').style.display = tab === 'overview' ? '' : 'none';
  el('view_projects').style.display = tab === 'projects' ? '' : 'none';
  el('view_updates').style.display = tab === 'updates' ? '' : 'none';
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  switchTab(t.dataset.tab);
});

el('btnRefresh').addEventListener('click', refresh);

el('btnAddProject').addEventListener('click', async () => {
  try {
    const name = el('projectName').value.trim();
    if (!name) return;
    await api('/api/projects', { name });
    el('projectName').value = '';
    await refresh();
  } catch (err) {
    setError(err.message || String(err));
  }
});

el('btnAddUpdate').addEventListener('click', async () => {
  try {
    const projectId = el('projectSelect').value;
    const type = el('updateType').value;
    const text = el('updateText').value.trim();
    const status = el('statusHint').value;
    if (!projectId || !text) return;
    await api('/api/updates', { projectId, type, text, status: status || null });
    el('updateText').value = '';
    el('statusHint').value = '';
    await refresh();
  } catch (err) {
    setError(err.message || String(err));
  }
});

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

refresh().catch(err => {
  console.error(err);
  setError('Failed to load: ' + (err.message || err));
});
</script>
</body>
</html>`;
}

export default function register(api: OpenClawPluginApi) {
  const cfg = cfgOrDefault((api.config?.get?.() as Cfg | undefined) ?? undefined);

  // Resolve a state directory if runtime is present (newer OpenClaw). Fallback to cwd.
  const stateDir = (api as any)?.runtime?.state?.resolveStateDir
    ? (api as any).runtime.state.resolveStateDir((api as any).config)
    : process.cwd();

  const dbFile = resolveDbPath({ stateDir, dbPath: cfg.dbPath });

  // sql.js init is async; we lazily open on first use.
  let repoPromise: Promise<ReturnType<typeof makeRepo>> | null = null;
  function getRepo() {
    if (!repoPromise) {
      repoPromise = openDb(dbFile).then((db) => makeRepo(db));
    }
    return repoPromise;
  }

  let server: http.Server | null = null;

  async function ensureServer() {
    if (server) return;
    const html = buildHtml();

    server = http
      .createServer(async (req, res) => {
        const url = req.url || "/";

        if (req.method === "GET" && url === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        if (req.method === "GET" && url === "/api/state") {
          const repo = await getRepo();
          const projects = repo.listProjects();
          const recentUpdates = repo.listRecentUpdates(50);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            dbFile,
            projects,
            recentUpdates,
          }));
          return;
        }

        if (req.method === "POST" && url === "/api/projects") {
          const body = await readJson(req);
          const name = String(body?.name ?? "").trim();
          if (!name) return json(res, 400, { error: "name required" });
          try {
            const repo = await getRepo();
            const proj = repo.createProject(name);
            return json(res, 200, proj);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        if (req.method === "POST" && url === "/api/updates") {
          const body = await readJson(req);
          const projectId = String(body?.projectId ?? "").trim();
          const type = String(body?.type ?? "note").trim() as UpdateType;
          const text = String(body?.text ?? "").trim();
          const status = body?.status ? String(body.status) : null;

          if (!projectId || !text) return json(res, 400, { error: "projectId and text required" });
          try {
            const repo = await getRepo();
            if (status === "green" || status === "yellow" || status === "red") {
              repo.updateProject({ id: projectId, status: status as any });
            }
            const upd = repo.addUpdate({ projectId, type, text });
            return json(res, 200, upd);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        json(res, 404, { error: "not found" });
      })
      .listen(cfg.port, "127.0.0.1");
  }

  api.registerCommand({
    name: "project-dashboard",
    description: "Open the local project dashboard and add updates.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim();
      const [cmd, ...rest] = args.split(/\s+/).filter(Boolean);

      if (!cmd || cmd === "help") {
        return {
          text: [
            "Project Dashboard commands:",
            "",
            "/project-dashboard open",
            "/project-dashboard add-project <name>",
            "/project-dashboard add-update <projectName> <type> <text...>",
            "",
            "Types: note|progress|decision|blocker|request",
          ].join("\n"),
        };
      }

      if (cmd === "open") {
        await ensureServer();
        return { text: `Dashboard running: http://127.0.0.1:${cfg.port}/ (db: ${dbFile})` };
      }

      if (cmd === "add-project") {
        const name = rest.join(" ").trim();
        if (!name) return { text: "Usage: /project-dashboard add-project <name>" };
        const repo = await getRepo();
        const proj = repo.createProject(name);
        return { text: `Created project: ${proj.name} (${proj.id})` };
      }

      if (cmd === "add-update") {
        const [projectName, type, ...textParts] = rest;
        if (!projectName || !type || textParts.length === 0) {
          return { text: "Usage: /project-dashboard add-update <projectName> <type> <text...>" };
        }
        const repo = await getRepo();
        const proj = repo.getProjectByName(projectName);
        if (!proj) return { text: `Project not found: ${projectName}` };
        repo.addUpdate({ projectId: proj.id, type: type as any, text: textParts.join(" ") });
        return { text: `Added update to ${proj.name}.` };
      }

      return { text: "Unknown subcommand. Try /project-dashboard help" };
    },
  });
}

function json(res: http.ServerResponse, status: number, body: any) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
