import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { bindSecurityLogCorrelation, type SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { emitNativeUiOwnership } from "./lifecycle-native-activity.js";

it("persists the closed native ownership outcome through the actual registered formatter", () => {
  const events: SecurityLogEvent[] = [];
  const sink = bindSecurityLogCorrelation(
    {
      write: (event): void => {
        events.push(event);
      },
    },
    randomUUID(),
  );
  emitNativeUiOwnership(sink, "commit", "uncertain");
  const event = events[0];
  if (event === undefined) throw new Error("Missing native ownership event");
  expect(
    expectActivityLogProof("cli.lifecycle.native-owner.outcome", formatActivityLogProofLine(event)),
  ).toMatchObject({
    phase: "commit",
    outcome: "uncertain",
    completeness: "complete",
    loss: "none",
  });
  expect(Object.keys(event.extra ?? {}).sort()).toEqual([
    "completeness",
    "loss",
    "outcome",
    "phase",
  ]);
});
