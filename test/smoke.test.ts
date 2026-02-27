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
