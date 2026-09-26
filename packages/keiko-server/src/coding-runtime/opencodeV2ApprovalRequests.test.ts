// #3610: a governed ask ends in exactly one closed outcome. Before this, the registry answered a
// bare boolean, so the tool facade route could not tell a denied or expired human decision from a
// browser-origin refusal and logged every one of them as `origin-not-allowed`.
// #3612: the ask names its tool call, and the decision carries the call it belongs to. A file edit
// asks no one (its change review is its one approval, ADR-0124 D6), so no ask carries more.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import { capturedGeneratedV2Ask } from "./opencodeFunctionalHarness/_governedTools.js";
import { createOpenCodeV2ApprovalRequests } from "./opencodeV2ApprovalRequests.js";

const RUN_ID = "run-approval";
const SESSION_ID = "ses_approval";
// A parsed ask's decision names its permission request; its shape is the projection's own.
const ANY_REQUEST_ID = expect.any(String) as unknown as string;

// The ask exactly as the generated V2 plugin sends it for one keiko_verification call.
function verificationAsk(callId = "call_1"): Promise<Record<string, unknown>> {
  return capturedGeneratedV2Ask({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    callId,
    tool: "keiko_verification",
    args: { verifierId: "test", targetPath: "" },
  });
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

function requestIdOf(ask: Asked, index = 0): string {
  const requestId = ask.events[index]?.requestId;
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
  ] as const)(
    "settles a human decision of %s as %s, for the asked call",
    async (approved, outcome) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      const decision = approvals.request({
        value: await verificationAsk(),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
      });
      expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(true);
      await expect(decision).resolves.toEqual({
        outcome,
        actionId: `${SESSION_ID}:call_1`,
        requestId: requestIdOf(ask),
      });
      // Settled once: a second reply for the same ask finds nothing pending.
      expect(approvals.resolve(RUN_ID, requestIdOf(ask), approved)).toBe(false);
    },
  );

  it("expires an unanswered ask after the one human-decision wait", async () => {
    const value = await verificationAsk();
    vi.useFakeTimers();
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    await expect(decision).resolves.toMatchObject({ outcome: "expired" });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(false);
  });

  it("cancels a pending ask when its caller goes away or the run closes", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const controller = new AbortController();
    const aborted = approvals.request({
      value: await verificationAsk("call_abort"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: controller.signal,
    });
    const closed = approvals.request({
      value: await verificationAsk("call_close"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: asked().onPermission,
      signal: new AbortController().signal,
    });
    controller.abort();
    approvals.close();
    await expect(aborted).resolves.toEqual({
      outcome: "cancelled",
      actionId: `${SESSION_ID}:call_abort`,
      requestId: ANY_REQUEST_ID,
    });
    await expect(closed).resolves.toMatchObject({ outcome: "cancelled" });
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
    ).resolves.toEqual({ outcome: "unavailable" });
    const twice = await verificationAsk("call_twice");
    const pending = approvals.request({
      value: twice,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission,
      signal,
    });
    await expect(
      approvals.request({
        value: twice,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
    await expect(
      approvals.request({
        value: await verificationAsk("call_late"),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({ outcome: "cancelled" });
    approvals.close();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled" });
  });

  // #3611 review: at most 64 asks wait at once. The 65th is refused as unavailable, and settling one
  // frees its slot again.
  it("refuses an ask beyond the 64 pending ones and admits one again after a settlement", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const signal = new AbortController().signal;
    const ask = asked();
    const values = await Promise.all(
      Array.from({ length: 66 }, (_unused, index) =>
        verificationAsk(`call_capacity_${String(index)}`),
      ),
    );
    const pending = values.slice(0, 64).map((value) =>
      approvals.request({
        value,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    );
    await expect(
      approvals.request({
        value: values[64],
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: ask.onPermission,
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });

    expect(approvals.resolve(RUN_ID, requestIdOf(ask), false)).toBe(true);
    await expect(pending[0]).resolves.toMatchObject({ outcome: "denied" });
    const admitted = approvals.request({
      value: values[65],
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal,
    });
    expect(ask.events).toHaveLength(65);
    approvals.close();
    await expect(admitted).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("answers an ask whose delivery to the human failed as unavailable", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    await expect(
      approvals.request({
        value: await verificationAsk(),
        runId: RUN_ID,
        sessionId: SESSION_ID,
        onPermission: (): void => {
          throw new Error("event hub closed");
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ outcome: "unavailable" });
  });

  it("sends the tool call's own identity and settles the decision for that call (#3612)", async () => {
    const verification = await verificationAsk("call_verify");
    expect(verification).toMatchObject({
      action: "permission-request",
      runId: RUN_ID,
      actionId: `${SESSION_ID}:call_verify`,
    });
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = approvals.request({
      value: verification,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    expect(approvals.resolve(RUN_ID, requestIdOf(ask), true)).toBe(true);
    await expect(decision).resolves.toEqual({
      outcome: "approved",
      actionId: `${SESSION_ID}:call_verify`,
      requestId: requestIdOf(ask),
    });
  });

  // Fail closed: an ask that does not name its own call, or carries more than the ask's own keys,
  // never reaches the human. Base digests are such a key now that a file edit asks no one.
  type Ask = Record<string, unknown>;
  const REFUSED_ASKS: readonly (readonly [string, (ask: Ask) => Ask])[] = [
    [
      "an actionId that does not hash to the ask id",
      (ask): Ask => ({ ...ask, actionId: `${SESSION_ID}:call_other` }),
    ],
    ["an actionId of another session", (ask): Ask => ({ ...ask, actionId: "ses_other:call_1" })],
    ["an ask without an actionId", ({ actionId: _dropped, ...ask }: Ask): Ask => ask],
    ["an unknown extra field", (ask): Ask => ({ ...ask, extra: true })],
    [
      "base digests",
      (ask): Ask => ({
        ...ask,
        baseDigests: [{ file: "src/example.ts", expectedContentHash: "a".repeat(64) }],
      }),
    ],
  ];
  it.each(REFUSED_ASKS)(
    "refuses %s as unavailable without asking the human",
    async (_name, mutate) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      await expect(
        approvals.request({
          value: mutate(await verificationAsk()),
          runId: RUN_ID,
          sessionId: SESSION_ID,
          onPermission: ask.onPermission,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ outcome: "unavailable" });
      expect(ask.events).toEqual([]);
    },
  );
});
