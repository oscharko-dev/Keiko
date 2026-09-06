import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeIntent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import {
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchRuntimeState,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import {
  createInMemoryRuntimeCapabilityStore,
  type RuntimeCapabilityBinding,
} from "./runtimeCapabilityStore.js";
import { createInMemorySupervisedCodingApprovalStore } from "./supervisedCodingApprovalStore.js";
import {
  CodingRuntimeAuthorityService,
  codingRuntimeActionClassesForMode,
  codingRuntimeBudgetDigest,
  codingRuntimeCommandPolicyForMode,
  codingRuntimeConnectorScopesForMode,
  codingRuntimeFactDigest,
  codingRuntimeNetworkPolicyForMode,
  type CodingRuntimeMintResult,
  type CodingRuntimeResolution,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";
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
    recoveryHandle: "f".repeat(32),
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
  ["idle", "starting"],
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
  const headRef = projectRuntimeAuthorityValue("branch", trusted.branch.headRef);
  const projectedBranch = {
    ...trusted.branch,
    baseRef: projectRuntimeAuthorityValue("branch", trusted.branch.baseRef),
    headRef,
    allowedPrefixes: [headRef],
  };
  const projectedModelProfile = {
    ...trusted.modelProfile,
    profileId: projectRuntimeAuthorityValue("profile", trusted.modelProfile.profileId),
  };
  return {
    binding: {
      taskId: projectRuntimeAuthorityValue("task", trusted.taskId),
      projectId: projectRuntimeAuthorityValue("project", trusted.projectId),
      projectDigest: trusted.projectDigest,
      workspaceId: projectRuntimeAuthorityValue("workspace", trusted.workspaceId),
      workspaceRootDigest: createHash("sha256").update(ROOT).digest("hex"),
      branchRef: projectRuntimeAuthorityValue("branch", trusted.branchRef),
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
    branchConstraintsDigest: codingRuntimeFactDigest(projectedBranch),
    modelProfileDigest: codingRuntimeFactDigest(projectedModelProfile),
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

function mintFailureService(
  activity: ServerLogEvent[],
  registry = new EditorAgentAuthorityRegistry(),
  capabilities = createInMemoryRuntimeCapabilityStore(),
): CodingRuntimeAuthorityService {
  return new CodingRuntimeAuthorityService(
    registry,
    () => "run-1",
    () => "nonce-1",
    createInMemorySupervisedCodingApprovalStore(),
    capabilities,
    { write: (event): void => void activity.push(event) },
  );
}

function promptBudgetService(): CodingRuntimeAuthorityService {
  return new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => "run-1",
    () => "nonce-1",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) }),
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
  return authority.resolveForDelegation(reference, {
    liveFacts: live,
    delegationId,
    idempotencyKey,
    usage,
    workspaceRoot: ROOT,
    deploymentCeiling: "autonomous-delivery",
    nowIso: NOW,
  });
}

function serviceInState(state: CodingWorkbenchRuntimeStateName): {
  readonly authority: CodingRuntimeAuthorityService;
  readonly runId: string | undefined;
} {
  const authority = service();
  if (state === "idle") return { authority, runId: undefined };
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
  it("logs the exact minted authority grants for lower-mode reconstruction", () => {
    const activity: ServerLogEvent[] = [];
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      createInMemorySupervisedCodingApprovalStore(),
      createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) }),
      { write: (event): void => void activity.push(event) },
    );
    const trusted: CodingRuntimeTrustedContext = {
      ...context(),
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "verification",
        "command-execution",
        "delivery-substrate",
        "connector-access",
      ],
      connectorScopes: ["source-control.read", "source-control.write"],
      networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    };
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    expect(authority.mintStart(intent, trusted, confirmation, NOW).ok).toBe(true);

    expect(activity).toContainEqual({
      category: "security",
      op: "coding-runtime.authority.minted",
      correlationId: "run-1",
      level: "info",
      extra: {
        runId: "run-1",
        effectiveMode: "supervised-coding",
        actionClasses: trusted.actionClasses,
        connectorScopes: trusted.connectorScopes,
        networkPolicyMode: "deny-all",
        maxPromptTokens: trusted.budget.maxPromptTokens,
      },
    });
  });

  it("atomically charges the exact prompt budget and fails closed after exhaustion", async () => {
    const authority = promptBudgetService();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    expect(authority.state()).toMatchObject({ state: "running", runId: "run-1" });
    expect(
      authority.authenticateCapability(
        minted.modelGatewayCapability,
        "model-gateway",
        Date.parse(NOW),
      ),
    ).toMatchObject({ ok: true, binding: { runId: "run-1" } });

    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 10_000, Date.parse(NOW)),
    ).toEqual({ ok: true, runId: "run-1" });
    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 1, Date.parse(NOW)),
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });

    const concurrent = promptBudgetService();
    const concurrentMint = mint(concurrent);
    if (!concurrentMint.ok) throw new Error("expected mint");
    const reservations = await Promise.all(
      Array.from({ length: 2 }, async () => {
        await Promise.resolve();
        return concurrent.reservePromptTokens(
          concurrentMint.modelGatewayCapability,
          6_000,
          Date.parse(NOW),
        );
      }),
    );
    expect(reservations.filter((result) => result.ok)).toHaveLength(1);
    expect(reservations.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "authority-budget-exceeded" },
    ]);
  });

  it("admits a prompt reservation as soon as the run reaches ready, ahead of its own running transition (#3390), while a paused run or a mismatched run id are still refused", () => {
    // #3390: reproduces the real #3390 race -- the sidecar's first model call can reach the
    // gateway while the orchestrator's own initial-turn dispatch is still between its "ready" and
    // "running" transitions. A reservation issued in exactly that window must be admitted, not
    // refused as an authority-resolution failure.
    const capabilities = createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) });
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      undefined,
      capabilities,
    );
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("expected mint");
    expect(authority.transition(minted.authorityRef.runId, "ready", NOW)).toBe(true);
    expect(authority.state()).toMatchObject({ state: "ready", runId: "run-1" });

    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 100, Date.parse(NOW)),
    ).toEqual({ ok: true, runId: "run-1" });

    // A wrong run id must still be refused: the widened state gate never substitutes for the
    // per-run identity checks.
    const wrongRun = capabilities.issue({
      runId: "run-mismatch",
      workspaceRootDigest: DIGEST,
      envelopeDigest: DIGEST,
      adapterKind: "model-gateway-sidecar",
      audience: "model-gateway",
      expiresAtMs: Date.parse(NOW) + 60_000,
    });
    if (!wrongRun.ok) throw new Error("expected wrong-run capability issue");
    expect(authority.reservePromptTokens(wrongRun.capability, 1, Date.parse(NOW))).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });

    // A paused run must still be refused: the widened gate covers only the "ready" dispatch
    // window, never the sticky-pause hold.
    expect(authority.transition("run-1", "running", NOW)).toBe(true);
    expect(authority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 1, Date.parse(NOW)),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
  });

  it('admits a prompt reservation issued from inside the managed runtime\'s own start() -- while runtimeState is still "starting", ahead of any "ready"/"running" transition (#3390 real window), while a paused run or a mismatched run id are still refused', () => {
    // #3390 (review repair): production wiring (productionCodingRuntimePorts.ts's
    // startProductionRuntime) only transitions runtimeState to "ready" then "running" AFTER the
    // managed runtime's own start() promise resolves. If the sidecar becomes reachable and issues
    // its first model call while that start() call is still in flight, runtimeState is "starting"
    // -- not "ready" -- so a reservation must be admissible in that exact state, with no
    // transition call made at all (this is the actual real-world race window; the "ready" pin
    // above covers the orchestrator's local, related-but-distinct dispatch ordering).
    const capabilities = createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) });
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      undefined,
      capabilities,
    );
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("expected mint");
    expect(authority.state()).toMatchObject({ state: "starting", runId: "run-1" });

    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 100, Date.parse(NOW)),
    ).toEqual({ ok: true, runId: "run-1" });

    // A wrong run id must still be refused even while "starting": the widened state gate never
    // substitutes for the per-run identity checks.
    const wrongRun = capabilities.issue({
      runId: "run-mismatch",
      workspaceRootDigest: DIGEST,
      envelopeDigest: DIGEST,
      adapterKind: "model-gateway-sidecar",
      audience: "model-gateway",
      expiresAtMs: Date.parse(NOW) + 60_000,
    });
    if (!wrongRun.ok) throw new Error("expected wrong-run capability issue");
    expect(authority.reservePromptTokens(wrongRun.capability, 1, Date.parse(NOW))).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });

    // A paused run must still be refused: reaching "starting" never substitutes for the sticky
    // pause hold once the run has actually progressed past it.
    expect(authority.transition("run-1", "ready", NOW)).toBe(true);
    expect(authority.transition("run-1", "running", NOW)).toBe(true);
    expect(authority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(
      authority.reservePromptTokens(minted.modelGatewayCapability, 1, Date.parse(NOW)),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
  });

  it("fails retained prompt and pause or resume operations closed after runtime exhaustion", () => {
    const afterRuntimeBudget = "2026-07-11T12:01:00.001Z";
    const promptAuthority = promptBudgetService();
    const promptMint = mint(promptAuthority);
    if (!promptMint.ok) throw new Error("expected prompt-authority mint");

    expect(
      promptAuthority.reservePromptTokens(
        promptMint.modelGatewayCapability,
        1,
        Date.parse(afterRuntimeBudget),
      ),
    ).toEqual({ ok: false, reason: "authority-budget-exceeded" });

    const pauseAuthority = service();
    expect(mint(pauseAuthority)).toMatchObject({ ok: true });
    expect(pauseAuthority.pause("run-1", afterRuntimeBudget)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });

    const resumeAuthority = service();
    expect(mint(resumeAuthority)).toMatchObject({ ok: true });
    expect(resumeAuthority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(resumeAuthority.resume("run-1", "supervised-coding", afterRuntimeBudget)).toEqual({
      ok: false,
      reason: "authority-budget-exceeded",
    });
  });

  it("revalidates expiry and permits only idempotent or monotonically narrower resume", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");

    expect(authority.pause("run-1", NOW)).toEqual({ ok: true, effectiveMode: "supervised-coding" });
    expect(authority.pause("run-1", NOW)).toEqual({ ok: true, effectiveMode: "supervised-coding" });
    expect(authority.resume("run-1", "governed-assist", NOW)).toEqual({
      ok: true,
      effectiveMode: "governed-assist",
    });
    expect(authority.resume("run-1", "governed-assist", NOW)).toEqual({
      ok: true,
      effectiveMode: "governed-assist",
    });
    expect(authority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(authority.resume("run-1", "supervised-coding", NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    expect(authority.resume("run-1", "governed-assist", context().expiresAt)).toEqual({
      ok: false,
      reason: "authority-expired",
    });
  });

  it("projects the narrowed resume mode to Git-delivery authority", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");

    expect(authority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(authority.resume("run-1", "governed-assist", NOW)).toEqual({
      ok: true,
      effectiveMode: "governed-assist",
    });

    expect(authority.gitDeliveryAuthorityPort().current(NOW)).toMatchObject({
      projectId: ROOT,
      workspaceRoot: ROOT,
      authority: { effectiveMode: "governed-assist" },
    });
  });

  it("narrows every retained authority field when a Full access run resumes in Ask for approval", () => {
    const authority = service();
    const fullContext: CodingRuntimeTrustedContext = {
      ...context(),
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "command-execution",
        "verification",
        "delivery-substrate",
        "connector-access",
        "network-egress",
      ],
      connectorScopes: [
        "source-control.read",
        "source-control.write",
        "issue-tracker.read",
        "issue-tracker.write",
      ],
      commandPolicy: {
        mode: "governed",
        allow: [],
        deny: [],
        maxCommandTimeoutMs: 60_000,
        requirePerCommandApproval: false,
      },
      networkPolicy: {
        mode: "connector-scoped-egress",
        allowLoopback: false,
        connectorScopes: [
          "source-control.read",
          "source-control.write",
          "issue-tracker.read",
          "issue-tracker.write",
        ],
      },
    };
    const fullIntent = { ...intent, requestedMode: "autonomous-delivery" as const };
    const confirmation = authority.confirmStart(
      fullIntent,
      fullContext.taskId,
      fullContext.operatorId,
      NOW,
    );
    const minted = authority.mintStart(fullIntent, fullContext, confirmation, NOW);
    if (!minted.ok) throw new Error("expected mint");
    authority.transition(minted.authorityRef.runId, "ready", NOW);
    authority.transition(minted.authorityRef.runId, "running", NOW);
    expect(authority.pause("run-1", NOW)).toMatchObject({ ok: true });
    expect(authority.resume("run-1", "governed-assist", NOW)).toMatchObject({ ok: true });

    const live = facts({
      actionClasses: fullContext.actionClasses,
      connectorScopes: fullContext.connectorScopes,
      commandPolicyDigest: codingRuntimeFactDigest(fullContext.commandPolicy),
      networkPolicyDigest: codingRuntimeFactDigest(fullContext.networkPolicy),
    });
    const resolution = resolve(authority, minted.authorityRef, live);
    if (!resolution.ok) throw new Error("expected narrowed resolution");
    // ADR-0138 D2: Ask for approval's workspace-contained/internet effects are approval-required,
    // never denied outright, so a narrowed authority retains "command-execution" (gated by
    // commandPolicy.requirePerCommandApproval, not stripped) and the authority-level connector
    // scopes an approved request would need. The network policy itself stays deny-all with no
    // scopes: the envelope contract forbids scopes on a deny-all policy, and an approved
    // connector-scoped request is redeemed through its approval proof, not through the policy.
    expect(resolution.envelope.authority).toMatchObject({
      effectiveMode: "governed-assist",
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "command-execution",
        "verification",
        "delivery-substrate",
        "connector-access",
      ],
      connectorScopes: ["source-control.read", "source-control.write"],
      commandPolicy: { mode: "governed", requirePerCommandApproval: true },
      networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    });
    expect(authority.gitDeliveryAuthorityPort().current(NOW)?.authority).toMatchObject({
      effectiveMode: "governed-assist",
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "command-execution",
        "verification",
        "delivery-substrate",
        "connector-access",
      ],
      connectorScopes: ["source-control.read", "source-control.write"],
      commandPolicy: { mode: "governed", requirePerCommandApproval: true },
      networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    });
  });

  it("fails pause closed when retained authority is expired or revoked", () => {
    const expired = service();
    expect(mint(expired)).toMatchObject({ ok: true });
    expect(expired.pause("run-1", context().expiresAt)).toEqual({
      ok: false,
      reason: "authority-expired",
    });

    const registry = new EditorAgentAuthorityRegistry();
    const revoked = new CodingRuntimeAuthorityService(
      registry,
      () => "run-1",
      () => "nonce-1",
    );
    const minted = mint(revoked);
    if (!minted.ok) throw new Error("expected mint");
    registry.revoke(minted.authorityRef);
    expect(revoked.pause("run-1", NOW)).toEqual({ ok: false, reason: "revoked" });
  });

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
      envelope: {
        authority: { localUser: projectRuntimeAuthorityValue("operator", "operator-1") },
      },
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
        capability: minted.toolFacadeCapability,
        ...capabilityBinding(minted.authorityRef),
        nowMs: Date.parse(NOW),
      }),
    ).toMatchObject({ ok: true });
    const delegated = resolve(authority, minted.authorityRef, facts(), "private-capability");
    expect(minted.treeBindingId).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({ state: authority.state(), delegated })).not.toContain(
      minted.toolFacadeCapability,
    );
    expect(JSON.stringify({ state: authority.state(), delegated })).not.toContain(
      minted.treeBindingId,
    );
  });

  // Relocated for epic #3384 correction 8 (the execution binding never carries `issueBinding` —
  // only the run's public snapshot does). The invariant this pin encodes is unchanged and must
  // stay exactly as strict: a run minted while bound to one issue must reject a delegation that
  // reports a different bound issue as `task-drift`. What moved is the comparison's data shape:
  // the registry now compares the content-free `issueBindingDigest` fingerprint retained at mint
  // time (`AuthorityRecord.runtimeIssueBindingDigest`) against the live fingerprint, never the
  // binding object itself — so this pin is strengthened, not relaxed, with an explicit assertion
  // that the retained envelope's binding carries no `issueBinding` at all.
  it("binds admitted issue identity at mint time and rejects rebinding on delegation (epic #3384 correction 8)", () => {
    const authority = service();
    const issueBinding = {
      schemaVersion: "1" as const,
      repositoryId: "repo_123",
      remoteDigest: DIGEST,
      issueNumber: 42,
      issueIdDigest: "b".repeat(64),
      defaultBaseRef: "dev",
      contentRevisionDigest: "c".repeat(64),
      bindingDigest: "d".repeat(64),
    };
    const trusted = { ...context(), issueBinding };
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    const minted = authority.mintStart(intent, trusted, confirmation, NOW);
    if (!minted.ok) throw new Error("expected mint");
    authority.transition(minted.authorityRef.runId, "ready", NOW);
    authority.transition(minted.authorityRef.runId, "running", NOW);
    const admitted = resolve(
      authority,
      minted.authorityRef,
      facts({ issueBindingDigest: issueBinding.bindingDigest }),
    );
    expect(admitted).toMatchObject({ ok: true });
    expect(JSON.stringify(admitted)).not.toContain("issueBinding");
    expect(
      resolve(
        authority,
        minted.authorityRef,
        facts({ issueBindingDigest: "e".repeat(64) }),
        "changed-issue",
      ),
    ).toMatchObject({
      ok: false,
      reason: "task-drift",
    });
  });

  it("keeps projected authority evidence separate from private runtime model binding", () => {
    const capabilities = createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) });
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "run-1",
      () => "nonce-1",
      undefined,
      capabilities,
    );
    const trusted = context();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    const projectedProfileId = projectRuntimeAuthorityValue(
      "profile",
      trusted.modelProfile.profileId,
    );

    expect(
      capabilities.resolve({
        capability: minted.modelGatewayCapability,
        ...capabilityBinding(minted.authorityRef),
        audience: "model-gateway",
        nowMs: Date.parse(NOW),
      }),
    ).toMatchObject({
      ok: true,
      binding: { modelProfileId: trusted.modelProfile.profileId },
    });
    expect(
      capabilities.resolve({
        capability: minted.modelGatewayCapability,
        ...capabilityBinding(minted.authorityRef),
        audience: "model-gateway",
        modelProfileId: projectedProfileId,
        nowMs: Date.parse(NOW),
      }),
    ).toEqual({ ok: false, reason: "invalid" });

    const delegated = resolve(authority, minted.authorityRef, facts(), "private-model-binding");
    expect(JSON.stringify(delegated)).not.toContain(trusted.modelProfile.profileId);
  });

  it("mints distinct run-scoped gateway and tool capabilities that cannot cross audiences", () => {
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
    const privateResult = minted as typeof minted & {
      readonly modelGatewayCapability?: string;
      readonly toolFacadeCapability?: string;
    };

    expect(privateResult.modelGatewayCapability).toMatch(/^[A-Za-z0-9_-]{32,256}$/u);
    expect(privateResult.toolFacadeCapability).toMatch(/^[A-Za-z0-9_-]{32,256}$/u);
    expect(privateResult.modelGatewayCapability).not.toBe(privateResult.toolFacadeCapability);
    expect(
      capabilities.resolve({
        capability: privateResult.modelGatewayCapability,
        ...capabilityBinding(minted.authorityRef),
        audience: "tool-facade",
        nowMs: Date.parse(NOW),
      } as never),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      capabilities.resolve({
        capability: privateResult.toolFacadeCapability,
        ...capabilityBinding(minted.authorityRef),
        audience: "model-gateway",
        nowMs: Date.parse(NOW),
      } as never),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(JSON.stringify(authority.state())).not.toContain(privateResult.modelGatewayCapability);
    expect(JSON.stringify(authority.state())).not.toContain(privateResult.toolFacadeCapability);
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
        capability: minted.toolFacadeCapability,
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

  it("admits operator operations on a paused run while the tool path stays running-only", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    const recheck = {
      capability: minted.toolFacadeCapability,
      adapterKind: "model-gateway-sidecar" as const,
      liveFacts: facts(),
      workspaceRoot: ROOT,
      deploymentCeiling: "autonomous-delivery" as const,
      nowIso: NOW,
    };
    expect(authority.pause(minted.authorityRef.runId, NOW)).toMatchObject({ ok: true });
    // Sticky pause holds the RUNTIME: a paused run must never execute a child tool mutation.
    expect(authority.revalidateCapabilityForMutation(recheck)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });
    // The operator's own admissions (follow-up dispatch, abort, question answers) keep their
    // authority while paused — the coordinator deliberately admits a follow-up task turn there,
    // and holding it to running-only silently 403'd every paused follow-up (post-#2644 stall).
    expect(authority.revalidateCapabilityForOperatorAdmission(recheck)).toMatchObject({
      ok: true,
    });
  });

  it("authenticates the server-private capability before live-fact and replay admission", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");
    const input = {
      capability: minted.toolFacadeCapability,
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
        capability: minted.toolFacadeCapability,
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

  // KEIKO-0618: the shared `starting` -> `cancelled` contract edge is genuinely reachable through
  // REAP_SETTLEMENT_TRANSITIONS, via confirmReaped, when a Codex/OpenCode sidecar fails its startup
  // handshake before productionCodingRuntimePorts.ts ever advances authority state past `starting`.
  // Pinned so a future edit does not remove this edge on the mistaken belief that it is dead code.
  it("settles a starting run's reap through the starting->cancelled edge (KEIKO-0618)", async () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    expect(authority.state()).toMatchObject({ state: "starting", runId: "run-1" });
    expect(authority.revokeBeforeTerminate("run-1")).toBe(true);
    expect(authority.state()).toMatchObject({ state: "starting", runId: "run-1" });
    const receipt = await reapReceipt("run-1", treeBinding(authority));
    expect(authority.confirmReaped("run-1", receipt, NOW)).toBe(true);
    expect(authority.state()).toMatchObject({ state: "idle", runId: undefined });
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
    // KEIKO-0737: revoke() was a dead combinator; call its two primitives directly instead.
    authority.revokeBeforeTerminate(minted.authorityRef.runId);
    authority.transition(minted.authorityRef.runId, "taken-over", NOW);
    expect(resolve(authority, minted.authorityRef)).toEqual({
      ok: false,
      reason: "revoked",
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
    const capabilities = createInMemoryRuntimeCapabilityStore({ nowMs: () => 1 });
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
      audience: "tool-facade",
      expiresAtMs: Date.parse(context().expiresAt),
    });
    if (!capability.ok) throw new Error("expected capability");
    const approvalBinding = {
      grantScope: "once" as const,
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
    modelProfileId: context().modelProfile.profileId,
    audience: "tool-facade",
    expiresAtMs: Date.parse(context().expiresAt),
  };
}

describe("CodingRuntimeAuthorityService fail-closed mint and release guards", () => {
  it("refuses a confirmed mint while a run is active", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    expect(authority.mintConfirmedStartForRun("run-2", intent, context(), DIGEST, NOW)).toEqual({
      ok: false,
      reason: "active-run-conflict",
    });
  });

  it("refuses a confirmed mint for a mismatched model source or malformed approval digest", () => {
    expect(
      authority.mintConfirmedStartForRun(
        "run-1",
        { ...intent, modelSource: "chatgpt-codex-subscription-profile" },
        context(),
        DIGEST,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
    expect(
      authority.mintConfirmedStartForRun("run-1", intent, context(), "not-a-digest", NOW),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });
    expect(authority.state().state).toBe("idle");
  });

  it("records the closed stage and reason for every start-mint refusal", () => {
    const events: ServerLogEvent[] = [];
    const sourceMismatch = mintFailureService(events);
    const sourceConfirmation = sourceMismatch.confirmStart(
      intent,
      context().taskId,
      context().operatorId,
      NOW,
    );
    expect(
      sourceMismatch.mintStartForRun(
        "run-source",
        { ...intent, modelSource: "chatgpt-codex-subscription-profile" },
        context(),
        sourceConfirmation,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    const confirmationRefused = mintFailureService(events);
    const rejectedConfirmation = confirmationRefused.confirmStart(
      intent,
      context().taskId,
      context().operatorId,
      NOW,
    );
    expect(
      confirmationRefused.mintStartForRun(
        "run-confirmation",
        intent,
        context(),
        { ...rejectedConfirmation, taskId: "different-task" },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    const mismatched = mintFailureService(events);
    expect(
      mismatched.mintConfirmedStartForRun(
        "run-model",
        { ...intent, modelSource: "chatgpt-codex-subscription-profile" },
        context(),
        DIGEST,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    const malformedDigest = mintFailureService(events);
    expect(
      malformedDigest.mintConfirmedStartForRun(
        "run-digest",
        intent,
        context(),
        "not-a-digest",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    const invalidEnvelope = mintFailureService(events);
    expect(
      invalidEnvelope.mintConfirmedStartForRun(
        "run-envelope",
        intent,
        { ...context(), projectDigest: "not-a-digest" },
        DIGEST,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    const refusingRegistry = new EditorAgentAuthorityRegistry();
    vi.spyOn(refusingRegistry, "registerRuntime").mockReturnValue({
      ok: false,
      reason: "invalid",
    });
    const registration = mintFailureService(events, refusingRegistry);
    expect(registration.mintConfirmedStartForRun("run-1", intent, context(), DIGEST, NOW)).toEqual({
      ok: false,
      reason: "authority-resolution-failed",
    });

    const capabilityIssuance = mintFailureService(
      events,
      new EditorAgentAuthorityRegistry(),
      createInMemoryRuntimeCapabilityStore({
        maxRecords: 1,
        nowMs: () => Date.parse(NOW),
      }),
    );
    expect(
      capabilityIssuance.mintConfirmedStartForRun("run-1", intent, context(), DIGEST, NOW),
    ).toEqual({ ok: false, reason: "authority-resolution-failed" });

    expect(
      events.map((event) => ({
        op: event.op,
        correlationId: event.correlationId,
        stage: event.extra?.stage,
        reason: event.extra?.reason,
        errorKind: event.errorKind,
      })),
    ).toEqual([
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-source",
        stage: "intent-binding",
        reason: "model-source-mismatch",
        errorKind: "CodingRuntimeAuthorityBindingFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-confirmation",
        stage: "confirmation-consumption",
        reason: "confirmation-refused",
        errorKind: "CodingRuntimeAuthorityConfirmationFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-model",
        stage: "intent-binding",
        reason: "model-source-mismatch",
        errorKind: "CodingRuntimeAuthorityBindingFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-digest",
        stage: "approval-digest",
        reason: "approval-digest-invalid",
        errorKind: "CodingRuntimeAuthorityValidationFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-envelope",
        stage: "envelope-validation",
        reason: "envelope-invalid",
        errorKind: "CodingRuntimeAuthorityValidationFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-1",
        stage: "authority-registration",
        reason: "registration-refused",
        errorKind: "CodingRuntimeAuthorityRegistrationFailure",
      },
      {
        op: "coding-runtime.authority.mint-failed",
        correlationId: "run-1",
        stage: "capability-issuance",
        reason: "capability-issuance-refused",
        errorKind: "CodingRuntimeAuthorityCapabilityFailure",
      },
    ]);
  });

  it("rejects a tampered one-use mint confirmation", () => {
    const authority = service();
    const trusted = context();
    const confirmation = authority.confirmStart(intent, trusted.taskId, trusted.operatorId, NOW);
    const tampered = { ...confirmation, taskId: "task-attacker" };
    expect(authority.mintStart(intent, trusted, tampered, NOW).ok).toBe(false);
    // The untampered confirmation stays consumable exactly once afterwards.
    expect(authority.mintStart(intent, trusted, confirmation, NOW).ok).toBe(true);
  });

  it("rejects a capability presented to the wrong audience", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("mint");
    expect(
      authority.authenticateCapability(
        minted.toolFacadeCapability,
        "model-gateway",
        Date.parse(NOW),
      ),
    ).toMatchObject({ ok: false });
    expect(
      authority.authenticateCapability(minted.toolFacadeCapability, "tool-facade", Date.parse(NOW)),
    ).toMatchObject({ ok: true });
  });

  it("abandons only an unlaunched starting run and returns the slot to idle", () => {
    const authority = service();
    const minted = mint(authority, intent, false);
    if (!minted.ok) throw new Error("mint");
    expect(authority.abandonUnlaunched("run-9", NOW)).toBe(false);
    expect(authority.abandonUnlaunched("run-1", NOW)).toBe(true);
    expect(authority.state()).toMatchObject({ state: "idle" });
    // The slot is released exactly once; a replay cannot double-release it.
    expect(authority.abandonUnlaunched("run-1", NOW)).toBe(false);
    // And the slot is genuinely reusable for a fresh mint.
    expect(mint(authority, intent, false).ok).toBe(true);
  });

  const authority = service();
});

// #3399 (epic #3384 correction 4): the server-minted, bounded description authority that admits
// description generation and the "pull-request" body-only apply outside a running Code task.
describe("CodingRuntimeAuthorityService description authority", () => {
  const SCOPE = {
    remoteDigest: "d".repeat(64),
    pr: { ownerAndRepo: "oscharko-dev/Keiko", prNumber: 3399 },
    snapshotDigest: "e".repeat(64),
  };

  it("mints an effective mode clamped by the deployment ceiling, never the requested mode alone", () => {
    const authority = service();
    const minted = authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "autonomous-delivery",
      deploymentCeiling: "supervised-coding",
      nowIso: NOW,
    });
    expect(minted.effectiveMode).toBe("supervised-coding");
    expect(minted.scope).toEqual(SCOPE);
  });

  it("the port returns the live record for the exact scope and nothing for a different one", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
    });
    const port = authority.gitDeliveryDescriptionAuthorityPort();
    expect(port.current(SCOPE, NOW)?.effectiveMode).toBe("governed-assist");
    expect(port.current({ ...SCOPE, snapshotDigest: "f".repeat(64) }, NOW)).toBeUndefined();
  });

  it("expires the record after its TTL", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
      ttlMs: 1_000,
    });
    const port = authority.gitDeliveryDescriptionAuthorityPort();
    expect(port.current(SCOPE, "2026-07-11T12:00:00.500Z")).toBeDefined();
    expect(port.current(SCOPE, "2026-07-11T12:00:01.500Z")).toBeUndefined();
  });

  // #3400/#3401 final-audit F1: before `expired()` existed, `current()` alone could not tell
  // `authorizeGitDeliveryModelEgress` whether a record for this exact scope had passed its
  // `expiresAt` or had never been minted at all — both were the SAME `undefined`. This is the
  // failing-before case for the read path: `expired()` must report `true` once the TTL has
  // elapsed, and `false` for a scope that was never minted, even though `current()` returns
  // `undefined` for both.
  it("expired() distinguishes a past record from one that was never minted for this scope", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
      ttlMs: 1_000,
    });
    const port = authority.gitDeliveryDescriptionAuthorityPort();
    const laterIso = "2026-07-11T12:00:01.500Z";
    expect(port.current(SCOPE, laterIso)).toBeUndefined();
    expect(port.expired?.(SCOPE, laterIso)).toBe(true);
    const neverMinted = { ...SCOPE, snapshotDigest: "f".repeat(64) };
    expect(port.current(neverMinted, laterIso)).toBeUndefined();
    expect(port.expired?.(neverMinted, laterIso)).toBe(false);
  });

  // Review repair (final-audit F1): `mintGitDeliveryDescriptionAuthority` used to sweep every
  // expired entry out of the map on EVERY mint, for any scope. That meant a wholly unrelated mint
  // for scope B, happening after scope A's record had passed its `expiresAt`, silently erased
  // scope A's record before anyone asked `expired()` about it — collapsing "A had an authority
  // that expired" back into the indistinguishable "A was never minted" case the whole audit item
  // exists to fix. This is the failing-before case for that erasure: `expired(A)` must still
  // report `true` after an intervening, unrelated mint for scope B.
  it("keeps reporting authority-expired for a scope after an unrelated scope is minted", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
      ttlMs: 1_000,
    });
    const port = authority.gitDeliveryDescriptionAuthorityPort();
    const laterIso = "2026-07-11T12:00:01.500Z";
    expect(port.expired?.(SCOPE, laterIso)).toBe(true);

    const unrelatedScope = { ...SCOPE, snapshotDigest: "c".repeat(64) };
    authority.mintGitDeliveryDescriptionAuthority({
      scope: unrelatedScope,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: laterIso,
      ttlMs: 1_000,
    });

    expect(port.expired?.(SCOPE, laterIso)).toBe(true);
  });

  it("revokes the record explicitly on a scope change or stale re-check the caller detected", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
    });
    authority.revokeGitDeliveryDescriptionAuthority(SCOPE);
    expect(authority.gitDeliveryDescriptionAuthorityPort().current(SCOPE, NOW)).toBeUndefined();
  });

  it("re-minting the same scope replaces the prior grant rather than accumulating records", () => {
    const authority = service();
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      nowIso: NOW,
    });
    authority.mintGitDeliveryDescriptionAuthority({
      scope: SCOPE,
      requestedMode: "governed-assist",
      deploymentCeiling: "governed-assist",
      nowIso: NOW,
    });
    expect(authority.gitDeliveryDescriptionAuthorityPort().current(SCOPE, NOW)?.effectiveMode).toBe(
      "governed-assist",
    );
  });
});

// B3-1 / authority-matrix-1: Ask for approval (governed-assist) must mint an approval-required
// command policy, not a hard "deny" -- ADR-0138 D2's workspace-contained row is approval-required,
// never denied, at every mode. Regression: before the fix, codingRuntimeCommandPolicyForMode
// hardcoded mode:"deny" for governed-assist and codingRuntimeActionClassesForMode excluded
// "command-execution" from its envelope, so no approval proof could ever unlock a command.
describe("codingRuntimeCommandPolicyForMode / codingRuntimeActionClassesForMode", () => {
  it("mints an approval-required, never a hard-denied, command policy for every product mode", () => {
    expect(codingRuntimeCommandPolicyForMode("governed-assist")).toMatchObject({
      mode: "governed",
      requirePerCommandApproval: true,
    });
    expect(codingRuntimeCommandPolicyForMode("supervised-coding")).toMatchObject({
      mode: "governed",
      requirePerCommandApproval: true,
    });
    expect(codingRuntimeCommandPolicyForMode("autonomous-delivery")).toMatchObject({
      mode: "governed",
      requirePerCommandApproval: false,
    });
  });

  it("includes command-execution in governed-assist's action classes so an approved command is not double-denied", () => {
    expect(codingRuntimeActionClassesForMode("governed-assist", undefined)).toContain(
      "command-execution",
    );
    expect(codingRuntimeActionClassesForMode("supervised-coding", undefined)).toContain(
      "command-execution",
    );
    expect(codingRuntimeActionClassesForMode("autonomous-delivery", undefined)).toContain(
      "command-execution",
    );
  });
});

// B3-2 / authority-matrix-2: the authority-level connector scopes follow deliveryScopeGranted at
// every mode (codingRuntimeConnectorScopesForMode), but the envelope contract
// (validateNetworkPolicyConnectorScopesConsistency) forbids scopes on a deny-all network policy.
// A deny-all mint therefore carries none; the policies that admit egress carry the delivery scopes.
describe("codingRuntimeNetworkPolicyForMode", () => {
  it("carries the delivery connector scopes only on policies that admit egress", () => {
    expect(codingRuntimeNetworkPolicyForMode("governed-assist", undefined).connectorScopes).toEqual(
      [],
    );
    expect(
      codingRuntimeNetworkPolicyForMode("supervised-coding", undefined).connectorScopes,
    ).toEqual([]);
    expect(codingRuntimeNetworkPolicyForMode("governed-assist", true).connectorScopes).toEqual(
      codingRuntimeConnectorScopesForMode("governed-assist"),
    );
    expect(codingRuntimeNetworkPolicyForMode("governed-assist", true).connectorScopes).toEqual([
      "source-control.read",
      "source-control.write",
    ]);
    expect(
      codingRuntimeNetworkPolicyForMode("autonomous-delivery", undefined).connectorScopes,
    ).toEqual(["source-control.read", "source-control.write"]);
  });

  it("still keeps deny-all/governed-egress mode gating unchanged by the scope population", () => {
    expect(codingRuntimeNetworkPolicyForMode("governed-assist", undefined).mode).toBe("deny-all");
    expect(codingRuntimeNetworkPolicyForMode("governed-assist", true).mode).toBe("governed-egress");
    expect(codingRuntimeNetworkPolicyForMode("autonomous-delivery", undefined).mode).toBe(
      "connector-scoped-egress",
    );
  });
});

// B1-3: a run's git-delivery authority is minted before any PR necessarily exists. Once the run's
// PR is published, bindPublishedPullRequest lets the caller that learns of it attach that identity
// so downstream admission (prDescriptionRoutes.ts's admitDescriptionModelEgress) can compare a
// request's PR identity against the run's actual scope instead of admitting any PR in the project.
describe("CodingRuntimeAuthorityService.bindPublishedPullRequest", () => {
  it("binds the pull request identity onto the active run's projected Git-delivery authority", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");

    expect(
      authority.bindPublishedPullRequest(minted.authorityRef.runId, {
        ownerAndRepo: "acme/widgets",
        prNumber: 42,
      }),
    ).toBe(true);
    expect(authority.gitDeliveryAuthorityPort().current(NOW)).toMatchObject({
      pullRequest: { ownerAndRepo: "acme/widgets", prNumber: 42 },
    });
  });

  it("refuses to bind onto a run that is not the currently active one", () => {
    const authority = service();
    const minted = mint(authority);
    if (!minted.ok) throw new Error("expected mint");

    expect(
      authority.bindPublishedPullRequest("some-other-run", {
        ownerAndRepo: "acme/widgets",
        prNumber: 42,
      }),
    ).toBe(false);
    expect(authority.gitDeliveryAuthorityPort().current(NOW)).not.toMatchObject({
      pullRequest: { ownerAndRepo: "acme/widgets", prNumber: 42 },
    });
  });

  it("refuses to bind when no run is active", () => {
    const authority = service();
    expect(
      authority.bindPublishedPullRequest("run-1", { ownerAndRepo: "acme/widgets", prNumber: 42 }),
    ).toBe(false);
  });
});
