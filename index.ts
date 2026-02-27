import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type Cfg = { port?: number; dbPath?: string };

function cfgOrDefault(cfg: Cfg | undefined) {
  return {
    port: cfg?.port ?? 5178,
    dbPath: cfg?.dbPath ?? "project-dashboard.sqlite",
  };
}

function buildHtml() {
  // MVP: single-file UI. Later: real frontend build.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Project Dashboard</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; }
    header { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; gap: 12px; align-items: baseline; }
    header h1 { font-size: 16px; margin: 0; }
    main { padding: 16px; display: grid; grid-template-columns: 360px 1fr; gap: 16px; }
    .card { border: 1px solid #eee; border-radius: 10px; padding: 12px; }
    .muted { color: #666; font-size: 12px; }
    input, select, textarea, button { width: 100%; padding: 8px; margin-top: 6px; }
    textarea { min-height: 80px; }
    ul { padding-left: 18px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Project Dashboard</h1>
    <div class="muted">Manual-first (local). MVP UI.</div>
  </header>
  <main>
    <section class="card">
      <div style="font-weight:600;">Add project</div>
      <input id="projectName" placeholder="Project name" />
      <button id="btnAddProject">Create</button>
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0;" />
      <div style="font-weight:600;">Add update</div>
      <select id="projectSelect"></select>
      <select id="updateType">
        <option value="note">note</option>
        <option value="progress">progress</option>
        <option value="decision">decision</option>
        <option value="blocker">blocker</option>
        <option value="request">request</option>
      </select>
      <textarea id="updateText" placeholder="What changed? What’s next? Any blocker?"></textarea>
      <button id="btnAddUpdate">Add update</button>
    </section>

    <section class="card">
      <div class="row">
        <div>
          <div style="font-weight:600;">Projects</div>
          <div class="muted" id="projectsMeta"></div>
        </div>
        <div style="text-align:right">
          <button id="btnRefresh">Refresh</button>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="card" style="border-radius:10px;">
          <div style="font-weight:600;">List</div>
          <ul id="projectsList"></ul>
        </div>
        <div class="card" style="border-radius:10px;">
          <div style="font-weight:600;">Recent updates</div>
          <ul id="updatesList"></ul>
        </div>
      </div>
      <div class="muted" style="margin-top:10px">Data is stored locally by the plugin runtime (in progress).</div>
    </section>
  </main>

<script>
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function el(id){ return document.getElementById(id); }

async function refresh(){
  const data = await api('/api/state');
  el('projectsMeta').textContent = `${data.projects.length} projects`;

  // list
  el('projectsList').innerHTML = data.projects.map(p => `<li><b>${p.name}</b> <span class='muted'>(${p.status})</span></li>`).join('') || '<li class="muted">No projects yet.</li>';
  el('updatesList').innerHTML = data.updates.slice(0, 10).map(u => `<li><b>${u.projectName}</b> — <span class='muted'>${u.type}</span><br/>${u.text}</li>`).join('') || '<li class="muted">No updates yet.</li>';

  // select
  el('projectSelect').innerHTML = data.projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

el('btnRefresh').addEventListener('click', refresh);

el('btnAddProject').addEventListener('click', async () => {
  const name = el('projectName').value.trim();
  if (!name) return;
  await api('/api/projects', { name });
  el('projectName').value = '';
  await refresh();
});

el('btnAddUpdate').addEventListener('click', async () => {
  const projectId = el('projectSelect').value;
  const type = el('updateType').value;
  const text = el('updateText').value.trim();
  if (!projectId || !text) return;
  await api('/api/updates', { projectId, type, text });
  el('updateText').value = '';
  await refresh();
});

refresh().catch(err => {
  console.error(err);
  alert('Failed to load: ' + err.message);
});
</script>
</body>
</html>`;
}

function createInMemoryStore() {
  // MVP: in-memory. Next step: SQLite persistence.
  const projects: Array<{ id: string; name: string; status: "green" | "yellow" | "red" }> = [];
  const updates: Array<{ id: string; projectId: string; type: string; text: string; ts: number }> = [];
  return {
    projects,
    updates,
    createProject: (name: string) => {
      const id = `p_${Math.random().toString(36).slice(2, 10)}`;
      projects.push({ id, name, status: "green" });
      return projects.at(-1)!;
    },
    addUpdate: (projectId: string, type: string, text: string) => {
      const id = `u_${Math.random().toString(36).slice(2, 10)}`;
      updates.unshift({ id, projectId, type, text, ts: Date.now() });
      return updates[0]!;
    },
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = cfgOrDefault((api.config?.get?.() as Cfg | undefined) ?? undefined);
  const store = createInMemoryStore();

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
          const projects = store.projects;
          const updates = store.updates.map((u) => {
            const p = projects.find((p) => p.id === u.projectId);
            return { ...u, projectName: p?.name ?? "(unknown)" };
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ projects, updates }));
          return;
        }

        if (req.method === "POST" && url === "/api/projects") {
          const body = await readJson(req);
          const name = String(body?.name ?? "").trim();
          if (!name) return json(res, 400, { error: "name required" });
          const proj = store.createProject(name);
          return json(res, 200, proj);
        }

        if (req.method === "POST" && url === "/api/updates") {
          const body = await readJson(req);
          const projectId = String(body?.projectId ?? "").trim();
          const type = String(body?.type ?? "note").trim();
          const text = String(body?.text ?? "").trim();
          if (!projectId || !text) return json(res, 400, { error: "projectId and text required" });
          const upd = store.addUpdate(projectId, type, text);
          return json(res, 200, upd);
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
        return { text: `Dashboard running: http://127.0.0.1:${cfg.port}/` };
      }

      if (cmd === "add-project") {
        const name = rest.join(" ").trim();
        if (!name) return { text: "Usage: /project-dashboard add-project <name>" };
        const proj = store.createProject(name);
        return { text: `Created project: ${proj.name} (${proj.id})` };
      }

      if (cmd === "add-update") {
        const [projectName, type, ...textParts] = rest;
        if (!projectName || !type || textParts.length === 0) {
          return { text: "Usage: /project-dashboard add-update <projectName> <type> <text...>" };
        }
        const proj = store.projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
        if (!proj) return { text: `Project not found: ${projectName}` };
        store.addUpdate(proj.id, type, textParts.join(" "));
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
