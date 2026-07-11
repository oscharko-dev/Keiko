import { createHash, randomBytes } from "node:crypto";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
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
  type CodingWorkbenchRuntimeIntent,
  type CodingWorkbenchRuntimeMintConfirmation,
  type CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentAuthorityRegistry,
  editorAgentAuthorityEnvelopeDigest,
} from "../editor/agentAuthorityRegistry.js";

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
  private readonly confirmations = new Map<string, CodingWorkbenchRuntimeMintConfirmation>();

  public constructor(
    private readonly registry: EditorAgentAuthorityRegistry,
    private readonly newRunId: () => string = () => randomBytes(16).toString("hex"),
    private readonly newNonce: () => string = () => randomBytes(32).toString("hex"),
  ) {}

  public confirmStart(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    taskId: string,
    nowIso: string,
  ): CodingWorkbenchRuntimeMintConfirmation {
    const nonce = this.newNonce();
    const confirmation = {
      confirmationId: digest(nonce),
      taskId,
      intentDigest: digest(intent.taskIntent),
      proofDigest: digest(`${nonce}\u0000${taskId}\u0000${intent.requestId}`),
      expiresAt: new Date(Date.parse(nowIso) + 60_000).toISOString(),
    };
    this.confirmations.set(confirmation.confirmationId, confirmation);
    return confirmation;
  }

  public mintStart(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    context: CodingRuntimeTrustedContext,
    confirmation: CodingWorkbenchRuntimeMintConfirmation,
    nowIso: string,
  ): CodingRuntimeMintResult {
    if (this.activeAuthorityRef !== undefined) return { ok: false, reason: "active-run-conflict" };
    if (
      intent.modelSource !== context.modelProfile.source ||
      !this.consumeConfirmation(intent, context.taskId, confirmation, nowIso)
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const envelope = buildRuntimeAuthority(
      intent,
      context,
      nowIso,
      this.newRunId(),
      this.newNonce(),
    );
    if (!validateCodingWorkbenchRuntimeAuthorityEnvelope(envelope).ok) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const registered = this.registry.registerRuntime(envelope, context.deploymentCeiling, nowIso);
    if (!registered.ok) return { ok: false, reason: "authority-resolution-failed" };
    this.activeAuthorityRef = registered.authorityRef;
    return { ok: true, authorityRef: registered.authorityRef };
  }

  public resolveForDelegation(
    reference: CodingRuntimeAuthorityRef,
    liveFacts: CodingWorkbenchRuntimeAuthorityFacts,
    delegationId: string,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): CodingRuntimeResolution {
    return this.registry.resolveRuntime(
      reference,
      liveFacts,
      delegationId,
      workspaceRoot,
      deploymentCeiling,
      nowIso,
    );
  }

  public revoke(runId: string): void {
    if (this.activeAuthorityRef?.runId !== runId) return;
    this.registry.revoke(this.activeAuthorityRef);
    this.activeAuthorityRef = undefined;
  }

  public complete(runId: string): void {
    this.revoke(runId);
  }

  private consumeConfirmation(
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    taskId: string,
    supplied: CodingWorkbenchRuntimeMintConfirmation,
    nowIso: string,
  ): boolean {
    const stored = this.confirmations.get(supplied.confirmationId);
    this.confirmations.delete(supplied.confirmationId);
    return (
      stored !== undefined &&
      canonicalJson(stored) === canonicalJson(supplied) &&
      stored.taskId === taskId &&
      stored.intentDigest === digest(intent.taskIntent) &&
      Date.parse(nowIso) < Date.parse(stored.expiresAt)
    );
  }
}

function buildRuntimeAuthority(
  intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
  context: CodingRuntimeTrustedContext,
  issuedAt: string,
  runId: string,
  nonce: string,
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
    approvalProofDigest: digest(nonce),
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
    intentDigest: digest(intent.taskIntent),
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

export function codingRuntimeAuthorityEnvelopeDigest(
  envelope: CodingWorkbenchAuthorityEnvelope,
): string {
  return editorAgentAuthorityEnvelopeDigest(envelope);
}
