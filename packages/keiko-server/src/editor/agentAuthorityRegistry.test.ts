import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  readPersistedActivityLog,
  persistedActivityLogLines,
} from "../../../../tests/support/activity-log-proof.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  ChatToolAuthorityEnvelope,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  EditorAgentAction,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  EDITOR_AGENT_AUTHORITY_MAX_RECORDS,
  EditorAgentAuthorityRegistry,
  editorAgentAuthorityEnvelopeDigest,
  editorAgentAuthorizedConnectorScopes,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";

const NOW = "2026-07-09T12:00:00.000Z";
const FUTURE = "2026-07-09T13:00:00.000Z";
const ROOT = "/repo";

function envelope(
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-1",
    localUser: "local-operator",
    taskRefs: ["issue-2121"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: "autonomous-delivery",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 20,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: FUTURE,
    approvalProofDigest: "a".repeat(64),
    ...over,
  };
}

function action(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    actionId: "action-1",
    idempotencyKey: "key-1",
    type: "applyPatch",
    patch: "patch",
    expectedContentHash: "a".repeat(64),
    ...overrides,
  };
}

describe("editor agent authority digests", () => {
  // Keiko for Quality on #3394: the registry used a file-local canonical JSON with a
  // locale-sensitive key sort; every digest now goes through the shared canonical form.
  it("digests the envelope through the shared canonical form and hash (KEIKO-0577)", () => {
    const value = envelope();
    expect(editorAgentAuthorityEnvelopeDigest(value)).toBe(sha256Hex(canonicalise(value)));
  });
});

describe("EditorAgentAuthorityRegistry", () => {
  it("resolves only the server-registered digest for the matching workspace and ceiling", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const registered = registry.register(envelope(), "autonomous-delivery", NOW);
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("expected registration");

    expect(
      registry.resolve(registered.authorityRef, ROOT, "autonomous-delivery", NOW),
    ).toMatchObject({ ok: true, envelope: { effectiveMode: "autonomous-delivery" } });
    expect(
      registry.resolve(
        { ...registered.authorityRef, envelopeDigest: "b".repeat(64) },
        ROOT,
        "autonomous-delivery",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed for expired, wrong-workspace, changed-ceiling, and revoked authority", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const registered = registry.register(envelope(), "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");

    expect(registry.resolve(registered.authorityRef, "/other", "autonomous-delivery", NOW)).toEqual(
      { ok: false, reason: "invalid" },
    );
    expect(registry.resolve(registered.authorityRef, ROOT, "supervised-coding", NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
    registry.revoke(registered.authorityRef);
    expect(registry.resolve(registered.authorityRef, ROOT, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(
      registry.resolve(
        registered.authorityRef,
        ROOT,
        "autonomous-delivery",
        "2026-07-09T14:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(registry.register(envelope(), "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(registry.resolve(registered.authorityRef, ROOT, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });

    const expired = registry.register(
      envelope({ expiresAt: "2026-07-09T11:59:59.000Z" }),
      "autonomous-delivery",
      NOW,
    );
    expect(expired).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an envelope whose declared ceiling differs from server policy", () => {
    const registry = new EditorAgentAuthorityRegistry();
    expect(registry.register(envelope(), "supervised-coding", NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("remains bounded without evicting already-issued authority", () => {
    const registry = new EditorAgentAuthorityRegistry();
    let oldest: { readonly runId: string; readonly envelopeDigest: string } | undefined;
    for (let index = 0; index < EDITOR_AGENT_AUTHORITY_MAX_RECORDS; index += 1) {
      const registered = registry.register(
        envelope({ runId: `run-${String(index)}` }),
        "autonomous-delivery",
        NOW,
      );
      if (!registered.ok) throw new Error("expected registration");
      oldest ??= registered.authorityRef;
    }
    expect(
      registry.register(envelope({ runId: "run-over-capacity" }), "autonomous-delivery", NOW),
    ).toEqual({ ok: false, reason: "invalid" });
    if (oldest === undefined) throw new Error("expected oldest registration");
    expect(registry.resolve(oldest, ROOT, "autonomous-delivery", NOW)).toMatchObject({
      ok: true,
    });
  });

  it("evicts expired revoked records before applying the capacity limit", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const revoked = registry.register(
      envelope({ runId: "run-63", expiresAt: "2026-07-09T12:00:01.000Z" }),
      "autonomous-delivery",
      NOW,
    );
    if (!revoked.ok) throw new Error("expected registration");
    registry.revoke(revoked.authorityRef);
    for (let index = 0; index < EDITOR_AGENT_AUTHORITY_MAX_RECORDS - 1; index += 1) {
      expect(
        registry.register(envelope({ runId: `run-${String(index)}` }), "autonomous-delivery", NOW),
      ).toMatchObject({ ok: true });
    }

    expect(
      registry.register(
        envelope({ runId: "run-64" }),
        "autonomous-delivery",
        "2026-07-09T12:00:02.000Z",
      ),
    ).toMatchObject({ ok: true });
  });

  it("atomically enforces cumulative tool-call and patch-byte budgets", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const limited = envelope({
      budget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 2,
        maxPromptTokens: 1,
        maxPatchBytes: 5,
      },
    });
    const registered = registry.register(limited, "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");
    const first = action();
    const second = action({ actionId: "action-2", idempotencyKey: "key-2" });
    const third = action({ actionId: "action-3", idempotencyKey: "key-3" });

    expect(
      registry.reserveForAction(
        registered.authorityRef,
        first,
        ROOT,
        "autonomous-delivery",
        3,
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      registry.reserveForAction(
        registered.authorityRef,
        second,
        ROOT,
        "autonomous-delivery",
        2,
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      registry.reserveForAction(
        registered.authorityRef,
        third,
        ROOT,
        "autonomous-delivery",
        0,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
  });

  it("rolls back exactly one pre-dispatch reservation without underflow", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const limited = envelope({
      budget: {
        maxRuntimeMs: 60_000,
        maxToolCalls: 1,
        maxPromptTokens: 1,
        maxPatchBytes: 5,
      },
    });
    const registered = registry.register(limited, "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");

    expect(
      registry.reserveForAction(
        registered.authorityRef,
        action(),
        ROOT,
        "autonomous-delivery",
        3,
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(registry.rollbackActionReservation(registered.authorityRef, 3)).toBe(true);
    expect(registry.rollbackActionReservation(registered.authorityRef, 3)).toBe(false);
    expect(
      registry.reserveForAction(
        registered.authorityRef,
        action(),
        ROOT,
        "autonomous-delivery",
        3,
        NOW,
      ),
    ).toMatchObject({ ok: true });
  });

  it("binds external editor authority to its first session and denies cross-session reuse", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const registered = registry.register(envelope(), "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");
    const firstSession = action({ sessionId: "session-1" });
    const secondSession = action({
      sessionId: "session-2",
      actionId: "action-2",
      idempotencyKey: "key-2",
    });

    expect(
      registry.resolveForAction(
        registered.authorityRef,
        firstSession,
        ROOT,
        "autonomous-delivery",
        NOW,
      ),
    ).toMatchObject({ ok: true });
    expect(
      registry.resolveForAction(
        registered.authorityRef,
        secondSession,
        ROOT,
        "autonomous-delivery",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("does not reset cumulative budgets when the same envelope is registered again", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const limited = envelope({
      budget: {
        maxRuntimeMs: 1_000,
        maxToolCalls: 1,
        maxPromptTokens: 1,
        maxPatchBytes: 5,
      },
    });
    const registered = registry.register(limited, "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");
    expect(
      registry.reserveForAction(
        registered.authorityRef,
        action(),
        ROOT,
        "autonomous-delivery",
        5,
        NOW,
      ),
    ).toMatchObject({ ok: true });

    expect(registry.register(limited, "autonomous-delivery", NOW)).toEqual(registered);
    expect(
      registry.reserveForAction(
        registered.authorityRef,
        action({ actionId: "action-2", idempotencyKey: "key-2" }),
        ROOT,
        "autonomous-delivery",
        0,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
    expect(
      registry.resolve(
        registered.authorityRef,
        ROOT,
        "autonomous-delivery",
        "2026-07-09T12:00:01.001Z",
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
    expect(registry.register(limited, "autonomous-delivery", "2026-07-09T12:00:01.001Z")).toEqual(
      registered,
    );
  });

  it("fails closed when one patch or elapsed runtime exceeds its envelope budget", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const limited = envelope({
      budget: {
        maxRuntimeMs: 1_000,
        maxToolCalls: 2,
        maxPromptTokens: 1,
        maxPatchBytes: 5,
      },
    });
    const registered = registry.register(limited, "autonomous-delivery", NOW);
    if (!registered.ok) throw new Error("expected registration");

    expect(
      registry.reserveForAction(
        registered.authorityRef,
        action(),
        ROOT,
        "autonomous-delivery",
        6,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
    expect(
      registry.resolve(
        registered.authorityRef,
        ROOT,
        "autonomous-delivery",
        "2026-07-09T12:00:01.001Z",
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
  });

  it("offers no implicit local editor authority minting path", () => {
    expect("registerLocalBridge" in new EditorAgentAuthorityRegistry()).toBe(false);
  });
});

// ─── Issue #2244: connector-action budget reservation ───────────────────────────

describe("EditorAgentAuthorityRegistry.reserveForConnector", () => {
  function registered(over: Partial<CodingWorkbenchAuthorityEnvelope> = {}): {
    registry: EditorAgentAuthorityRegistry;
    reference: { runId: string; envelopeDigest: string };
  } {
    const registry = new EditorAgentAuthorityRegistry();
    const registration = registry.register(
      envelope({
        actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
        connectorScopes: ["source-control.read"],
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: false,
          connectorScopes: ["source-control.read"],
        },
        ...over,
      }),
      "autonomous-delivery",
      NOW,
    );
    if (!registration.ok) throw new Error("registration failed");
    return { registry, reference: registration.authorityRef };
  }

  it("charges exactly one toolCall per reservation and fails closed at the budget", () => {
    const { registry, reference } = registered({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 2, maxPromptTokens: 1, maxPatchBytes: 1 },
    });
    expect(registry.reserveForConnector(reference, ROOT, "autonomous-delivery", NOW).ok).toBe(true);
    expect(registry.reserveForConnector(reference, ROOT, "autonomous-delivery", NOW).ok).toBe(true);
    expect(registry.reserveForConnector(reference, ROOT, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "budget-exceeded",
    });
  });

  it("rejects an expired envelope, a digest mismatch, and a workspace-root mismatch", () => {
    const { registry, reference } = registered();
    expect(
      registry.reserveForConnector(
        reference,
        ROOT,
        "autonomous-delivery",
        "2027-01-01T00:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "expired" });
    const fresh = registered();
    expect(
      fresh.registry.reserveForConnector(
        { runId: fresh.reference.runId, envelopeDigest: "b".repeat(64) },
        ROOT,
        "autonomous-delivery",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      fresh.registry.reserveForConnector(
        fresh.reference,
        "/other-root",
        "autonomous-delivery",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    [
      "deny-all network policy",
      { networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] } },
    ],
    [
      "missing network-egress class",
      {
        actionClasses: CODING_WORKBENCH_ACTION_CLASSES.filter(
          (value) => value !== "network-egress",
        ),
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: false,
          connectorScopes: ["source-control.read"],
        },
      },
    ],
    [
      "missing connector-access class",
      {
        actionClasses: CODING_WORKBENCH_ACTION_CLASSES.filter(
          (value) => value !== "connector-access",
        ),
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: false,
          connectorScopes: ["source-control.read"],
        },
      },
    ],
    [
      "empty network connector scopes",
      {
        connectorScopes: ["source-control.read"],
        networkPolicy: {
          mode: "connector-scoped-egress",
          allowLoopback: false,
          connectorScopes: [],
        },
      },
    ],
  ] as const)("derives no authorized connector scopes for %s", (_label, overrides) => {
    expect(editorAgentAuthorizedConnectorScopes(envelope(overrides))).toBeUndefined();
  });

  it.each(["governed-assist", "supervised-coding"] as const)(
    "requires an approval workflow before connector reads in %s mode",
    (effectiveMode) => {
      expect(
        editorAgentAuthorizedConnectorScopes(
          envelope({
            requestedMode: effectiveMode,
            effectiveMode,
            actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
            connectorScopes: ["source-control.read"],
            networkPolicy: {
              mode: "connector-scoped-egress",
              allowLoopback: false,
              connectorScopes: ["source-control.read"],
            },
          }),
        ),
      ).toBeUndefined();
    },
  );

  it("derives the scope intersection when full access allows the connector read", () => {
    expect(
      editorAgentAuthorizedConnectorScopes(
        envelope({
          connectorScopes: ["source-control.read", "issue-tracker.read"],
          networkPolicy: {
            mode: "connector-scoped-egress",
            allowLoopback: false,
            connectorScopes: ["source-control.read"],
          },
        }),
      ),
    ).toEqual(["source-control.read"]);
  });

  it("offers no implicit local editor authority minting path", () => {
    expect("registerLocalBridge" in new EditorAgentAuthorityRegistry()).toBe(false);
  });
});

function runtimeEnvelope(
  over: Partial<CodingWorkbenchAuthorityEnvelope> = {},
): CodingWorkbenchRuntimeAuthorityEnvelope {
  const authority = envelope({ taskRefs: ["task-1"], ...over });
  return {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    authority,
    binding: {
      taskId: "task-1",
      projectId: "project-1",
      projectDigest: "a".repeat(64),
      workspaceId: authority.workspace.workspaceId,
      workspaceRootDigest: authority.workspace.rootDigest,
      branchRef: authority.branch.headRef,
      branchHeadDigest: "b".repeat(64),
    },
    intentDigest: "c".repeat(64),
    nonceDigest: "d".repeat(64),
    issuedAt: NOW,
  };
}

function registeredRuntime(over: Partial<CodingWorkbenchAuthorityEnvelope> = {}): {
  registry: EditorAgentAuthorityRegistry;
  reference: { runId: string; envelopeDigest: string };
} {
  const registry = new EditorAgentAuthorityRegistry();
  const runtime = runtimeEnvelope(over);
  const registration = registry.registerRuntime(runtime, "autonomous-delivery", NOW);
  if (!registration.ok) throw new Error("runtime registration failed: " + registration.reason);
  return { registry, reference: registration.authorityRef };
}

describe("EditorAgentAuthorityRegistry.runtimeDelegationFits (#3417)", () => {
  const read = { toolCalls: 1, patchBytes: 0, promptTokens: 0 } as const;

  it("answers whether one more delegation fits the retained budget, reserving nothing", () => {
    const { registry, reference } = registeredRuntime({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 1, maxPromptTokens: 100, maxPatchBytes: 1 },
    });
    expect(registry.runtimeDelegationFits(reference, ROOT, "autonomous-delivery", read, NOW)).toBe(
      true,
    );
    // Asking reserved nothing: the one call the budget holds is still there for a real charge.
    expect(registry.runtimeDelegationFits(reference, ROOT, "autonomous-delivery", read, NOW)).toBe(
      true,
    );
    expect(registry.reserveForConnector(reference, ROOT, "autonomous-delivery", NOW)).toMatchObject(
      { ok: true },
    );
    expect(registry.runtimeDelegationFits(reference, ROOT, "autonomous-delivery", read, NOW)).toBe(
      false,
    );
  });

  it("answers no for malformed usage and for a revoked record", () => {
    const { registry, reference } = registeredRuntime();
    const malformed = { toolCalls: -1, patchBytes: 0, promptTokens: 0 };
    expect(
      registry.runtimeDelegationFits(reference, ROOT, "autonomous-delivery", malformed, NOW),
    ).toBe(false);
    registry.revoke(reference);
    expect(registry.runtimeDelegationFits(reference, ROOT, "autonomous-delivery", read, NOW)).toBe(
      false,
    );
  });
});

// ─── live-journey-readiness-2: prompt-token reservation reconciliation ──────────

describe("EditorAgentAuthorityRegistry.settleRuntimePromptTokens", () => {
  it("replaces the booked estimate with the provider's real usage instead of stacking both", () => {
    const { registry, reference } = registeredRuntime({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 1_000, maxPatchBytes: 1 },
    });

    // A tool-calling client resends its whole growing history: the estimate for this call is 900
    // (close to the 1,000 ceiling), but the provider reports only 40 real prompt tokens spent.
    expect(registry.reserveRuntimePromptTokens(reference, 900, NOW)).toEqual({ ok: true });
    expect(registry.settleRuntimePromptTokens(reference, 900, 40, NOW)).toEqual({ ok: true });

    // Reconciled to 40, so a next call's full-history estimate (well below 1,000) is admitted —
    // proving the ledger no longer carries the discarded 900-token estimate.
    expect(registry.reserveRuntimePromptTokens(reference, 960, NOW)).toEqual({ ok: true });
  });

  it("without settlement, the stale estimate alone exhausts the budget the real usage never would", () => {
    const { registry, reference } = registeredRuntime({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 1_000, maxPatchBytes: 1 },
    });

    expect(registry.reserveRuntimePromptTokens(reference, 900, NOW)).toEqual({ ok: true });
    // No settlement call — the next call's real cumulative need (40 + 960 = 1,000) still fits the
    // budget, but the un-reconciled 900-token estimate already consumed it.
    expect(registry.reserveRuntimePromptTokens(reference, 960, NOW)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("rejects an over-refund instead of erasing already-booked usage and manufacturing budget", () => {
    const { registry, reference } = registeredRuntime({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 100, maxPatchBytes: 1 },
    });

    expect(registry.reserveRuntimePromptTokens(reference, 10, NOW)).toEqual({ ok: true });
    // Only 10 tokens were ever booked on this record. Claiming a 500-token refund must be
    // rejected outright — clamping the result to zero would silently hand back budget (90
    // tokens' worth) that was never actually reserved, letting a single bogus settlement erase
    // real, unrelated usage on the same run.
    expect(registry.settleRuntimePromptTokens(reference, 500, 0, NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    // Proof the rejection left the ledger untouched: exactly 90 of the 100-token budget remains
    // (10 still booked) — not the full 100 an accepted over-refund would have wrongly restored.
    expect(registry.reserveRuntimePromptTokens(reference, 90, NOW)).toEqual({ ok: true });
    expect(registry.reserveRuntimePromptTokens(reference, 1, NOW)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("rejects a replayed settlement once the first application already reduced the booked total", () => {
    const { registry, reference } = registeredRuntime({
      budget: { maxRuntimeMs: 60_000, maxToolCalls: 20, maxPromptTokens: 1_000, maxPatchBytes: 1 },
    });

    expect(registry.reserveRuntimePromptTokens(reference, 900, NOW)).toEqual({ ok: true });
    expect(registry.settleRuntimePromptTokens(reference, 900, 40, NOW)).toEqual({ ok: true });
    // A second, replayed settlement of the SAME reservation must not succeed a second time: only
    // 40 tokens remain booked, so claiming to refund the original 900-token reservation again is
    // rejected rather than double-subtracting it from the ledger.
    expect(registry.settleRuntimePromptTokens(reference, 900, 0, NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
  });

  it("rejects a non-finite or negative usage count instead of silently coercing it", () => {
    const { registry, reference } = registeredRuntime();
    expect(registry.settleRuntimePromptTokens(reference, -1, 0, NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    expect(registry.settleRuntimePromptTokens(reference, 0, Number.NaN, NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
  });

  it("fails closed for an expired runtime authority instead of settling a dead run", () => {
    const { registry, reference } = registeredRuntime();
    expect(
      registry.settleRuntimePromptTokens(reference, 10, 5, "2027-01-01T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "authority-expired" });
  });
});

// F9 (#3873): `reserveRuntimePromptTokens` answers `authority-budget-exceeded` both when the
// cumulative prompt allowance cannot hold a call and when the runtime's time budget is spent. Only
// the first is an exhausted prompt allowance; the Workbench must not name it for the second.
describe("EditorAgentAuthorityRegistry.runtimePromptAllowanceExhausted (F9)", () => {
  const budget = {
    maxRuntimeMs: 60_000,
    maxToolCalls: 20,
    maxPromptTokens: 1_000,
    maxPatchBytes: 1,
  };

  it("names the allowance only when the booked usage leaves no room for the refused call", () => {
    const { registry, reference } = registeredRuntime({ budget });
    expect(registry.reserveRuntimePromptTokens(reference, 900, NOW)).toEqual({ ok: true });
    expect(registry.runtimePromptAllowanceExhausted(reference, 100, NOW)).toBe(false);
    expect(registry.reserveRuntimePromptTokens(reference, 101, NOW)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(registry.runtimePromptAllowanceExhausted(reference, 101, NOW)).toBe(true);
    // Asking books nothing: the 100 tokens the allowance still holds are still there.
    expect(registry.reserveRuntimePromptTokens(reference, 100, NOW)).toEqual({ ok: true });
  });

  it("does not name the allowance when the runtime's time budget refused the call", () => {
    const { registry, reference } = registeredRuntime({ budget });
    const afterRuntimeBudget = "2026-07-09T12:01:00.001Z";
    expect(registry.reserveRuntimePromptTokens(reference, 2_000, afterRuntimeBudget)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
    expect(registry.runtimePromptAllowanceExhausted(reference, 2_000, afterRuntimeBudget)).toBe(
      false,
    );
  });

  it("answers no for a malformed count, a revoked record and an unknown run", () => {
    const { registry, reference } = registeredRuntime({ budget });
    expect(registry.runtimePromptAllowanceExhausted(reference, -1, NOW)).toBe(false);
    expect(registry.runtimePromptAllowanceExhausted(reference, Number.NaN, NOW)).toBe(false);
    expect(
      registry.runtimePromptAllowanceExhausted({ ...reference, runId: "run-unknown" }, 5_000, NOW),
    ).toBe(false);
    registry.revoke(reference);
    expect(registry.runtimePromptAllowanceExhausted(reference, 5_000, NOW)).toBe(false);
  });
});

function chatEnvelope(
  overrides: Partial<ChatToolAuthorityEnvelope> = {},
): ChatToolAuthorityEnvelope {
  const {
    schemaVersion,
    runId,
    requestedMode,
    deploymentCeiling,
    effectiveMode,
    expiresAt,
    approvalProofDigest,
    budget,
  } = envelope();
  return {
    schemaVersion,
    kind: "chat-tool-authority",
    runId,
    requestedMode,
    deploymentCeiling,
    effectiveMode,
    expiresAt,
    approvalProofDigest,
    subject: {
      actorDigest: "c".repeat(64),
      chatId: "chat-1",
      podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d018",
      bindingGeneration: 2,
      authenticationGeneration: 3,
    },
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["issue-tracker.read", "issue-tracker.write"],
    budget: { ...budget, maxPatchBytes: 0 },
    ...overrides,
  };
}

function registerChat(
  registry: EditorAgentAuthorityRegistry,
  value = chatEnvelope(),
): { readonly runId: string; readonly envelopeDigest: string } {
  const registered = registry.registerChat(value, "autonomous-delivery", NOW);
  expect(registered.ok).toBe(true);
  if (!registered.ok) throw new Error("expected Chat registration");
  return registered.authorityRef;
}

describe("ordinary Chat authority in the existing registry (#4084)", () => {
  it("resolves a Chat without a Coding record and refuses Coding consumers of that reference", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    expect(registry.resolveChat(reference, value.subject, "autonomous-delivery", NOW)).toEqual({
      ok: true,
      envelope: value,
    });
    expect(registry.resolve(reference, ROOT, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(registry.reserveForConnector(reference, ROOT, "autonomous-delivery", NOW).ok).toBe(
      false,
    );
    expect(registry.rollbackActionReservation(reference, 0)).toBe(false);
  });

  it("refuses a Coding reference in the Chat consumer", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const registration = registry.register(envelope(), "autonomous-delivery", NOW);
    if (!registration.ok) throw new Error("expected Coding registration");
    expect(
      registry.resolveChat(
        registration.authorityRef,
        chatEnvelope().subject,
        "autonomous-delivery",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it.each([
    { actorDigest: "d".repeat(64) },
    { chatId: "chat-2" },
    { podId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019" },
    { bindingGeneration: 3 },
    { authenticationGeneration: 4 },
  ])("revalidates each current subject fact %j", (patch) => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    expect(
      registry.resolveChat(reference, { ...value.subject, ...patch }, "autonomous-delivery", NOW),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(registry.resolveChat(reference, value.subject, "autonomous-delivery", NOW).ok).toBe(
      true,
    );
  });

  it("rejects ceiling drift and an unregistered digest", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    expect(registry.resolveChat(reference, value.subject, "governed-assist", NOW).ok).toBe(false);
    expect(
      registry.resolveChat(
        { ...reference, envelopeDigest: "f".repeat(64) },
        value.subject,
        "autonomous-delivery",
        NOW,
      ).ok,
    ).toBe(false);
    expect(registry.registerChat(value, "governed-assist", NOW).ok).toBe(false);
    expect(registry.registerChat({ ...value, workspace: {} }, "autonomous-delivery", NOW).ok).toBe(
      false,
    );
  });

  it("retains a private copy instead of trusting a caller-mutated subject or budget", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const subject = { ...value.subject };
    const reference = registerChat(registry, value);
    Object.assign(value.subject, { chatId: "chat-other" });
    Object.assign(value.budget, { maxToolCalls: 100_000 });
    const resolved = registry.resolveChat(reference, subject, "autonomous-delivery", NOW);
    expect(resolved).toMatchObject({
      ok: true,
      envelope: { subject: { chatId: "chat-1" }, budget: { maxToolCalls: 20 } },
    });
  });

  it("shares cumulative reservation rules and never resets them on duplicate registration", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    const reserve = (toolCalls: number, promptTokens = 0): boolean =>
      registry.reserveForChat(
        reference,
        value.subject,
        "autonomous-delivery",
        { toolCalls, promptTokens, patchBytes: 0 },
        NOW,
      ).ok;
    expect(reserve(19, 9_999)).toBe(true);
    expect(registerChat(registry, value)).toEqual(reference);
    expect(reserve(2)).toBe(false);
    expect(reserve(1, 1)).toBe(true);
    expect(reserve(0, 1)).toBe(false);
    expect(reserve(1)).toBe(false);
  });

  it("denies invalid usage and file patches before charging any budget", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    for (const usage of [
      { toolCalls: -1, promptTokens: 0, patchBytes: 0 },
      { toolCalls: 1, promptTokens: 0, patchBytes: 1 },
      { toolCalls: 0, promptTokens: Number.NaN, patchBytes: 0 },
    ])
      expect(
        registry.reserveForChat(reference, value.subject, "autonomous-delivery", usage, NOW).ok,
      ).toBe(false);
    expect(
      registry.reserveForChat(
        reference,
        value.subject,
        "autonomous-delivery",
        { toolCalls: 20, promptTokens: 10_000, patchBytes: 0 },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it("enforces expiry and elapsed runtime on registration and every resolution", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const reference = registerChat(registry, value);
    expect(
      registry.resolveChat(
        reference,
        value.subject,
        "autonomous-delivery",
        "2026-07-09T12:01:00.001Z",
      ),
    ).toEqual({ ok: false, reason: "budget-exceeded" });
    expect(registry.resolveChat(reference, value.subject, "autonomous-delivery", FUTURE)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(registry.registerChat(value, "autonomous-delivery", FUTURE)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(registry.registerChat(value, "autonomous-delivery", "invalid").ok).toBe(false);
  });

  it("revokes all authority for one Chat without touching another Chat or Coding", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const first = chatEnvelope();
    const second = chatEnvelope({ runId: "run-2" });
    const other = chatEnvelope({ runId: "run-3", subject: { ...first.subject, chatId: "chat-2" } });
    const firstRef = registerChat(registry, first);
    const secondRef = registerChat(registry, second);
    const otherRef = registerChat(registry, other);
    const coding = registry.register(envelope(), "autonomous-delivery", NOW);
    expect(registry.revokeChatAuthorities("chat-1")).toBe(2);
    expect(registry.revokeChatAuthorities("chat-1")).toBe(0);
    for (const reference of [firstRef, secondRef])
      expect(registry.resolveChat(reference, first.subject, "autonomous-delivery", NOW)).toEqual({
        ok: false,
        reason: "revoked",
      });
    expect(registry.registerChat(first, "autonomous-delivery", NOW).ok).toBe(false);
    expect(registry.resolveChat(otherRef, other.subject, "autonomous-delivery", NOW).ok).toBe(true);
    if (!coding.ok) throw new Error("expected Coding registration");
    expect(registry.resolve(coding.authorityRef, ROOT, "autonomous-delivery", NOW).ok).toBe(true);
    registry.revoke(otherRef);
    expect(registry.resolveChat(otherRef, other.subject, "autonomous-delivery", NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("shares the existing bounded capacity across Chat and Coding records", () => {
    const registry = new EditorAgentAuthorityRegistry();
    for (let index = 0; index < EDITOR_AGENT_AUTHORITY_MAX_RECORDS; index++) {
      registerChat(registry, chatEnvelope({ runId: `chat-authority-${String(index)}` }));
    }
    expect(registry.register(envelope(), "autonomous-delivery", NOW).ok).toBe(false);
    expect(registry.registerChat(chatEnvelope(), "autonomous-delivery", NOW).ok).toBe(false);
    registry.reset();
    expect(registry.register(envelope(), "autonomous-delivery", NOW).ok).toBe(true);
  });
});

it("reconstructs Chat authority decisions through the real writer and reader without identity contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keiko-chat-authority-"));
  const sink = createFileServerLogSink(directory, { level: "debug" });
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  try {
    const registry = new EditorAgentAuthorityRegistry();
    const value = chatEnvelope();
    const correlation = "chat-authority-proof";
    const registration = registry.registerChat(value, "autonomous-delivery", NOW, correlation);
    if (!registration.ok) throw new Error("expected Chat registration");
    const reference = registration.authorityRef;
    registry.resolveChat(
      reference,
      { ...value.subject, bindingGeneration: 3 },
      "autonomous-delivery",
      NOW,
      correlation,
    );
    registry.reserveForChat(
      reference,
      value.subject,
      "autonomous-delivery",
      { toolCalls: 20, promptTokens: 1, patchBytes: 0 },
      NOW,
      correlation,
    );
    registry.reserveForChat(
      reference,
      value.subject,
      "autonomous-delivery",
      { toolCalls: 1, promptTokens: 0, patchBytes: 0 },
      NOW,
      correlation,
    );
    registry.revokeChatAuthorities(value.subject.chatId, correlation);
    registry.resolveChat(reference, value.subject, "autonomous-delivery", NOW, correlation);
    registry.revoke(reference, correlation);
    sink.close?.();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(directory),
      "chat.tool-authority.operation",
    );
    const records = lines.map((line) =>
      expectActivityLogProof("chat.tool-authority.operation.lifecycle", line),
    );
    expect(records.map(({ phase, outcome }) => [phase, outcome])).toEqual([
      ["register", "allowed"],
      ["resolve", "invalid"],
      ["reserve", "allowed"],
      ["reserve", "budget-exceeded"],
      ["revoke", "allowed"],
      ["resolve", "revoked"],
      ["revoke", "allowed"],
    ]);
    expect(records.every((record) => record.correlationId === correlation)).toBe(true);
    expect(records[0]).toMatchObject({
      authorityDigest: reference.envelopeDigest,
      bindingGeneration: 2,
      authenticationGeneration: 3,
    });
    expect(records[1]).toMatchObject({ bindingGeneration: 3 });
    expect(records[4]).toMatchObject({ affectedCount: 1 });
    expect(records[6]).toMatchObject({ affectedCount: 0 });
    for (const identity of [value.runId, value.subject.chatId, value.subject.podId])
      expect(lines.join("\n")).not.toContain(identity);
  } finally {
    sink.close?.();
    resetServerLogger();
    await rm(directory, { recursive: true, force: true });
  }
});
