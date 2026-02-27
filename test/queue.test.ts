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
