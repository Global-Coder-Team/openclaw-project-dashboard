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
        `INSERT INTO projects (id,name,status,objective,nextAction,dueDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
        [id, name, "green", null, null, null, now, now]
      );
      return this.getProjectById(id)!;
    },
    updateProject(patch: Partial<Project> & { id: string }): Project {
      const existing = this.getProjectById(patch.id);
      if (!existing) throw new Error("Project not found");
      const updated: Project = { ...existing, ...patch, updatedAt: Date.now() };
      exec(
        db,
        `UPDATE projects SET name=?, status=?, objective=?, nextAction=?, dueDate=?, updatedAt=? WHERE id=?`,
        [updated.name, updated.status, updated.objective, updated.nextAction, updated.dueDate, updated.updatedAt, updated.id]
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
  };
}
