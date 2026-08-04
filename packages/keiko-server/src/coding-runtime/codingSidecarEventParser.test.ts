import { describe, expect, it } from "vitest";

import { parseCodingSidecarEventLine } from "./codingSidecarEventParser.js";

const VALID_APPROVAL_EVENT = {
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

describe("coding sidecar approval proof events", () => {
  it("preserves a structurally valid verification approval binding", () => {
    expect(parseCodingSidecarEventLine(JSON.stringify(VALID_APPROVAL_EVENT))).toEqual({
      status: "parsed",
      event: VALID_APPROVAL_EVENT,
    });
  });

  it.each(["short", "g".repeat(64), "A".repeat(64)])(
    "rejects a malformed approval digest at the parser boundary (%s)",
    (approvalDigest) => {
      expect(
        parseCodingSidecarEventLine(JSON.stringify({ ...VALID_APPROVAL_EVENT, approvalDigest })),
      ).toEqual({ status: "invalid" });
    },
  );
});
