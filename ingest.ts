import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UpdateType } from "./db.js";

type Repo = {
  getProjectByName(name: string): any | null;
  createProject(name: string): any;
  addUpdate(params: { projectId: string; type: UpdateType; text: string }): any;
  addQueueItem(params: { projectId?: string | null; instruction: string; source?: "agent" | "human" }): any;
  hasIngestion(key: string): boolean;
  markIngestion(key: string): void;
};

function hashKey(prefix: string, raw: string) {
  // Stable-enough hash for de-dupe without dependencies.
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${(h >>> 0).toString(16)}`;
}

function ensureProject(repo: Repo, name: string) {
  return repo.getProjectByName(name) ?? repo.createProject(name);
}

function mapTextToProjectName(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("church-") || t.includes("church outreach")) return "OCI - Church Outreach (Harvest Week 2026)";
  if (t.includes("burundi") || t.includes("harvest week")) return "OCI - Burundi Medical Camp / Harvest Week 2026 Ops";
  if (t.includes("goatport")) return "GoatPort (SaaS)";
  if (t.includes("global coder") || t.includes("globalcoder")) return "Global Coder (Bujumbura center launch 2026)";
  if (t.includes("project dashboard") || t.includes("openclaw-project-dashboard")) return "OpenClaw Project Dashboard (this plugin)";
  return "OpenClaw Automation System";
}

export function ingestLearnings(repo: Repo, workspaceDir: string) {
  const has = typeof (repo as any).hasIngestion === "function" ? (k: string) => (repo as any).hasIngestion(k) : (_: string) => false;
  const mark = typeof (repo as any).markIngestion === "function" ? (k: string) => (repo as any).markIngestion(k) : (_: string) => void 0;
  const dir = join(workspaceDir, ".learnings");
  const files = ["ERRORS.md", "LEARNINGS.md", "FEATURE_REQUESTS.md"].map((f) => join(dir, f));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");

    // Split on headings like: ## [ERR-2026...] ...
    const blocks = raw.split(/\n(?=## \[[A-Z]+-\d{8}-[A-Za-z0-9]+\])/g);
    for (const b of blocks) {
      const m = b.match(/^## \[([A-Z]+-\d{8}-[A-Za-z0-9]+)\]([^\n]*)/m);
      if (!m) continue;
      const id = m[1];
      const title = (m[2] ?? "").trim();

      const status = (b.match(/\*\*Status\*\*: (\w+)/)?.[1] ?? "").toLowerCase();
      const priority = (b.match(/\*\*Priority\*\*: (\w+)/)?.[1] ?? "").toLowerCase();
      if (!status || status === "resolved" || status === "promoted") continue;

      const summary = (b.match(/### Summary\n([\s\S]*?)(\n\n|$)/)?.[1] ?? "").trim();
      const line = `${id}${title ? ` ${title}` : ""}${summary ? ` — ${summary}` : ""}`.trim();

      const key = hashKey("learn", `${file}::${id}::${status}`);
      if (has(key)) continue;

      const projName = mapTextToProjectName(b);
      const proj = ensureProject(repo, projName);

      let type: UpdateType = "note";
      if (file.endsWith("ERRORS.md")) type = "blocker";
      else if (file.endsWith("FEATURE_REQUESTS.md")) type = "request";
      else type = "note";

      const pr = priority ? `Priority: ${priority}. ` : "";
      repo.addUpdate({ projectId: proj.id, type, text: `${pr}${line}` });

      // If it’s a high-priority error, add to work queue as an agent instruction.
      if (file.endsWith("ERRORS.md") && (priority === "high" || priority === "critical")) {
        repo.addQueueItem({ projectId: proj.id, instruction: `Resolve ${id}: ${summary || title || "(see learnings)"}`, source: "agent" });
      }

      mark(key);
    }
  }
}

export function ingestDailyMemory(repo: Repo, workspaceDir: string, daysBack = 2) {
  const has = typeof (repo as any).hasIngestion === "function" ? (k: string) => (repo as any).hasIngestion(k) : (_: string) => false;
  const mark = typeof (repo as any).markIngestion === "function" ? (k: string) => (repo as any).markIngestion(k) : (_: string) => void 0;
  const memDir = join(workspaceDir, "memory");
  if (!existsSync(memDir)) return;
  const files = readdirSync(memDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-daysBack);

  for (const f of files) {
    const p = join(memDir, f);
    const raw = readFileSync(p, "utf8");
    const key = hashKey("mem", `${f}::${raw.slice(0, 4000)}`);
    if (has(key)) continue;

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const top = lines.slice(0, 12).join(" ").trim();
    const proj = ensureProject(repo, "OpenClaw Automation System");
    repo.addUpdate({ projectId: proj.id, type: "note", text: `Memory ingest (${f}): ${top.slice(0, 220)}` });
    mark(key);
  }
}
