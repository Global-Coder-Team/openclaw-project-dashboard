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
