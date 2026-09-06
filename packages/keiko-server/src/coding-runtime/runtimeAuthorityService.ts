import { randomBytes } from "node:crypto";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
// KEIKO-0577: replace the file-local digest()/canonicalJson() with the shared, architecturally
// correct helpers from @oscharko-dev/keiko-security so a second silently-diverging
// implementation of a security-relevant hashing primitive cannot drift further.
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchBranchConstraints,
  CodingWorkbenchBudget,
  CodingWorkbenchCommandPolicy,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchGate,
  CodingWorkbenchIssueBinding,
  CodingWorkbenchMode,
  CodingWorkbenchModelProfile,
  CodingWorkbenchNetworkPolicy,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeExecutionBinding,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeDelegationUsage,
  CodingWorkbenchRuntimeIntent,
  CodingWorkbenchRuntimeMintConfirmation,
  CodingWorkbenchRuntimeState,
  CodingWorkbenchRuntimeStateName,
  CodingWorkbenchRuntimeSource,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  isLegalCodingWorkbenchRuntimeTransition,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeMintConfirmation,
  validateCodingWorkbenchRuntimeState,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  codingWorkbenchPolicyEffectFor,
  isCodingWorkbenchModeWidening,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  EditorAgentAuthorityRegistry,
  editorAgentAuthorityEnvelopeDigest,
  editorAgentWorkspaceRootDigest,
  type EditorAgentRuntimeDelegationRequest,
} from "../editor/agentAuthorityRegistry.js";
import type {
  ActiveGitDeliveryDescriptionAuthority,
  ActiveGitDeliveryRunAuthority,
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
  GitDeliveryRunAuthorityPort,
} from "../gitDelivery/runBoundAuthority.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  type SupervisedCodingApprovalBindingOnce,
  type SupervisedCodingApprovalStore,
} from "./supervisedCodingApprovalStore.js";
import {
  createInMemoryRuntimeCapabilityStore,
  type RuntimeCapabilityAudience,
  type RuntimeCapabilityStore,
} from "./runtimeCapabilityStore.js";
import { verifyRuntimeReapReceipt, type RuntimeReapReceipt } from "./runtimeProcessSupervisor.js";
import { projectRuntimeAuthorityValue } from "./runtimeAuthorityProjection.js";

// Child tool mutations may only ever run against a RUNNING run; operator admissions (follow-up
// dispatch, abort, question answers) legitimately reach a paused run — sticky pause holds the
// runtime, not the human.
const RUNNING_ONLY: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set(["running"]);
const OPERATOR_ADMISSIBLE_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "running",
  "paused",
]);
// #3390: the real race is not in the orchestrator's own local dispatch ordering -- production
// wiring (productionCodingRuntimePorts.ts's startProductionRuntime) already awaits the managed
// runtime's start() to completion, including both its "ready" and "running" authority
// transitions, before the orchestrator ever calls startInitialTurn. The actual window is earlier:
// mint() (activateMintedRuntime / stateForMint) sets runtimeState to "starting" -- with the
// authority ref, capability and tree binding already issued -- and that "starting" state
// persists for the full duration of the managed runtime's own start() call. If the underlying
// process becomes reachable and issues its own first model call before that start() promise
// settles, the reservation lands while runtimeState.state is still "starting", not "ready" or
// "running", and gets refused as an authority-resolution failure even though every other
// admission fact (audience, runId, envelopeDigest) already matches. "starting" is a legal
// interior state (LEGAL_TRANSITIONS.idle -> "starting" -> "ready" -> ...) and not a state a
// reservation could be replayed into from anywhere else, so it is safe to admit alongside
// "ready" and "running". Every other reservePromptTokens clause (audience, runId, envelopeDigest
// match, paused-state refusal) stays exactly as strict; only the running-only state gate widens.
const PROMPT_RESERVATION_ADMISSIBLE_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
]);

type RuntimeAuthorityMintFailureStage =
  | "intent-binding"
  | "approval-digest"
  | "confirmation-consumption"
  | "envelope-validation"
  | "authority-registration"
  | "capability-issuance";

type RuntimeAuthorityMintFailureReason =
  | "model-source-mismatch"
  | "approval-digest-invalid"
  | "confirmation-refused"
  | "envelope-invalid"
  | "registration-refused"
  | "capability-issuance-refused";

const MINT_FAILURE_ERROR_KIND: Readonly<Record<RuntimeAuthorityMintFailureReason, string>> = {
  "model-source-mismatch": "CodingRuntimeAuthorityBindingFailure",
  "approval-digest-invalid": "CodingRuntimeAuthorityValidationFailure",
  "confirmation-refused": "CodingRuntimeAuthorityConfirmationFailure",
  "envelope-invalid": "CodingRuntimeAuthorityValidationFailure",
  "registration-refused": "CodingRuntimeAuthorityRegistrationFailure",
  "capability-issuance-refused": "CodingRuntimeAuthorityCapabilityFailure",
};

function deliveryScopeGranted(mode: CodingWorkbenchMode): boolean {
  return codingWorkbenchPolicyEffectFor(mode, "delivery", "medium") !== "denied";
}

// ADR-0138 D2: workspace-contained effects (commands included) are approval-required, never
// denied outright, in Ask for approval. Deriving from the shared matrix -- the same pattern
// deliveryScopeGranted already uses -- instead of hardcoding a mode exclusion keeps this mint
// from silently diverging from the one evaluator every other workspace-contained action reads
// (codingToolAuthorityPort.ts's workspaceMediumRiskAllowed).
function commandExecutionGranted(mode: CodingWorkbenchMode): boolean {
  return codingWorkbenchPolicyEffectFor(mode, "workspace-contained", "medium") !== "denied";
}

export const DELIVERY_CONNECTOR_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "source-control.read",
  "source-control.write",
];

export function codingRuntimeActionClassesForMode(
  mode: CodingWorkbenchMode,
  researchEgressEnabled: boolean | undefined,
): readonly CodingWorkbenchActionClass[] {
  const actionClasses: CodingWorkbenchActionClass[] = [
    "workspace-read",
    "workspace-write",
    "verification",
  ];
  if (commandExecutionGranted(mode)) actionClasses.push("command-execution");
  if (deliveryScopeGranted(mode)) actionClasses.push("delivery-substrate", "connector-access");
  if (researchEgressEnabled === true || mode === "autonomous-delivery") {
    actionClasses.push("network-egress");
  }
  return actionClasses;
}

export function codingRuntimeConnectorScopesForMode(
  mode: CodingWorkbenchMode,
): readonly CodingWorkbenchConnectorScope[] {
  return deliveryScopeGranted(mode) ? DELIVERY_CONNECTOR_SCOPES : [];
}

export function codingRuntimeNetworkPolicyForMode(
  mode: CodingWorkbenchMode,
  researchEgressEnabled: boolean | undefined,
): CodingWorkbenchNetworkPolicy {
  // The connector scopes a mode carries follow deliveryScopeGranted (see
  // codingRuntimeConnectorScopesForMode), but the envelope contract
  // (validateNetworkPolicyConnectorScopesConsistency / validateNetworkPolicyActionClassConsistency)
  // requires networkPolicy.connectorScopes to be empty while the policy is deny-all. Below
  // autonomous-delivery without research egress the mint therefore stays deny-all with no scopes;
  // an approved connector-scoped request (git ci, "connector") is redeemed through the approval
  // proof, never through a scope smuggled onto a deny-all policy.
  const connectorScopes = codingRuntimeConnectorScopesForMode(mode);
  if (mode === "autonomous-delivery") {
    return { mode: "connector-scoped-egress", allowLoopback: false, connectorScopes };
  }
  return researchEgressEnabled === true
    ? { mode: "governed-egress", allowLoopback: false, connectorScopes }
    : { mode: "deny-all", allowLoopback: false, connectorScopes: [] };
}

export function codingRuntimeCommandPolicyForMode(
  mode: CodingWorkbenchMode,
): CodingWorkbenchCommandPolicy {
  return {
    mode: commandExecutionGranted(mode) ? "governed" : "deny",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 120_000,
    requirePerCommandApproval: mode !== "autonomous-delivery",
  };
}

function narrowedCommandPolicy(
  policy: CodingWorkbenchCommandPolicy,
  mode: CodingWorkbenchMode,
): CodingWorkbenchCommandPolicy {
  const ceiling = codingRuntimeCommandPolicyForMode(mode);
  return {
    ...policy,
    mode: policy.mode === "deny" || ceiling.mode === "deny" ? "deny" : policy.mode,
    requirePerCommandApproval:
      policy.requirePerCommandApproval || ceiling.requirePerCommandApproval,
  };
}

function narrowAuthorityToMode(
  authority: CodingWorkbenchAuthorityEnvelope,
  mode: CodingWorkbenchMode,
): CodingWorkbenchAuthorityEnvelope {
  if (authority.effectiveMode === mode) return authority;
  const retainGovernedResearch = authority.networkPolicy.mode === "governed-egress";
  const allowedActionClasses = codingRuntimeActionClassesForMode(mode, retainGovernedResearch);
  const allowedConnectorScopes = codingRuntimeConnectorScopesForMode(mode);
  return {
    ...authority,
    effectiveMode: mode,
    actionClasses: authority.actionClasses.filter((value) => allowedActionClasses.includes(value)),
    connectorScopes: authority.connectorScopes.filter((value) =>
      allowedConnectorScopes.includes(value),
    ),
    commandPolicy: narrowedCommandPolicy(authority.commandPolicy, mode),
    networkPolicy: codingRuntimeNetworkPolicyForMode(mode, retainGovernedResearch),
  };
}

export interface CodingRuntimeTrustedContext {
  /** Captured before start confirmation; absent legacy contexts cannot execute verified commits. */
  readonly repositoryIdentity?: {
    readonly kind: "github-origin" | "local";
    readonly digest: string;
  };
  /** Server-resolved launch identity; absent legacy contexts cannot adopt a committed head. */
  readonly runId?: string;
  readonly operatorId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly branchRef: string;
  readonly branchHeadDigest: string;
  readonly issueBinding?: CodingWorkbenchIssueBinding | undefined;
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
      /** Server-private audience-separated Model Gateway secret. */
      readonly modelGatewayCapability: string;
      /** Server-private audience-separated governed-tool secret. */
      readonly toolFacadeCapability: string;
      readonly effectiveMode: CodingWorkbenchMode;
      /** Server-private per-launch supervisor binding; never project to browser or evidence. */
      readonly treeBindingId: string;
    }
  | { readonly ok: false; readonly reason: "active-run-conflict" | "authority-resolution-failed" };
export type CodingRuntimeResolution =
  | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode };

export type CodingRuntimeAuthorityBoundaryResult =
  | { readonly ok: true; readonly effectiveMode: CodingWorkbenchMode }
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

// ─── Description authority (#3399, epic #3384 correction 4) ──────────────────────────────────────
//
// Admits exactly two effects outside a running Code task: model egress of snapshot content through
// the Model Gateway (description generation) and the "pull-request" body-only description apply. It
// is minted server-side for one immutable scope — never for "every PR" or "every repository" — and
// carries no workspace-write or command action classes: it exists only to let a Chat turn or a
// post-terminal Workbench job re-derive admission for these two narrow effects after the run that
// produced the snapshot has ended (or never existed), never to reuse a terminated run's own
// capabilities (runtimeAuthorityService.ts's `revokeBeforeTerminate` already clears those). The
// scope/authority shapes live in runBoundAuthority.ts (the module that already owns every other
// Git-delivery authority shape and consults this one at admission) so this file stays a producer
// of that owning module's types, exactly like `ActiveGitDeliveryRunAuthority` above.
interface StoredDescriptionAuthority {
  readonly scope: GitDeliveryDescriptionAuthorityScope;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly expiresAtMs: number;
}
export interface MintGitDeliveryDescriptionAuthorityInput {
  readonly scope: GitDeliveryDescriptionAuthorityScope;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
  readonly ttlMs?: number;
  readonly correlationId?: string;
}

const DEFAULT_DESCRIPTION_AUTHORITY_TTL_MS = 10 * 60 * 1000;
const MAX_DESCRIPTION_AUTHORITIES = 256;

function descriptionAuthorityLifetime(input: MintGitDeliveryDescriptionAuthorityInput): {
  readonly nowMs: number;
  readonly expiresAtMs: number;
} {
  const nowMs = Date.parse(input.nowIso);
  const ttlMs = input.ttlMs ?? DEFAULT_DESCRIPTION_AUTHORITY_TTL_MS;
  const expiresAtMs = nowMs + ttlMs;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > DEFAULT_DESCRIPTION_AUTHORITY_TTL_MS ||
    !Number.isFinite(new Date(expiresAtMs).getTime())
  ) {
    throw new TypeError("Invalid description authority lifetime.");
  }
  return { nowMs, expiresAtMs };
}

export function descriptionAuthorityScopeDigest(
  scope: GitDeliveryDescriptionAuthorityScope,
): string {
  return sha256Hex(canonicalise(scope));
}

export class CodingRuntimeAuthorityService {
  private activeAuthorityRef: CodingRuntimeAuthorityRef | undefined;
  private activeGitDeliveryAuthority: ActiveGitDeliveryRunAuthority | undefined;
  private readonly descriptionAuthorities = new Map<string, StoredDescriptionAuthority>();
  private activeTreeBindingId: string | undefined;
  private activeEffectiveMode: CodingWorkbenchMode | undefined;
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
    private readonly activityLog?: ServerLogSink,
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
    return this.mintStartForRun(this.newRunId(), intent, context, confirmation, nowIso);
  }

  /** Server-only bridge aligning an orchestrator-owned run id with minted authority. */
  public mintStartForRun(
    runId: string,
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    context: CodingRuntimeTrustedContext,
    confirmation: CodingWorkbenchRuntimeMintConfirmation,
    nowIso: string,
  ): CodingRuntimeMintResult {
    if (this.runtimeState.state !== "idle") return { ok: false, reason: "active-run-conflict" };
    if (intent.modelSource !== context.modelProfile.source) {
      return this.refuseMint(runId, "intent-binding", "model-source-mismatch");
    }
    const approvalDigest = this.consumeConfirmation(
      intent,
      context.taskId,
      context.operatorId,
      confirmation,
      nowIso,
    );
    if (approvalDigest === undefined) {
      return this.refuseMint(runId, "confirmation-consumption", "confirmation-refused");
    }
    return this.mintConfirmedStartForRun(runId, intent, context, approvalDigest, nowIso);
  }

  /** Accepts only a proof already consumed by the server-private central confirmation adapter. */
  public mintConfirmedStartForRun(
    runId: string,
    intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
    context: CodingRuntimeTrustedContext,
    approvalDigest: string,
    nowIso: string,
  ): CodingRuntimeMintResult {
    if (this.runtimeState.state !== "idle") return { ok: false, reason: "active-run-conflict" };
    if (intent.modelSource !== context.modelProfile.source) {
      return this.refuseMint(runId, "intent-binding", "model-source-mismatch");
    }
    if (!/^[a-f0-9]{64}$/u.test(approvalDigest)) {
      return this.refuseMint(runId, "approval-digest", "approval-digest-invalid");
    }
    const envelope = buildRuntimeAuthority(
      intent,
      context,
      nowIso,
      runId,
      this.newNonce(),
      approvalDigest,
    );
    if (!validateCodingWorkbenchRuntimeAuthorityEnvelope(envelope).ok) {
      return this.refuseMint(runId, "envelope-validation", "envelope-invalid");
    }
    const registered = this.registry.registerRuntime(
      envelope,
      context.deploymentCeiling,
      nowIso,
      context.issueBinding?.bindingDigest,
    );
    if (!registered.ok) return this.refuseRegistration(runId);
    const capabilities = this.issueCapabilities(
      envelope,
      registered.authorityRef,
      context.modelProfile,
    );
    if (capabilities === undefined) {
      return this.refuseMint(runId, "capability-issuance", "capability-issuance-refused");
    }
    return this.activateMintedRuntime({
      runId,
      envelope,
      authorityRef: registered.authorityRef,
      capabilities,
      context,
      nowIso,
    });
  }

  private refuseMint(
    runId: string,
    stage: RuntimeAuthorityMintFailureStage,
    reason: RuntimeAuthorityMintFailureReason,
  ): CodingRuntimeMintResult {
    (this.activityLog ?? processServerLogSink()).write({
      category: "security",
      op: "coding-runtime.authority.mint-failed",
      correlationId: runId,
      level: "warn",
      errorKind: MINT_FAILURE_ERROR_KIND[reason],
      extra: { runId, stage, reason },
    });
    return { ok: false, reason: "authority-resolution-failed" };
  }

  private refuseRegistration(runId: string): CodingRuntimeMintResult {
    return this.refuseMint(runId, "authority-registration", "registration-refused");
  }

  private activateMintedRuntime(input: {
    readonly runId: string;
    readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope;
    readonly authorityRef: CodingRuntimeAuthorityRef;
    readonly capabilities: {
      readonly modelGatewayCapability: string;
      readonly toolFacadeCapability: string;
    };
    readonly context: CodingRuntimeTrustedContext;
    readonly nowIso: string;
  }): CodingRuntimeMintResult {
    const { runId, envelope, authorityRef, capabilities, context, nowIso } = input;
    const treeBindingId = randomBytes(32).toString("hex");
    this.activeAuthorityRef = authorityRef;
    this.activeGitDeliveryAuthority = {
      runId,
      envelopeDigest: authorityRef.envelopeDigest,
      // Git-delivery's `projectId` is the canonical workspace root its route resolves and then
      // compares with `workspaceRoot` at admission. The runtime context's `projectId` is the
      // repository identity used by runtime-fact projection, so projecting it here made every
      // managed-worktree delivery request fail `workspace-out-of-envelope` even when the exact
      // active root matched. Preserve both meanings at their owning boundaries.
      projectId: context.workspaceRoot,
      workspaceRoot: context.workspaceRoot,
      branch: context.branch,
      authority: envelope.authority,
    };
    this.activeTreeBindingId = treeBindingId;
    this.activeEffectiveMode = envelope.authority.effectiveMode;
    this.runtimeState = stateForMint(this.runtimeState, envelope, nowIso);
    (this.activityLog ?? processServerLogSink()).write({
      category: "security",
      op: "coding-runtime.authority.minted",
      correlationId: runId,
      level: "info",
      extra: {
        runId,
        effectiveMode: envelope.authority.effectiveMode,
        actionClasses: envelope.authority.actionClasses,
        connectorScopes: envelope.authority.connectorScopes,
        networkPolicyMode: envelope.authority.networkPolicy.mode,
        maxPromptTokens: envelope.authority.budget.maxPromptTokens,
      },
    });
    return {
      ok: true,
      authorityRef,
      modelGatewayCapability: capabilities.modelGatewayCapability,
      toolFacadeCapability: capabilities.toolFacadeCapability,
      effectiveMode: envelope.authority.effectiveMode,
      treeBindingId,
    };
  }

  public authenticateCapability(
    capability: string,
    audience: RuntimeCapabilityAudience,
    nowMs = Date.now(),
  ): ReturnType<RuntimeCapabilityStore["authenticate"]> {
    const authenticated = this.capabilities.authenticate(capability, nowMs);
    if (!authenticated.ok || authenticated.binding.audience !== audience) {
      return { ok: false, reason: authenticated.ok ? "invalid" : authenticated.reason };
    }
    return authenticated;
  }

  public effectiveMode(): CodingWorkbenchMode | undefined {
    return this.activeEffectiveMode;
  }

  /**
   * Server-private projection used by Git delivery only. It deliberately exposes the live,
   * accepted run instead of a deployment-wide ceiling or browser-provided authority object.
   */
  public gitDeliveryAuthorityPort(): GitDeliveryRunAuthorityPort {
    return {
      current: (nowIso): ActiveGitDeliveryRunAuthority | undefined =>
        this.currentGitDeliveryAuthority(nowIso),
    };
  }

  // B1-3 (epic #3384): a run's git-delivery authority is minted before any pull request
  // necessarily exists, so it carries no PR identity at mint time. Once the run's PR is created
  // and published, the caller that learns of it (Git delivery's PR-creation path) binds that
  // identity here so `current()`'s projection — and every admission that reads it, e.g.
  // prDescriptionRoutes.ts's `admitDescriptionModelEgress` — can compare a request's
  // ownerAndRepo/prNumber against the run's *actual* PR scope instead of admitting any PR in the
  // same project. Requires the exact runId of the still-active run so a stale or mismatched
  // caller cannot bind a PR onto a different (or already-ended) run.
  public bindPublishedPullRequest(
    runId: string,
    pullRequest: { readonly ownerAndRepo: string; readonly prNumber: number },
  ): boolean {
    if (this.activeGitDeliveryAuthority?.runId !== runId) return false;
    this.activeGitDeliveryAuthority = { ...this.activeGitDeliveryAuthority, pullRequest };
    return true;
  }

  // A same-scope remint can only narrow a live grant's mode and expiry. An expired grant may
  // be replaced only by a newly admitted caller; it cannot become live through a read.
  public mintGitDeliveryDescriptionAuthority(
    input: MintGitDeliveryDescriptionAuthorityInput,
  ): ActiveGitDeliveryDescriptionAuthority {
    let lifetime: ReturnType<typeof descriptionAuthorityLifetime>;
    try {
      lifetime = descriptionAuthorityLifetime(input);
    } catch (error) {
      this.logDescriptionAuthority(input, "rejected", {}, error);
      throw error;
    }
    const digest = descriptionAuthorityScopeDigest(input.scope);
    const prior = this.descriptionAuthorities.get(digest);
    const live = prior !== undefined && prior.expiresAtMs > lifetime.nowMs ? prior : undefined;
    const requested = resolveEffectiveCodingWorkbenchMode(
      input.requestedMode,
      input.deploymentCeiling,
    );
    const effectiveMode = resolveEffectiveCodingWorkbenchMode(
      requested,
      live?.effectiveMode ?? requested,
    );
    const expiresAtMs = Math.min(lifetime.expiresAtMs, live?.expiresAtMs ?? lifetime.expiresAtMs);
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.descriptionAuthorities.set(digest, { scope: input.scope, effectiveMode, expiresAtMs });
    const evictedCount = this.pruneDescriptionAuthorities(lifetime.nowMs);
    this.logDescriptionAuthority(input, live === undefined ? "minted" : "narrowed", {
      effectiveMode,
      expiresAtMs,
      evictedCount,
      retainedCount: this.descriptionAuthorities.size,
    });
    return { scope: input.scope, effectiveMode, expiresAt };
  }

  private logDescriptionAuthority(
    input: MintGitDeliveryDescriptionAuthorityInput,
    event: "minted" | "narrowed" | "rejected",
    extra: Readonly<Record<string, string | number>>,
    error?: unknown,
  ): void {
    (this.activityLog ?? processServerLogSink()).write({
      category: "security",
      op: "coding-runtime.description-authority",
      correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID,
      level: event === "rejected" ? "warn" : "info",
      ...(error === undefined ? {} : { errorKind: errorKindOf(error) }),
      extra: {
        event,
        scopeDigest: descriptionAuthorityScopeDigest(input.scope),
        requestedMode: input.requestedMode,
        deploymentCeiling: input.deploymentCeiling,
        ...extra,
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    });
  }

  /**
   * Server-private projection consumed only by `runBoundAuthority.ts`'s description-authority
   * admission for the two operations it names. Revalidates on every read: an exact scope match
   * (the caller's freshly re-derived snapshot/base/head digests, not a cached identity) that has
   * not expired. A changed scope — a stale re-check, a different PR, a moved base/head — simply
   * finds no record, which is the fail-closed default: this port never widens what it returns.
   */
  public gitDeliveryDescriptionAuthorityPort(): GitDeliveryDescriptionAuthorityPort {
    return {
      current: (scope, nowIso): ActiveGitDeliveryDescriptionAuthority | undefined =>
        this.currentGitDeliveryDescriptionAuthority(scope, nowIso),
      expired: (scope, nowIso): boolean =>
        this.gitDeliveryDescriptionAuthorityExpired(scope, nowIso),
    };
  }

  /** Explicit revocation for a scope change or stale re-check the caller has already detected. */
  public revokeGitDeliveryDescriptionAuthority(scope: GitDeliveryDescriptionAuthorityScope): void {
    this.descriptionAuthorities.delete(descriptionAuthorityScopeDigest(scope));
  }

  private currentGitDeliveryDescriptionAuthority(
    scope: GitDeliveryDescriptionAuthorityScope,
    nowIso: string,
  ): ActiveGitDeliveryDescriptionAuthority | undefined {
    const nowMs = Date.parse(nowIso);
    const stored = this.descriptionAuthorities.get(descriptionAuthorityScopeDigest(scope));
    if (stored === undefined || Number.isNaN(nowMs) || stored.expiresAtMs <= nowMs) {
      return undefined;
    }
    return {
      scope: stored.scope,
      effectiveMode: stored.effectiveMode,
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
    };
  }

  // #3400/#3401 final-audit F1: consulted only by `authorizeGitDeliveryModelEgress` once `current`
  // has already returned `undefined` for this exact scope. Distinguishes a record that WAS minted
  // for this scope but has since passed its `expiresAt` (`true`) from no record ever having
  // existed for it (`false`) — the same map lookup `currentGitDeliveryDescriptionAuthority` already
  // performs, read for its expiry state instead of being discarded on it.
  private gitDeliveryDescriptionAuthorityExpired(
    scope: GitDeliveryDescriptionAuthorityScope,
    nowIso: string,
  ): boolean {
    const nowMs = Date.parse(nowIso);
    const stored = this.descriptionAuthorities.get(descriptionAuthorityScopeDigest(scope));
    return stored !== undefined && !Number.isNaN(nowMs) && stored.expiresAtMs <= nowMs;
  }

  // Retain expired-vs-absent evidence until the bounded map needs space. At capacity, evict
  // expired records before still-live grants, and enforce the cap after inserting the new scope.
  private pruneDescriptionAuthorities(nowMs: number): number {
    let evictedCount = 0;
    while (this.descriptionAuthorities.size > MAX_DESCRIPTION_AUTHORITIES) {
      const expired = [...this.descriptionAuthorities].find(
        ([, value]) => value.expiresAtMs <= nowMs,
      );
      const oldest = expired?.[0] ?? this.descriptionAuthorities.keys().next().value;
      if (oldest === undefined) break;
      this.descriptionAuthorities.delete(oldest);
      evictedCount += 1;
    }
    return evictedCount;
  }

  /** Authenticates and atomically reserves estimated prompt tokens before provider dispatch. */
  public reservePromptTokens(
    capability: string,
    promptTokens: number,
    nowMs = Date.now(),
  ):
    | { readonly ok: true; readonly runId: string }
    | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode } {
    const authenticated = this.capabilities.authenticate(capability, nowMs);
    const reference = this.activeAuthorityRef;
    if (!authenticated.ok) return capabilityFailure(authenticated.reason);
    if (
      authenticated.binding.audience !== "model-gateway" ||
      reference === undefined ||
      !PROMPT_RESERVATION_ADMISSIBLE_STATES.has(this.runtimeState.state) ||
      this.runtimeState.runId !== authenticated.binding.runId ||
      reference.runId !== authenticated.binding.runId ||
      reference.envelopeDigest !== authenticated.binding.envelopeDigest
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const reserved = this.registry.reserveRuntimePromptTokens(
      reference,
      promptTokens,
      new Date(nowMs).toISOString(),
    );
    return reserved.ok ? { ok: true, runId: reference.runId } : reserved;
  }

  /**
   * Authenticates and reconciles a prompt-token reservation against the provider's real reported
   * usage for the same call, mirroring {@link reservePromptTokens}'s authentication and binding
   * checks so a settlement can only ever land against the same run whose capability reserved it.
   */
  public settlePromptTokens(
    capability: string,
    reservedPromptTokens: number,
    actualPromptTokens: number,
    nowMs = Date.now(),
  ):
    | { readonly ok: true; readonly runId: string }
    | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode } {
    const authenticated = this.capabilities.authenticate(capability, nowMs);
    const reference = this.activeAuthorityRef;
    if (!authenticated.ok) return capabilityFailure(authenticated.reason);
    if (
      authenticated.binding.audience !== "model-gateway" ||
      reference === undefined ||
      !PROMPT_RESERVATION_ADMISSIBLE_STATES.has(this.runtimeState.state) ||
      this.runtimeState.runId !== authenticated.binding.runId ||
      reference.runId !== authenticated.binding.runId ||
      reference.envelopeDigest !== authenticated.binding.envelopeDigest
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const settled = this.registry.settleRuntimePromptTokens(
      reference,
      reservedPromptTokens,
      actualPromptTokens,
      new Date(nowMs).toISOString(),
    );
    return settled.ok ? { ok: true, runId: reference.runId } : settled;
  }

  public pause(runId: string, nowIso: string): CodingRuntimeAuthorityBoundaryResult {
    const reference = this.activeAuthorityRef;
    if (
      this.runtimeState.runId !== runId ||
      reference === undefined ||
      this.activeEffectiveMode === undefined
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const revalidated = this.registry.revalidateRetainedRuntime(reference, nowIso);
    if (!revalidated.ok) return revalidated;
    if (this.runtimeState.state === "paused") {
      return { ok: true, effectiveMode: this.activeEffectiveMode };
    }
    if (this.runtimeState.state !== "running" || !this.transition(runId, "paused", nowIso)) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return { ok: true, effectiveMode: this.activeEffectiveMode };
  }

  public resume(
    runId: string,
    requestedMode: CodingWorkbenchMode,
    nowIso: string,
  ): CodingRuntimeAuthorityBoundaryResult {
    const reference = this.activeAuthorityRef;
    const currentMode = this.activeEffectiveMode;
    if (this.runtimeState.runId !== runId || reference === undefined || currentMode === undefined) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    if (isCodingWorkbenchModeWidening(currentMode, requestedMode)) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const revalidated = this.registry.revalidateRetainedRuntime(reference, nowIso);
    if (!revalidated.ok) return revalidated;
    if (this.runtimeState.state === "running") {
      return requestedMode === currentMode
        ? { ok: true, effectiveMode: currentMode }
        : { ok: false, reason: "authority-resolution-failed" };
    }
    if (this.runtimeState.state !== "paused" || !this.transition(runId, "running", nowIso)) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    this.activeEffectiveMode = requestedMode;
    return { ok: true, effectiveMode: requestedMode };
  }

  public resolveForDelegation(
    reference: CodingRuntimeAuthorityRef,
    request: EditorAgentRuntimeDelegationRequest,
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
    return this.restrictResolution(this.registry.resolveRuntime(reference, request));
  }

  public resolveCapabilityForDelegation(
    input: CodingRuntimeCapabilityDelegationInput,
  ): CodingRuntimeResolution {
    const authenticated = this.capabilities.authenticate(
      input.capability,
      Date.parse(input.nowIso),
    );
    if (!authenticated.ok || authenticated.binding.audience !== "tool-facade") {
      return authenticated.ok
        ? capabilityFailure("invalid")
        : capabilityFailure(authenticated.reason);
    }
    const reference = this.activeAuthorityRef;
    if (
      this.runtimeState.state !== "running" ||
      this.activeTreeBindingId === undefined ||
      this.runtimeState.runId !== reference?.runId ||
      !capabilityMatchesDelegation(authenticated.binding, reference, input)
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return this.resolveForDelegation(reference, {
      liveFacts: input.liveFacts,
      delegationId: input.delegationId,
      idempotencyKey: input.idempotencyKey,
      usage: input.usage,
      workspaceRoot: input.workspaceRoot,
      deploymentCeiling: input.deploymentCeiling,
      nowIso: input.nowIso,
    });
  }

  public revalidateCapabilityForMutation(
    input: CodingRuntimeCapabilityRecheckInput,
  ): CodingRuntimeResolution {
    // A paused run must never execute a child mutation — running is the only admissible state
    // for the tool path.
    return this.revalidateCapabilityForStates(input, RUNNING_ONLY);
  }

  /**
   * The operator-admission variant: dispatching a follow-up task turn, aborting, and answering
   * questions are HUMAN operations the coordinator deliberately admits while the run is paused
   * (sticky pause, no auto-resume). They carry the same capability, envelope, and live-facts
   * revalidation as the tool path — only the admissible runtime states differ. Holding these to
   * running-only silently 403'd every paused follow-up after #2644 unified the authority path.
   */
  public revalidateCapabilityForOperatorAdmission(
    input: CodingRuntimeCapabilityRecheckInput,
  ): CodingRuntimeResolution {
    return this.revalidateCapabilityForStates(input, OPERATOR_ADMISSIBLE_STATES);
  }

  private revalidateCapabilityForStates(
    input: CodingRuntimeCapabilityRecheckInput,
    admissibleStates: ReadonlySet<CodingWorkbenchRuntimeStateName>,
  ): CodingRuntimeResolution {
    const authenticated = this.capabilities.authenticate(
      input.capability,
      Date.parse(input.nowIso),
    );
    if (!authenticated.ok || authenticated.binding.audience !== "tool-facade") {
      return authenticated.ok
        ? capabilityFailure("invalid")
        : capabilityFailure(authenticated.reason);
    }
    const reference = this.activeAuthorityRef;
    if (
      !admissibleStates.has(this.runtimeState.state) ||
      this.activeTreeBindingId === undefined ||
      this.runtimeState.runId !== reference?.runId ||
      !capabilityMatchesDelegation(authenticated.binding, reference, input)
    ) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    return this.restrictResolution(
      this.registry.revalidateRuntime(
        reference,
        input.liveFacts,
        input.workspaceRoot,
        input.deploymentCeiling,
        input.nowIso,
      ),
    );
  }

  // KEIKO-0737: the combined revoke(runId, nowIso) was only ever exercised by its own unit test
  // (production called revokeBeforeTerminate directly), and because "taken-over" is a terminal
  // state, transition()'s applyTransition already calls revokeBeforeTerminate a second time,
  // masking a latent double-invocation defect that no production path exercised. The method has
  // been removed; the one caller now calls the two primitives directly and inline.

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
    this.activeGitDeliveryAuthority = undefined;
    this.activeTreeBindingId = undefined;
    this.activeEffectiveMode = undefined;
    this.reapPending = undefined;
    return true;
  }

  public complete(runId: string, nowIso: string): void {
    if (this.runtimeState.runId === runId) this.transition(runId, "succeeded", nowIso);
  }

  /** Releases authority only when launch failed before a supervised process tree existed. */
  public abandonUnlaunched(runId: string, nowIso: string): boolean {
    if (
      this.runtimeState.state !== "starting" ||
      this.runtimeState.runId !== runId ||
      this.activeAuthorityRef?.runId !== runId ||
      this.reapPending !== undefined
    ) {
      return false;
    }
    this.registry.revoke(this.activeAuthorityRef);
    this.capabilities.revokeRun(runId);
    this.approvals.invalidateRun(runId);
    this.activeAuthorityRef = undefined;
    this.activeGitDeliveryAuthority = undefined;
    this.activeTreeBindingId = undefined;
    this.activeEffectiveMode = undefined;
    this.runtimeState = {
      schemaVersion: "1",
      state: "idle",
      revision: this.runtimeState.revision + 1,
      updatedAt: nowIso,
    };
    return true;
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

  private restrictResolution(resolution: CodingRuntimeResolution): CodingRuntimeResolution {
    if (!resolution.ok || this.activeEffectiveMode === undefined) return resolution;
    return {
      ok: true,
      envelope: {
        ...resolution.envelope,
        authority: narrowAuthorityToMode(resolution.envelope.authority, this.activeEffectiveMode),
      },
    };
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
      this.activeGitDeliveryAuthority = undefined;
    }
    return true;
  }

  private currentGitDeliveryAuthority(nowIso: string): ActiveGitDeliveryRunAuthority | undefined {
    const active = this.activeGitDeliveryAuthority;
    const reference = this.activeAuthorityRef;
    if (
      active === undefined ||
      reference === undefined ||
      this.activeEffectiveMode === undefined ||
      this.reapPending !== undefined ||
      this.runtimeState.state !== "running" ||
      this.runtimeState.runId !== active.runId ||
      reference.runId !== active.runId ||
      reference.envelopeDigest !== active.envelopeDigest
    ) {
      return undefined;
    }
    if (!this.registry.revalidateRetainedRuntime(reference, nowIso).ok) return undefined;
    return {
      ...active,
      authority: narrowAuthorityToMode(active.authority, this.activeEffectiveMode),
    };
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
    audience: RuntimeCapabilityAudience,
    modelProfile: CodingWorkbenchModelProfile,
  ): ReturnType<RuntimeCapabilityStore["issue"]> {
    const adapterKind = runtimeAdapterKind(envelope.authority.runtimeSource);
    if (adapterKind === undefined) return { ok: false, reason: "invalid" };
    return this.capabilities.issue({
      runId: authorityRef.runId,
      workspaceRootDigest: envelope.binding.workspaceRootDigest,
      envelopeDigest: authorityRef.envelopeDigest,
      adapterKind,
      modelProfileId: modelProfile.profileId,
      ...(modelProfile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: modelProfile.reasoningEffort }),
      audience,
      expiresAtMs: Date.parse(envelope.authority.expiresAt),
    });
  }

  private issueCapabilities(
    envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
    authorityRef: CodingRuntimeAuthorityRef,
    modelProfile: CodingWorkbenchModelProfile,
  ):
    { readonly modelGatewayCapability: string; readonly toolFacadeCapability: string } | undefined {
    const modelGateway = this.issueCapability(
      envelope,
      authorityRef,
      "model-gateway",
      modelProfile,
    );
    const toolFacade = this.issueCapability(envelope, authorityRef, "tool-facade", modelProfile);
    if (modelGateway.ok && toolFacade.ok) {
      return {
        modelGatewayCapability: modelGateway.capability,
        toolFacadeCapability: toolFacade.capability,
      };
    }
    this.registry.revoke(authorityRef);
    this.capabilities.revokeRun(authorityRef.runId);
    return undefined;
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
  paused: ["stopping", "cancelled"],
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
  return target === "idle" && (current === "recovery-required" || reapPendingRunId !== undefined);
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
  const clear = target === "idle";
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
): SupervisedCodingApprovalBindingOnce {
  return {
    grantScope: "once",
    runId: "coding-runtime-mint",
    requestId: intent.requestId,
    actionKind: "system-mutation",
    scopeDigest: sha256Hex(canonicalise({ taskId, operatorId, startIntent: intent })),
    connectorScopes: [],
  };
}

function startIntentDigest(
  intent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }>,
): string {
  return sha256Hex(canonicalise(intent));
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
  const rootDigest = sha256Hex(context.workspaceRoot);
  const identity = projectedIdentity(context, rootDigest);
  const branch = projectedBranch(context.branch);
  const modelProfile = {
    ...context.modelProfile,
    profileId: projectRuntimeAuthorityValue("profile", context.modelProfile.profileId),
  };
  const authority: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: "1",
    runId,
    localUser: identity.localUser,
    taskRefs: [identity.taskId],
    workspace: identity.workspace,
    branch,
    requestedMode: intent.requestedMode,
    deploymentCeiling: context.deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(
      intent.requestedMode,
      context.deploymentCeiling,
    ),
    runtimeSource: context.runtimeSource,
    actionClasses: context.actionClasses,
    connectorScopes: context.connectorScopes,
    modelProfile,
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
    binding: identity.binding,
    intentDigest: startIntentDigest(intent),
    nonceDigest: sha256Hex(nonce),
    issuedAt,
  };
}

function projectedIdentity(
  context: CodingRuntimeTrustedContext,
  rootDigest: string,
): {
  readonly localUser: string;
  readonly taskId: string;
  readonly workspace: CodingWorkbenchAuthorityEnvelope["workspace"];
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
} {
  const taskId = projectRuntimeAuthorityValue("task", context.taskId);
  const workspaceId = projectRuntimeAuthorityValue("workspace", context.workspaceId);
  return {
    localUser: projectRuntimeAuthorityValue("operator", context.operatorId),
    taskId,
    workspace: { workspaceId, rootLabel: workspaceId, rootDigest },
    binding: {
      taskId,
      projectId: projectRuntimeAuthorityValue("project", context.projectId),
      projectDigest: context.projectDigest,
      workspaceId,
      workspaceRootDigest: rootDigest,
      branchRef: projectRuntimeAuthorityValue("branch", context.branchRef),
      branchHeadDigest: context.branchHeadDigest,
    },
  };
}

function projectedBranch(
  branch: CodingWorkbenchBranchConstraints,
): CodingWorkbenchBranchConstraints {
  const headRef = projectRuntimeAuthorityValue("branch", branch.headRef);
  return {
    ...branch,
    baseRef: projectRuntimeAuthorityValue("branch", branch.baseRef),
    headRef,
    allowedPrefixes: [headRef],
  };
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

export function codingRuntimeBudgetDigest(budget: CodingWorkbenchBudget): string {
  return sha256Hex(canonicalise(budget));
}

export function codingRuntimeFactDigest(value: unknown): string {
  return sha256Hex(canonicalise(value));
}

export function codingRuntimeAuthorityEnvelopeDigest(
  envelope: CodingWorkbenchAuthorityEnvelope,
): string {
  return editorAgentAuthorityEnvelopeDigest(envelope);
}
