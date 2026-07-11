import { createHash, randomBytes } from "node:crypto";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  isLegalCodingWorkbenchRuntimeTransition,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeMintConfirmation,
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
} from "../editor/agentAuthorityRegistry.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  type SupervisedCodingApprovalBinding,
  type SupervisedCodingApprovalStore,
} from "./supervisedCodingApprovalStore.js";

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
  | { readonly ok: true; readonly authorityRef: CodingRuntimeAuthorityRef }
  | { readonly ok: false; readonly reason: "active-run-conflict" | "authority-resolution-failed" };
export type CodingRuntimeResolution =
  | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode };

export class CodingRuntimeAuthorityService {
  private activeAuthorityRef: CodingRuntimeAuthorityRef | undefined;
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
    this.activeAuthorityRef = registered.authorityRef;
    this.runtimeState = stateForMint(this.runtimeState, envelope, nowIso);
    return { ok: true, authorityRef: registered.authorityRef };
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
    if (this.runtimeState.state !== "running" || this.runtimeState.runId !== reference.runId) {
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

  public revoke(runId: string, nowIso: string): void {
    this.transition(runId, "taken-over", nowIso);
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
    if (Number.isNaN(Date.parse(nowIso))) return false;
    if (!isLegalCodingWorkbenchRuntimeTransition(this.runtimeState.state, target)) return false;
    if (this.runtimeState.runId !== undefined && this.runtimeState.runId !== runId) return false;
    this.runtimeState = transitionedState(this.runtimeState, target, nowIso, failureCode);
    if (isTerminalRuntimeState(target)) {
      if (this.activeAuthorityRef !== undefined) this.registry.revoke(this.activeAuthorityRef);
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
