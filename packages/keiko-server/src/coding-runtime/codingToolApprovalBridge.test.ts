import { describe, expect, it } from "vitest";

import {
  codingToolApprovalBindingDigest,
  createCodingToolApprovalBridge,
} from "./codingToolApprovalBridge.js";

const RUN_ID = "run-bounded-approvals";
const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const EXPIRES_AT = "2026-08-03T12:05:00.000Z";

function observe(
  bridge: ReturnType<typeof createCodingToolApprovalBridge>,
  index: number,
): boolean {
  const actionId = `action-${String(index)}`;
  const request = {
    action: "verification" as const,
    actionId,
    idempotencyKey: `idempotency-${String(index)}`,
    verifierId: "typecheck",
  };
  return bridge.observePermission({
    runId: RUN_ID,
    requestId: `permission-${String(index)}`,
    action: request.action,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    targetId: request.verifierId,
    proof: {
      approvalId: request.actionId,
      approvalDigest: codingToolApprovalBindingDigest(RUN_ID, request),
    },
    expiresAt: EXPIRES_AT,
    nowMs: NOW_MS,
  });
}

describe("coding tool approval bridge capacity", () => {
  it("rejects excess pending observations without evicting a live approval", () => {
    const bridge = createCodingToolApprovalBridge();
    for (let index = 0; index < 64; index += 1) expect(observe(bridge, index)).toBe(true);

    expect(observe(bridge, 64)).toBe(false);
    expect(
      bridge.activatePermission({
        runId: RUN_ID,
        requestId: "permission-0",
        approvalAuthorityDigest: "a".repeat(64),
        expiresAtMs: Date.parse(EXPIRES_AT),
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });
});
