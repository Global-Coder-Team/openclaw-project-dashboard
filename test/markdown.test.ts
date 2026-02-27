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
