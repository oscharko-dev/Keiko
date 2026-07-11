import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentAction,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_AUTHORITY_MAX_RECORDS,
  EditorAgentAuthorityRegistry,
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

  it("derives a bounded local authority that cannot be replayed for another action", () => {
    const registry = new EditorAgentAuthorityRegistry();
    const localSnapshot = {
      schemaVersion: "1",
      sessionId: "session-1",
      windowId: "window-1",
      workspaceRoot: ROOT,
      activePaneId: "pane-1",
      panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
      dirtyFiles: [],
      activeFile: "src/a.ts",
      cursor: null,
      selection: null,
      diagnosticsSummary: null,
      textMode: "none",
      updatedAt: 1,
    } as const;
    const localAction = action();
    const otherAction = { ...localAction, actionId: "action-2", idempotencyKey: "key-2" };
    const first = registry.registerLocalBridge(
      localSnapshot,
      localAction,
      "autonomous-delivery",
      NOW,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected local registration");
    expect(JSON.stringify(first.authorityRef)).not.toContain("capability");
    expect(
      registry.resolveForAction(first.authorityRef, localAction, ROOT, "autonomous-delivery", NOW),
    ).toMatchObject({
      ok: true,
      envelope: {
        requestedMode: "governed-assist",
        actionClasses: ["workspace-read", "workspace-write"],
      },
    });
    expect(
      registry.resolveForAction(first.authorityRef, otherAction, ROOT, "autonomous-delivery", NOW),
    ).toEqual({ ok: false, reason: "invalid" });
  });
});
