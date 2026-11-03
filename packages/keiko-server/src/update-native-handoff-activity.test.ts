import { describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { emitNativeHandoffState } from "./update-native-handoff-activity.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("native handoff Activity Log evidence", () => {
  it.each([
    ["admission", "failed", false],
    ["acceptance", "completed", true],
    ["commit", "completed", true],
    ["cleanup", "uncertain", true],
    ["cleanup", "completed", false],
  ] as const)("persists the bounded %s/%s state", (phase, outcome, nativeAuthorityMayBeLive) => {
    const events: SecurityLogEvent[] = [];
    emitNativeHandoffState(
      {
        write: (event): void => {
          events.push(event);
        },
      },
      "a".repeat(32),
      phase,
      outcome,
      nativeAuthorityMayBeLive,
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("Native handoff evidence is missing");
    const persisted = expectActivityLogProof(
      "update.portable.native-control.lifetime",
      formatActivityLogProofLine(event),
    );
    expect(persisted).toMatchObject({
      op: "update.portable.native-control",
      phase,
      outcome,
      nativeAuthorityMayBeLive,
      completeness: "complete",
      loss: "none",
    });
  });
});
