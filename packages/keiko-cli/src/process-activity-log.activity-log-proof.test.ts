// Activity Log proofs for the two still-pending `process.exiting`/`process.fatal` fields (#3532
// proof backlog, partition p4-cli). `process.exiting.reason` and `process.fatal.body-free` are
// already proven elsewhere (process-guards.test.ts, not edited here); this file drives the same two
// registered emitters directly — both are plain exported functions — to prove the remaining
// `uptimeMs` and stack-context (`frames`/`causeChain`) evidence fields.
import { describe, expect, it } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  processExitingActivityLogEvent,
  processFatalActivityLogEvent,
} from "./process-activity-log.js";

describe("process-activity-log activity log proofs", () => {
  it("persists process.exiting with the observed uptime", () => {
    const line = formatActivityLogProofLine(
      processExitingActivityLogEvent({ reason: "sigterm", uptimeMs: 12_345.6 }),
    );
    const record = expectActivityLogProof("process.exiting.uptime", line);
    expect(record).toMatchObject({ reason: "sigterm", uptimeMs: 12_345.6 });
  });

  it("clamps a negative or non-finite uptime to zero rather than persisting a nonsensical duration", () => {
    const line = formatActivityLogProofLine(
      processExitingActivityLogEvent({ reason: "sighup", uptimeMs: Number.NaN }),
    );
    const record = expectActivityLogProof("process.exiting.uptime", line);
    expect(record).toMatchObject({ uptimeMs: 0 });
  });

  it("persists process.fatal with the redacted stack frames and cause chain", () => {
    const line = formatActivityLogProofLine(
      processFatalActivityLogEvent({
        kind: "uncaught-exception",
        failureKind: "GatewayError",
        frames: ["packages/keiko-cli/dist/run.js:12:4", "packages/keiko-cli/dist/index.js:3:1"],
        causeChain: ["TypeError"],
      }),
    );
    const record = expectActivityLogProof("process.fatal.stack-context", line);
    expect(record).toMatchObject({
      kind: "uncaught-exception",
      failureKind: "GatewayError",
      frames: ["packages/keiko-cli/dist/run.js:12:4", "packages/keiko-cli/dist/index.js:3:1"],
      causeChain: ["TypeError"],
    });
  });
});
