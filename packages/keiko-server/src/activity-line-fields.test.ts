import { describe, expect, it } from "vitest";

import {
  activityErrorFields,
  activityStateLevel,
  definedActivityFields,
} from "./activity-line-fields.js";

describe("activity line fields", () => {
  it("warns on a refusal, adds an internal error kind on a failure and leaves others plain", () => {
    expect(activityStateLevel("failed")).toEqual({ level: "warn", errorKind: "internal" });
    expect(activityStateLevel("refused")).toEqual({ level: "warn" });
    expect(activityStateLevel("completed")).toEqual({});
  });

  it("keeps only the listed fields a line actually carries", () => {
    const line = { outcome: "completed", tool: "jira.issue", durationMs: 0, reason: undefined };
    expect(definedActivityFields(line, ["tool", "durationMs", "reason"])).toEqual({
      tool: "jira.issue",
      durationMs: 0,
    });
  });

  it("adds frames and a cause chain only for a line with an error", () => {
    expect(activityErrorFields({ outcome: "completed" })).toEqual({});
    const error = new Error("outer", { cause: new TypeError("inner") });
    const fields = activityErrorFields({ outcome: "failed", error });
    expect(fields.causeChain).toEqual(["TypeError"]);
    expect(Array.isArray(fields.frames)).toBe(true);
  });
});
