import http from "node:http";
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { makeRepo, openDb, resolveDbPath, type UpdateType } from "./db.js";
import { inferSeedProjects, loadCronJobsFromStateDir } from "./bootstrap.js";
import { ingestDailyMemory, ingestLearnings } from "./ingest.js";

type Cfg = { port?: number; dbPath?: string; bootstrapOnEmpty?: boolean; autoStart?: boolean };

function cfgOrDefault(cfg: Cfg | undefined) {
  return {
    port: cfg?.port ?? 5178,
    dbPath: cfg?.dbPath ?? "project-dashboard.sqlite",
    bootstrapOnEmpty: cfg?.bootstrapOnEmpty !== false,
    autoStart: cfg?.autoStart !== false,
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

  const workspaceDir = ((api as any)?.runtime?.workspace?.dir as string | undefined) ?? process.cwd();
  const dbFile = resolveDbPath({ stateDir, dbPath: cfg.dbPath });

  // sql.js init is async; we lazily open on first use.
  let repoPromise: Promise<ReturnType<typeof makeRepo>> | null = null;
  function getRepo() {
    if (!repoPromise) {
      repoPromise = openDb(dbFile).then((db) => makeRepo(db));
    }
    return repoPromise;
  }

  async function regenerateMd(repo: Awaited<ReturnType<typeof getRepo>>) {
    const { generateAgentQueueMd, writeAgentQueueMd } = await import("./markdown.js");
    const queueItems = repo.listQueue();
    const projects = repo.listProjects();
    const recentlyCompleted = repo.listRecentlyCompleted();
    const content = generateAgentQueueMd({ queueItems, projects, recentlyCompleted });
    writeAgentQueueMd(workspaceDir, content);
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
          // Auto-seed/ensure core projects exist (keeps dashboard populated even when you never manually add projects)
          if (cfg.bootstrapOnEmpty) {
            ensureSeeded(repo, { workspaceDir, stateDir });
          }

          // Auto-ingest workspace signals so the dashboard stays populated.
          try {
            ingestLearnings(repo as any, workspaceDir);
            ingestDailyMemory(repo as any, workspaceDir, 2);
          } catch {
            // best-effort only
          }

          const projects = repo.listProjects();
          const recentUpdates = repo.listRecentUpdates(50);
          const jobs = loadCronJobsFromStateDir(stateDir);
          const schedules = mapCronToProjects(projects, jobs);
          const tasks = projects.map((p) => ({ projectId: p.id, items: repo.listTasks(p.id) }));
          const active = computeActive(projects, recentUpdates, tasks, schedules);

          // Update cron snapshots and detect changes
          for (const j of jobs) {
            const prev = repo.getCronSnapshot(j.id);
            const status = j.status ?? "unknown";
            const changed = !prev || prev.lastStatus !== status || (j.lastAt && j.lastAt !== prev.lastSeenAt);
            if (changed) {
              repo.upsertCronSnapshot({ jobId: j.id, lastStatus: status });

              // Log activity + write an update into the mapped project so information "flows".
              const mapped = schedules.find((s: any) => s.jobId === j.id);
              const projectId = mapped?.projectId ?? null;

              repo.logActivity({
                projectId,
                source: "agent",
                action: status === "failure" || status === "error" ? "cron_failed" : "cron_ran",
                detail: j.name,
              });

              if (projectId) {
                const txt = `${j.name} → ${status}${j.lastAt ? ` @ ${new Date(j.lastAt).toLocaleString()}` : ""}`;
                const type: UpdateType = status === "error" || status === "failure" ? "blocker" : "progress";
                repo.addUpdate({ projectId, type, text: txt });

                // Auto-set project status from cron result
                if (status === "error" || status === "failure") repo.updateProject({ id: projectId, status: "red" } as any);
                else if (status === "unknown") repo.updateProject({ id: projectId, status: "yellow" } as any);
              }
            }
          }

          // New fields
          const queue = repo.listQueue();
          const activityFeed = repo.listActivity(20);
          const snapshots = repo.listCronSnapshots();
          const cronHealth = jobs.map((j) => {
            const snap = snapshots.find((s) => s.jobId === j.id);
            const lastStatus = (j.status ?? snap?.lastStatus ?? "unknown");
            const lastError = (j as any).lastError ?? snap?.lastError ?? null;
            const lastSeenAt = snap?.lastSeenAt ?? null;
            return {
              ...j,
              lastStatus,
              lastError,
              lastSeenAt,
              health: deriveHealth({ lastStatus, lastSeenAt, lastAt: j.lastAt ?? null }),
            };
          });

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            dbFile,
            projects,
            recentUpdates,
            schedules,
            tasks,
            active,
            queue,
            activity: activityFeed,
            cronHealth,
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
            await regenerateMd(repo);
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

        // ── Queue routes ──

        if (req.method === "GET" && url === "/api/queue") {
          const repo = await getRepo();
          return json(res, 200, repo.listQueue());
        }

        if (req.method === "POST" && url === "/api/queue") {
          const body = await readJson(req);
          const instruction = String(body?.instruction ?? "").trim();
          if (!instruction) return json(res, 400, { error: "instruction required" });
          try {
            const repo = await getRepo();
            const item = repo.addQueueItem({
              projectId: body?.projectId ?? null,
              instruction,
              rank: body?.rank,
              source: body?.source ?? "human",
            });
            await regenerateMd(repo);
            return json(res, 200, item);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        if (req.method === "POST" && url === "/api/queue/update") {
          const body = await readJson(req);
          const id = String(body?.id ?? "").trim();
          if (!id) return json(res, 400, { error: "id required" });
          try {
            const repo = await getRepo();
            const item = repo.updateQueueItem({
              id,
              status: body?.status,
              instruction: body?.instruction,
              rank: body?.rank,
            });
            await regenerateMd(repo);
            return json(res, 200, item);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        if (req.method === "POST" && url === "/api/queue/reorder") {
          const body = await readJson(req);
          const ids = body?.ids;
          if (!Array.isArray(ids)) return json(res, 400, { error: "ids array required" });
          try {
            const repo = await getRepo();
            repo.reorderQueue(ids);
            await regenerateMd(repo);
            return json(res, 200, { ok: true });
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        if (req.method === "POST" && url === "/api/queue/delete") {
          const body = await readJson(req);
          const id = String(body?.id ?? "").trim();
          if (!id) return json(res, 400, { error: "id required" });
          try {
            const repo = await getRepo();
            repo.deleteQueueItem(id);
            await regenerateMd(repo);
            return json(res, 200, { ok: true });
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        // ── Activity routes ──

        if (req.method === "GET" && url.startsWith("/api/activity")) {
          const params = new URL(url, "http://localhost").searchParams;
          const limit = Number(params.get("limit") ?? 50);
          const offset = Number(params.get("offset") ?? 0);
          const repo = await getRepo();
          return json(res, 200, repo.listActivity(limit, offset));
        }

        if (req.method === "POST" && url === "/api/activity") {
          const body = await readJson(req);
          const action = String(body?.action ?? "").trim();
          const source = String(body?.source ?? "human").trim();
          if (!action) return json(res, 400, { error: "action required" });
          try {
            const repo = await getRepo();
            const entry = repo.logActivity({
              projectId: body?.projectId ?? null,
              source: source as any,
              action,
              detail: body?.detail ?? null,
            });
            return json(res, 200, entry);
          } catch (e: any) {
            return json(res, 400, { error: e?.message ?? "failed" });
          }
        }

        // ── Cron routes ──

        if (req.method === "GET" && url === "/api/cron") {
          const repo = await getRepo();
          const jobs = loadCronJobsFromStateDir(stateDir);
          const snapshots = repo.listCronSnapshots();
          const cronHealth = jobs.map((j) => {
            const snap = snapshots.find((s) => s.jobId === j.id);
            const lastStatus = (j.status ?? snap?.lastStatus ?? "unknown");
            const lastError = (j as any).lastError ?? snap?.lastError ?? null;
            const lastSeenAt = snap?.lastSeenAt ?? null;
            return {
              ...j,
              lastStatus,
              lastError,
              lastSeenAt,
              health: deriveHealth({ lastStatus, lastSeenAt, lastAt: j.lastAt ?? null }),
            };
          });
          return json(res, 200, cronHealth);
        }

        if (req.method === "POST" && url === "/api/cron/trigger") {
          return json(res, 501, { error: "Cron trigger not yet implemented — awaiting OpenClaw cron API" });
        }

        if (req.method === "POST" && url === "/api/cron/toggle") {
          return json(res, 501, { error: "Cron toggle not yet implemented — awaiting OpenClaw cron API" });
        }

        json(res, 404, { error: "not found" });
      })
      .listen(cfg.port, "127.0.0.1");
  }

  // Auto-start the dashboard server so http://127.0.0.1:<port> works without running a command.
  if (cfg.autoStart) {
    ensureServer().catch(() => void 0);
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

function deriveHealth(params: { lastStatus?: string | null; lastSeenAt?: number | null; lastAt?: number | null } | null | undefined): "green" | "yellow" | "red" {
  if (!params) return "yellow";
  const status = String(params.lastStatus ?? "unknown").toLowerCase();
  const seenAt = typeof params.lastSeenAt === "number" && params.lastSeenAt > 0 ? params.lastSeenAt : null;
  const lastAt = typeof params.lastAt === "number" && params.lastAt > 0 ? params.lastAt : null;
  const ts = seenAt ?? lastAt;

  if (status === "error" || status === "failure" || status === "failed") return "red";
  if (!ts) return "yellow";

  const age = Date.now() - ts;
  if (age > 24 * 60 * 60 * 1000) return "yellow"; // stale > 24h
  return "green";
}

function ensureSeeded(
  repo: Awaited<ReturnType<typeof makeRepo>>,
  params: { workspaceDir: string; stateDir: string }
) {
  const seeds = inferSeedProjects(params);

  // Always ensure these exist (even if MEMORY.md heuristics miss them)
  const required = [
    "Inbox / Triage",
    "Research / Opportunities",
    "Ideas / Backlog",
  ];
  for (const name of required) seeds.push({ name, seedUpdate: "Auto-created baseline project." });

  for (const s of seeds) {
    const existing = repo.getProjectByName(s.name);
    if (existing) continue;
    const proj = repo.createProject(s.name);
    if (s.seedUpdate) {
      repo.addUpdate({ projectId: proj.id, type: "note", text: s.seedUpdate });
    }
  }
}

function computeActive(projects: any[], updates: any[], tasks: any[], schedules: any[]) {
  const now = Date.now();
  return projects.map((p) => {
    const upd = updates.find((u) => u.projectId === p.id && now - u.createdAt <= 10 * 60 * 1000);
    const taskBlock = tasks.find((t: any) => t.projectId === p.id) || { items: [] };
    const doing = (taskBlock.items || []).find((t: any) => t.status === "doing" && now - t.updatedAt <= 30 * 60 * 1000);
    const schedule = schedules.find((s: any) => s.projectId === p.id && s.lastAt);
    const reasons: string[] = [];
    if (upd) reasons.push(`Recent update ${Math.floor((now - upd.createdAt) / 60000)}m ago`);
    if (doing) reasons.push(`Task in progress: ${doing.title}`);
    if (schedule) reasons.push(`Schedule last ran ${Math.floor((now - schedule.lastAt) / 60000)}m ago: ${schedule.jobName}`);
    return { projectId: p.id, reasons };
  });
}

