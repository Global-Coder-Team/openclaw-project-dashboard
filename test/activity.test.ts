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
