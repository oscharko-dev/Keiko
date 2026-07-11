import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeIntent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import {
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchRuntimeState,
} from "@oscharko-dev/keiko-contracts";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import {
  createInMemoryRuntimeCapabilityStore,
  type RuntimeCapabilityBinding,
} from "./runtimeCapabilityStore.js";
import { createInMemorySupervisedCodingApprovalStore } from "./supervisedCodingApprovalStore.js";
import {
  CodingRuntimeAuthorityService,
  codingRuntimeBudgetDigest,
  codingRuntimeFactDigest,
  type CodingRuntimeMintResult,
  type CodingRuntimeResolution,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  createRuntimeProcessSupervisor,
  type RuntimeReapReceipt,
} from "./runtimeProcessSupervisor.js";

const NOW = "2026-07-11T12:00:00.000Z";
const ROOT = "/managed/project/task-2252";
const DIGEST = "a".repeat(64);

async function reapReceipt(runId: string, treeBindingId: string): Promise<RuntimeReapReceipt> {
  const qualification = {
    platform: "win32" as const,
    arch: "x64" as const,
    backend: "windows-job-object" as const,
    releaseReceipt: `sha256:${"b".repeat(64)}`,
  };
  const supervisor = createRuntimeProcessSupervisor({
    qualifications: [qualification],
    backend: {
      identity: qualification,
      spawnOwnedTree: () => ({
        treeId: `tree-${runId}`,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        onTreeExit: (): void => undefined,
      }),
      signalTree: (): void => undefined,
      waitForCompleteTreeExit: (): Promise<true> => Promise.resolve(true),
      reconcileTreeExit: (): Promise<true> => Promise.resolve(true),
    },
  });
  const launched = supervisor.spawnOwnedTree({
    runId,
    treeBindingId,
    executable: "/managed/runtime",
    args: [],
    cwd: ROOT,
    env: {},
    qualification,
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  });
  if (!launched.ok) throw new Error("expected qualified test launch");
  const result = await supervisor.waitForCompleteTreeExit(launched.tree, 1);
  if (result.status !== "reaped") throw new Error("expected reap proof");
  return result.receipt;
}

const TREE_BINDINGS = new WeakMap<CodingRuntimeAuthorityService, string>();

function treeBinding(authority: CodingRuntimeAuthorityService): string {
  const binding = TREE_BINDINGS.get(authority);
  if (binding === undefined) throw new Error("expected tree binding");
  return binding;
}
const intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> = {
  schemaVersion: "1",
  requestId: "request-1",
  command: "start",
  taskIntent: "Implement issue",
  requestedMode: "supervised-coding",
  modelSource: "keiko-model-gateway",
};

const LEGAL_TRANSITION_PAIRS: readonly (readonly [
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchRuntimeStateName,
])[] = [
  ["unavailable", "idle"],
  ["unavailable", "recovery-required"],
  ["idle", "starting"],
  ["idle", "unavailable"],
  ["idle", "recovery-required"],
  ["starting", "ready"],
  ["starting", "failed"],
  ["starting", "cancelled"],
  ["starting", "taken-over"],
  ["starting", "recovery-required"],
  ["ready", "running"],
  ["ready", "stopping"],
  ["ready", "failed"],
  ["ready", "taken-over"],
  ["ready", "recovery-required"],
  ["running", "awaiting-approval"],
  ["running", "stopping"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "taken-over"],
  ["running", "recovery-required"],
  ["awaiting-approval", "running"],
  ["awaiting-approval", "stopping"],
  ["awaiting-approval", "failed"],
  ["awaiting-approval", "taken-over"],
  ["awaiting-approval", "recovery-required"],
  ["stopping", "cancelled"],
  ["stopping", "succeeded"],
  ["stopping", "failed"],
  ["stopping", "recovery-required"],
  ["succeeded", "idle"],
  ["succeeded", "recovery-required"],
  ["failed", "idle"],
  ["failed", "recovery-required"],
  ["cancelled", "idle"],
  ["cancelled", "recovery-required"],
  ["taken-over", "idle"],
  ["taken-over", "recovery-required"],
];

const STATE_PATHS: Partial<
  Readonly<Record<CodingWorkbenchRuntimeStateName, readonly CodingWorkbenchRuntimeStateName[]>>
> = {
  starting: [],
  ready: ["ready"],
  running: ["ready", "running"],
  "awaiting-approval": ["ready", "running", "awaiting-approval"],
  stopping: ["ready", "stopping"],
  succeeded: ["ready", "running", "succeeded"],
  failed: ["failed"],
  cancelled: ["cancelled"],
  "taken-over": ["taken-over"],
};

function context(): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-1",
    taskId: "task-2252",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRoot: ROOT,
    branchRef: "issue-2252",
    branchHeadDigest: DIGEST,
    branch: {
      baseRef: "dev",
      headRef: "issue-2252",
      allowDetachedHead: false,
      allowedPrefixes: ["issue-"],
    },
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
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
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 10,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2026-07-11T13:00:00.000Z",
  };
}

function facts(
  overrides: Partial<CodingWorkbenchRuntimeAuthorityFacts> = {},
): CodingWorkbenchRuntimeAuthorityFacts {
  const trusted = context();
  return {
    binding: {
      taskId: trusted.taskId,
      projectId: trusted.projectId,
      projectDigest: trusted.projectDigest,
      workspaceId: trusted.workspaceId,
      workspaceRootDigest: createHash("sha256").update(ROOT).digest("hex"),
      branchRef: trusted.branchRef,
      branchHeadDigest: trusted.branchHeadDigest,
    },
    actionClasses: trusted.actionClasses,
    connectorScopes: [],
    runtimeSource: trusted.runtimeSource,
    modelSource: trusted.modelProfile.source,
    budgetDigest: codingRuntimeBudgetDigest(trusted.budget),
    commandPolicyDigest: codingRuntimeFactDigest(trusted.commandPolicy),
    networkPolicyDigest: codingRuntimeFactDigest(trusted.networkPolicy),
    gatesDigest: codingRuntimeFactDigest(trusted.gates),
    branchConstraintsDigest: codingRuntimeFactDigest(trusted.branch),
    modelProfileDigest: codingRuntimeFactDigest(trusted.modelProfile),
    ...overrides,
  };
}

function service(): CodingRuntimeAuthorityService {
  return new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => "run-1",
    () => "nonce-1",
  );
}

function mint(
  authority: CodingRuntimeAuthorityService,
  startIntent = intent,
  makeRunning = true,
): CodingRuntimeMintResult {
  const trusted = context();
  const confirmation = authority.confirmStart(startIntent, trusted.taskId, trusted.operatorId, NOW);
  const minted = authority.mintStart(startIntent, trusted, confirmation, NOW);
  if (minted.ok) {
    TREE_BINDINGS.set(authority, minted.treeBindingId);
    if (makeRunning) {
      authority.transition(minted.authorityRef.runId, "ready", NOW);
      authority.transition(minted.authorityRef.runId, "running", NOW);
    }
  }
  return minted;
}

function resolve(
  authority: CodingRuntimeAuthorityService,
  reference: { readonly runId: string; readonly envelopeDigest: string },
  live = facts(),
  delegationId = "delegation-1",
  usage = { toolCalls: 1, patchBytes: 1, promptTokens: 1 },
  idempotencyKey = `key-${delegationId}`,
): CodingRuntimeResolution {
  return authority.resolveForDelegation(
    reference,
    live,
    delegationId,
    idempotencyKey,
    usage,
    ROOT,
    "autonomous-delivery",
    NOW,
  );
}

function serviceInState(state: CodingWorkbenchRuntimeStateName): {
  readonly authority: CodingRuntimeAuthorityService;
  readonly runId: string | undefined;
} {
  const authority = service();
  if (state === "idle") return { authority, runId: undefined };
  if (state === "unavailable") {
    authority.transition(undefined, "unavailable", NOW, "runtime-unavailable");
    return { authority, runId: undefined };
  }
  if (state === "recovery-required") {
    authority.transition(undefined, "recovery-required", NOW, "recovery-required");
    return { authority, runId: undefined };
  }
  const minted = mint(authority, intent, false);
  if (!minted.ok) throw new Error("mint");
  for (const target of STATE_PATHS[state] ?? []) {
    const failure = target === "failed" ? "runtime-failed" : undefined;
    if (!authority.transition(minted.authorityRef.runId, target, NOW, failure))
      throw new Error(`transition to ${target}`);
  }
  return { authority, runId: minted.authorityRef.runId };
}

describe("CodingRuntimeAuthorityService", () => {
  it("uses a one-use confirmation to mint retained server authority", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    const minted = authority.mintStart(intent, trusted, confirmation, NOW);
    expect(minted).toMatchObject({ ok: true, authorityRef: { runId: "run-1" } });
    expect(authority.mintStart(intent, trusted, confirmation, NOW)).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
    if (!minted.ok) throw new Error("expected mint");
    authority.transition(minted.authorityRef.runId, "ready", NOW);
    authority.transition(minted.authorityRef.runId, "running", NOW);
    expect(resolve(authority, minted.authorityRef)).toMatchObject({
      ok: true,
      envelope: { authority: { localUser: "operator-1" } },
    });
    expect(resolve(authority, minted.authorityRef, facts(), "delegation-2")).toMatchObject({
      ok: true,
    });
    expect(
      JSON.stringify(resolve(authority, minted.authorityRef, facts(), "delegation-3")),
    ).not.toContain(intent.taskIntent);
  });

  it("mints a private capability bound to the exact authority without exposing it in public state", () => {
    const capabilities = createInMemoryRuntimeCapabilityStore();
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      undefined,
      capabilities,
    );
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");

    expect(
      capabilities.resolve({
        capability: minted.runtimeCapability,
        ...capabilityBinding(minted.authorityRef),
        nowMs: Date.parse(NOW),
      }),
    ).toMatchObject({ ok: true });
    const delegated = resolve(authority, minted.authorityRef, facts(), "private-capability");
    expect(minted.treeBindingId).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({ state: authority.state(), delegated })).not.toContain(
      minted.runtimeCapability,
    );
    expect(JSON.stringify({ state: authority.state(), delegated })).not.toContain(
      minted.treeBindingId,
    );
  });

  it("derives the private capability adapter kind from the trusted Codex runtime source", () => {
    const capabilities = createInMemoryRuntimeCapabilityStore();
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      undefined,
      capabilities,
    );
    const codexIntent = { ...intent, modelSource: "chatgpt-codex-subscription-profile" as const };
    const trusted = {
      ...context(),
      runtimeSource: "codex-cli-adapter" as const,
      modelProfile: {
        ...context().modelProfile,
        source: "chatgpt-codex-subscription-profile" as const,
      },
    };
    const confirmation = authority.confirmStart(
      codexIntent,
      trusted.taskId,
      trusted.operatorId,
      NOW,
    );
    const minted = authority.mintStart(codexIntent, trusted, confirmation, NOW);
    if (!minted.ok) throw new Error("expected mint");

    expect(
      capabilities.resolve({
        capability: minted.runtimeCapability,
        ...capabilityBinding(minted.authorityRef),
        adapterKind: "codex-cli-adapter",
        nowMs: Date.parse(NOW),
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects replay of a delegation identity while retaining the run envelope", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(resolve(authority, minted.authorityRef)).toMatchObject({ ok: true });
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "authority-replayed",
    });
  });

  it("authenticates the server-private capability before live-fact and replay admission", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    const input = {
      capability: minted.runtimeCapability,
      adapterKind: "model-gateway-sidecar" as const,
      liveFacts: facts(),
      delegationId: "capability-action-1",
      idempotencyKey: "capability-key-1",
      usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
      workspaceRoot: ROOT,
      deploymentCeiling: "autonomous-delivery" as const,
      nowIso: NOW,
    };

    expect(authority.resolveCapabilityForDelegation(input)).toMatchObject({ ok: true });
    const recheck = {
      capability: input.capability,
      adapterKind: input.adapterKind,
      liveFacts: input.liveFacts,
      workspaceRoot: input.workspaceRoot,
      deploymentCeiling: input.deploymentCeiling,
      nowIso: input.nowIso,
    };
    expect(authority.revalidateCapabilityForMutation(recheck)).toMatchObject({ ok: true });
    expect(authority.revalidateCapabilityForMutation(recheck)).toMatchObject({ ok: true });
    expect(authority.resolveCapabilityForDelegation(input)).toEqual({
      ok: false,
      reason: "authority-replayed",
    });
    expect(
      authority.resolveCapabilityForDelegation({
        ...input,
        capability: "forged-capability-material-that-is-invalid",
        delegationId: "capability-action-2",
        idempotencyKey: "capability-key-2",
      }),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
    expect(
      authority.resolveCapabilityForDelegation({
        ...input,
        adapterKind: "codex-cli-adapter",
        delegationId: "capability-action-3",
        idempotencyKey: "capability-key-3",
      }),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
    expect(authority.revokeBeforeTerminate("run-1")).toBe(true);
    expect(authority.revalidateCapabilityForMutation(recheck)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it.each([
    ["awaiting-approval", ["awaiting-approval"]],
    ["stopping", ["stopping"]],
    ["succeeded", ["succeeded"]],
    ["failed", ["failed"]],
    ["cancelled", ["stopping", "cancelled"]],
    ["taken-over", ["taken-over"]],
    ["recovery-required", ["recovery-required"]],
  ] as const)("denies final mutation revalidation in %s state", (_state, path) => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    for (const target of path) {
      expect(
        authority.transition(
          "run-1",
          target,
          NOW,
          target === "failed" || target === "recovery-required" ? "runtime-failed" : undefined,
        ),
      ).toBe(true);
    }

    expect(
      authority.revalidateCapabilityForMutation({
        capability: minted.runtimeCapability,
        adapterKind: "model-gateway-sidecar",
        liveFacts: facts(),
        workspaceRoot: ROOT,
        deploymentCeiling: "autonomous-delivery",
        nowIso: NOW,
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects reuse of either delegation identity and binds the original usage", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-1",
        { toolCalls: 1, patchBytes: 2, promptTokens: 3 },
        "key-1",
      ),
    ).toMatchObject({ ok: true });
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-1",
        { toolCalls: 9, patchBytes: 9, promptTokens: 9 },
        "key-2",
      ),
    ).toEqual({ ok: false, reason: "authority-replayed" });
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts(),
        "d-2",
        { toolCalls: 1, patchBytes: 2, promptTokens: 3 },
        "key-1",
      ),
    ).toEqual({ ok: false, reason: "authority-replayed" });
  });

  it("returns a deterministic concurrent-start conflict", () => {
    const authority = service();
    expect(mint(authority)).toMatchObject({ ok: true });
    expect(mint(authority, { ...intent, requestId: "request-2" })).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
  });

  it.each([
    ["task-drift", { binding: { ...facts().binding, taskId: "other" } }],
    ["workspace-drift", { binding: { ...facts().binding, workspaceId: "other" } }],
    ["project-drift", { binding: { ...facts().binding, projectDigest: "b".repeat(64) } }],
    ["branch-drift", { binding: { ...facts().binding, branchHeadDigest: "b".repeat(64) } }],
    ["scope-drift", { actionClasses: ["workspace-read"] }],
    ["budget-drift", { budgetDigest: "b".repeat(64) }],
    ["source-drift", { runtimeSource: "codex-cli-adapter" }],
    ["scope-drift", { commandPolicyDigest: "b".repeat(64) }],
    ["scope-drift", { networkPolicyDigest: "b".repeat(64) }],
    ["scope-drift", { gatesDigest: "b".repeat(64) }],
    ["scope-drift", { branchConstraintsDigest: "b".repeat(64) }],
    ["scope-drift", { modelProfileDigest: "b".repeat(64) }],
  ] as const)("rejects %s", (reason, override) => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(resolve(authority, minted.authorityRef, facts(override))).toEqual({ ok: false, reason });
  });

  it.each([
    { requestId: "swapped" },
    { taskIntent: "swapped" },
    { requestedMode: "governed-assist" as const },
    { modelSource: "chatgpt-codex-subscription-profile" as const },
  ])("rejects a start-intent swap: $requestId$taskIntent$requestedMode$modelSource", (swap) => {
    const authority = service();
    const confirmation = authority.confirmStart(
      intent,
      context().taskId,
      context().operatorId,
      NOW,
    );
    expect(authority.mintStart({ ...intent, ...swap }, context(), confirmation, NOW)).toMatchObject(
      { ok: false },
    );
  });

  it("rejects confirmation consumption by another authenticated operator", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    expect(
      authority.mintStart(intent, { ...trusted, operatorId: "operator-2" }, confirmation, NOW),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
  });

  it("reserves all delegation budgets once per id", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    const usage = { toolCalls: 10, patchBytes: 65_536, promptTokens: 10_000 };
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(facts())).toMatchObject({ ok: true });
    expect(resolve(authority, minted.authorityRef, facts(), "budgeted", usage)).toMatchObject({
      ok: true,
    });
    expect(resolve(authority, minted.authorityRef, facts(), "budgeted", usage)).toEqual({
      ok: false,
      reason: "authority-replayed",
    });
    expect(
      resolve(authority, minted.authorityRef, facts(), "fresh", {
        toolCalls: 1,
        patchBytes: 0,
        promptTokens: 0,
      }),
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });
  });

  it("owns legal lifecycle transitions and rejects illegal or wrong-run transitions", async () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    expect(authority.state()).toMatchObject({ state: "starting", runId: "run-1", revision: 1 });
    expect(authority.transition("run-1", "running", NOW)).toBe(false);
    expect(authority.transition("other", "ready", NOW)).toBe(false);
    expect(authority.transition("run-1", "ready", NOW)).toBe(true);
    expect(authority.transition("run-1", "running", NOW)).toBe(true);
    expect(authority.transition("run-1", "succeeded", NOW)).toBe(true);
    expect(authority.transition("run-1", "idle", NOW)).toBe(false);
    expect(
      authority.confirmReaped("run-1", await reapReceipt("run-1", treeBinding(authority)), NOW),
    ).toBe(true);
    expect(authority.transition(undefined, "recovery-required", NOW, "recovery-required")).toBe(
      true,
    );
    expect(validateCodingWorkbenchRuntimeState(authority.state())).toMatchObject({ ok: true });
  });

  it("rejects an invalid transition candidate atomically", () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    const before = authority.state();
    expect(authority.transition("run-1", "ready", "2026-02-30T12:00:00.000Z")).toBe(false);
    expect(authority.state()).toEqual(before);
  });

  it("keeps recovery-required fail-closed until orchestration supplies reap proof", () => {
    const authority = service();
    expect(authority.transition(undefined, "recovery-required", NOW, "recovery-required")).toBe(
      true,
    );
    expect(authority.transition(undefined, "idle", NOW)).toBe(false);
    expect(authority.transition(undefined, "unavailable", NOW, "runtime-unavailable")).toBe(false);
    expect(authority.state()).toMatchObject({ state: "recovery-required" });
  });

  it.each(LEGAL_TRANSITION_PAIRS)(
    "emits a valid state for legal transition %s -> %s",
    async (from, to) => {
      const { authority, runId } = serviceInState(from);
      if (from === "idle" && to === "starting") {
        expect(mint(authority, intent, false)).toMatchObject({ ok: true });
      } else {
        const failure =
          to === "failed"
            ? "runtime-failed"
            : to === "recovery-required"
              ? "recovery-required"
              : undefined;
        const transitioned = authority.transition(runId, to, NOW, failure);
        if (to === "idle" && runId !== undefined) {
          expect(transitioned).toBe(false);
          expect(
            authority.confirmReaped(runId, await reapReceipt(runId, treeBinding(authority)), NOW),
          ).toBe(true);
        } else {
          expect(transitioned).toBe(true);
        }
      }
      expect(validateCodingWorkbenchRuntimeState(authority.state())).toMatchObject({ ok: true });
    },
  );

  it.each([
    ["starting", []],
    ["ready", ["ready"]],
    ["running", ["ready", "running"]],
    ["awaiting-approval", ["ready", "running", "awaiting-approval"]],
    ["stopping", ["ready", "stopping"]],
    ["succeeded", ["ready", "running", "succeeded"]],
    ["failed", ["failed"]],
    ["cancelled", ["cancelled"]],
    ["taken-over", ["taken-over"]],
    ["recovery-required", ["recovery-required"]],
    ["idle", ["cancelled", "idle"]],
  ] as const)("permits productive delegation only in %s state", async (state, path) => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    for (const target of path) {
      const runId = authority.state().runId;
      const transitioned = authority.transition(
        runId,
        target,
        NOW,
        target === "failed" || target === "recovery-required" ? "runtime-failed" : undefined,
      );
      if (target === "idle" && runId !== undefined) {
        expect(transitioned).toBe(false);
        expect(
          authority.confirmReaped(runId, await reapReceipt(runId, treeBinding(authority)), NOW),
        ).toBe(true);
      } else {
        expect(transitioned).toBe(true);
      }
      expect(validateCodingWorkbenchRuntimeState(authority.state())).toMatchObject({ ok: true });
    }
    expect(validateCodingWorkbenchRuntimeState(authority.state())).toMatchObject({ ok: true });
    const result = resolve(authority, minted.authorityRef);
    expect(result.ok).toBe(state === "running");
  });

  it("revokes stop/takeover authority and releases the active-run slot only after reap proof", async () => {
    let nextRun = 0;
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => `run-${String((nextRun += 1))}`,
      () => "nonce-1",
    );
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    authority.revoke(minted.authorityRef.runId, NOW);
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    expect(mint(authority, { ...intent, requestId: "request-2" })).toMatchObject({ ok: false });
    expect(authority.transition("run-1", "idle", NOW)).toBe(false);
    const receipt = await reapReceipt("run-1", treeBinding(authority));
    const foreignReceipt = await reapReceipt("run-1", "d".repeat(64));
    expect(authority.confirmReaped("other", receipt, NOW)).toBe(false);
    expect(authority.confirmReaped("run-1", { ...receipt }, NOW)).toBe(false);
    expect(authority.confirmReaped("run-1", foreignReceipt, NOW)).toBe(false);
    expect(authority.confirmReaped("run-1", receipt, NOW)).toBe(true);
    expect(mint(authority, { ...intent, requestId: "request-2" })).toMatchObject({ ok: true });
  });

  it("keeps a failed termination occupied until the exact supervisor reap proof arrives", async () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("expected mint");
    expect(authority.transition("run-1", "ready", NOW)).toBe(true);
    expect(authority.transition("run-1", "running", NOW)).toBe(true);
    expect(authority.revokeBeforeTerminate("run-1")).toBe(true);
    expect(authority.markRecoveryRequired("run-1", NOW)).toBe(true);
    expect(authority.transition("run-1", "idle", NOW)).toBe(false);
    const receipt = await reapReceipt("run-1", treeBinding(authority));
    expect(authority.confirmReaped("other", receipt, NOW)).toBe(false);
    expect(authority.confirmReaped("run-1", receipt, NOW)).toBe(true);
    expect(authority.state()).toMatchObject({ state: "idle", runId: undefined });
  });

  it("revokes authority, run capabilities, and run approvals before terminal lifecycle confirmation", () => {
    const approvals = createInMemorySupervisedCodingApprovalStore();
    const capabilities = createInMemoryRuntimeCapabilityStore();
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      approvals,
      capabilities,
    );
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    const capability = capabilities.issue({
      runId: minted.authorityRef.runId,
      workspaceRootDigest: createHash("sha256").update(ROOT).digest("hex"),
      envelopeDigest: minted.authorityRef.envelopeDigest,
      adapterKind: "model-gateway-sidecar",
      expiresAtMs: Date.parse(context().expiresAt),
    });
    if (!capability.ok) throw new Error("expected capability");
    const approvalBinding = {
      runId: minted.authorityRef.runId,
      requestId: "action-1",
      actionKind: "system-mutation" as const,
      scopeDigest: "a".repeat(64),
      connectorScopes: [],
    };
    const approval = approvals.issue({
      binding: approvalBinding,
      approvedByUserId: "operator-1",
      nowMs: 1,
    });

    expect(authority.revokeBeforeTerminate(minted.authorityRef.runId)).toBe(true);
    expect(authority.state().state).toBe("running");
    expect(resolve(authority, minted.authorityRef)).toEqual({ ok: false, reason: "revoked" });
    expect(
      capabilities.resolve({
        capability: capability.capability,
        ...capabilityBinding(minted.authorityRef),
        nowMs: 1,
      }),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(
      approvals.consume({ approval: approval.approval, binding: approvalBinding, nowMs: 2 }),
    ).toBeUndefined();
  });
});

function capabilityBinding(reference: {
  readonly runId: string;
  readonly envelopeDigest: string;
}): RuntimeCapabilityBinding {
  return {
    runId: reference.runId,
    workspaceRootDigest: createHash("sha256").update(ROOT).digest("hex"),
    envelopeDigest: reference.envelopeDigest,
    adapterKind: "model-gateway-sidecar" as const,
    expiresAtMs: Date.parse(context().expiresAt),
  };
}
