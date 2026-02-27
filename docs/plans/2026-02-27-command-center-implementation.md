# Dashboard Command Center Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use globalcoder-workflow:executing-plans to implement this plan task-by-task.

**Goal:** Evolve the project dashboard into a command center with a work queue, activity log, cron health monitoring, markdown bridge for agent communication, and a restructured split-view UI with auto-refresh.

**Architecture:** New tables (queue, activity, cron_snapshots) added to the existing sql.js SQLite database. A markdown bridge writes AGENT_QUEUE.md to the workspace for the agent to read. Existing mutation methods gain automatic activity logging. The UI restructures the left panel into a command center (queue + cron + activity) while the right panel gains a dashboard aggregate tab. Auto-refresh polls /api/state every 15 seconds.

**Tech Stack:** TypeScript (ESM, executed directly by OpenClaw), sql.js (WASM SQLite), vanilla JS SPA, Node.js HTTP server, vitest (new, for testing)

**Design doc:** `docs/plans/2026-02-27-dashboard-command-center-design.md`

---

## Dependency Graph

```
Task 1 (test infra)
  └─► Task 2 (schema + repo)
        ├─► Task 3 (auto activity logging)  ─┐
        ├─► Task 4 (markdown bridge)         ├─► Task 6 (activity/cron API + /api/state)
        └─► Task 5 (queue API routes)        ┘         └─► Task 7 (UI layout)
                                                              ├─► Task 8 (UI queue)
                                                              └─► Task 9 (UI cron/activity/dashboard/auto-refresh)
```

**Parallel groups:**
- Tasks 3, 4, 5 are independent of each other (all depend on Task 2)
- Tasks 8, 9 are independent of each other (both depend on Task 7)

---

### Task 1: Test Infrastructure

**Files:**
- Modify: `package.json`
- Create: `test/helpers.ts`
- Create: `test/smoke.test.ts`

**Step 1: Install vitest**

Run: `npm install --save-dev vitest`

**Step 2: Update package.json test script**

In `package.json`, change:
```json
"test": "echo no-tests"
```
to:
```json
"test": "vitest run"
```

**Step 3: Create test helper**

Create `test/helpers.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, makeRepo } from "../db.js";

export async function createTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-test-"));
  const dbFile = join(dir, "test.sqlite");
  const db = await openDb(dbFile);
  return { db, repo: makeRepo(db), dbFile, dir };
}
```

**Step 4: Create smoke test**

Create `test/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestRepo } from "./helpers.js";

describe("smoke", () => {
  it("opens db and creates a project", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test Project");
    expect(proj.id).toMatch(/^p_/);
    expect(proj.name).toBe("Test Project");
    expect(proj.status).toBe("green");
  });

  it("lists projects after creation", async () => {
    const { repo } = await createTestRepo();
    repo.createProject("A");
    repo.createProject("B");
    const list = repo.listProjects();
    expect(list).toHaveLength(2);
  });
});
```

**Step 5: Run tests to verify setup**

Run: `npm test`
Expected: 2 passing tests

**Step 6: Commit**

```bash
git add package.json package-lock.json test/
git commit -m "feat: add vitest test infrastructure with smoke tests"
```

---

### Task 2: Queue, Activity, Cron Snapshots Schema + Repo Methods

**Files:**
- Modify: `db.ts` (types at lines 5-39, migrate at lines 76-129, makeRepo at lines 155-299)
- Create: `test/queue.test.ts`
- Create: `test/activity.test.ts`
- Create: `test/cron-snapshots.test.ts`

**Step 1: Write failing queue tests**

Create `test/queue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestRepo } from "./helpers.js";

describe("queue", () => {
  it("adds a queue item with auto-rank", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Do something" });
    expect(item.id).toMatch(/^q_/);
    expect(item.instruction).toBe("Do something");
    expect(item.status).toBe("pending");
    expect(item.source).toBe("human");
    expect(item.rank).toBe(1);
  });

  it("auto-increments rank", async () => {
    const { repo } = await createTestRepo();
    repo.addQueueItem({ instruction: "First" });
    const second = repo.addQueueItem({ instruction: "Second" });
    expect(second.rank).toBe(2);
  });

  it("lists queue items ordered by rank", async () => {
    const { repo } = await createTestRepo();
    repo.addQueueItem({ instruction: "Second", rank: 2 });
    repo.addQueueItem({ instruction: "First", rank: 1 });
    const list = repo.listQueue();
    expect(list[0].instruction).toBe("First");
    expect(list[1].instruction).toBe("Second");
  });

  it("links queue item to a project", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("MyProj");
    const item = repo.addQueueItem({ projectId: proj.id, instruction: "Work on it" });
    expect(item.projectId).toBe(proj.id);
  });

  it("updates queue item status", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Do it" });
    const updated = repo.updateQueueItem({ id: item.id, status: "in_progress" });
    expect(updated.status).toBe("in_progress");
  });

  it("updates queue item instruction", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Old text" });
    const updated = repo.updateQueueItem({ id: item.id, instruction: "New text" });
    expect(updated.instruction).toBe("New text");
  });

  it("reorders queue items", async () => {
    const { repo } = await createTestRepo();
    const a = repo.addQueueItem({ instruction: "A" });
    const b = repo.addQueueItem({ instruction: "B" });
    const c = repo.addQueueItem({ instruction: "C" });
    repo.reorderQueue([c.id, a.id, b.id]);
    const list = repo.listQueue();
    expect(list.map((q) => q.instruction)).toEqual(["C", "A", "B"]);
  });

  it("deletes a queue item", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Delete me" });
    repo.deleteQueueItem(item.id);
    expect(repo.listQueue()).toHaveLength(0);
  });

  it("lists recently completed items", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Done" });
    repo.updateQueueItem({ id: item.id, status: "completed" });
    const completed = repo.listRecentlyCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].instruction).toBe("Done");
  });

  it("filters queue by status", async () => {
    const { repo } = await createTestRepo();
    repo.addQueueItem({ instruction: "Pending" });
    const ip = repo.addQueueItem({ instruction: "Active" });
    repo.updateQueueItem({ id: ip.id, status: "in_progress" });
    const pending = repo.listQueueByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].instruction).toBe("Pending");
  });
});
```

**Step 2: Run queue tests to verify they fail**

Run: `npm test -- test/queue.test.ts`
Expected: FAIL — `repo.addQueueItem is not a function`

**Step 3: Write failing activity tests**

Create `test/activity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestRepo } from "./helpers.js";

describe("activity", () => {
  it("logs an activity event", async () => {
    const { repo } = await createTestRepo();
    const entry = repo.logActivity({ source: "human", action: "test_action", detail: "hello" });
    expect(entry.id).toMatch(/^a_/);
    expect(entry.source).toBe("human");
    expect(entry.action).toBe("test_action");
    expect(entry.detail).toBe("hello");
  });

  it("logs activity with project link", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Proj");
    const entry = repo.logActivity({ projectId: proj.id, source: "agent", action: "queue_picked" });
    expect(entry.projectId).toBe(proj.id);
  });

  it("lists activity in reverse chronological order", async () => {
    const { repo } = await createTestRepo();
    repo.logActivity({ source: "human", action: "first" });
    repo.logActivity({ source: "human", action: "second" });
    const list = repo.listActivity();
    expect(list[0].action).toBe("second");
    expect(list[1].action).toBe("first");
  });

  it("respects limit and offset", async () => {
    const { repo } = await createTestRepo();
    for (let i = 0; i < 5; i++) repo.logActivity({ source: "human", action: `a${i}` });
    const page = repo.listActivity(2, 1);
    expect(page).toHaveLength(2);
    expect(page[0].action).toBe("a3");
  });
});
```

**Step 4: Run activity tests to verify they fail**

Run: `npm test -- test/activity.test.ts`
Expected: FAIL — `repo.logActivity is not a function`

**Step 5: Write failing cron snapshot tests**

Create `test/cron-snapshots.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestRepo } from "./helpers.js";

describe("cron snapshots", () => {
  it("upserts a cron snapshot", async () => {
    const { repo } = await createTestRepo();
    repo.upsertCronSnapshot({ jobId: "j1", lastStatus: "success" });
    const snap = repo.getCronSnapshot("j1");
    expect(snap).not.toBeNull();
    expect(snap!.lastStatus).toBe("success");
    expect(snap!.lastError).toBeNull();
  });

  it("updates existing snapshot", async () => {
    const { repo } = await createTestRepo();
    repo.upsertCronSnapshot({ jobId: "j1", lastStatus: "success" });
    repo.upsertCronSnapshot({ jobId: "j1", lastStatus: "failure", lastError: "timeout" });
    const snap = repo.getCronSnapshot("j1");
    expect(snap!.lastStatus).toBe("failure");
    expect(snap!.lastError).toBe("timeout");
  });

  it("lists all snapshots", async () => {
    const { repo } = await createTestRepo();
    repo.upsertCronSnapshot({ jobId: "j1", lastStatus: "success" });
    repo.upsertCronSnapshot({ jobId: "j2", lastStatus: "failure" });
    const list = repo.listCronSnapshots();
    expect(list).toHaveLength(2);
  });

  it("returns null for unknown job", async () => {
    const { repo } = await createTestRepo();
    expect(repo.getCronSnapshot("nope")).toBeNull();
  });
});
```

**Step 6: Run cron snapshot tests to verify they fail**

Run: `npm test -- test/cron-snapshots.test.ts`
Expected: FAIL — `repo.upsertCronSnapshot is not a function`

**Step 7: Add new types to db.ts**

After the existing `Task` type (line 39), add:

```ts
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
```

**Step 8: Add new tables to migrate()**

In the `migrate()` function, after the existing `CREATE TABLE IF NOT EXISTS tasks` block (after line 115), add:

```ts
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
```

**Step 9: Add normalizer functions and repo methods to makeRepo()**

Inside `makeRepo()`, after the existing `normTask` function (after line 186), add normalizers:

```ts
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
```

Then, inside the return object (after the `updateTask` method closing brace at line 297), add all new methods:

```ts
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
      return qAll(db, `SELECT * FROM activity ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [limit, offset]).map(normActivity);
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
```

**Step 10: Run all tests**

Run: `npm test`
Expected: All tests PASS (smoke + queue + activity + cron-snapshots)

**Step 11: Commit**

```bash
git add db.ts test/
git commit -m "feat: add queue, activity, cron_snapshots schema and repo methods"
```

---

### Task 3: Auto Activity Logging in Existing Mutations

**Files:**
- Modify: `db.ts:214-297` (updateProject, addUpdate, updateTask, updateQueueItem)
- Create: `test/auto-activity.test.ts`

**Step 1: Write failing tests**

Create `test/auto-activity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTestRepo } from "./helpers.js";

describe("auto activity logging", () => {
  it("logs status_changed when project status changes", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test");
    repo.updateProject({ id: proj.id, status: "red" });
    const activity = repo.listActivity();
    const statusChange = activity.find((a) => a.action === "status_changed");
    expect(statusChange).toBeDefined();
    expect(statusChange!.projectId).toBe(proj.id);
  });

  it("does not log status_changed when status is unchanged", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test");
    repo.updateProject({ id: proj.id, objective: "New objective" });
    const activity = repo.listActivity();
    const statusChange = activity.find((a) => a.action === "status_changed");
    expect(statusChange).toBeUndefined();
  });

  it("logs update_added when an update is created", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test");
    repo.addUpdate({ projectId: proj.id, type: "note", text: "Hello" });
    const activity = repo.listActivity();
    const added = activity.find((a) => a.action === "update_added");
    expect(added).toBeDefined();
    expect(added!.projectId).toBe(proj.id);
  });

  it("logs task_started when task moves to doing", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test");
    const task = repo.addTask({ projectId: proj.id, title: "Do thing" });
    repo.updateTask({ id: task.id, status: "doing" });
    const activity = repo.listActivity();
    const started = activity.find((a) => a.action === "task_started");
    expect(started).toBeDefined();
    expect(started!.detail).toContain("Do thing");
  });

  it("logs task_completed when task moves to done", async () => {
    const { repo } = await createTestRepo();
    const proj = repo.createProject("Test");
    const task = repo.addTask({ projectId: proj.id, title: "Do thing" });
    repo.updateTask({ id: task.id, status: "done" });
    const activity = repo.listActivity();
    const completed = activity.find((a) => a.action === "task_completed");
    expect(completed).toBeDefined();
  });

  it("logs queue_picked when queue item moves to in_progress", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Work on X" });
    repo.updateQueueItem({ id: item.id, status: "in_progress" });
    const activity = repo.listActivity();
    const picked = activity.find((a) => a.action === "queue_picked");
    expect(picked).toBeDefined();
    expect(picked!.detail).toContain("Work on X");
  });

  it("logs queue_completed when queue item moves to completed", async () => {
    const { repo } = await createTestRepo();
    const item = repo.addQueueItem({ instruction: "Work on X" });
    repo.updateQueueItem({ id: item.id, status: "completed" });
    const activity = repo.listActivity();
    const completed = activity.find((a) => a.action === "queue_completed");
    expect(completed).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- test/auto-activity.test.ts`
Expected: FAIL — no activity events logged for mutations

**Step 3: Add auto-logging to updateProject**

In `db.ts`, inside the `updateProject` method, after the `exec()` call (after the line that does the UPDATE SQL), add:

```ts
      // Auto-log status change
      if (existing.status !== updated.status) {
        this.logActivity({
          projectId: updated.id,
          source: "human",
          action: "status_changed",
          detail: `${existing.status} → ${updated.status}`,
        });
      }
```

**Step 4: Add auto-logging to addUpdate**

In `db.ts`, inside the `addUpdate` method, after the `exec()` INSERT call, add:

```ts
      this.logActivity({
        projectId: params.projectId,
        source: "human",
        action: "update_added",
        detail: `${params.type}: ${params.text.slice(0, 100)}`,
      });
```

**Step 5: Add auto-logging to updateTask**

In `db.ts`, inside the `updateTask` method, after the `exec()` UPDATE call, add:

```ts
      // Auto-log task status transitions
      if (params.status && params.status !== task.status) {
        if (params.status === "doing") {
          this.logActivity({
            projectId: task.projectId,
            source: "human",
            action: "task_started",
            detail: updated.title,
          });
        } else if (params.status === "done") {
          this.logActivity({
            projectId: task.projectId,
            source: "human",
            action: "task_completed",
            detail: updated.title,
          });
        }
      }
```

**Step 6: Add auto-logging to updateQueueItem**

In `db.ts`, inside the `updateQueueItem` method, after the `exec()` UPDATE call, add:

```ts
      // Auto-log queue status transitions
      if (params.status && params.status !== existing.status) {
        if (params.status === "in_progress") {
          this.logActivity({
            projectId: existing.projectId,
            source: existing.source,
            action: "queue_picked",
            detail: existing.instruction,
          });
        } else if (params.status === "completed") {
          this.logActivity({
            projectId: existing.projectId,
            source: existing.source,
            action: "queue_completed",
            detail: existing.instruction,
          });
        }
      }
```

**Step 7: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add db.ts test/auto-activity.test.ts
git commit -m "feat: auto-log activity events on project/task/queue mutations"
```

---

### Task 4: Markdown Bridge

**Files:**
- Create: `markdown.ts`
- Create: `test/markdown.test.ts`

**Step 1: Write failing tests**

Create `test/markdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateAgentQueueMd } from "../markdown.js";
import type { QueueItem, Project } from "../db.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p_test", name: "TestProj", status: "green",
    objective: null, nextAction: null, strategy: null,
    hypothesis: null, constraints: null, success: null,
    dueDate: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "q_test", projectId: null, instruction: "Do something",
    rank: 1, status: "pending", source: "human",
    createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

describe("generateAgentQueueMd", () => {
  it("generates header", () => {
    const md = generateAgentQueueMd({ queueItems: [], projects: [], recentlyCompleted: [] });
    expect(md).toContain("# Agent Work Queue");
    expect(md).toContain("Do not edit manually");
  });

  it("renders priority queue with project names", () => {
    const proj = makeProject({ id: "p1", name: "GoatPort" });
    const item = makeQueueItem({ projectId: "p1", instruction: "Fix onboarding", rank: 1 });
    const md = generateAgentQueueMd({ queueItems: [item], projects: [proj], recentlyCompleted: [] });
    expect(md).toContain("## Priority Queue");
    expect(md).toContain("[Project: GoatPort] Fix onboarding");
  });

  it("renders global items without project prefix", () => {
    const item = makeQueueItem({ instruction: "Review logs", rank: 1 });
    const md = generateAgentQueueMd({ queueItems: [item], projects: [], recentlyCompleted: [] });
    expect(md).toContain("[Global] Review logs");
  });

  it("marks in-progress items", () => {
    const item = makeQueueItem({ instruction: "Active task", status: "in_progress", rank: 1 });
    const md = generateAgentQueueMd({ queueItems: [item], projects: [], recentlyCompleted: [] });
    expect(md).toContain("IN PROGRESS");
  });

  it("renders per-project standing instructions from nextAction", () => {
    const proj = makeProject({ name: "GoatPort", nextAction: "Finish onboarding" });
    const md = generateAgentQueueMd({ queueItems: [], projects: [proj], recentlyCompleted: [] });
    expect(md).toContain("## Per-Project Standing Instructions");
    expect(md).toContain("### GoatPort");
    expect(md).toContain("Finish onboarding");
  });

  it("renders strategy and constraints as standing instructions", () => {
    const proj = makeProject({ name: "X", strategy: "Go fast", constraints: "No prod deploys" });
    const md = generateAgentQueueMd({ queueItems: [], projects: [proj], recentlyCompleted: [] });
    expect(md).toContain("Strategy: Go fast");
    expect(md).toContain("Constraints: No prod deploys");
  });

  it("omits projects with no standing instructions", () => {
    const proj = makeProject({ name: "Empty" });
    const md = generateAgentQueueMd({ queueItems: [], projects: [proj], recentlyCompleted: [] });
    expect(md).not.toContain("### Empty");
  });

  it("renders recently completed items", () => {
    const item = makeQueueItem({ instruction: "Old task", status: "completed" });
    const proj = makeProject({ id: "p1", name: "Proj" });
    const linked = { ...item, projectId: "p1" };
    const md = generateAgentQueueMd({ queueItems: [], projects: [proj], recentlyCompleted: [linked] });
    expect(md).toContain("## Recently Completed");
    expect(md).toContain("~~[Proj] Old task~~");
  });

  it("sorts queue items by rank", () => {
    const a = makeQueueItem({ id: "q1", instruction: "Second", rank: 2 });
    const b = makeQueueItem({ id: "q2", instruction: "First", rank: 1 });
    const md = generateAgentQueueMd({ queueItems: [a, b], projects: [], recentlyCompleted: [] });
    const firstIdx = md.indexOf("First");
    const secondIdx = md.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("is deterministic — same input produces same output (ignoring timestamp)", () => {
    const items = [makeQueueItem({ instruction: "A", rank: 1 })];
    const md1 = generateAgentQueueMd({ queueItems: items, projects: [], recentlyCompleted: [] });
    const md2 = generateAgentQueueMd({ queueItems: items, projects: [], recentlyCompleted: [] });
    const strip = (s: string) => s.replace(/Last updated:.*/, "");
    expect(strip(md1)).toBe(strip(md2));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- test/markdown.test.ts`
Expected: FAIL — cannot find module `../markdown.js`

**Step 3: Implement markdown.ts**

Create `markdown.ts`:

```ts
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { QueueItem, Project } from "./db.js";

export function generateAgentQueueMd(params: {
  queueItems: QueueItem[];
  projects: Project[];
  recentlyCompleted: QueueItem[];
}): string {
  const lines: string[] = [];
  lines.push("# Agent Work Queue");
  lines.push(`> Auto-generated by Project Dashboard. Do not edit manually.`);
  lines.push(`> Last updated: ${new Date().toISOString()}`);
  lines.push("");

  // Priority Queue
  const pending = params.queueItems
    .filter((q) => q.status === "pending" || q.status === "in_progress")
    .sort((a, b) => a.rank - b.rank);

  if (pending.length) {
    lines.push("## Priority Queue");
    pending.forEach((q, i) => {
      const proj = q.projectId ? params.projects.find((p) => p.id === q.projectId) : null;
      const prefix = proj ? `[Project: ${proj.name}]` : "[Global]";
      const marker = q.status === "in_progress" ? " → IN PROGRESS" : "";
      lines.push(`${i + 1}. ${prefix} ${q.instruction}${marker}`);
    });
    lines.push("");
  }

  // Per-Project Standing Instructions
  const withInstructions = params.projects.filter(
    (p) => p.nextAction || p.strategy || p.constraints
  );

  if (withInstructions.length) {
    lines.push("## Per-Project Standing Instructions");
    for (const p of withInstructions) {
      lines.push(`### ${p.name}`);
      if (p.nextAction) lines.push(`- ${p.nextAction}`);
      if (p.strategy) lines.push(`- Strategy: ${p.strategy}`);
      if (p.constraints) lines.push(`- Constraints: ${p.constraints}`);
      lines.push("");
    }
  }

  // Recently Completed
  if (params.recentlyCompleted.length) {
    lines.push("## Recently Completed");
    for (const q of params.recentlyCompleted) {
      const proj = q.projectId ? params.projects.find((p) => p.id === q.projectId) : null;
      const prefix = proj ? `[${proj.name}]` : "[Global]";
      lines.push(`- ~~${prefix} ${q.instruction}~~ ✓`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeAgentQueueMd(workspaceDir: string, content: string): void {
  const filePath = join(workspaceDir, "AGENT_QUEUE.md");
  // Only write if content changed (ignoring timestamp line)
  const strip = (s: string) => s.replace(/^> Last updated:.*$/m, "");
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8");
    if (strip(existing) === strip(content)) return;
  }
  writeFileSync(filePath, content, "utf8");
}
```

**Step 4: Run tests**

Run: `npm test -- test/markdown.test.ts`
Expected: All PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All PASS

**Step 6: Commit**

```bash
git add markdown.ts test/markdown.test.ts
git commit -m "feat: add markdown bridge for AGENT_QUEUE.md generation"
```

---

### Task 5: Queue API Routes

**Files:**
- Modify: `index.ts:48-161` (inside the HTTP request handler)

**Step 1: Add queue API routes to the HTTP handler**

In `index.ts`, inside the `http.createServer` callback, before the final `json(res, 404, ...)` line (line 158), add:

```ts
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
```

**Step 2: Add the regenerateMd helper and workspaceDir**

At the top of the `register()` function (after the `stateDir` resolution around line 29), add:

```ts
  const workspaceDir = process.cwd();
```

Then, after the `getRepo()` function definition (after line 40), add:

```ts
  async function regenerateMd(repo: Awaited<ReturnType<typeof getRepo>>) {
    const { generateAgentQueueMd, writeAgentQueueMd } = await import("./markdown.js");
    const queueItems = repo.listQueue();
    const projects = repo.listProjects();
    const recentlyCompleted = repo.listRecentlyCompleted();
    const content = generateAgentQueueMd({ queueItems, projects, recentlyCompleted });
    writeAgentQueueMd(workspaceDir, content);
  }
```

**Step 3: Add import for markdown module**

Add to the top of `index.ts` (no static import needed — using dynamic import in `regenerateMd` to avoid circular issues at load time). No changes needed.

**Step 4: Also regenerate markdown on project instruction changes**

In the existing `POST /api/projects/update` handler (around line 91-106), after `const proj = repo.updateProject(patch);`, add:

```ts
            await regenerateMd(repo);
```

**Step 5: Manual verification**

Run the plugin (or use `curl` against a running server):

```bash
# Add a queue item
curl -X POST http://127.0.0.1:5178/api/queue -H 'content-type: application/json' -d '{"instruction":"Test task"}'

# List queue
curl http://127.0.0.1:5178/api/queue

# Check AGENT_QUEUE.md was written
cat AGENT_QUEUE.md
```

**Step 6: Commit**

```bash
git add index.ts
git commit -m "feat: add queue API routes with markdown bridge regeneration"
```

---

### Task 6: Activity + Cron Health API Routes + Extend /api/state

**Files:**
- Modify: `index.ts` (HTTP handler and /api/state)
- Modify: `bootstrap.ts` (add health derivation helper)

**Step 1: Add activity API routes**

In `index.ts`, inside the HTTP handler, before the `json(res, 404, ...)` line, add:

```ts
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
```

**Step 2: Add cron health API routes**

Continue adding in the same location:

```ts
        // ── Cron routes ──

        if (req.method === "GET" && url === "/api/cron") {
          const repo = await getRepo();
          const jobs = loadCronJobsFromStateDir(stateDir);
          const snapshots = repo.listCronSnapshots();
          const cronHealth = jobs.map((j) => {
            const snap = snapshots.find((s) => s.jobId === j.id);
            return {
              ...j,
              lastStatus: snap?.lastStatus ?? "unknown",
              lastError: snap?.lastError ?? null,
              lastSeenAt: snap?.lastSeenAt ?? null,
              health: deriveHealth(snap),
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
```

**Step 3: Add deriveHealth helper**

Add as a standalone function at the bottom of `index.ts` (after the existing helper functions):

```ts
function deriveHealth(snap: { lastStatus: string; lastSeenAt: number } | null | undefined): "green" | "yellow" | "red" {
  if (!snap || !snap.lastSeenAt) return "yellow";
  const age = Date.now() - snap.lastSeenAt;
  if (snap.lastStatus === "failure") return "red";
  if (age > 24 * 60 * 60 * 1000) return "yellow"; // stale > 24h
  return "green";
}
```

**Step 4: Add cron snapshot updating to /api/state**

In the existing `/api/state` handler, add snapshot updating and new fields. Modify the handler to:

```ts
        if (req.method === "GET" && url === "/api/state") {
          const repo = await getRepo();
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
            if (!prev || prev.lastStatus !== status || (j.lastAt && j.lastAt !== prev.lastSeenAt)) {
              repo.upsertCronSnapshot({ jobId: j.id, lastStatus: status });
              if (prev && prev.lastStatus !== status) {
                repo.logActivity({
                  source: "agent",
                  action: status === "failure" ? "cron_failed" : "cron_ran",
                  detail: j.name,
                });
              }
            }
          }

          // New fields
          const queue = repo.listQueue();
          const activityFeed = repo.listActivity(20);
          const snapshots = repo.listCronSnapshots();
          const cronHealth = jobs.map((j) => {
            const snap = snapshots.find((s) => s.jobId === j.id);
            return { ...j, lastStatus: snap?.lastStatus ?? "unknown", lastError: snap?.lastError ?? null, health: deriveHealth(snap) };
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
```

**Step 5: Add source parameter support to existing mutation routes**

In the `POST /api/updates` handler, pass `source` to the update (this requires adding a `source` parameter to `addUpdate` in db.ts — or handle it at the route level by calling `logActivity` explicitly). Since the auto-logging in db.ts defaults to `"human"`, and we want API callers to pass `source`, modify the auto-logging in `addUpdate` in `db.ts` to accept an optional source:

Actually, to keep it simple: the auto-logging defaults to `"human"`. When the agent calls the API, the UI/agent can separately call `POST /api/activity` to log with `source: "agent"`. The auto-logging captures the event; the `source` on the activity entry can be overridden by the caller. This is good enough for now — skip this step.

**Step 6: Manual verification**

```bash
# Get activity feed
curl http://127.0.0.1:5178/api/activity

# Get cron health
curl http://127.0.0.1:5178/api/cron

# Get full state (should include queue, activity, cronHealth)
curl http://127.0.0.1:5178/api/state | python3 -m json.tool | head -50
```

**Step 7: Run all tests to confirm nothing broke**

Run: `npm test`
Expected: All PASS

**Step 8: Commit**

```bash
git add index.ts
git commit -m "feat: add activity/cron API routes and extend /api/state with queue, activity, cronHealth"
```

---

### Task 7: UI — Command Center Layout Restructure

**Files:**
- Modify: `ui.html` (full restructure of layout, CSS, and left panel)

**Step 1: Update CSS for the new layout**

In `ui.html`, within the `<style>` block, replace the `main` grid rule:

```css
main { max-width: 1200px; margin: 0 auto; padding: 16px; display: grid; grid-template-columns: 380px 1fr; gap: 14px; }
@media (max-width: 960px) { main { grid-template-columns: 1fr; } }
```

Add new CSS rules for collapsible sections:

```css
.section { margin-bottom: 8px; }
.sectionHeader { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; cursor: pointer; user-select: none; border-radius: 10px; background: rgba(255,255,255,0.03); }
.sectionHeader:hover { background: rgba(255,255,255,0.06); }
.sectionTitle { font-weight: 700; font-size: 13px; }
.sectionBody { padding: 8px 0; }
.sectionBody.collapsed { display: none; }
.chevron { transition: transform 0.2s; font-size: 11px; color: var(--muted); }
.chevron.open { transform: rotate(90deg); }
.source-badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; font-weight: 600; }
.source-human { background: rgba(120,166,255,0.2); color: var(--accent); }
.source-agent { background: rgba(57,217,138,0.2); color: var(--good); }
.health-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.health-green { background: var(--good); }
.health-yellow { background: var(--warn); }
.health-red { background: var(--bad); }
.queue-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,0.03); cursor: grab; }
.queue-item.active { border-color: rgba(57,217,138,0.4); background: rgba(57,217,138,0.08); }
.queue-rank { font-size: 11px; color: var(--muted); min-width: 18px; text-align: center; }
.queue-text { flex: 1; font-size: 12px; }
.queue-project { font-size: 10px; color: var(--accent); }
.queue-actions { display: flex; gap: 4px; }
.queue-actions button { width: auto; padding: 3px 7px; font-size: 10px; }
.activity-item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; }
.activity-time { color: var(--muted); font-size: 11px; min-width: 40px; }
.pulse-dot { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.offline-badge { color: var(--bad); font-size: 11px; display: none; }
```

**Step 2: Restructure left panel HTML**

Replace the existing left `<section class="card">` (the projects list card) with:

```html
    <section class="card" style="overflow-y:auto; max-height: calc(100vh - 80px);">
      <div class="cardHeader">
        <div style="font-weight:700;">Command Center</div>
        <div class="row" style="gap:6px;">
          <span class="offline-badge" id="offlineBadge">offline</span>
          <button class="secondary" id="btnRefresh" style="width:auto;">Refresh</button>
        </div>
      </div>
      <div class="cardBody" style="padding:8px;">

        <!-- Work Queue Section -->
        <div class="section" id="sectionQueue">
          <div class="sectionHeader" data-section="queue">
            <div class="sectionTitle">Work Queue <span class="badge" id="queueCount">0</span></div>
            <span class="chevron open" id="chevronQueue">▶</span>
          </div>
          <div class="sectionBody" id="bodyQueue">
            <div style="display:flex; gap:6px; margin-bottom:8px;">
              <input id="queueInput" placeholder="Add instruction..." style="flex:1;" />
              <button id="btnAddQueue" style="width:auto; padding:6px 10px;">Add</button>
            </div>
            <div id="queueList" class="list" style="gap:6px;"></div>
          </div>
        </div>

        <!-- Cron Health Section -->
        <div class="section" id="sectionCron">
          <div class="sectionHeader" data-section="cron">
            <div class="sectionTitle">Cron Health <span class="badge" id="cronCount">0</span></div>
            <span class="chevron open" id="chevronCron">▶</span>
          </div>
          <div class="sectionBody" id="bodyCron">
            <div id="cronList" class="list" style="gap:6px;"></div>
          </div>
        </div>

        <!-- Activity Feed Section -->
        <div class="section" id="sectionActivity">
          <div class="sectionHeader" data-section="activity">
            <div class="sectionTitle">Activity Feed</div>
            <span class="chevron open" id="chevronActivity">▶</span>
          </div>
          <div class="sectionBody" id="bodyActivity">
            <div id="activityList"></div>
          </div>
        </div>

        <!-- Projects list (compact, below activity) -->
        <div class="section" id="sectionProjects">
          <div class="sectionHeader" data-section="projects">
            <div class="sectionTitle">Projects <span class="badge" id="projectCount">0</span></div>
            <span class="chevron open" id="chevronProjects">▶</span>
          </div>
          <div class="sectionBody" id="bodyProjects">
            <div class="list" id="projectsList"></div>
          </div>
        </div>

      </div>
    </section>
```

**Step 3: Add collapsible section toggle logic**

In the `<script>` block, add section toggle handler:

```js
document.querySelectorAll('.sectionHeader').forEach(header => {
  header.addEventListener('click', () => {
    const section = header.dataset.section;
    const body = document.getElementById('body' + section.charAt(0).toUpperCase() + section.slice(1));
    const chevron = document.getElementById('chevron' + section.charAt(0).toUpperCase() + section.slice(1));
    if (body) body.classList.toggle('collapsed');
    if (chevron) chevron.classList.toggle('open');
  });
});
```

**Step 4: Add "Dashboard" tab to right panel**

In the `#detailTabs` div, add a new tab at the beginning:

```html
<div class="tab active" data-tab="dashboard">Dashboard</div>
```

Change the existing "overview" tab to not be active by default:

```html
<div class="tab" data-tab="overview">Overview</div>
```

Add a new view div before `view_overview`:

```html
<div id="view_dashboard" class="stack" style="margin-top:10px; display:grid; gap:10px;"></div>
```

Update `currentTab` default:

```js
let currentTab = 'dashboard';
```

**Step 5: Update renderDetail to show right panel even without project selected (for dashboard tab)**

Modify `renderDetail()` so the right panel always shows when dashboard tab is selected. The detail card should show by default. Update the logic:

```js
function renderDetail(){
  const detail = el('detailCard');
  detail.style.display = '';

  if (currentTab === 'dashboard') {
    el('projTitle').textContent = 'Dashboard';
    el('projStatus').textContent = '';
    el('projActive').style.display = 'none';
    renderTab();
    return;
  }

  const proj = (STATE.projects||[]).find(p => p.id===selectedId);
  if (!proj){ detail.style.display='none'; return; }
  el('projTitle').textContent = proj.name;
  el('projStatus').textContent = `Status: ${proj.status}`;
  const act = activeFor(proj.id);
  if (act.active){ el('projActive').style.display='inline-flex'; el('projActive').textContent = act.reasons[0] || 'Active now'; } else { el('projActive').style.display='none'; }
  switchTab(currentTab);
}
```

**Step 6: Update switchTab to handle the new dashboard tab**

Add `view_dashboard` to the tab switching logic:

```js
function switchTab(tab){
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  ['dashboard','overview','tasks','schedules','strategy','updates'].forEach(v => {
    el('view_' + v).style.display = v === tab ? '' : 'none';
  });
  renderTab();
}
```

**Step 7: Manual verification**

Open `http://127.0.0.1:5178/` and verify:
- Left panel shows Command Center with four collapsible sections
- Sections toggle open/closed on header click
- Right panel shows with Dashboard tab as default
- Projects section still renders the project list
- Clicking a project switches to project detail view

**Step 8: Commit**

```bash
git add ui.html
git commit -m "feat: restructure UI to command center split layout with collapsible sections"
```

---

### Task 8: UI — Work Queue Interactivity

**Files:**
- Modify: `ui.html` (queue rendering, add/edit/reorder/status logic)

**Step 1: Implement queue rendering in refresh cycle**

In the `<script>` block, after the `renderProjects()` call in `refresh()`, add queue rendering. Create a `renderQueue()` function:

```js
function renderQueue() {
  const queue = STATE?.queue || [];
  el('queueCount').textContent = queue.length;
  const list = el('queueList');
  list.innerHTML = queue.map((q, i) => {
    const proj = q.projectId ? (STATE.projects||[]).find(p=>p.id===q.projectId) : null;
    const isActive = q.status === 'in_progress';
    return `<div class="queue-item ${isActive ? 'active' : ''}" draggable="true" data-qid="${q.id}">
      <div class="queue-rank">${i+1}</div>
      <div style="flex:1;">
        <div class="queue-text">${escapeHtml(q.instruction)}</div>
        ${proj ? `<div class="queue-project">${escapeHtml(proj.name)}</div>` : ''}
      </div>
      <div class="queue-actions">
        ${q.status === 'pending' ? `<button class="secondary" data-qaction="start" data-qid="${q.id}" title="Start">▶</button>` : ''}
        ${q.status === 'in_progress' ? `<button class="secondary" data-qaction="done" data-qid="${q.id}" title="Complete">✓</button>` : ''}
        <button class="secondary" data-qaction="skip" data-qid="${q.id}" title="Skip">⊘</button>
        <button class="secondary" data-qaction="delete" data-qid="${q.id}" title="Delete">×</button>
      </div>
    </div>`;
  }).join('');

  // Action buttons
  list.querySelectorAll('button[data-qaction]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const qid = btn.dataset.qid;
      const action = btn.dataset.qaction;
      if (action === 'start') await api('/api/queue/update', { id: qid, status: 'in_progress' });
      else if (action === 'done') await api('/api/queue/update', { id: qid, status: 'completed' });
      else if (action === 'skip') await api('/api/queue/update', { id: qid, status: 'skipped' });
      else if (action === 'delete') await api('/api/queue/delete', { id: qid });
      await refresh();
    };
  });

  // Drag-to-reorder
  let dragId = null;
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', (e) => { dragId = item.dataset.qid; item.style.opacity = '0.4'; });
    item.addEventListener('dragend', () => { item.style.opacity = ''; });
    item.addEventListener('dragover', (e) => { e.preventDefault(); });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragId || dragId === item.dataset.qid) return;
      const items = [...list.querySelectorAll('.queue-item')];
      const ids = items.map(el => el.dataset.qid);
      const fromIdx = ids.indexOf(dragId);
      const toIdx = ids.indexOf(item.dataset.qid);
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, dragId);
      dragId = null;
      await api('/api/queue/reorder', { ids });
      await refresh();
    });
  });

  // Click queue item to select linked project
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('click', () => {
      const q = queue.find(q => q.id === item.dataset.qid);
      if (q?.projectId) { selectedId = q.projectId; switchTab('overview'); renderDetail(); }
    });
  });
}
```

**Step 2: Wire up the Add button**

```js
el('btnAddQueue').onclick = async () => {
  const input = el('queueInput');
  const instruction = input.value.trim();
  if (!instruction) return;
  await api('/api/queue', { instruction });
  input.value = '';
  await refresh();
};

el('queueInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('btnAddQueue').click();
});
```

**Step 3: Call renderQueue() from refresh()**

In the `refresh()` function, after `renderProjects()`, add:

```js
  renderQueue();
```

**Step 4: Manual verification**

- Add a queue item via the input field
- Verify it appears in the list with rank number
- Click Start (▶) → item should highlight as active
- Click Complete (✓) → item should disappear from list
- Drag items to reorder → ranks update
- Click Delete (×) → item removed
- Check that AGENT_QUEUE.md gets updated on each action

**Step 5: Commit**

```bash
git add ui.html
git commit -m "feat: add work queue UI with add, status transitions, drag reorder, and delete"
```

---

### Task 9: UI — Cron Health, Activity Feed, Dashboard Tab, Auto-Refresh

**Files:**
- Modify: `ui.html` (cron health rendering, activity feed, dashboard aggregate tab, auto-refresh polling)

**Step 1: Implement cron health rendering**

Add a `renderCron()` function:

```js
function renderCron() {
  const crons = STATE?.cronHealth || [];
  el('cronCount').textContent = crons.length;
  const list = el('cronList');
  if (!crons.length) {
    list.innerHTML = '<div class="small">No cron jobs detected.</div>';
    return;
  }
  list.innerHTML = crons.map(c => `
    <div class="item" style="padding:8px;">
      <div class="itemTop">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="health-dot health-${c.health || 'yellow'}"></span>
          <span style="font-size:12px;font-weight:600;">${escapeHtml(c.name)}</span>
        </div>
        <span class="badge">${escapeHtml(c.lastStatus || 'unknown')}</span>
      </div>
      <div class="small">
        Last: ${c.lastAt ? fmtTime(c.lastAt) : '—'}
        ${c.lastError ? ` · Error: ${escapeHtml(c.lastError)}` : ''}
      </div>
    </div>
  `).join('');
}
```

**Step 2: Implement activity feed rendering**

Add a `renderActivity()` function:

```js
function renderActivity() {
  const activity = STATE?.activity || [];
  const list = el('activityList');
  if (!activity.length) {
    list.innerHTML = '<div class="small">No activity yet.</div>';
    return;
  }
  list.innerHTML = activity.slice(0, 15).map(a => {
    const proj = a.projectId ? (STATE.projects||[]).find(p=>p.id===a.projectId) : null;
    return `<div class="activity-item">
      <div class="activity-time">${fmtAge(Date.now() - a.createdAt)}</div>
      <span class="source-badge source-${a.source}">${a.source}</span>
      <div style="flex:1;">
        <span>${escapeHtml(a.action.replace(/_/g,' '))}</span>
        ${a.detail ? ` · <span class="muted">${escapeHtml(a.detail.slice(0,80))}</span>` : ''}
        ${proj ? ` <span class="queue-project" style="cursor:pointer;" data-pid="${proj.id}">${escapeHtml(proj.name)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  // Click project name to navigate
  list.querySelectorAll('[data-pid]').forEach(el => {
    el.onclick = () => { selectedId = el.dataset.pid; switchTab('overview'); renderDetail(); };
  });
}
```

**Step 3: Implement dashboard aggregate tab**

In the `renderTab()` function, add a `dashboard` tab case:

```js
  if (currentTab === 'dashboard') {
    const projects = STATE?.projects || [];
    const queue = STATE?.queue || [];
    const crons = STATE?.cronHealth || [];
    const activity = STATE?.activity || [];

    const green = projects.filter(p => p.status === 'green').length;
    const yellow = projects.filter(p => p.status === 'yellow').length;
    const red = projects.filter(p => p.status === 'red').length;
    const cronRed = crons.filter(c => c.health === 'red').length;
    const cronYellow = crons.filter(c => c.health === 'yellow').length;
    const inProgress = queue.find(q => q.status === 'in_progress');

    el('view_dashboard').innerHTML = `
      <div class="grid-2">
        <div class="item">
          <div class="itemTitle">Projects</div>
          <div class="row" style="gap:12px; margin-top:6px;">
            <span>${statusDot('green')} ${green} green</span>
            <span>${statusDot('yellow')} ${yellow} yellow</span>
            <span>${statusDot('red')} ${red} red</span>
          </div>
        </div>
        <div class="item">
          <div class="itemTitle">Work Queue</div>
          <div style="margin-top:6px; font-size:13px;">
            ${queue.length} pending${inProgress ? ` · <span style="color:var(--good);">Active: ${escapeHtml(inProgress.instruction.slice(0,50))}</span>` : ''}
          </div>
        </div>
        <div class="item">
          <div class="itemTitle">Cron Health</div>
          <div class="row" style="gap:12px; margin-top:6px;">
            <span><span class="health-dot health-green"></span>${crons.length - cronRed - cronYellow} healthy</span>
            ${cronYellow ? `<span><span class="health-dot health-yellow"></span>${cronYellow} stale</span>` : ''}
            ${cronRed ? `<span><span class="health-dot health-red"></span>${cronRed} failing</span>` : ''}
          </div>
        </div>
        <div class="item">
          <div class="itemTitle">Recent Activity</div>
          <div style="margin-top:6px;">
            ${activity.slice(0,5).map(a => `<div class="small">${fmtAge(Date.now()-a.createdAt)} · ${escapeHtml(a.action.replace(/_/g,' '))}${a.detail ? ': '+escapeHtml(a.detail.slice(0,60)) : ''}</div>`).join('') || '<div class="small">No activity</div>'}
          </div>
        </div>
      </div>
    `;
  }
```

**Step 4: Call new render functions from refresh()**

In the `refresh()` function, after `renderQueue()`, add:

```js
  renderCron();
  renderActivity();
```

**Step 5: Implement auto-refresh polling**

After the initial `refresh().catch(...)` call at the bottom of the script, add:

```js
let pollInterval = null;
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      await refresh();
      el('offlineBadge').style.display = 'none';
    } catch (err) {
      el('offlineBadge').style.display = 'inline';
    }
  }, 15000);
}
startPolling();
```

Also update the header timestamp to show last refresh with a pulse. In the `refresh()` function, update `nowMeta`:

```js
  el('nowMeta').innerHTML = `<span class="pulse-dot">●</span> ${new Date().toLocaleTimeString()}`;
```

**Step 6: Show right panel by default (for dashboard tab)**

Remove `style="display:none;"` from the `#detailCard` section so the dashboard tab shows on load.

**Step 7: Manual verification**

- Open the dashboard — should show the aggregate Dashboard tab by default
- Verify project status counts, queue depth, cron health summary are correct
- Left panel: Work Queue shows items with action buttons
- Left panel: Cron Health shows jobs with colored health dots
- Left panel: Activity Feed shows recent events with timestamps and source badges
- Wait 15 seconds — UI should auto-refresh (check timestamp updates)
- Stop the server — "offline" badge should appear after next poll cycle
- Click project names in activity feed — should navigate to that project

**Step 8: Run all tests to confirm nothing broke**

Run: `npm test`
Expected: All PASS

**Step 9: Commit**

```bash
git add ui.html
git commit -m "feat: add cron health, activity feed, dashboard tab, and 15s auto-refresh polling"
```

---

## Post-Implementation Checklist

After all tasks are complete, verify the full workflow end-to-end:

1. Start the dashboard (`/project-dashboard open`)
2. Add a project through the UI
3. Add queue items, reorder them, start one, complete one
4. Verify `AGENT_QUEUE.md` exists and contains the expected content
5. Check that activity feed shows all the actions you took
6. Verify cron health section shows jobs (if any exist in state dir)
7. Leave the dashboard open for 30+ seconds — confirm auto-refresh works
8. Check the Dashboard aggregate tab shows correct summaries
9. Run `npm test` one final time
