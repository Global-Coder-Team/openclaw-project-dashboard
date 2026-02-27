import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import initSqlJs from "sql.js";

export type ProjectStatus = "green" | "yellow" | "red";
export type UpdateType = "note" | "progress" | "decision" | "blocker" | "request";

export type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
  objective: string | null;
  nextAction: string | null;
  strategy: string | null;
  hypothesis: string | null;
  constraints: string | null;
  success: string | null;
  dueDate: string | null; // ISO-8601 date
  createdAt: number;
  updatedAt: number;
};

export type Update = {
  id: string;
  projectId: string;
  type: UpdateType;
  text: string;
  createdAt: number;
};

export type TaskStatus = "todo" | "doing" | "done";
export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
};

export type QueueStatus = "pending" | "in_progress" | "completed" | "skipped";
export type QueueSource = "human" | "agent";
export type QueueItem = {
  id: string;
  projectId: string | null;
  instruction: string;
  rank: number;
  status: QueueStatus;
  source: QueueSource;
  createdAt: number;
  updatedAt: number;
};

export type ActivityAction = "task_started" | "task_completed" | "status_changed" | "update_added" | "queue_picked" | "queue_completed" | "cron_ran" | "cron_failed";
export type ActivityEntry = {
  id: string;
  projectId: string | null;
  source: QueueSource;
  action: string;
  detail: string | null;
  createdAt: number;
};

export type CronSnapshot = {
  jobId: string;
  lastStatus: string;
  lastError: string | null;
  lastSeenAt: number;
};

export function resolveDbPath(params: { stateDir?: string; dbPath: string }) {
  const dbPath = params.dbPath.trim();
  if (!dbPath) throw new Error("dbPath required");

  const resolved = params.stateDir && !isAbsOrDrive(dbPath) ? join(params.stateDir, dbPath) : resolve(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function isAbsOrDrive(p: string) {
  return /^[a-zA-Z]:\\/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

type SqlDb = any;

export async function openDb(dbFile: string): Promise<SqlDb> {
  const SQL = await initSqlJs({});

  let db: SqlDb;
  if (existsSync(dbFile)) {
    const buf = readFileSync(dbFile);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }

  migrate(db);
  persist(db, dbFile);

  // monkey patch a persist helper
  (db as any).__persist = () => persist(db, dbFile);
  (db as any).__dbFile = dbFile;
  return db;
}

function migrate(db: SqlDb) {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT,
      nextAction TEXT,
      strategy TEXT,
      hypothesis TEXT,
      constraints TEXT,
      success TEXT,
      dueDate TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

    CREATE TABLE IF NOT EXISTS updates (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_updates_projectId_createdAt ON updates(projectId, createdAt DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_projectId_status ON tasks(projectId, status);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      instruction TEXT NOT NULL,
      rank INTEGER NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status_rank ON queue(status, rank);

    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_createdAt ON activity(createdAt DESC);

    CREATE TABLE IF NOT EXISTS cron_snapshots (
      jobId TEXT PRIMARY KEY,
      lastStatus TEXT,
      lastError TEXT,
      lastSeenAt INTEGER
    );
  `);

  // Upgrade existing DBs: add new project columns if missing
  const cols = qAll(db, `PRAGMA table_info(projects)`);
  const have = new Set(cols.map((c: any) => String(c.name)));
  const maybeAdd = (col: string) => {
    if (!have.has(col)) {
      db.run(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
    }
  };
  maybeAdd("strategy");
  maybeAdd("hypothesis");
  maybeAdd("constraints");
  maybeAdd("success");
}

function persist(db: SqlDb, dbFile: string) {
  const data = db.export();
  writeFileSync(dbFile, Buffer.from(data));
}

function qAll(db: SqlDb, sql: string, params: any[] = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function qGet(db: SqlDb, sql: string, params: any[] = []) {
  const rows = qAll(db, sql, params);
  return rows[0] ?? null;
}

function exec(db: SqlDb, sql: string, params: any[] = []) {
  db.run(sql, params);
  (db as any).__persist?.();
}

export function makeRepo(db: SqlDb) {
  const normProject = (r: any): Project => ({
    id: String(r.id),
    name: String(r.name),
    status: r.status as ProjectStatus,
    objective: r.objective ?? null,
    nextAction: r.nextAction ?? null,
    strategy: r.strategy ?? null,
    hypothesis: r.hypothesis ?? null,
    constraints: r.constraints ?? null,
    success: r.success ?? null,
    dueDate: r.dueDate ?? null,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  });

  const normUpdate = (r: any): Update => ({
    id: String(r.id),
    projectId: String(r.projectId),
    type: r.type as UpdateType,
    text: String(r.text),
    createdAt: Number(r.createdAt),
  });

  const normTask = (r: any): Task => ({
    id: String(r.id),
    projectId: String(r.projectId),
    title: String(r.title),
    status: (r.status as TaskStatus) ?? "todo",
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  });

  const normQueueItem = (r: any): QueueItem => ({
    id: String(r.id),
    projectId: r.projectId ? String(r.projectId) : null,
    instruction: String(r.instruction),
    rank: Number(r.rank),
    status: r.status as QueueStatus,
    source: (r.source as QueueSource) ?? "human",
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  });

  const normActivity = (r: any): ActivityEntry => ({
    id: String(r.id),
    projectId: r.projectId ? String(r.projectId) : null,
    source: (r.source as QueueSource) ?? "human",
    action: String(r.action),
    detail: r.detail ? String(r.detail) : null,
    createdAt: Number(r.createdAt),
  });

  const normCronSnapshot = (r: any): CronSnapshot => ({
    jobId: String(r.jobId),
    lastStatus: String(r.lastStatus ?? "unknown"),
    lastError: r.lastError ? String(r.lastError) : null,
    lastSeenAt: Number(r.lastSeenAt ?? 0),
  });

  return {
    listProjects(): Project[] {
      return qAll(db, `SELECT * FROM projects ORDER BY updatedAt DESC`).map(normProject);
    },
    projectCount(): number {
      const r = qGet(db, `SELECT COUNT(1) as c FROM projects`);
      return r ? Number(r.c) : 0;
    },
    getProjectById(id: string): Project | null {
      const r = qGet(db, `SELECT * FROM projects WHERE id = ?`, [id]);
      return r ? normProject(r) : null;
    },
    getProjectByName(name: string): Project | null {
      const r = qGet(db, `SELECT * FROM projects WHERE lower(name) = lower(?)`, [name]);
      return r ? normProject(r) : null;
    },
    createProject(name: string): Project {
      const now = Date.now();
      const id = `p_${Math.random().toString(36).slice(2, 10)}`;
      exec(
        db,
        `INSERT INTO projects (id,name,status,objective,nextAction,strategy,hypothesis,constraints,success,dueDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, name, "green", null, null, null, null, null, null, null, now, now]
      );
      return this.getProjectById(id)!;
    },
    updateProject(patch: Partial<Project> & { id: string }): Project {
      const existing = this.getProjectById(patch.id);
      if (!existing) throw new Error("Project not found");
      const updated: Project = { ...existing, ...patch, updatedAt: Date.now() };
      exec(
        db,
        `UPDATE projects SET name=?, status=?, objective=?, nextAction=?, strategy=?, hypothesis=?, constraints=?, success=?, dueDate=?, updatedAt=? WHERE id=?`,
        [
          updated.name,
          updated.status,
          updated.objective,
          updated.nextAction,
          updated.strategy,
          updated.hypothesis,
          updated.constraints,
          updated.success,
          updated.dueDate,
          updated.updatedAt,
          updated.id,
        ]
      );
      return this.getProjectById(updated.id)!;
    },
    addUpdate(params: { projectId: string; type: UpdateType; text: string }): Update {
      const now = Date.now();
      const id = `u_${Math.random().toString(36).slice(2, 10)}`;
      exec(db, `INSERT INTO updates (id,projectId,type,text,createdAt) VALUES (?,?,?,?,?)`, [
        id,
        params.projectId,
        params.type,
        params.text,
        now,
      ]);
      // bump project updatedAt
      const proj = this.getProjectById(params.projectId);
      if (proj) this.updateProject({ id: proj.id, updatedAt: now } as any);
      return { id, projectId: params.projectId, type: params.type, text: params.text, createdAt: now };
    },
    listRecentUpdates(limit = 50): Array<Update & { projectName: string }> {
      const rows = qAll(
        db,
        `SELECT u.id,u.projectId,u.type,u.text,u.createdAt,p.name as projectName
         FROM updates u JOIN projects p ON p.id = u.projectId
         ORDER BY u.createdAt DESC LIMIT ?`,
        [limit]
      );
      return rows.map((r) => ({ ...normUpdate(r), projectName: String(r.projectName) }));
    },

    listTasks(projectId: string): Task[] {
      return qAll(db, `SELECT * FROM tasks WHERE projectId = ? ORDER BY updatedAt DESC`, [projectId]).map(normTask);
    },
    addTask(params: { projectId: string; title: string; status?: TaskStatus }): Task {
      const now = Date.now();
      const id = `t_${Math.random().toString(36).slice(2, 10)}`;
      const status: TaskStatus = params.status ?? "todo";
      exec(db, `INSERT INTO tasks (id,projectId,title,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`, [
        id,
        params.projectId,
        params.title,
        status,
        now,
        now,
      ]);
      return { id, projectId: params.projectId, title: params.title, status, createdAt: now, updatedAt: now };
    },
    updateTask(params: { id: string; status?: TaskStatus; title?: string }): Task {
      const row = qGet(db, `SELECT * FROM tasks WHERE id = ?`, [params.id]);
      if (!row) throw new Error("Task not found");
      const task = normTask(row);
      const updated: Task = {
        ...task,
        title: params.title ?? task.title,
        status: params.status ?? task.status,
        updatedAt: Date.now(),
      };
      exec(db, `UPDATE tasks SET title=?, status=?, updatedAt=? WHERE id=?`, [
        updated.title,
        updated.status,
        updated.updatedAt,
        updated.id,
      ]);
      return updated;
    },

    // ── Queue ──

    listQueue(): QueueItem[] {
      return qAll(db, `SELECT * FROM queue WHERE status IN ('pending','in_progress') ORDER BY rank ASC`).map(normQueueItem);
    },
    listQueueByStatus(status: QueueStatus): QueueItem[] {
      return qAll(db, `SELECT * FROM queue WHERE status = ? ORDER BY rank ASC`, [status]).map(normQueueItem);
    },
    addQueueItem(params: { projectId?: string | null; instruction: string; rank?: number; source?: QueueSource }): QueueItem {
      const now = Date.now();
      const id = `q_${Math.random().toString(36).slice(2, 10)}`;
      let rank = params.rank;
      if (rank == null) {
        const maxRow = qGet(db, `SELECT MAX(rank) as m FROM queue`);
        rank = (maxRow?.m != null ? Number(maxRow.m) : 0) + 1;
      }
      const source: QueueSource = params.source ?? "human";
      exec(db, `INSERT INTO queue (id,projectId,instruction,rank,status,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`, [
        id, params.projectId ?? null, params.instruction, rank, "pending", source, now, now,
      ]);
      return { id, projectId: params.projectId ?? null, instruction: params.instruction, rank, status: "pending", source, createdAt: now, updatedAt: now };
    },
    updateQueueItem(params: { id: string; status?: QueueStatus; instruction?: string; rank?: number }): QueueItem {
      const row = qGet(db, `SELECT * FROM queue WHERE id = ?`, [params.id]);
      if (!row) throw new Error("Queue item not found");
      const existing = normQueueItem(row);
      const updated: QueueItem = {
        ...existing,
        status: params.status ?? existing.status,
        instruction: params.instruction ?? existing.instruction,
        rank: params.rank ?? existing.rank,
        updatedAt: Date.now(),
      };
      exec(db, `UPDATE queue SET status=?, instruction=?, rank=?, updatedAt=? WHERE id=?`, [
        updated.status, updated.instruction, updated.rank, updated.updatedAt, updated.id,
      ]);
      return updated;
    },
    reorderQueue(ids: string[]): void {
      ids.forEach((id, i) => {
        exec(db, `UPDATE queue SET rank=?, updatedAt=? WHERE id=?`, [i + 1, Date.now(), id]);
      });
    },
    deleteQueueItem(id: string): void {
      exec(db, `DELETE FROM queue WHERE id = ?`, [id]);
    },
    listRecentlyCompleted(limit = 10): QueueItem[] {
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      return qAll(db, `SELECT * FROM queue WHERE status = 'completed' AND updatedAt > ? ORDER BY updatedAt DESC LIMIT ?`, [cutoff, limit]).map(normQueueItem);
    },

    // ── Activity ──

    logActivity(params: { projectId?: string | null; source: QueueSource; action: string; detail?: string | null }): ActivityEntry {
      const now = Date.now();
      const id = `a_${Math.random().toString(36).slice(2, 10)}`;
      exec(db, `INSERT INTO activity (id,projectId,source,action,detail,createdAt) VALUES (?,?,?,?,?,?)`, [
        id, params.projectId ?? null, params.source, params.action, params.detail ?? null, now,
      ]);
      return { id, projectId: params.projectId ?? null, source: params.source, action: params.action, detail: params.detail ?? null, createdAt: now };
    },
    listActivity(limit = 50, offset = 0): ActivityEntry[] {
      return qAll(db, `SELECT * FROM activity ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`, [limit, offset]).map(normActivity);
    },

    // ── Cron Snapshots ──

    getCronSnapshot(jobId: string): CronSnapshot | null {
      const r = qGet(db, `SELECT * FROM cron_snapshots WHERE jobId = ?`, [jobId]);
      return r ? normCronSnapshot(r) : null;
    },
    upsertCronSnapshot(params: { jobId: string; lastStatus: string; lastError?: string | null }): void {
      const now = Date.now();
      const existing = qGet(db, `SELECT * FROM cron_snapshots WHERE jobId = ?`, [params.jobId]);
      if (existing) {
        exec(db, `UPDATE cron_snapshots SET lastStatus=?, lastError=?, lastSeenAt=? WHERE jobId=?`, [
          params.lastStatus, params.lastError ?? null, now, params.jobId,
        ]);
      } else {
        exec(db, `INSERT INTO cron_snapshots (jobId,lastStatus,lastError,lastSeenAt) VALUES (?,?,?,?)`, [
          params.jobId, params.lastStatus, params.lastError ?? null, now,
        ]);
      }
    },
    listCronSnapshots(): CronSnapshot[] {
      return qAll(db, `SELECT * FROM cron_snapshots`).map(normCronSnapshot);
    },
  };
}
