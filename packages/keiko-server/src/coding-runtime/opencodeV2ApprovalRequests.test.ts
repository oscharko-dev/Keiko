// #3610: a governed ask ends in exactly one closed outcome. Before this, the registry answered a
// bare boolean, so the tool facade route could not tell a denied or expired human decision from a
// browser-origin refusal and logged every one of them as `origin-not-allowed`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import { createOpenCodeV2ApprovalRequests } from "./opencodeV2ApprovalRequests.js";

const RUN_ID = "run-approval";
const SESSION_ID = "ses_approval";

function permissionBody(id = "per_approval_1"): Readonly<Record<string, unknown>> {
  return {
    action: "permission-request",
    runId: RUN_ID,
    properties: {
      id,
      sessionID: SESSION_ID,
      permission: "keiko_governed_action",
      patterns: ["src/example.ts"],
      always: [],
      tool: { messageID: "msg_1", callID: "call_1" },
      metadata: {
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        expiresAt: "2099-07-23T14:05:00.000Z",
        actionKind: "file-edit",
        scopeLabel: "workspace-scope",
        risk: "medium",
        policyReason: "approval-required",
        targetPath: "src/example.ts",
        allowedRelativePaths: ["src/example.ts"],
        fileCount: 1,
        addedLines: 1,
        deletedLines: 1,
      },
    },
  };
}

interface Asked {
  readonly events: SidecarPermissionEvent[];
  readonly onPermission: (event: SidecarPermissionEvent) => void;
}

function asked(): Asked {
  const events: SidecarPermissionEvent[] = [];
  return {
    events,
    onPermission: (event): void => {
      events.push(event);
    },
  };
}

function requestIdOf(ask: Asked): string {
  const requestId = ask.events[0]?.requestId;
  if (requestId === undefined) throw new Error("the ask never reached the human");
  return requestId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCode V2 approval requests", () => {
  it.each([
    [true, "approved"],
    [false, "denied"],
  ] as const)("settles a human decision of %s as %s", async (approved, outcome) => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value: permissionBody(),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(true);
    await expect(decision).resolves.toBe(outcome);
    // Settled once: a second reply for the same ask finds nothing pending.
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(false);
  });

  it("expires an unanswered ask after the one human-decision wait", async () => {
    vi.useFakeTimers();
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value: permissionBody(),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    await expect(decision).resolves.toBe("expired");
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(false);
  });

  it("cancels a pending ask when its caller goes away or the run closes", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const controller = new AbortController();
    const aborted = approvals.request({
      value: permissionBody("per_approval_abort"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: controller.signal,
    });
    const closed = approvals.request({
      value: permissionBody("per_approval_close"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: new AbortController().signal,
    });
    controller.abort();
    approvals.close();
    await expect(aborted).resolves.toBe("cancelled");
    await expect(closed).resolves.toBe("cancelled");
  });

  it("answers an ask it cannot put to the human as unavailable, and an aborted one as cancelled", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const signal = new AbortController().signal;
    const onPermission = asked().onPermission;
    await expect(
      approvals.request({
        value: { action: "read" },
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal,
      }),
    ).resolves.toBe("unavailable");
    const pending = approvals.request({
      value: permissionBody("per_approval_twice"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission,
      signal,
    });
    await expect(
      approvals.request({
        value: permissionBody("per_approval_twice"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal,
      }),
    ).resolves.toBe("unavailable");
    await expect(
      approvals.request({
        value: permissionBody("per_approval_late"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toBe("cancelled");
    approvals.close();
    await expect(pending).resolves.toBe("cancelled");
  });

  // #3611 review: at most 64 asks wait at once. The 65th is refused as unavailable, and settling one
  // frees its slot again.
  it("refuses an ask beyond the 64 pending ones and admits one again after a settlement", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const signal = new AbortController().signal;
    const ask = asked();
    const pending = Array.from({ length: 64 }, (_unused, index) =>
      approvals.request({
        value: permissionBody(`per_capacity_${String(index)}`),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    );
    await expect(
      approvals.request({
        value: permissionBody("per_capacity_overflow"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    ).resolves.toBe("unavailable");

    expect(approvals.resolve(RUN_ID, requestIdOf(ask), false)).toBe(true);
    await expect(pending[0]).resolves.toBe("denied");
    const admitted = approvals.request({
      value: permissionBody("per_capacity_after"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal,
    });
    expect(ask.events).toHaveLength(65);
    approvals.close();
    await expect(admitted).resolves.toBe("cancelled");
  });

  it("answers an ask whose delivery to the human failed as unavailable", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    await expect(
      approvals.request({
        value: permissionBody(),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: (): void => {
          throw new Error("event hub closed");
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("unavailable");
  });
});
