import { describe, expect, it } from "vitest";
import { LocalKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";

describe("LocalKnowledgeIndexingRegistry", () => {
  it("tracks active capsule jobs and aborts superseded work", () => {
    const registry = new LocalKnowledgeIndexingRegistry();

    expect(registry.cancel("missing")).toBe(false);
    registry.attachJobId("missing", "job-missing");
    registry.complete("missing");

    const first = registry.start("capsule-a");
    registry.attachJobId("capsule-a", "job-a");
    expect(registry.isActiveCapsule("capsule-a")).toBe(true);
    expect(registry.isActiveJob("job-a")).toBe(true);

    registry.attachJobId("capsule-a", "job-b");
    expect(registry.isActiveJob("job-a")).toBe(false);
    expect(registry.isActiveJob("job-b")).toBe(true);
    expect(registry.cancel("capsule-a")).toBe(true);
    expect(first.signal.aborted).toBe(true);

    registry.complete("capsule-a");
    expect(registry.isActiveCapsule("capsule-a")).toBe(false);
    expect(registry.isActiveJob("job-b")).toBe(false);

    const resetRun = registry.start("capsule-b");
    registry.attachJobId("capsule-b", "job-c");
    registry.reset();
    expect(resetRun.signal.aborted).toBe(true);
    expect(registry.isActiveCapsule("capsule-b")).toBe(false);
    expect(registry.isActiveJob("job-c")).toBe(false);
  });
});
