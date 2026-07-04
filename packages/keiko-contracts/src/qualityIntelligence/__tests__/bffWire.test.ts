import { describe, expect, it } from "vitest";
import {
  QUALITY_INTELLIGENCE_RUN_STATUSES,
  type QualityIntelligenceRunStatus,
} from "../bffWire.js";

describe("Quality Intelligence run-status union (GEN-DUP-SEMANTIC-010)", () => {
  it("pins the canonical run-status set", () => {
    expect(QUALITY_INTELLIGENCE_RUN_STATUSES).toEqual<readonly QualityIntelligenceRunStatus[]>([
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
});
