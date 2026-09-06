import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
  GitDeliveryApprovalClaim,
} from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchCodeTaskDeliveryEffectFor,
  codingWorkbenchPolicyEffectFor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

import type {
  CodingToolAuthorityPort,
  CodingToolFacade,
  CodingToolFacadeOptions,
  CodingToolProducerBinding,
} from "./codingToolFacadePorts.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import {
  createCodingToolGovernedDelegate,
  type CodingToolGovernedPorts,
} from "./codingToolGovernedDelegate.js";
import { codingToolRequiredActionClasses, type CodingToolActionRequest } from "./codingToolIpc.js";
import {
  isApprovableToolRequest,
  commitClaim,
  type CodingToolApprovalProofVerifier,
} from "./codingToolApprovalBridge.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import {
  createCanonicalCatalogFacadeBridge,
  type CanonicalCatalogFacadeBridge,
} from "../tool-catalog/catalogToolFacadeBridge.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
import type { CatalogToolBudgetPort } from "../tool-catalog/catalogToolPorts.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { defaultServerDiagnosticSink, type ServerDiagnosticSink } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";

export interface CodingToolAuthorityContext {
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
  readonly runId?: string | undefined;
  readonly envelopeDigest?: string | undefined;
  readonly authorityExpiresAt?: string | undefined;
  // F8 (#3413): threads this run's correlation id into the tool-catalog.* lifecycle log lines the
  // catalog facade bridge emits. productionManagedWorktreeTools.ts's context provider now populates
  // this from `input.authorityRef.runId`, so those lines join the run's own activity log.
  // UNKNOWN_CORRELATION_ID (correlation.ts) remains the sanctioned fallback for any other/future
  // caller that leaves this optional field unset -- never a silently missing id.
  readonly correlationId?: string | undefined;
}

export type CodingToolAuthorityContextProvider = () => CodingToolAuthorityContext;

interface CodingToolAuthorityPortOptions {
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly requireProducerBinding?: boolean | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
}

interface RuntimeCodingToolFacadeOptions extends CodingToolFacadeOptions {
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
  // F8 (#3413): production always wires the real catalog facade bridge; these three let a test
  // observe its lifecycle log lines or replace its budget port without touching process-wide
  // state. `disableCatalogBridge` exists only for a test that must isolate an unrelated concern.
  readonly catalogActivityLog?: ServerLogSink | undefined;
  readonly catalogDiagnostics?: ServerDiagnosticSink | undefined;
  readonly catalogBudget?: CatalogToolBudgetPort | undefined;
  readonly unavailableOptionalTools?: (() => ReadonlySet<OpenCodeOptionalToolName>) | undefined;
  readonly disableCatalogBridge?: boolean | undefined;
}

export type CodingToolAuthorityAvailability =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type CodingToolAuthorityPreview = (
  capability: string | undefined,
  request: CodingToolActionRequest,
) => CodingToolAuthorityAvailability;

/** Non-consuming availability only. Actual dispatch must still call the authoritative admission. */
export function createCodingToolAuthorityPreview(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  options: CodingToolAuthorityPortOptions = {},
): CodingToolAuthorityPreview {
  return (capability, request): CodingToolAuthorityAvailability => {
    const result = admissionPreflight(
      authority,
      context,
      capability,
      request,
      options.approvalProofVerifier,
      options.requireProducerBinding === true,
    );
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          reason: result.approvalRequired === true ? "approval-required" : result.reason,
        };
  };
}

type AdmissionPreflight =
  | { readonly ok: false; readonly reason: string; readonly approvalRequired?: boolean }
  | {
      readonly ok: true;
      readonly trusted: CodingToolAuthorityContext;
      readonly binding: CodingToolProducerBinding | undefined;
      readonly approvalMatched: boolean;
    };

function admissionPreflight(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string | undefined,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
  requireProducerBinding: boolean,
  activityLog?: ServerLogSink,
): AdmissionPreflight {
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const trusted = context();
  const binding = producerBinding(trusted);
  if (requireProducerBinding && binding === undefined)
    return { ok: false, reason: "producer-binding-missing" };
  const preflight = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const approvalMatched = approved(preflight.envelope, trusted, request, verifier);
  if (!actionAllowed(preflight.envelope, request, approvalMatched)) {
    logAuthorityDenial(activityLog, trusted, preflight.envelope, request);
    return {
      ok: false,
      reason: "action-not-authorized",
      approvalRequired: !approvalMatched && actionAllowed(preflight.envelope, request, true),
    };
  }
  return { ok: true, trusted, binding, approvalMatched };
}

function logAuthorityDenial(
  activityLog: ServerLogSink | undefined,
  context: CodingToolAuthorityContext,
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
): void {
  activityLog?.write({
    level: "warn",
    category: "security",
    op: "coding-runtime.tool-authority.denied",
    correlationId: context.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: { action: request.action, effectiveMode: envelope.authority.effectiveMode },
  });
}

export function createCodingToolAuthorityPort(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  options: CodingToolAuthorityPortOptions = {},
): CodingToolAuthorityPort {
  return {
    admit: (capability, request): ReturnType<CodingToolAuthorityPort["admit"]> =>
      admit(authority, context, capability, request, options),
  };
}

function admit(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  capability: string | undefined,
  request: CodingToolActionRequest,
  options: CodingToolAuthorityPortOptions,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const { approvalProofVerifier, requireProducerBinding, reserveEditDelegation, activityLog } =
    options;
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const preflight = admissionPreflight(
    authority,
    context,
    capability,
    request,
    approvalProofVerifier,
    requireProducerBinding === true,
    activityLog,
  );
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const { trusted, binding, approvalMatched } = preflight;
  if (request.action === "edit" && !reserveEditDelegation) {
    return guarded(authority, context, capability, request, binding, false);
  }
  const resolved = resolveDelegation(authority, trusted, capability, request);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (!actionAllowed(resolved.envelope, request, approvalMatched)) {
    logAuthorityDenial(activityLog, trusted, resolved.envelope, request);
    return { ok: false, reason: "action-not-authorized" };
  }
  // A one-shot proof is consumed only after the delegation budget has been reserved. Consuming it
  // during preflight or before the resolved envelope is authorized would make a transient failure
  // permanently deny a valid action.
  return finishAdmission({
    authority,
    context,
    capability,
    request,
    binding,
    trusted,
    approvalMatched,
    approvalProofVerifier,
  });
}

// #3384 F4: the commit-execute branch of `finishAdmission` no longer consumes the one-use commit
// approval at admission — see the comment there. It instead threads the un-consumed claim through
// `mutationGuard.deliveryApproval` wrapped in this shape (never `undefined` itself, so it stays
// distinguishable from "no delivery approval applies to this request"); `claim` itself legitimately
// stays `undefined` for a binding-matched, un-tokened redemption. productionManagedWorktreeTools.ts
// unwraps it and passes `.claim` to `VerifiedCommitService.execute()`, which alone decides — after
// its own preflight — whether the claim is spent.
export interface CommitExecutionApproval {
  readonly claim: GitDeliveryApprovalClaim | undefined;
}

interface FinishAdmissionInput {
  readonly authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >;
  readonly context: CodingToolAuthorityContextProvider;
  readonly capability: string;
  readonly request: CodingToolActionRequest;
  readonly binding: CodingToolProducerBinding | undefined;
  readonly trusted: CodingToolAuthorityContext;
  readonly approvalMatched: boolean;
  readonly approvalProofVerifier: CodingToolApprovalProofVerifier | undefined;
}
function finishAdmission(
  input: FinishAdmissionInput,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const {
    authority,
    context,
    capability,
    request,
    binding,
    trusted,
    approvalMatched,
    approvalProofVerifier,
  } = input;
  if (request.action === "delivery" && request.phase === "execute") {
    if (trusted.runId === undefined) return { ok: false, reason: "action-not-authorized" };
    // Full access reaches this branch only after both admission passes accepted the exact live
    // delivery envelope without an approval proof. Preserve that policy authorization as an
    // approval-free guard; the delivery service rechecks the live mode and this guard at its
    // effect edge before it can pass `{ required: false }` to the Git kernel.
    if (!approvalMatched) return guarded(authority, context, capability, request, binding, false);
    if (isDraftToolRequest(request)) {
      const lease = approvalProofVerifier?.consumeDelivery?.(trusted.runId, request);
      if (lease === undefined) return { ok: false, reason: "action-not-authorized" };
      return guarded(authority, context, capability, request, binding, true, lease);
    }
    // #3384 F4 (executeApproved consumes before preflight): the one-use commit approval must
    // NOT be consumed here. `admissionPreflight`'s `approved()` already confirmed a matching,
    // unconsumed approval exists (non-mutating `matchesCommit` check) moments ago, so consuming
    // it now would burn it on every legitimate pre-commit block (staged-tree drift, unresolved
    // conflict markers) that VerifiedCommitService.execute()'s own preflight runs strictly
    // AFTER admission. Pass the un-consumed claim through the guard instead; execute() alone
    // decides whether to spend it, only once that preflight has cleared (mirrors executeOne's
    // HTTP-route parity comment in verifiedCommitService.ts).
    const approval: CommitExecutionApproval = { claim: commitClaim(request) };
    return guarded(authority, context, capability, request, binding, true, approval);
  }
  const stage = finishStageAdmission(input);
  if (stage !== undefined) return stage;
  const approvalVerified = consumeMatchedApproval(
    approvalMatched,
    trusted,
    request,
    approvalProofVerifier,
  );
  return guarded(authority, context, capability, request, binding, approvalVerified);
}

function finishStageAdmission(
  input: FinishAdmissionInput,
): ReturnType<CodingToolAuthorityPort["admit"]> | undefined {
  const {
    request,
    trusted,
    approvalProofVerifier,
    authority,
    context,
    capability,
    binding,
    approvalMatched,
  } = input;
  if (
    request.action === "git" &&
    request.operation === "stage" &&
    request.phase === "execute" &&
    approvalMatched
  ) {
    const lease =
      trusted.runId === undefined
        ? undefined
        : approvalProofVerifier?.consumeStage?.(trusted.runId, request.proposalId);
    if (lease === undefined) return { ok: false, reason: "action-not-authorized" };
    const admitted = guarded(authority, context, capability, request, binding, true);
    return admitted.ok
      ? { ...admitted, mutationGuard: { ...admitted.mutationGuard, stageApproval: lease } }
      : admitted;
  }
  return undefined;
}

function resolveDelegation(
  authority: Pick<CodingRuntimeAuthorityService, "resolveCapabilityForDelegation">,
  context: CodingToolAuthorityContext,
  capability: string,
  request: CodingToolActionRequest,
): ReturnType<CodingRuntimeAuthorityService["resolveCapabilityForDelegation"]> {
  return authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: context.adapterKind,
    liveFacts: context.liveFacts,
    delegationId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    usage: delegationUsage(request),
    workspaceRoot: context.workspaceRoot,
    deploymentCeiling: context.deploymentCeiling,
    nowIso: context.nowIso,
  });
}

function approved(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  return (
    actionClassesAllowed(envelope, request, true) &&
    verifyApprovalProof(envelope, context, request, verifier)
  );
}

function guarded(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  binding: CodingToolProducerBinding | undefined,
  approvalVerified: boolean,
  deliveryApproval?: object,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const mutationGuard = {
    ...(deliveryApproval === undefined ? {} : { deliveryApproval }),
    check: (): boolean => revalidate(authority, context, capability, request, approvalVerified),
    resolveParentAuthority: (): CodingWorkbenchAuthorityEnvelope | undefined =>
      revalidateEnvelope(authority, context, capability, request, approvalVerified)?.authority,
    chargeDelegatedRead: (delegationId: string, idempotencyKey: string): boolean =>
      chargeDelegatedRead(authority, context, capability, delegationId, idempotencyKey),
    ...(binding === undefined ? {} : { binding }),
  };
  return {
    ok: true,
    mutationGuard,
    ...(binding === undefined ? {} : { binding }),
  };
}

function producerBinding(
  context: CodingToolAuthorityContext,
): CodingToolProducerBinding | undefined {
  if (
    context.runId === undefined ||
    context.envelopeDigest === undefined ||
    context.authorityExpiresAt === undefined ||
    !/^[a-f0-9]{64}$/u.test(context.envelopeDigest) ||
    !Number.isFinite(Date.parse(context.authorityExpiresAt))
  ) {
    return undefined;
  }
  return {
    runId: context.runId,
    envelopeDigest: context.envelopeDigest,
    workspaceId: context.liveFacts.binding.workspaceId,
    workspaceRootDigest: context.liveFacts.binding.workspaceRootDigest,
    expiresAt: context.authorityExpiresAt,
  };
}

export function createRuntimeCodingToolFacade(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  governedPorts: CodingToolGovernedPorts,
  options: RuntimeCodingToolFacadeOptions = {},
): CodingToolFacade {
  const activityLog = options.catalogActivityLog ?? processServerLogSink();
  const authorityPort = createCodingToolAuthorityPort(authority, context, {
    approvalProofVerifier: options.approvalProofVerifier,
    activityLog,
    requireProducerBinding: true,
    reserveEditDelegation: options.reserveEditDelegation === true,
  });
  return createCodingToolFacade(
    {
      authority: authorityPort,
      delegate: createCodingToolGovernedDelegate(governedPorts, options.ciRepairBudget),
    },
    {
      ...options,
      requireInvocationRegistryForEdits: true,
      catalogBridge:
        options.disableCatalogBridge === true
          ? undefined
          : catalogFacadeBridgeFor(authority, authorityPort, context, options, activityLog),
    },
  );
}

/** F8 (#3413): the production CatalogToolBinder-backed bridge for the facade's covered actions
 * (see catalogToolFacadeBridge.ts). Built from the same real catalog used to advertise tools to
 * the model (createOpenCodeGatewayToolCatalogAdvertisement), so there is exactly one catalog, not
 * a second one grown for this integration. */
function catalogFacadeBridgeFor(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  authorityPort: CodingToolAuthorityPort,
  context: CodingToolAuthorityContextProvider,
  options: RuntimeCodingToolFacadeOptions,
  activityLog: ServerLogSink,
): CanonicalCatalogFacadeBridge | undefined {
  const invocationRegistry =
    options.invocationRegistry ??
    createCodingToolInvocationRegistry({ now: () => Date.parse(context().nowIso) });
  return createCanonicalCatalogFacadeBridge({
    authority: authorityPort,
    previewAuthority: createCodingToolAuthorityPreview(authority, context, {
      approvalProofVerifier: options.approvalProofVerifier,
      activityLog,
      requireProducerBinding: true,
    }),
    invocationRegistry,
    approvalAvailable: options.approvalProofVerifier !== undefined,
    ...(options.catalogBudget === undefined ? {} : { budgetPort: options.catalogBudget }),
    logPort: {
      primary: activityLog,
      diagnostics: options.catalogDiagnostics ?? defaultServerDiagnosticSink,
    },
    context: () => {
      const current = context();
      return current.runId === undefined || current.authorityExpiresAt === undefined
        ? undefined
        : {
            runId: current.runId,
            correlationId: current.correlationId ?? UNKNOWN_CORRELATION_ID,
            workspaceRoot: current.workspaceRoot,
            workspaceIdentity: current.liveFacts.binding.workspaceId,
            workspaceRevision: current.liveFacts.binding.branchHeadDigest,
            authorityExpiresAt: current.authorityExpiresAt,
            now: Date.parse(current.nowIso),
          };
    },
    ...(options.unavailableOptionalTools === undefined
      ? {}
      : { unavailableOptionalTools: options.unavailableOptionalTools }),
  });
}

function revalidate(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  return (
    revalidateEnvelope(authority, context, capability, request, approvalVerified) !== undefined
  );
}

function revalidateEnvelope(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): CodingWorkbenchRuntimeAuthorityEnvelope | undefined {
  const trusted = context();
  const resolved = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  return resolved.ok && actionAllowed(resolved.envelope, request, approvalVerified)
    ? resolved.envelope
    : undefined;
}

function chargeDelegatedRead(
  authority: Pick<CodingRuntimeAuthorityService, "resolveCapabilityForDelegation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  delegationId: string,
  idempotencyKey: string,
): boolean {
  const trusted = context();
  return authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    delegationId,
    idempotencyKey,
    usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  }).ok;
}

function actionAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  return (
    actionClassesAllowed(envelope, request, approvalVerified) &&
    additionalPolicyAllowed(envelope, request, approvalVerified)
  );
}

function actionClassesAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approved: boolean,
): boolean {
  if (request.action === "git" && request.operation === "stage" && approved)
    return hasClasses(envelope.authority.actionClasses, ["workspace-read"]);
  if (request.action === "delivery" && deliveryHasScopedApproval(request)) {
    if (request.phase === "propose" || request.phase === "reconcile")
      return hasClasses(envelope.authority.actionClasses, ["workspace-read"]);
    if (approved && envelope.authority.effectiveMode !== "autonomous-delivery")
      return hasClasses(envelope.authority.actionClasses, ["workspace-read"]);
  }
  return hasClasses(envelope.authority.actionClasses, codingToolRequiredActionClasses(request));
}

// The extra policy beyond the required action class, one exhaustive case per governed action.
// Keeping every action's disposition in a single compiler-checked switch is what makes this
// authority decision auditable in one read; splitting it would hide half of the allow/deny surface
// in a second function.
// eslint-disable-next-line complexity -- exhaustive authority switch, see above
function additionalPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  switch (request.action) {
    case "read":
    case "discover":
    case "search":
    case "edit":
      return true;
    case "verification":
      return workspaceMediumRiskAllowed(envelope, approvalVerified);
    case "command":
      return (
        workspaceMediumRiskAllowed(envelope, approvalVerified) &&
        commandAllowed(envelope, request.commandId, approvalVerified)
      );
    case "git":
      return runtimeGitPolicyAllowed(envelope, request, approvalVerified);
    case "delivery":
      return request.intent === "commit" || isDraftToolRequest(request)
        ? commitPolicyAllowed(envelope, request, approvalVerified)
        : deliveryAllowed(envelope, request.intent);
    case "connector":
      return (
        internetPolicyAllowed(envelope, approvalVerified) &&
        connectorAllowed(envelope, request.scope)
      );
    case "egress":
      return internetPolicyAllowed(envelope, approvalVerified) && networkAllowed(envelope);
    case "skill":
    case "child-agent":
      return true;
  }
}

function internetPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  approvalVerified: boolean,
): boolean {
  return (
    approvalVerified ||
    codingWorkbenchPolicyEffectFor(envelope.authority.effectiveMode, "internet", "medium") ===
      "allowed"
  );
}

function commitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
  approved: boolean,
): boolean {
  if (request.phase === "propose" || request.phase === "reconcile") return true;
  if (request.phase !== "execute") return false;
  const mode = envelope.authority.effectiveMode;
  const effect = codingWorkbenchCodeTaskDeliveryEffectFor(mode, request.intent);
  if (effect === "denied" || (!approved && effect !== "allowed")) return false;
  return (
    mode !== "autonomous-delivery" ||
    (isDraftToolRequest(request)
      ? deliveryAllowed(envelope, request.intent)
      : hasScope(envelope.authority.connectorScopes, "source-control.write"))
  );
}

/**
 * True only when the current server-resolved envelope authorizes this exact Code-task delivery
 * execute without a per-action approval. Proposal handlers use this to decide whether they can
 * expose a model-only ready disposition without opening an operator approval request.
 */
export function codingToolFullAccessDeliveryAllowed(
  authority: CodingWorkbenchAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): boolean {
  const executeRequest = { ...request, phase: "execute" } as const;
  return (
    codingWorkbenchCodeTaskDeliveryEffectFor(authority.effectiveMode, request.intent) ===
      "allowed" &&
    hasClasses(authority.actionClasses, codingToolRequiredActionClasses(executeRequest)) &&
    hasScope(authority.connectorScopes, "source-control.write") &&
    (request.intent === "commit" ||
      (authority.networkPolicy.mode !== "deny-all" &&
        hasClasses(authority.actionClasses, ["network-egress"]) &&
        hasScope(authority.networkPolicy.connectorScopes, "source-control.write")))
  );
}

function workspaceMediumRiskAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  approvalVerified: boolean,
): boolean {
  return (
    approvalVerified ||
    codingWorkbenchPolicyEffectFor(
      envelope.authority.effectiveMode,
      "workspace-contained",
      "medium",
    ) === "allowed"
  );
}

function runtimeGitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "git" }>,
  approved: boolean,
): boolean {
  if (request.operation === "ci")
    return (
      internetPolicyAllowed(envelope, approved) && connectorAllowed(envelope, "source-control.read")
    );
  if (request.operation === "read" || request.operation === "write")
    return gitPolicyAllowed(envelope, request.operation, approved);
  if (request.operation === "stage" && request.phase === "execute")
    return workspaceMediumRiskAllowed(envelope, approved);
  return true;
}

function gitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  operation: "read" | "write",
  approved: boolean,
): boolean {
  // A raw git "write" bypasses the propose/stage review path entirely, so it carries the same
  // risk class as a delivery commit and is gated the same way commitPolicyAllowed gates
  // commit-execute: an approval proof is required unconditionally, in every mode, never merely a
  // connector scope that (per deliveryScopeGranted) is present at every mode by design.
  if (operation === "read") return true;
  const effect = codingWorkbenchPolicyEffectFor(
    envelope.authority.effectiveMode,
    "delivery",
    "high",
  );
  return (
    approved &&
    effect !== "denied" &&
    hasScope(envelope.authority.connectorScopes, "source-control.write")
  );
}

function connectorAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  scope: string,
): boolean {
  return (
    networkAllowed(envelope) &&
    hasScope(envelope.authority.connectorScopes, scope) &&
    hasScope(envelope.authority.networkPolicy.connectorScopes, scope)
  );
}

function commandAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  commandId: string,
  approvalVerified: boolean,
): boolean {
  const policy = envelope.authority.commandPolicy;
  if (
    policy.mode === "deny" ||
    (policy.requirePerCommandApproval && !approvalVerified) ||
    policy.deny.includes(commandId)
  )
    return false;
  return policy.mode !== "allowlisted" || policy.allow.includes(commandId);
}

function verifyApprovalProof(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (request.action === "delivery") return matchedCommitApproval(context, request, verifier);
  const stage = matchedStageApproval(context, request, verifier);
  if (stage !== undefined) return stage;
  // A proof is required only when the ordinary policy denies this action without one. Keeping this
  // guard inverted prevents an unrelated proof from becoming authority for an already-allowed act.
  if (additionalPolicyAllowed(envelope, request, false)) return false;
  // 3941816393 / authority-matrix-2: "git ci" and "connector" carry the same bounded-action risk
  // as command/verification and are redeemable through the exact same per-run pendingPermission
  // approval (see isApprovableToolRequest); a request whose action cannot carry a proof at all, or
  // that omits one, is rejected the same way verifier.matches already rejects a missing proof.
  if (verifier === undefined || context.runId === undefined || !isApprovableToolRequest(request)) {
    return false;
  }
  const nowMs = Date.parse(context.nowIso);
  return Number.isFinite(nowMs) && verifier.matches({ runId: context.runId, request, nowMs });
}

function matchedStageApproval(
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean | undefined {
  if (request.action === "git" && request.operation === "stage" && request.phase === "execute")
    return (
      context.runId !== undefined &&
      verifier?.matchesStage?.(context.runId, request.proposalId) === true
    );
  return undefined;
}

function matchedCommitApproval(
  context: CodingToolAuthorityContext,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (context.runId === undefined) return false;
  return isDraftToolRequest(request)
    ? verifier?.matchesDelivery?.(context.runId, request) === true
    : verifier?.matchesCommit?.(context.runId, request) === true;
}

function consumeApprovalProof(
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (verifier === undefined || context.runId === undefined || !isApprovableToolRequest(request)) {
    return false;
  }
  const nowMs = Date.parse(context.nowIso);
  return Number.isFinite(nowMs) && verifier.consume({ runId: context.runId, request, nowMs });
}

function consumeMatchedApproval(
  matched: boolean,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  return matched && consumeApprovalProof(context, request, verifier);
}

function deliveryAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  intent: Extract<CodingToolActionRequest, { readonly action: "delivery" }>["intent"],
): boolean {
  const authority = envelope.authority;
  if (!hasScope(authority.connectorScopes, "source-control.write")) return false;
  return intent === "commit"
    ? true
    : networkAllowed(envelope) &&
        hasClasses(authority.actionClasses, ["network-egress"]) &&
        hasScope(authority.networkPolicy.connectorScopes, "source-control.write");
}

function networkAllowed(envelope: CodingWorkbenchRuntimeAuthorityEnvelope): boolean {
  return envelope.authority.networkPolicy.mode !== "deny-all";
}

function hasClasses(
  actual: CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["actionClasses"],
  required: readonly (typeof actual)[number][],
): boolean {
  return required.every((actionClass) => actual.includes(actionClass));
}

function hasScope(actual: readonly string[], required: string): boolean {
  return actual.includes(required);
}

function delegationUsage(request: CodingToolActionRequest): CodingWorkbenchRuntimeDelegationUsage {
  return {
    toolCalls: 1,
    patchBytes: request.action === "edit" ? Buffer.byteLength(request.changeset.patch, "utf8") : 0,
    promptTokens: 0,
  };
}

function deliveryHasScopedApproval(
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): boolean {
  return request.intent === "commit" || isDraftToolRequest(request);
}
