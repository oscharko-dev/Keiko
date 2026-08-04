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

  it("keeps distinct full bindings independent when an action id is reused", () => {
    const bridge = createCodingToolApprovalBridge();
    const firstRequest = {
      action: "verification" as const,
      actionId: "shared-action",
      idempotencyKey: "first-idempotency",
      verifierId: "typecheck",
    };
    const secondRequest = {
      ...firstRequest,
      idempotencyKey: "second-idempotency",
      verifierId: "lint",
    };
    const observeRequest = (requestId: string, request: typeof firstRequest): boolean =>
      bridge.observePermission({
        runId: RUN_ID,
        requestId,
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
    const activate = (requestId: string): boolean =>
      bridge.activatePermission({
        runId: RUN_ID,
        requestId,
        approvalAuthorityDigest: "a".repeat(64),
        expiresAtMs: Date.parse(EXPIRES_AT),
        nowMs: NOW_MS,
      });

    expect(observeRequest("permission-first", firstRequest)).toBe(true);
    expect(activate("permission-first")).toBe(true);
    expect(observeRequest("permission-second", secondRequest)).toBe(true);
    expect(activate("permission-second")).toBe(true);
    expect(
      bridge.consume({
        runId: RUN_ID,
        request: {
          ...firstRequest,
          approvalProof: {
            approvalId: firstRequest.actionId,
            approvalDigest: codingToolApprovalBindingDigest(RUN_ID, firstRequest),
          },
        },
        nowMs: NOW_MS,
      }),
    ).toBe(true);
    expect(
      bridge.consume({
        runId: RUN_ID,
        request: {
          ...secondRequest,
          approvalProof: {
            approvalId: secondRequest.actionId,
            approvalDigest: codingToolApprovalBindingDigest(RUN_ID, secondRequest),
          },
        },
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects an identical binding replayed under a new permission request id", () => {
    const bridge = createCodingToolApprovalBridge();
    const request = {
      action: "verification" as const,
      actionId: "replayed-action",
      idempotencyKey: "replayed-idempotency",
      verifierId: "typecheck",
    };
    const observeRequest = (requestId: string): boolean =>
      bridge.observePermission({
        runId: RUN_ID,
        requestId,
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

    expect(observeRequest("permission-original")).toBe(true);
    expect(observeRequest("permission-replay")).toBe(false);
  });

  it("rejects a forged approval id even when the binding digest is correct", () => {
    const bridge = createCodingToolApprovalBridge();
    const request = {
      action: "verification" as const,
      actionId: "bound-action",
      idempotencyKey: "bound-idempotency",
      verifierId: "typecheck",
    };
    expect(
      bridge.observePermission({
        runId: RUN_ID,
        requestId: "permission-bound",
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
      }),
    ).toBe(true);
    expect(
      bridge.activatePermission({
        runId: RUN_ID,
        requestId: "permission-bound",
        approvalAuthorityDigest: "a".repeat(64),
        expiresAtMs: Date.parse(EXPIRES_AT),
        nowMs: NOW_MS,
      }),
    ).toBe(true);

    expect(
      bridge.consume({
        runId: RUN_ID,
        request: {
          ...request,
          approvalProof: {
            approvalId: "forged-action",
            approvalDigest: codingToolApprovalBindingDigest(RUN_ID, request),
          },
        },
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects replacement of a pending request id before activation", () => {
    const bridge = createCodingToolApprovalBridge();
    const requestId = "permission-shared";
    const observeRequest = (actionId: string, verifierId: string): boolean => {
      const request = {
        action: "verification" as const,
        actionId,
        idempotencyKey: `idempotency-${actionId}`,
        verifierId,
      };
      return bridge.observePermission({
        runId: RUN_ID,
        requestId,
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
    };

    expect(observeRequest("original-action", "typecheck")).toBe(true);
    expect(observeRequest("replacement-action", "publish")).toBe(false);
    expect(
      bridge.activatePermission({
        runId: RUN_ID,
        requestId,
        approvalAuthorityDigest: "a".repeat(64),
        expiresAtMs: Date.parse(EXPIRES_AT),
        nowMs: NOW_MS,
      }),
    ).toBe(true);
    const original = {
      action: "verification" as const,
      actionId: "original-action",
      idempotencyKey: "idempotency-original-action",
      verifierId: "typecheck",
    };
    expect(
      bridge.consume({
        runId: RUN_ID,
        request: {
          ...original,
          approvalProof: {
            approvalId: original.actionId,
            approvalDigest: codingToolApprovalBindingDigest(RUN_ID, original),
          },
        },
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });
});
