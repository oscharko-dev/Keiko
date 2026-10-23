import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

import { RUNTIME_NOW } from "../tool-catalog/__fixtures__/catalogRuntimeFixture.js";
import { createRuntimeCodingToolFacade } from "./codingToolAuthorityPort.js";
import type { CodingToolNativeInvocation } from "./codingToolFacadePorts.js";
import {
  createCodingToolNativeEffectFacet,
  createCodingToolNativeSettlementFacet,
  NATIVE_SETTLEMENT_MEMORY_MAX,
} from "./codingToolNativeEffect.js";
import {
  CodingRuntimeRunEffortLedger,
  createCodingRuntimeRunEffortRegistry,
} from "./codingRuntimeRunEffort.js";
import { OPENCODE_NATIVE_DELIVERY_TOOL_NAMES } from "./opencodeNativeDeliveryTools.js";
import {
  governedPorts,
  NATIVE_EFFECT_FIXTURE_RUN_ID as RUN_ID,
  realNativeRuntime,
} from "../tool-catalog/__fixtures__/nativeEffectRuntimeFixture.js";

const runtimes: { dispose: () => void }[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function startRuntime(
  maxToolCalls: number,
  mode?: CodingWorkbenchMode,
  maxPatchBytes?: number,
): ReturnType<typeof realNativeRuntime> {
  const runtime = realNativeRuntime(maxToolCalls, mode, maxPatchBytes);
  runtimes.push(runtime);
  return runtime;
}

const invocation = (
  callId: string,
  sessionId = "ses_primary",
  messageId = "msg_1",
): CodingToolNativeInvocation => ({ sessionId, messageId, callId });

describe("native permission checks charge the run's tool-call budget once per invocation (#3897, PR #4064)", () => {
  // CORRECTED INVARIANT. An earlier revision exempted reads ("workspace-read") from the tool-call
  // budget, which pinned the defect the PR #4064 audit found: with a genuine authority service and
  // maxToolCalls=10, 100 distinct native reads were admitted and ten commands still followed. The
  // established contract is that every native tool call, reads included, costs one tool call of the
  // run's envelope, charged once per original invocation identity (run, session, message, call id)
  // however many permission checks it raises, and that every check revalidates live authority.
  it("exhausts an N-call envelope with N distinct reads and refuses read N+1 and every effect after it", () => {
    const runtime = startRuntime(10);
    const admitRead = (callId: string): ReturnType<typeof admitNative> =>
      admitNative(runtime, "workspace-read", invocation(callId));
    for (let index = 1; index <= 10; index += 1) {
      expect(admitRead(`call_read_${String(index)}`), `read ${String(index)}`).toEqual({
        ok: true,
        charge: "charged",
      });
    }
    expect(admitRead("call_read_11")).toEqual({ ok: false, reason: "authority-budget-exceeded" });
    expect(
      admitNative(runtime, "command-execution", invocation("call_command_1")),
      "an effect shares the allowance reads spent",
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });
  });

  it("does not admit 100 distinct reads and then ten commands (the audit's repro)", () => {
    const runtime = startRuntime(10);
    let admittedReads = 0;
    for (let index = 0; index < 100; index += 1) {
      if (admitNative(runtime, "workspace-read", invocation(`call_read_${String(index)}`)).ok)
        admittedReads += 1;
    }
    let admittedCommands = 0;
    for (let index = 0; index < 10; index += 1) {
      if (admitNative(runtime, "command-execution", invocation(`call_cmd_${String(index)}`)).ok)
        admittedCommands += 1;
    }
    expect(admittedReads).toBe(10);
    expect(admittedCommands).toBe(0);
  });

  it("charges several permission checks of one invocation once", () => {
    const runtime = startRuntime(3);
    // OpenCode asks the edit and the directory it touches for ONE tool call, and may evaluate the
    // same call again; the class of each check differs, the invocation does not.
    const same = invocation("call_edit_1");
    expect(admitNative(runtime, "workspace-write", same)).toEqual({ ok: true, charge: "charged" });
    expect(admitNative(runtime, "workspace-read", same)).toEqual({
      ok: true,
      charge: "already-charged",
    });
    expect(admitNative(runtime, "workspace-write", same)).toEqual({
      ok: true,
      charge: "already-charged",
    });
    // Exactly one of the three calls was spent: two more distinct invocations fit, the next does not.
    expect(admitNative(runtime, "workspace-read", invocation("call_2")).ok).toBe(true);
    expect(admitNative(runtime, "workspace-read", invocation("call_3")).ok).toBe(true);
    expect(admitNative(runtime, "workspace-read", invocation("call_4"))).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("keeps admitting a later check of an invocation whose call spent the last of the budget", () => {
    const runtime = startRuntime(1);
    const only = invocation("call_last");
    expect(admitNative(runtime, "workspace-read", only)).toEqual({ ok: true, charge: "charged" });
    expect(admitNative(runtime, "workspace-write", only)).toEqual({
      ok: true,
      charge: "already-charged",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_next"))).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("shares the parent's allowance with a child session, each session charging its own calls", () => {
    const runtime = startRuntime(4);
    // The same message and call ids in another session are another invocation.
    expect(admitNative(runtime, "workspace-read", invocation("call_1", "ses_primary"))).toEqual({
      ok: true,
      charge: "charged",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_1", "ses_child"))).toEqual({
      ok: true,
      charge: "charged",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_2", "ses_child"))).toEqual({
      ok: true,
      charge: "charged",
    });
    expect(admitNative(runtime, "workspace-write", invocation("call_2", "ses_primary"))).toEqual({
      ok: true,
      charge: "charged",
    });
    // The child's repeated check of its own call is free; a new child call meets the exhausted run.
    expect(admitNative(runtime, "workspace-read", invocation("call_2", "ses_child"))).toEqual({
      ok: true,
      charge: "already-charged",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_3", "ses_child"))).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_3", "ses_primary"))).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("charges a check that names no tool invocation on its own, so it can only spend the budget faster", () => {
    const runtime = startRuntime(3);
    for (let index = 0; index < 3; index += 1) {
      expect(admitNative(runtime, "workspace-read", undefined), `check ${String(index)}`).toEqual({
        ok: true,
        charge: "per-check",
      });
    }
    expect(admitNative(runtime, "workspace-read", undefined)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(admitNative(runtime, "workspace-read", invocation("call_after"))).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("goes through the production facade the audit named, not only the owner", () => {
    const runtime = startRuntime(2);
    const admit = (callId: string): unknown =>
      runtime.facade.nativeEffect?.admit({
        capability: runtime.capability,
        actionClass: "workspace-read",
        invocation: invocation(callId),
      });
    expect(admit("call_a")).toEqual({ ok: true, charge: "charged" });
    expect(admit("call_a")).toEqual({ ok: true, charge: "already-charged" });
    expect(admit("call_b")).toEqual({ ok: true, charge: "charged" });
    expect(admit("call_c")).toEqual({ ok: false, reason: "authority-budget-exceeded" });
  });

  it("refuses an action class the envelope lacks without spending a tool call", () => {
    // Below Full access the envelope carries no network egress.
    const runtime = startRuntime(1, "supervised-coding");
    expect(admitNative(runtime, "network-egress", invocation("call_fetch"))).toEqual({
      ok: false,
      reason: "action-not-authorized",
    });
    // The refused check left the one call unspent.
    expect(admitNative(runtime, "workspace-read", invocation("call_read"))).toEqual({
      ok: true,
      charge: "charged",
    });
  });

  it("refuses even a read once the authority expired", () => {
    const runtime = startRuntime(5);
    expect(admitNative(runtime, "workspace-read", invocation("call_read")).ok).toBe(true);
    expect(admitAt(runtime, expiredAt(runtime), "workspace-read", invocation("call_new"))).toEqual({
      ok: false,
      reason: "authority-expired",
    });
  });

  it("revalidates an already charged invocation too: expiry refuses its repeated check", () => {
    const runtime = startRuntime(5);
    const read = invocation("call_read");
    expect(admitNative(runtime, "workspace-read", read)).toEqual({ ok: true, charge: "charged" });
    expect(admitAt(runtime, expiredAt(runtime), "workspace-read", read)).toEqual({
      ok: false,
      reason: "authority-expired",
    });
  });

  it("refuses even a read after the run's authority was revoked or the run paused", () => {
    const revoked = startRuntime(5);
    expect(revoked.authority.revokeBeforeTerminate(RUN_ID)).toBe(true);
    expect(admitNative(revoked, "workspace-read", invocation("call_read"))).toEqual({
      ok: false,
      reason: "revoked",
    });
    const paused = startRuntime(5);
    expect(paused.authority.pause(RUN_ID, RUNTIME_NOW)).toMatchObject({ ok: true });
    expect(admitNative(paused, "workspace-read", invocation("call_read")).ok).toBe(false);
  });

  it("refuses a forged capability before any reservation", () => {
    const runtime = startRuntime(1);
    const forged = createCodingToolNativeEffectFacet(runtime.authority, runtime.context).admit({
      capability: "forged-capability-material-that-is-invalid",
      actionClass: "workspace-read",
      invocation: invocation("call_read"),
    });
    expect(forged.ok).toBe(false);
    expect(admitNative(runtime, "workspace-read", invocation("call_read")).ok).toBe(true);
  });
});

describe("native edits charge the run's patch budget before the runtime writes (#3897, PR #4064)", () => {
  // The audit's counterexample: maxPatchBytes=64, a native edit of a 4097-byte file was admitted
  // and charged only its tool call, and the whole 64-byte allowance could still be reserved after
  // it. A native edit now reserves the size of the producer's diff on the same reservation.
  const admitEdit = (
    runtime: ReturnType<typeof realNativeRuntime>,
    callId: string,
    patchBytes: number | undefined,
  ): ReturnType<typeof admitNative> =>
    createCodingToolNativeEffectFacet(runtime.authority, runtime.context).admit({
      capability: runtime.capability,
      actionClass: "workspace-write",
      invocation: invocation(callId),
      ...(patchBytes === undefined ? {} : { patchBytes }),
    });
  const reserveRemaining = (
    runtime: ReturnType<typeof realNativeRuntime>,
    patchBytes: number,
  ): boolean => {
    const context = runtime.context();
    return runtime.authority.resolveCapabilityForDelegation({
      capability: runtime.capability,
      adapterKind: context.adapterKind,
      liveFacts: context.liveFacts,
      workspaceRoot: context.workspaceRoot,
      deploymentCeiling: context.deploymentCeiling,
      nowIso: context.nowIso,
      delegationId: "independent-probe",
      idempotencyKey: "independent-probe",
      usage: { toolCalls: 0, patchBytes, promptTokens: 0 },
    }).ok;
  };

  it("refuses an edit whose diff exceeds the allowance and leaves the allowance unspent", () => {
    const runtime = startRuntime(10, undefined, 64);
    expect(admitEdit(runtime, "call_write", 4_097)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(reserveRemaining(runtime, 64)).toBe(true);
  });

  it("charges an edit within the allowance, so the allowance it used can no longer be reserved", () => {
    const runtime = startRuntime(10, undefined, 64);
    expect(admitEdit(runtime, "call_edit", 40)).toEqual({ ok: true, charge: "charged" });
    expect(reserveRemaining(runtime, 25)).toBe(false);
    expect(reserveRemaining(runtime, 24)).toBe(true);
  });

  it("admits an edit at exactly the allowance and refuses the next byte cumulatively", () => {
    const runtime = startRuntime(10, undefined, 64);
    expect(admitEdit(runtime, "call_a", 30)).toEqual({ ok: true, charge: "charged" });
    expect(admitEdit(runtime, "call_b", 34)).toEqual({ ok: true, charge: "charged" });
    expect(admitEdit(runtime, "call_c", 1)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("charges an invocation's diff once however many checks it raises, child sessions included", () => {
    const runtime = startRuntime(10, undefined, 64);
    expect(admitEdit(runtime, "call_a", 40)).toEqual({ ok: true, charge: "charged" });
    expect(admitEdit(runtime, "call_a", 40)).toEqual({ ok: true, charge: "already-charged" });
    const child = createCodingToolNativeEffectFacet(runtime.authority, runtime.context).admit({
      capability: runtime.capability,
      actionClass: "workspace-write",
      invocation: invocation("call_a", "ses_child"),
      patchBytes: 40,
    });
    expect(child).toEqual({ ok: false, reason: "authority-budget-exceeded" });
  });

  it("charges only the tool call for an edit the producer attached no diff to", () => {
    const runtime = startRuntime(10, undefined, 64);
    expect(admitEdit(runtime, "call_unmatched", undefined)).toEqual({
      ok: true,
      charge: "charged",
    });
    expect(reserveRemaining(runtime, 64)).toBe(true);
  });
});

function expiredAt(runtime: ReturnType<typeof realNativeRuntime>): string {
  return new Date(Date.parse(runtime.expiresAt) + 1_000).toISOString();
}

function admitAt(
  runtime: ReturnType<typeof realNativeRuntime>,
  nowIso: string,
  actionClass: CodingWorkbenchActionClass,
  call: CodingToolNativeInvocation,
): ReturnType<ReturnType<typeof createCodingToolNativeEffectFacet>["admit"]> {
  return createCodingToolNativeEffectFacet(runtime.authority, () => runtime.context(nowIso)).admit({
    capability: runtime.capability,
    actionClass,
    invocation: call,
  });
}

function admitNative(
  runtime: ReturnType<typeof realNativeRuntime>,
  actionClass: CodingWorkbenchActionClass,
  call: CodingToolNativeInvocation | undefined,
): ReturnType<ReturnType<typeof createCodingToolNativeEffectFacet>["admit"]> {
  return createCodingToolNativeEffectFacet(runtime.authority, runtime.context).admit({
    capability: runtime.capability,
    actionClass,
    ...(call === undefined ? {} : { invocation: call }),
  });
}

describe("native tool calls reach the run's effort roll-up once per call (#3873, PR #4064)", () => {
  const settle = (
    facet: ReturnType<typeof createCodingToolNativeSettlementFacet>,
    callId: string,
    tool: string | undefined,
    state: "succeeded" | "failed",
    messageId = "msg_1",
  ): ReturnType<typeof facet.settled> => facet.settled({ messageId, callId, tool, state });
  const effortFor = (): {
    readonly effort: ReturnType<typeof createCodingRuntimeRunEffortRegistry>;
    readonly facet: ReturnType<typeof createCodingToolNativeSettlementFacet>;
  } => {
    const effort = createCodingRuntimeRunEffortRegistry();
    return {
      effort,
      facet: createCodingToolNativeSettlementFacet((action, status) => {
        effort.toolSettled(RUN_ID, action, status);
      }),
    };
  };

  it("counts an actual read, edit and read as two reads and one edit", () => {
    const { effort, facet } = effortFor();
    expect(settle(facet, "call_1", "read", "succeeded")).toBe("counted");
    expect(settle(facet, "call_2", "edit", "succeeded")).toBe("counted");
    expect(settle(facet, "call_3", "read", "succeeded")).toBe("counted");
    expect(effort.read(RUN_ID)).toMatchObject({
      toolInvocationCount: 3,
      workspaceReadCount: 2,
      editCount: 1,
      editRefusedCount: 0,
    });
  });

  it("shows the native counts, and nothing but counts, in the roll-up the settled line carries", () => {
    const { effort, facet } = effortFor();
    settle(facet, "call_1", "read", "succeeded");
    settle(facet, "call_2", "edit", "succeeded");
    settle(facet, "call_3", "read", "succeeded");
    // The orchestrator spreads exactly this value into `coding-runtime.run.settled`.
    const ledger = new CodingRuntimeRunEffortLedger();
    ledger.begin(RUN_ID);
    const rollUp = ledger.rollUp(
      { runId: RUN_ID, createdAt: RUNTIME_NOW, updatedAt: RUNTIME_NOW },
      effort.read(RUN_ID),
    );
    expect(rollUp).toMatchObject({
      toolInvocationCount: 3,
      workspaceReadCount: 2,
      editCount: 1,
      editRefusedCount: 0,
    });
    expect(Object.values(rollUp).every((value) => typeof value === "number")).toBe(true);
  });

  it("counts a call the policy refused as a refusal and never as a success", () => {
    const { effort, facet } = effortFor();
    facet.refused({ messageId: "msg_1", callId: "call_denied_edit" });
    facet.refused({ messageId: "msg_1", callId: "call_denied_read" });
    settle(facet, "call_denied_edit", "edit", "failed");
    settle(facet, "call_denied_read", "read", "failed");
    expect(effort.read(RUN_ID)).toMatchObject({
      toolInvocationCount: 2,
      workspaceReadCount: 0,
      editCount: 0,
      editRefusedCount: 1,
    });
  });

  it("counts a tool's own failure as a failed call and an edit that did not apply as refused", () => {
    const { effort, facet } = effortFor();
    settle(facet, "call_1", "edit", "failed");
    settle(facet, "call_2", "read", "failed");
    expect(effort.read(RUN_ID)).toMatchObject({
      toolInvocationCount: 2,
      workspaceReadCount: 0,
      editCount: 0,
      editRefusedCount: 1,
    });
  });

  it("counts a call seen again by a repeated history read or a reconnect once", () => {
    const { effort, facet } = effortFor();
    const sequence = [
      ["call_1", "read"],
      ["call_2", "edit"],
      ["call_3", "read"],
    ] as const;
    for (const [callId, tool] of sequence) settle(facet, callId, tool, "succeeded");
    // The reconnect re-reads the same history: every call comes again, in any order, and a failed
    // report of an already counted call is the same call.
    const replay = [...sequence, ...[...sequence].reverse()].map(([callId, tool]) =>
      settle(facet, callId, tool, "succeeded"),
    );
    expect(replay.every((result) => result === "duplicate")).toBe(true);
    expect(settle(facet, "call_2", "edit", "failed")).toBe("duplicate");
    expect(effort.read(RUN_ID)).toMatchObject({
      toolInvocationCount: 3,
      workspaceReadCount: 2,
      editCount: 1,
      editRefusedCount: 0,
    });
  });

  it("identifies a call by its message and call id, so another message's equal call id is another call", () => {
    const { effort, facet } = effortFor();
    expect(settle(facet, "call_1", "read", "succeeded", "msg_a")).toBe("counted");
    expect(settle(facet, "call_1", "read", "succeeded", "msg_b")).toBe("counted");
    expect(effort.read(RUN_ID)?.workspaceReadCount).toBe(2);
  });

  it("maps each native tool onto the facade's closed action vocabulary and leaves the rest unnamed", () => {
    const seen: (string | undefined)[] = [];
    const facet = createCodingToolNativeSettlementFacet((action) => {
      seen.push(action);
    });
    const tools = [
      "read",
      "glob",
      "grep",
      "edit",
      "write",
      "patch",
      "shell",
      "webfetch",
      "websearch",
      "skill",
      "subagent",
      "question",
      "todo",
      "execute",
      "some_extension_tool",
      "constructor",
    ];
    tools.forEach((tool, index) => settle(facet, `call_${String(index)}`, tool, "succeeded"));
    expect(seen).toEqual([
      "read",
      "discover",
      "search",
      "edit",
      "edit",
      "edit",
      "command",
      "egress",
      "egress",
      "skill",
      "child-agent",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(settle(facet, "call_unnamed", undefined, "succeeded")).toBe("counted");
    expect(seen.at(-1)).toBeUndefined();
  });

  // A Keiko delivery tool is served by the facade, which settles every request itself; the
  // runtime's report of the same call must not count it a second time (#3897).
  it("leaves a Keiko delivery tool to the facade that served it, whatever the call's outcome", () => {
    const { effort, facet } = effortFor();
    for (const [index, tool] of OPENCODE_NATIVE_DELIVERY_TOOL_NAMES.entries()) {
      expect(settle(facet, `call_${String(index)}`, tool, "succeeded"), tool).toBe("duplicate");
      expect(settle(facet, `call_failed_${String(index)}`, tool, "failed"), tool).toBe("duplicate");
    }
    expect(effort.read(RUN_ID)?.toolInvocationCount ?? 0).toBe(0);
    expect(settle(facet, "call_read", "read", "succeeded")).toBe("counted");
    expect(effort.read(RUN_ID)?.toolInvocationCount).toBe(1);
  });

  it("keeps a fixed-size memory: the oldest call is forgotten, the recent ones are not", () => {
    const counted: string[] = [];
    const facet = createCodingToolNativeSettlementFacet((action, status) => {
      counted.push(`${String(action)}:${status}`);
    });
    for (let index = 0; index < NATIVE_SETTLEMENT_MEMORY_MAX + 10; index += 1)
      settle(facet, `call_${String(index)}`, "read", "succeeded");
    expect(counted).toHaveLength(NATIVE_SETTLEMENT_MEMORY_MAX + 10);
    const latest = `call_${String(NATIVE_SETTLEMENT_MEMORY_MAX + 9)}`;
    expect(settle(facet, latest, "read", "succeeded")).toBe("duplicate");
    expect(settle(facet, "call_0", "read", "succeeded")).toBe("counted");
  });

  it("counts nothing for approval: only a reported terminal call settles", () => {
    const onToolSettled = vi.fn();
    const runtime = startRuntime(5);
    const facet = createCodingToolNativeSettlementFacet(onToolSettled);
    // A refusal is noted for later; an admitted permission check settles nothing.
    facet.refused({ messageId: "msg_1", callId: "call_refused" });
    expect(admitNative(runtime, "workspace-write", invocation("call_edit_1")).ok).toBe(true);
    expect(onToolSettled).not.toHaveBeenCalled();
  });

  it("reaches the run effort owner through the production facade's own tool-settled option", () => {
    const effort = createCodingRuntimeRunEffortRegistry();
    const runtime = startRuntime(5);
    const facade = createRuntimeCodingToolFacade(
      runtime.authority,
      runtime.context,
      governedPorts(),
      {
        onToolSettled: (action, status): void => {
          effort.toolSettled(RUN_ID, action, status);
        },
      },
    );
    facade.nativeSettlement?.settled({
      messageId: "msg_1",
      callId: "call_1",
      tool: "read",
      state: "succeeded",
    });
    expect(effort.read(RUN_ID)).toMatchObject({ toolInvocationCount: 1, workspaceReadCount: 1 });
  });
});
