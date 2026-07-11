import { createHash, randomBytes } from "node:crypto";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  isLegalCodingWorkbenchRuntimeTransition,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeMintConfirmation,
  validateCodingWorkbenchRuntimeState,
  type CodingWorkbenchActionClass,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchBranchConstraints,
  type CodingWorkbenchBudget,
  type CodingWorkbenchCommandPolicy,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchGate,
  type CodingWorkbenchMode,
  type CodingWorkbenchModelProfile,
  type CodingWorkbenchNetworkPolicy,
  type CodingWorkbenchRuntimeAuthorityEnvelope,
  type CodingWorkbenchRuntimeAdapterKind,
  type CodingWorkbenchRuntimeAuthorityFacts,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeDelegationUsage,
  type CodingWorkbenchRuntimeIntent,
  type CodingWorkbenchRuntimeMintConfirmation,
  type CodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeStateName,
  type CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentAuthorityRegistry,
  editorAgentAuthorityEnvelopeDigest,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  type SupervisedCodingApprovalBinding,
  type SupervisedCodingApprovalStore,
} from "./supervisedCodingApprovalStore.js";
import {
  createInMemoryRuntimeCapabilityStore,
  type RuntimeCapabilityStore,
} from "./runtimeCapabilityStore.js";
import { verifyRuntimeReapReceipt, type RuntimeReapReceipt } from "./runtimeProcessSupervisor.js";

export interface CodingRuntimeTrustedContext {
  readonly operatorId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly branchRef: string;
  readonly branchHeadDigest: string;
  readonly branch: CodingWorkbenchBranchConstraints;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly modelProfile: CodingWorkbenchModelProfile;
  readonly commandPolicy: CodingWorkbenchCommandPolicy;
  readonly networkPolicy: CodingWorkbenchNetworkPolicy;
  readonly gates: readonly CodingWorkbenchGate[];
  readonly budget: CodingWorkbenchBudget;
  readonly expiresAt: string;
}

export interface CodingRuntimeAuthorityRef {
  readonly runId: string;
  readonly envelopeDigest: string;
}
export type CodingRuntimeMintResult =
  | {
      readonly ok: true;
      readonly authorityRef: CodingRuntimeAuthorityRef;
      /** Server-private runtime-to-BFF secret; never forward to browser-safe contracts or evidence. */
      readonly runtimeCapability: string;
      /** Server-private per-launch supervisor binding; never project to browser or evidence. */
      readonly treeBindingId: string;
    }
  | { readonly ok: false; readonly reason: "active-run-conflict" | "authority-resolution-failed" };
export type CodingRuntimeResolution =
  | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode };

export interface CodingRuntimeCapabilityDelegationInput {
  readonly capability: string;
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly delegationId: string;
  readonly idempotencyKey: string;
  readonly usage: CodingWorkbenchRuntimeDelegationUsage;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
}

export type CodingRuntimeCapabilityRecheckInput = Omit<
  CodingRuntimeCapabilityDelegationInput,
  "delegationId" | "idempotencyKey" | "usage"
>;

export class CodingRuntimeAuthorityService {
  private activeAuthorityRef: CodingRuntimeAuthorityRef | undefined;
  private activeTreeBindingId: string | undefined;
  private reapPending: { readonly runId: string; readonly treeBindingId: string } | undefined;
  private runtimeState: CodingWorkbenchRuntimeState = {
    schemaVersion: "1",
    state: "idle",
    revision: 0,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };

  public constructor(
    private readonly registry: EditorAgentAuthorityRegistry,
    private readonly newRunId: () => string = () => randomBytes(16).toString("hex"),
    private readonly newNonce: () => string = () => randomBytes(32).toString("hex"),
    private readonly approvals: SupervisedCodingApprovalStore = createInMemorySupervisedCodingApprovalStore(),
    private readonly capabilities: RuntimeCapabilityStore = createInMemoryRuntimeCapabilityStore(),
  ) {}

  public confirmStart(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    taskId: string,
    operatorId: string,
    nowIso: string,
  ): CodingWorkbenchRuntimeMintConfirmation {
    const binding = mintApprovalBinding(intent, taskId, operatorId);
    const issued = this.approvals.issue({
      binding,
      approvedByUserId: operatorId,
      nowMs: Date.parse(nowIso),
      ttlMs: 60_000,
    });
    return {
      approvalId: issued.approval.approvalId,
      approvalToken: issued.approval.approvalToken,
      taskId,
      operatorId,
      intentDigest: startIntentDigest(intent),
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
  }

  public mintStart(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    context: CodingRuntimeTrustedContext,
    confirmation: CodingWorkbenchRuntimeMintConfirmation,
    nowIso: string,
  ): CodingRuntimeMintResult {
    if (this.runtimeState.state !== "idle") return { ok: false, reason: "active-run-conflict" };
    if (intent.modelSource !== context.modelProfile.source) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const approvalDigest = this.consumeConfirmation(
      intent,
      context.taskId,
      context.operatorId,
      confirmation,
      nowIso,
    );
    if (approvalDigest === undefined) return { ok: false, reason: "authority-resolution-failed" };
    const envelope = buildRuntimeAuthority(
      intent,
      context,
      nowIso,
      this.newRunId(),
      this.newNonce(),
      approvalDigest,
    );
    if (!validateCodingWorkbenchRuntimeAuthorityEnvelope(envelope).ok) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const registered = this.registry.registerRuntime(envelope, context.deploymentCeiling, nowIso);
    if (!registered.ok) return { ok: false, reason: "authority-resolution-failed" };
    const capability = this.issueCapability(envelope, registered.authorityRef);
    if (!capability.ok) {
      this.registry.revoke(registered.authorityRef);
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const treeBindingId = randomBytes(32).toString("hex");
    this.activeAuthorityRef = registered.authorityRef;
    this.activeTreeBindingId = treeBindingId;
    this.runtimeState = stateForMint(this.runtimeState, envelope, nowIso);
    return {
      ok: true,
      authorityRef: registered.authorityRef,
      runtimeCapability: capability.capability,
      treeBindingId,
    };
  }

  public resolveForDelegation(
    reference: CodingRuntimeAuthorityRef,
    liveFacts: CodingWorkbenchRuntimeAuthorityFacts,
    delegationId: string,
    idempotencyKey: string,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): CodingRuntimeResolution {
    if (
      this.reapPending?.runId === reference.runId &&
      this.activeAuthorityRef?.runId === reference.runId
    ) {
      return { ok: false, reason: "revoked" };
    }
    if (
      this.activeTreeBindingId === undefined ||
      this.runtimeState.state !== "running" ||
      this.runtimeState.runId !== reference.runId
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return this.registry.resolveRuntime(
      reference,
      liveFacts,
      delegationId,
      idempotencyKey,
      usage,
      workspaceRoot,
      deploymentCeiling,
      nowIso,
    );
  }

  public resolveCapabilityForDelegation(
    input: CodingRuntimeCapabilityDelegationInput,
  ): CodingRuntimeResolution {
    const authenticated = this.capabilities.authenticate(
      input.capability,
      Date.parse(input.nowIso),
    );
    if (!authenticated.ok) return capabilityFailure(authenticated.reason);
    const reference = this.activeAuthorityRef;
    if (
      this.runtimeState.state !== "running" ||
      this.activeTreeBindingId === undefined ||
      this.runtimeState.runId !== reference?.runId ||
      !capabilityMatchesDelegation(authenticated.binding, reference, input)
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return this.resolveForDelegation(
      reference,
      input.liveFacts,
      input.delegationId,
      input.idempotencyKey,
      input.usage,
      input.workspaceRoot,
      input.deploymentCeiling,
      input.nowIso,
    );
  }

  public revalidateCapabilityForMutation(
    input: CodingRuntimeCapabilityRecheckInput,
  ): CodingRuntimeResolution {
    const authenticated = this.capabilities.authenticate(
      input.capability,
      Date.parse(input.nowIso),
    );
    if (!authenticated.ok) return capabilityFailure(authenticated.reason);
    const reference = this.activeAuthorityRef;
    if (
      this.runtimeState.state !== "running" ||
      this.activeTreeBindingId === undefined ||
      this.runtimeState.runId !== reference?.runId ||
      !capabilityMatchesDelegation(authenticated.binding, reference, input)
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return this.registry.revalidateRuntime(
      reference,
      input.liveFacts,
      input.workspaceRoot,
      input.deploymentCeiling,
      input.nowIso,
    );
  }

  public revoke(runId: string, nowIso: string): void {
    this.revokeBeforeTerminate(runId);
    this.transition(runId, "taken-over", nowIso);
  }

  /** Synchronously closes every server-owned authority before process termination is signalled. */
  public revokeBeforeTerminate(runId: string): boolean {
    if (this.activeAuthorityRef?.runId !== runId || this.activeTreeBindingId === undefined) {
      return false;
    }
    this.registry.revoke(this.activeAuthorityRef);
    this.capabilities.revokeRun(runId);
    this.approvals.invalidateRun(runId);
    this.reapPending = { runId, treeBindingId: this.activeTreeBindingId };
    return true;
  }

  /** Marks a revoked run unrecoverable until its owning supervisor proves complete tree exit. */
  public markRecoveryRequired(runId: string, nowIso: string): boolean {
    if (this.reapPending?.runId !== runId || this.activeAuthorityRef?.runId !== runId) return false;
    return this.transition(runId, "recovery-required", nowIso, "recovery-required");
  }

  /** Releases the active slot only for the exact run whose process tree was observed reaped. */
  public confirmReaped(runId: string, receipt: RuntimeReapReceipt, nowIso: string): boolean {
    if (
      this.reapPending?.runId !== runId ||
      !verifyRuntimeReapReceipt(receipt, runId, this.reapPending.treeBindingId) ||
      this.activeAuthorityRef?.runId !== runId
    )
      return false;
    if (!this.settleStateAfterObservedReap(runId, nowIso)) return false;
    this.activeAuthorityRef = undefined;
    this.activeTreeBindingId = undefined;
    this.reapPending = undefined;
    return true;
  }

  public complete(runId: string, nowIso: string): void {
    if (this.runtimeState.runId === runId) this.transition(runId, "succeeded", nowIso);
  }

  public state(): CodingWorkbenchRuntimeState {
    return { ...this.runtimeState };
  }

  public transition(
    runId: string | undefined,
    target: CodingWorkbenchRuntimeStateName,
    nowIso: string,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): boolean {
    if (
      !transitionAllowed(
        this.runtimeState,
        target,
        runId,
        this.reapPending?.runId,
        this.activeTreeBindingId !== undefined,
      )
    )
      return false;
    const candidate = transitionedState(this.runtimeState, target, nowIso, failureCode);
    if (!validateCodingWorkbenchRuntimeState(candidate).ok) return false;
    return this.applyTransition(runId, target, candidate);
  }

  private applyTransition(
    runId: string | undefined,
    target: CodingWorkbenchRuntimeStateName,
    candidate: CodingWorkbenchRuntimeState,
  ): boolean {
    const terminal = isTerminalRuntimeState(target);
    if (terminal && runId !== undefined && !this.revokeBeforeTerminate(runId)) return false;
    this.runtimeState = candidate;
    if (terminal && this.reapPending?.runId !== runId) {
      this.activeAuthorityRef = undefined;
    }
    return true;
  }

  private consumeConfirmation(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    taskId: string,
    operatorId: string,
    supplied: CodingWorkbenchRuntimeMintConfirmation,
    nowIso: string,
  ): string | undefined {
    if (!validateCodingWorkbenchRuntimeMintConfirmation(supplied).ok) return undefined;
    if (
      supplied.taskId !== taskId ||
      supplied.operatorId !== operatorId ||
      supplied.intentDigest !== startIntentDigest(intent)
    )
      return undefined;
    return this.approvals.consume({
      approval: { approvalId: supplied.approvalId, approvalToken: supplied.approvalToken },
      binding: mintApprovalBinding(intent, taskId, operatorId),
      nowMs: Date.parse(nowIso),
    })?.approvalDigest;
  }

  private issueCapability(
    envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
    authorityRef: CodingRuntimeAuthorityRef,
  ): ReturnType<RuntimeCapabilityStore["issue"]> {
    const adapterKind = runtimeAdapterKind(envelope.authority.runtimeSource);
    if (adapterKind === undefined) return { ok: false, reason: "invalid" };
    return this.capabilities.issue({
      runId: authorityRef.runId,
      workspaceRootDigest: envelope.binding.workspaceRootDigest,
      envelopeDigest: authorityRef.envelopeDigest,
      adapterKind,
      expiresAtMs: Date.parse(envelope.authority.expiresAt),
    });
  }

  private settleStateAfterObservedReap(runId: string, nowIso: string): boolean {
    if (this.runtimeState.state === "recovery-required") {
      return this.applyObservedReapIdle(nowIso);
    }
    const transitions = REAP_SETTLEMENT_TRANSITIONS[this.runtimeState.state];
    if (transitions === undefined) return false;
    for (const target of transitions) {
      if (!this.transition(runId, target, nowIso)) return false;
    }
    return this.applyObservedReapIdle(nowIso);
  }

  private applyObservedReapIdle(nowIso: string): boolean {
    const candidate = transitionedState(this.runtimeState, "idle", nowIso, undefined);
    if (!validateCodingWorkbenchRuntimeState(candidate).ok) return false;
    this.runtimeState = candidate;
    return true;
  }
}

const REAP_SETTLEMENT_TRANSITIONS: Partial<
  Readonly<Record<CodingWorkbenchRuntimeStateName, readonly CodingWorkbenchRuntimeStateName[]>>
> = {
  starting: ["cancelled"],
  ready: ["stopping", "cancelled"],
  running: ["stopping", "cancelled"],
  "awaiting-approval": ["stopping", "cancelled"],
  stopping: ["cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  "taken-over": [],
};

function capabilityMatchesDelegation(
  binding: RuntimeCapabilityResolutionBinding,
  reference: CodingRuntimeAuthorityRef | undefined,
  input: CodingRuntimeCapabilityRecheckInput,
): reference is CodingRuntimeAuthorityRef {
  return (
    reference?.runId === binding.runId &&
    binding.envelopeDigest === reference.envelopeDigest &&
    binding.workspaceRootDigest === editorAgentWorkspaceRootDigest(input.workspaceRoot) &&
    binding.adapterKind === input.adapterKind
  );
}

type RuntimeCapabilityResolutionBinding = Extract<
  ReturnType<RuntimeCapabilityStore["authenticate"]>,
  { readonly ok: true }
>["binding"];

function reusableTransitionRequiresReapProof(
  current: CodingWorkbenchRuntimeStateName,
  target: CodingWorkbenchRuntimeStateName,
  reapPendingRunId: string | undefined,
): boolean {
  return (
    (target === "idle" || target === "unavailable") &&
    (current === "recovery-required" || reapPendingRunId !== undefined)
  );
}

function transitionAllowed(
  current: CodingWorkbenchRuntimeState,
  target: CodingWorkbenchRuntimeStateName,
  runId: string | undefined,
  reapPendingRunId: string | undefined,
  treeBound: boolean,
): boolean {
  if (reusableTransitionRequiresReapProof(current.state, target, reapPendingRunId)) return false;
  if ((target === "ready" || target === "running") && !treeBound) return false;
  if (!isLegalCodingWorkbenchRuntimeTransition(current.state, target)) return false;
  return current.runId === undefined || current.runId === runId;
}

function isTerminalRuntimeState(state: CodingWorkbenchRuntimeStateName): boolean {
  return ["succeeded", "failed", "cancelled", "taken-over", "recovery-required"].includes(state);
}

function transitionedState(
  previous: CodingWorkbenchRuntimeState,
  target: CodingWorkbenchRuntimeStateName,
  nowIso: string,
  failureCode: CodingWorkbenchRuntimeFailureCode | undefined,
): CodingWorkbenchRuntimeState {
  const clear = target === "idle" || target === "unavailable";
  return {
    ...previous,
    state: target,
    revision: previous.revision + 1,
    updatedAt: nowIso,
    ...(clear
      ? {
          runId: undefined,
          taskId: undefined,
          workspaceId: undefined,
          runtimeSource: undefined,
          modelSource: undefined,
          failureCode: undefined,
        }
      : {}),
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}

function mintApprovalBinding(
  intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
  taskId: string,
  operatorId: string,
): SupervisedCodingApprovalBinding {
  return {
    runId: "coding-runtime-mint",
    requestId: intent.requestId,
    actionKind: "system-mutation",
    scopeDigest: digest(canonicalJson({ taskId, operatorId, startIntent: intent })),
    connectorScopes: [],
  };
}

function startIntentDigest(
  intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
): string {
  return digest(canonicalJson(intent));
}

function stateForMint(
  previous: CodingWorkbenchRuntimeState,
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  nowIso: string,
): CodingWorkbenchRuntimeState {
  return {
    schemaVersion: "1",
    state: "starting",
    revision: previous.revision + 1,
    updatedAt: nowIso,
    runId: envelope.authority.runId,
    taskId: envelope.binding.taskId,
    workspaceId: envelope.binding.workspaceId,
    runtimeSource: envelope.authority.runtimeSource,
    modelSource: envelope.authority.modelProfile.source,
  };
}

function buildRuntimeAuthority(
  intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
  context: CodingRuntimeTrustedContext,
  issuedAt: string,
  runId: string,
  nonce: string,
  approvalDigest: string,
): CodingWorkbenchRuntimeAuthorityEnvelope {
  const rootDigest = digest(context.workspaceRoot);
  const authority: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: "1",
    runId,
    localUser: context.operatorId,
    taskRefs: [context.taskId],
    workspace: { workspaceId: context.workspaceId, rootLabel: "workspace", rootDigest },
    branch: context.branch,
    requestedMode: intent.requestedMode,
    deploymentCeiling: context.deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(
      intent.requestedMode,
      context.deploymentCeiling,
    ),
    runtimeSource: context.runtimeSource,
    actionClasses: context.actionClasses,
    connectorScopes: context.connectorScopes,
    modelProfile: context.modelProfile,
    commandPolicy: context.commandPolicy,
    networkPolicy: context.networkPolicy,
    gates: context.gates,
    budget: context.budget,
    expiresAt: context.expiresAt,
    approvalProofDigest: approvalDigest,
  };
  return {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    authority,
    binding: {
      taskId: context.taskId,
      projectId: context.projectId,
      projectDigest: context.projectDigest,
      workspaceId: context.workspaceId,
      workspaceRootDigest: rootDigest,
      branchRef: context.branchRef,
      branchHeadDigest: context.branchHeadDigest,
    },
    intentDigest: startIntentDigest(intent),
    nonceDigest: digest(nonce),
    issuedAt,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeAdapterKind(
  runtimeSource: CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["runtimeSource"],
): CodingWorkbenchRuntimeAdapterKind | undefined {
  if (runtimeSource === "keiko-sidecar") return "model-gateway-sidecar";
  if (runtimeSource === "codex-cli-adapter") return "codex-cli-adapter";
  return undefined;
}

function capabilityFailure(reason: "invalid" | "expired" | "revoked"): {
  readonly ok: false;
  readonly reason: CodingWorkbenchRuntimeFailureCode;
} {
  if (reason === "expired") return { ok: false, reason: "authority-expired" };
  if (reason === "revoked") return { ok: false, reason: "revoked" };
  return { ok: false, reason: "authority-resolution-failed" };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function codingRuntimeBudgetDigest(budget: CodingWorkbenchBudget): string {
  return digest(canonicalJson(budget));
}

export function codingRuntimeFactDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

export function codingRuntimeAuthorityEnvelopeDigest(
  envelope: CodingWorkbenchAuthorityEnvelope,
): string {
  return editorAgentAuthorityEnvelopeDigest(envelope);
}
