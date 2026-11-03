// #3610: a governed ask ends in exactly one closed outcome. Before this, the registry answered a
// bare boolean, so the tool facade route could not tell a denied or expired human decision from a
// browser-origin refusal and logged every one of them as `origin-not-allowed`.
// #3612: the ask names its tool call, and the decision carries the call it belongs to. A file edit
// asks no one (its change review is its one approval, ADR-0124 D6), so no ask carries more.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
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

// #3897: the native policy builds its ask itself, so it reaches the human through the same pending
// registry, wait and settlement as a plugin ask, with no tool-call parsing in front of it.
describe("OpenCode V2 approval requests for native asks (#3897)", () => {
  const NATIVE_ACTION_ID = `${SESSION_ID}:call_native`;

  function nativeEvent(requestId: string): SidecarPermissionEvent {
    return {
      type: "permission-request",
      requestId,
      kind: "command-execution",
      actionClass: "command-execution",
      reasonCode: "approval-required",
      expiresAt: "2026-10-23T12:00:00.000Z",
      scopeLabel: "workspace-scope",
      nativeAction: { permission: "shell", resources: ["npm test"] },
    };
  }

  function nativeRequest(
    approvals: ReturnType<typeof createOpenCodeV2ApprovalRequests>,
    ask: Asked,
    requestId: string,
    options: {
      readonly actionId?: string | undefined;
      readonly signal?: AbortSignal;
      readonly runId?: string;
    } = {},
  ): ReturnType<ReturnType<typeof createOpenCodeV2ApprovalRequests>["requestNative"]> {
    return approvals.requestNative({
      runId: options.runId ?? RUN_ID,
      event: nativeEvent(requestId),
      ...(options.actionId === undefined ? {} : { actionId: options.actionId }),
      onPermission: ask.onPermission,
      signal: options.signal ?? new AbortController().signal,
    });
  }

  it.each([
    [true, "approved"],
    [false, "denied"],
  ] as const)(
    "puts the projected event to the human unchanged and settles a decision of %s as %s",
    async (approved, outcome) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      const event = nativeEvent("per_native_decision");
      const decision = approvals.requestNative({
        runId: RUN_ID,
        event,
        actionId: NATIVE_ACTION_ID,
        onPermission: ask.onPermission,
        signal: new AbortController().signal,
      });
      expect(ask.events).toHaveLength(1);
      expect(ask.events[0]).toBe(event);
      expect(approvals.resolve(RUN_ID, "per_native_decision", approved)).toBe(true);
      await expect(decision).resolves.toStrictEqual({
        outcome,
        actionId: NATIVE_ACTION_ID,
        requestId: "per_native_decision",
      });
      // Settled once: a second reply for the same ask finds nothing pending.
      expect(approvals.resolve(RUN_ID, "per_native_decision", approved)).toBe(false);
    },
  );

  it.each([
    ["no action id", undefined],
    ["an empty action id", ""],
  ])(
    "names no tool call to settle for %s, which an ask outside a tool part has",
    async (_label, actionId) => {
      const approvals = createOpenCodeV2ApprovalRequests();
      const ask = asked();
      const decision = nativeRequest(approvals, ask, "per_native_no_call", { actionId });
      approvals.resolve(RUN_ID, "per_native_no_call", true);
      await expect(decision).resolves.toStrictEqual({
        outcome: "approved",
        requestId: "per_native_no_call",
      });
    },
  );

  it("answers an unanswered ask as expired after the one human-decision wait", async () => {
    vi.useFakeTimers();
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = nativeRequest(approvals, ask, "per_native_expiry", {
      actionId: NATIVE_ACTION_ID,
    });
    await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS - 1);
    expect(approvals.resolve(RUN_ID, "per_native_expiry", true)).toBe(true);
    await expect(decision).resolves.toMatchObject({ outcome: "approved" });

    const late = nativeRequest(approvals, ask, "per_native_expired", {
      actionId: NATIVE_ACTION_ID,
    });
    await vi.advanceTimersByTimeAsync(GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    await expect(late).resolves.toStrictEqual({
      outcome: "expired",
      actionId: NATIVE_ACTION_ID,
      requestId: "per_native_expired",
    });
    expect(approvals.resolve(RUN_ID, "per_native_expired", true)).toBe(false);
  });

  it("cancels a pending ask when its caller goes away and frees its slot", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const controller = new AbortController();
    const decision = nativeRequest(approvals, ask, "per_native_abort", {
      actionId: NATIVE_ACTION_ID,
      signal: controller.signal,
    });
    controller.abort();
    await expect(decision).resolves.toStrictEqual({
      outcome: "cancelled",
      actionId: NATIVE_ACTION_ID,
      requestId: "per_native_abort",
    });
    expect(approvals.resolve(RUN_ID, "per_native_abort", true)).toBe(false);
    // The slot and the request id are free again.
    const again = nativeRequest(approvals, ask, "per_native_abort");
    expect(approvals.resolve(RUN_ID, "per_native_abort", false)).toBe(true);
    await expect(again).resolves.toMatchObject({ outcome: "denied" });
  });

  it("cancels every pending native ask when the run closes", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const first = nativeRequest(approvals, ask, "per_native_close_1", {
      actionId: NATIVE_ACTION_ID,
    });
    const second = nativeRequest(approvals, ask, "per_native_close_2");
    approvals.close();
    await expect(first).resolves.toStrictEqual({
      outcome: "cancelled",
      actionId: NATIVE_ACTION_ID,
      requestId: "per_native_close_1",
    });
    await expect(second).resolves.toStrictEqual({
      outcome: "cancelled",
      requestId: "per_native_close_2",
    });
  });

  it("never asks the human once the caller has gone or the run has closed", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    await expect(
      nativeRequest(approvals, ask, "per_native_gone", {
        actionId: NATIVE_ACTION_ID,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toStrictEqual({
      outcome: "cancelled",
      actionId: NATIVE_ACTION_ID,
      requestId: "per_native_gone",
    });
    approvals.close();
    await expect(nativeRequest(approvals, ask, "per_native_after_close")).resolves.toStrictEqual({
      outcome: "cancelled",
      requestId: "per_native_after_close",
    });
    expect(ask.events).toEqual([]);
  });

  it("refuses an ask beyond the 64 pending ones as unavailable and admits one after a settlement", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const pending = Array.from({ length: 64 }, (_unused, index) =>
      nativeRequest(approvals, ask, `per_native_capacity_${String(index)}`),
    );
    await expect(nativeRequest(approvals, ask, "per_native_capacity_64")).resolves.toStrictEqual({
      outcome: "unavailable",
      requestId: "per_native_capacity_64",
    });
    expect(ask.events).toHaveLength(64);

    expect(approvals.resolve(RUN_ID, "per_native_capacity_0", false)).toBe(true);
    await expect(pending[0]).resolves.toMatchObject({ outcome: "denied" });
    const admitted = nativeRequest(approvals, ask, "per_native_capacity_65");
    expect(ask.events).toHaveLength(65);
    approvals.close();
    await expect(admitted).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("refuses a second ask under a request id that is still pending, leaving the first intact", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const first = nativeRequest(approvals, ask, "per_native_twice", { actionId: NATIVE_ACTION_ID });
    await expect(
      nativeRequest(approvals, ask, "per_native_twice", { actionId: "ses_approval:call_other" }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
      actionId: "ses_approval:call_other",
      requestId: "per_native_twice",
    });
    expect(ask.events).toHaveLength(1);
    expect(approvals.resolve(RUN_ID, "per_native_twice", true)).toBe(true);
    await expect(first).resolves.toMatchObject({ outcome: "approved", actionId: NATIVE_ACTION_ID });
  });

  it("shares one pending registry with plugin asks", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const plugin = approvals.request({
      value: await verificationAsk("call_shared"),
      runId: RUN_ID,
      sessionId: SESSION_ID,
      onPermission: ask.onPermission,
      signal: new AbortController().signal,
    });
    const pluginRequestId = requestIdOf(ask);
    await expect(nativeRequest(approvals, ask, pluginRequestId)).resolves.toMatchObject({
      outcome: "unavailable",
    });

    const natives = Array.from({ length: 63 }, (_unused, index) =>
      nativeRequest(approvals, ask, `per_native_shared_${String(index)}`),
    );
    await expect(nativeRequest(approvals, ask, "per_native_shared_over")).resolves.toMatchObject({
      outcome: "unavailable",
    });
    expect(approvals.resolve(RUN_ID, pluginRequestId, true)).toBe(true);
    await expect(plugin).resolves.toMatchObject({ outcome: "approved" });
    approvals.close();
    for (const native of natives)
      await expect(native).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("settles a decision only for the run that owns the ask", async () => {
    const approvals = createOpenCodeV2ApprovalRequests();
    const ask = asked();
    const decision = nativeRequest(approvals, ask, "per_native_owner", {
      actionId: NATIVE_ACTION_ID,
    });
    expect(approvals.resolve("run-other", "per_native_owner", true)).toBe(false);
    expect(approvals.resolve(RUN_ID, "per_native_other", true)).toBe(false);
    expect(approvals.resolve(RUN_ID, "per_native_owner", true)).toBe(true);
    await expect(decision).resolves.toMatchObject({ outcome: "approved" });
  });

  it("answers an ask whose delivery to the human failed as unavailable, body-free, and frees the slot", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const approvals = createOpenCodeV2ApprovalRequests({
      record: (record): void => {
        records.push(record);
      },
    });
    const decision = approvals.requestNative({
      runId: RUN_ID,
      event: nativeEvent("per_native_delivery"),
      actionId: NATIVE_ACTION_ID,
      onPermission: (): void => {
        throw new Error("event hub closed: secret-detail");
      },
      signal: new AbortController().signal,
    });
    await expect(decision).resolves.toStrictEqual({
      outcome: "unavailable",
      actionId: NATIVE_ACTION_ID,
      requestId: "per_native_delivery",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: RUN_ID,
      operation: "coding-runtime.opencode-composition",
      source: "opencode.permission",
      message: "runtime-turn-failed",
      code: "stage=permission-dispatch",
    });
    expect(JSON.stringify(records)).not.toContain("secret-detail");
    expect(approvals.resolve(RUN_ID, "per_native_delivery", true)).toBe(false);
  });
});
