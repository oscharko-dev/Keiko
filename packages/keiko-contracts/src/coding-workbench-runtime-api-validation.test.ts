import { describe, expect, it } from "vitest";

import { sseEventKeys } from "./coding-workbench-runtime-api-validation.js";

describe("coding workbench runtime SSE validation", () => {
  it("uses the closed event key set for auxiliary runtime events", () => {
    expect(sseEventKeys("runtime-event")).toContain("auxiliaryOutcome");
    expect(sseEventKeys("unknown")).not.toContain("auxiliaryOutcome");
  });
});
