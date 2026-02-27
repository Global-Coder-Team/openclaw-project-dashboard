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
