import { describe, expect, it } from "vitest";

import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

describe("runtime authority projection", () => {
  it("projects private values deterministically with domain separation", () => {
    const task = projectRuntimeAuthorityValue("task", "private-value");
    expect(task).toMatch(/^task-[0-9]+$/u);
    expect(task).toBe(projectRuntimeAuthorityValue("task", "private-value"));
    expect(task).not.toBe(projectRuntimeAuthorityValue("workspace", "private-value"));
    expect(task).not.toContain("private-value");
  });
});
