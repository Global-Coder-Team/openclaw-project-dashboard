import http from "node:http";
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { makeRepo, openDb, resolveDbPath, type UpdateType } from "./db.js";
import { inferSeedProjects, loadCronJobsFromStateDir } from "./bootstrap.js";

type Cfg = { port?: number; dbPath?: string; bootstrapOnEmpty?: boolean };

function cfgOrDefault(cfg: Cfg | undefined) {
  return {
    port: cfg?.port ?? 5178,
    dbPath: cfg?.dbPath ?? "project-dashboard.sqlite",
    bootstrapOnEmpty: cfg?.bootstrapOnEmpty !== false,
  };
}

function buildHtml() {
  const htmlPath = new URL("./ui.html", import.meta.url);
  return readFileSync(htmlPath, "utf8");
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
          const jobs = loadCronJobsFromStateDir(stateDir);
          const schedules = mapCronToProjects(projects, jobs);
          const tasks = projects.map((p) => ({ projectId: p.id, items: repo.listTasks(p.id) }));
          const active = computeActive(projects, recentUpdates, tasks, schedules);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            dbFile,
            projects,
            recentUpdates,
            schedules,
            tasks,
            active,
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

        if (req.method === "POST" && url === "/api/projects/update") {
          const body = await readJson(req);
          const id = String(body?.id ?? "").trim();
          if (!id) return json(res, 400, { error: "id required" });
          const patch: any = { id };
          for (const key of ["name", "status", "objective", "nextAction", "strategy", "hypothesis", "constraints", "success", "dueDate"]) {
            if (body?.[key] !== undefined && body?.[key] !== null) patch[key] = body[key];
          }
          try {
            const repo = await getRepo();
            const proj = repo.updateProject(patch);
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

        if (req.method === "POST" && url === "/api/tasks") {
          const body = await readJson(req);
          const projectId = String(body?.projectId ?? "").trim();
          const title = String(body?.title ?? "").trim();
          const status = body?.status ? String(body.status) : undefined;
          if (!projectId || !title) return json(res, 400, { error: "projectId and title required" });
          try {
            const repo = await getRepo();
            const task = repo.addTask({ projectId, title, status });
            return json(res, 200, task);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        if (req.method === "POST" && url === "/api/tasks/update") {
          const body = await readJson(req);
          const id = String(body?.id ?? "").trim();
          const status = body?.status ? String(body.status) : undefined;
          const title = body?.title ? String(body.title) : undefined;
          if (!id) return json(res, 400, { error: "id required" });
          try {
            const repo = await getRepo();
            const task = repo.updateTask({ id, status: status as any, title });
            return json(res, 200, task);
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

function mapCronToProjects(
  projects: Array<{ id: string; name: string }>,
  jobs: Array<{ name: string; id: string; status?: string; lastAt?: number | null; nextAt?: number | null }>
) {
  const lowerProjects = projects.map((p) => ({ ...p, key: p.name.toLowerCase() }));
  const findBy = (pred: (name: string) => boolean) => lowerProjects.find((p) => pred(p.key))?.id ?? null;

  return jobs.map((j) => {
    const name = j.name || "";
    const lower = name.toLowerCase();
    let projectId: string | null = null;

    // Prefix mapping
    if (lower.startsWith("church-")) projectId = findBy((k) => k.includes("church outreach"));
    else if (lower.startsWith("burundi-")) projectId = findBy((k) => k.includes("burundi"));
    else if (lower.startsWith("goatport")) projectId = findBy((k) => k.includes("goatport"));
    else if (lower.startsWith("globalcoder") || lower.startsWith("global-coder"))
      projectId = findBy((k) => k.includes("global coder"));
    else if (lower.startsWith("nightly-learning")) projectId = findBy((k) => k.includes("automation"));

    return {
      jobId: j.id,
      jobName: name,
      status: j.status ?? "unknown",
      lastAt: j.lastAt ?? null,
      nextAt: j.nextAt ?? null,
      projectId,
    };
  });
}

function computeActive(projects: any[], updates: any[], tasks: any[], schedules: any[]) {
  const now = Date.now();
  return projects.map((p) => {
    const upd = updates.find((u) => u.projectId === p.id && now - u.createdAt <= 10 * 60 * 1000);
    const taskBlock = tasks.find((t: any) => t.projectId === p.id) || { items: [] };
    const doing = (taskBlock.items || []).find((t: any) => t.status === "doing" && now - t.updatedAt <= 15 * 60 * 1000);
    const schedule = schedules.find((s: any) => s.projectId === p.id && s.lastAt && now - s.lastAt <= 5 * 60 * 1000);
    const reasons: string[] = [];
    if (upd) reasons.push(`Recent update ${Math.floor((now - upd.createdAt) / 60000)}m ago`);
    if (doing) reasons.push(`Task in progress: ${doing.title}`);
    if (schedule) reasons.push(`Schedule ran ${Math.floor((now - schedule.lastAt) / 60000)}m ago: ${schedule.jobName}`);
    return { projectId: p.id, reasons };
  });
}

