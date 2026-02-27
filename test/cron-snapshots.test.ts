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
