import { describe, expect, it } from "vitest";

import { parseCodingSidecarEventLine } from "./codingSidecarEventParser.js";

describe("coding sidecar approval proof events", () => {
  it("preserves a structurally valid verification approval binding", () => {
    const event = {
      type: "permission-request",
      expiresAt: "2026-07-07T13:05:00.000Z",
      requestId: "permission-verification",
      kind: "command-execution",
      actionClass: "command-execution",
      reasonCode: "approval-required",
      actionKind: "verification-command",
      scopeLabel: "workspace-scope",
      risk: "low",
      policyReason: "approval-required",
      commandLabel: "typecheck",
      actionId: "session:call",
      idempotencyKey: "session:call",
      approvalId: "session:call",
      approvalDigest: "b".repeat(64),
    };

    expect(parseCodingSidecarEventLine(JSON.stringify(event))).toEqual({
      status: "parsed",
      event,
    });
  });
});
