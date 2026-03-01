import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type CronJob = {
  id: string;
  name: string;
  schedule?: any;
  enabled?: boolean;
  status?: string;
  lastError?: string | null;
  lastAt?: number | null;
  nextAt?: number | null;
};

export function loadCronJobsFromStateDir(stateDir: string): CronJob[] {
  // Local-first: read cron store directly rather than calling gateway RPC.
  const cronPath = join(stateDir, "cron", "jobs.json");
  if (!existsSync(cronPath)) return [];
  const raw = readFileSync(cronPath, "utf8");
  const json = JSON.parse(raw);

  const jobs = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : [];
  return jobs
    .map((j: any) => {
      const st = j.state ?? {};
      const lastAt =
        typeof st.lastRunAtMs === "number" ? st.lastRunAtMs :
        typeof st.lastAtMs === "number" ? st.lastAtMs :
        typeof j.lastAtMs === "number" ? j.lastAtMs :
        typeof j.lastAt === "number" ? j.lastAt : null;

      const nextAt =
        typeof st.nextRunAtMs === "number" ? st.nextRunAtMs :
        typeof st.nextAtMs === "number" ? st.nextAtMs :
        typeof j.nextAtMs === "number" ? j.nextAtMs :
        typeof j.nextAt === "number" ? j.nextAt : null;

      const status =
        typeof st.lastStatus === "string" ? st.lastStatus :
        typeof st.lastRunStatus === "string" ? st.lastRunStatus :
        typeof j.status === "string" ? j.status : undefined;

      const lastError = typeof st.lastError === "string" ? st.lastError : null;

      return {
        id: String(j.id ?? j.jobId ?? ""),
        name: String(j.name ?? ""),
        schedule: j.schedule,
        enabled: j.enabled !== false,
        status,
        lastError,
        lastAt,
        nextAt,
      } as CronJob;
    })
    .filter((j: CronJob) => j.id && j.name);
}

export function inferSeedProjects(params: {
  workspaceDir: string;
  stateDir: string;
}): Array<{ name: string; seedUpdate?: string }> {
  const memoryMd = join(params.workspaceDir, "MEMORY.md");
  const soul = join(params.workspaceDir, "SOUL.md");
  const user = join(params.workspaceDir, "USER.md");

  const blobs: string[] = [];
  for (const p of [memoryMd, soul, user]) {
    if (existsSync(p)) blobs.push(readFileSync(p, "utf8"));
  }
  const text = blobs.join("\n\n");

  const found = (k: string) => text.toLowerCase().includes(k.toLowerCase());

  const seeds: Array<{ name: string; seedUpdate?: string }> = [];

  // Core ventures/programs (heuristic)
  if (found("goatport")) seeds.push({ name: "GoatPort (SaaS)", seedUpdate: "Imported from workspace memory." });
  if (found("global coder")) seeds.push({ name: "Global Coder (Bujumbura center launch 2026)", seedUpdate: "Imported from workspace memory." });
  if (found("our children international") || found("oci")) {
    seeds.push({ name: "OCI - Grants Pipeline", seedUpdate: "Imported from workspace memory." });
    seeds.push({ name: "OCI - Donor Outreach / Major Donors", seedUpdate: "Imported from workspace memory." });
    seeds.push({ name: "OCI - Sponsorship Program Growth", seedUpdate: "Imported from workspace memory." });
    seeds.push({ name: "OCI - Burundi Medical Camp / Harvest Week 2026 Ops", seedUpdate: "Imported from workspace memory." });
    seeds.push({ name: "OCI - Church Outreach (Harvest Week 2026)", seedUpdate: "Imported from workspace memory." });
  }

  // Platform/meta
  seeds.push({ name: "OpenClaw Automation System", seedUpdate: "Imported from workspace memory." });
  seeds.push({ name: "OpenClaw Project Dashboard (this plugin)", seedUpdate: "Imported from workspace memory." });

  // Cron-derived hints
  const jobs = loadCronJobsFromStateDir(params.stateDir);
  const church = jobs.filter((j) => j.name.toLowerCase().startsWith("church-")).length;
  const burundi = jobs.filter((j) => j.name.toLowerCase().startsWith("burundi-")).length;

  if (church > 0) {
    seeds.push({
      name: "OCI - Church Outreach (Harvest Week 2026)",
      seedUpdate: `Detected ${church} church outreach cron job(s) in OpenClaw state.`,
    });
  }
  if (burundi > 0) {
    seeds.push({
      name: "OCI - Burundi Medical Camp / Harvest Week 2026 Ops",
      seedUpdate: `Detected ${burundi} Burundi logistics cron job(s) in OpenClaw state.`,
    });
  }

  // De-dupe by name (keep first occurrence)
  const seen = new Set<string>();
  const out: typeof seeds = [];
  for (const s of seeds) {
    const key = s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
