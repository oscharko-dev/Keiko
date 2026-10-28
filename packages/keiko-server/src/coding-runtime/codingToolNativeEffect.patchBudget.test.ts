import { afterEach, describe, expect, it } from "vitest";

import {
  CODING_RUNTIME_PATCH_BUDGET_BYTES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";

import { realNativeRuntime } from "../tool-catalog/__fixtures__/nativeEffectRuntimeFixture.js";
import { createCodingToolNativeEffectFacet } from "./codingToolNativeEffect.js";

// Owner decision 2026-10-28: the patch budget of one coding run is 64 MiB. The budget is charged
// by the genuine authority owner (a real service and registry, not a mock), so these cases prove
// the boundary the run actually enforces: 64 MiB is admitted, one byte more is refused, and the
// allowance is cumulative across edits.
const MIB = 1_048_576;
const runtimes: { dispose: () => void }[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function startRuntime(): ReturnType<typeof realNativeRuntime> {
  const runtime = realNativeRuntime(10, undefined, CODING_RUNTIME_PATCH_BUDGET_BYTES);
  runtimes.push(runtime);
  return runtime;
}

function admitEdit(
  runtime: ReturnType<typeof realNativeRuntime>,
  callId: string,
  patchBytes: number,
): ReturnType<ReturnType<typeof createCodingToolNativeEffectFacet>["admit"]> {
  return createCodingToolNativeEffectFacet(runtime.authority, runtime.context).admit({
    capability: runtime.capability,
    actionClass: "workspace-write",
    invocation: { sessionId: "ses_primary", messageId: "msg_1", callId },
    patchBytes,
  });
}

describe("the coding run patch budget is 64 MiB", () => {
  it("is the figure the owner decided", () => {
    expect(CODING_RUNTIME_PATCH_BUDGET_BYTES).toBe(64 * MIB);
  });

  it("admits one 8 MiB edit and leaves the rest of the budget", () => {
    const runtime = startRuntime();
    expect(admitEdit(runtime, "call_one", 8 * MIB)).toEqual({ ok: true, charge: "charged" });
    for (let call = 0; call < 7; call += 1) {
      expect(admitEdit(runtime, `call_more_${String(call)}`, 8 * MIB)).toEqual({
        ok: true,
        charge: "charged",
      });
    }
  });

  it("refuses the byte after 64 MiB, cumulatively", () => {
    const runtime = startRuntime();
    for (let call = 0; call < 7; call += 1) {
      expect(admitEdit(runtime, `call_${String(call)}`, 8 * MIB)).toEqual({
        ok: true,
        charge: "charged",
      });
    }
    expect(admitEdit(runtime, "call_last", 8 * MIB - 1)).toEqual({ ok: true, charge: "charged" });
    expect(admitEdit(runtime, "call_over", 2)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(admitEdit(runtime, "call_exact", 1)).toEqual({ ok: true, charge: "charged" });
  });
});

describe("one native edit is capped at the changeset size, like the mapped path", () => {
  it("is the contract constant, 8 MiB", () => {
    expect(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES).toBe(8 * MIB);
  });

  it("admits an edit of exactly the changeset cap", () => {
    const runtime = startRuntime();
    expect(admitEdit(runtime, "call_cap", EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)).toEqual({
      ok: true,
      charge: "charged",
    });
  });

  it("refuses one byte more with the mapped path's closed class and spends nothing", () => {
    const runtime = startRuntime();
    expect(admitEdit(runtime, "call_over", EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES + 1)).toEqual({
      ok: false,
      reason: "patch-too-large",
    });
    // The refusal reserved neither the tool call nor any patch bytes: the whole run budget is
    // still available to eight cap-sized edits.
    for (let call = 0; call < 8; call += 1) {
      expect(
        admitEdit(runtime, `call_${String(call)}`, EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES),
      ).toEqual({
        ok: true,
        charge: "charged",
      });
    }
  });

  it("refuses an oversized edit even when it would also exceed the run budget", () => {
    const runtime = startRuntime();
    expect(admitEdit(runtime, "call_huge", CODING_RUNTIME_PATCH_BUDGET_BYTES + 1)).toEqual({
      ok: false,
      reason: "patch-too-large",
    });
  });
});
