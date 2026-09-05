import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
} from "@oscharko-dev/keiko-contracts";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

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
import type { CodingToolActionRequest } from "./codingToolIpc.js";
import type { CodingToolApprovalProofVerifier } from "./codingToolApprovalBridge.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";

export interface CodingToolAuthorityContext {
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
  readonly runId?: string | undefined;
  readonly envelopeDigest?: string | undefined;
  readonly authorityExpiresAt?: string | undefined;
}

export type CodingToolAuthorityContextProvider = () => CodingToolAuthorityContext;

interface CodingToolAuthorityPortOptions {
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly requireProducerBinding?: boolean | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
}

interface RuntimeCodingToolFacadeOptions extends CodingToolFacadeOptions {
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
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
  if (!actionAllowed(preflight.envelope, request, approvalMatched))
    return {
      ok: false,
      reason: "action-not-authorized",
      approvalRequired: !approvalMatched && actionAllowed(preflight.envelope, request, true),
    };
  return { ok: true, trusted, binding, approvalMatched };
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
      admit(
        authority,
        context,
        capability,
        request,
        options.approvalProofVerifier,
        options.requireProducerBinding === true,
        options.reserveEditDelegation === true,
      ),
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
  approvalProofVerifier: CodingToolApprovalProofVerifier | undefined,
  requireProducerBinding: boolean,
  reserveEditDelegation: boolean,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const preflight = admissionPreflight(
    authority,
    context,
    capability,
    request,
    approvalProofVerifier,
    requireProducerBinding,
  );
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const { trusted, binding, approvalMatched } = preflight;
  if (request.action === "edit" && !reserveEditDelegation) {
    return guarded(authority, context, capability, request, binding, false);
  }
  const resolved = resolveDelegation(authority, trusted, capability, request);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (!actionAllowed(resolved.envelope, request, approvalMatched)) {
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
    const lease =
      trusted.runId === undefined
        ? undefined
        : consumeDeliveryLease(approvalProofVerifier, trusted.runId, request);
    if (lease === undefined) return { ok: false, reason: "action-not-authorized" };
    return guarded(authority, context, capability, request, binding, true, lease);
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
  return createCodingToolFacade(
    {
      authority: createCodingToolAuthorityPort(authority, context, {
        approvalProofVerifier: options.approvalProofVerifier,
        requireProducerBinding: true,
        reserveEditDelegation: options.reserveEditDelegation === true,
      }),
      delegate: createCodingToolGovernedDelegate(governedPorts, options.ciRepairBudget),
    },
    { ...options, requireInvocationRegistryForEdits: true },
  );
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
  return hasClasses(envelope.authority.actionClasses, requiredClasses(request));
}

type RuntimeActionClass =
  CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["actionClasses"][number];

// Static action-class requirement per governed action. Declared as a Record over the full action
// union minus "git", so adding an action to the union fails to compile until its required classes
// are named here — a new action can never default to "no class required". "git" is the one action
// whose requirement depends on the request itself and is resolved below.
const STATIC_REQUIRED_CLASSES: Readonly<
  Record<Exclude<CodingToolActionRequest["action"], "git">, readonly RuntimeActionClass[]>
> = {
  read: ["workspace-read"],
  discover: ["workspace-read"],
  edit: ["workspace-write"],
  command: ["command-execution"],
  verification: ["verification"],
  delivery: ["delivery-substrate"],
  connector: ["connector-access", "network-egress"],
  egress: ["network-egress"],
  skill: ["workspace-read"],
  "child-agent": ["workspace-read"],
};

function requiredClasses(request: CodingToolActionRequest): readonly RuntimeActionClass[] {
  if (request.action === "git") {
    if (request.operation === "ci") return ["workspace-read", "connector-access", "network-egress"];
    return [
      request.operation === "write" ||
      (request.operation === "stage" && request.phase === "execute")
        ? "workspace-write"
        : "workspace-read",
    ];
  }
  return STATIC_REQUIRED_CLASSES[request.action];
}

// Catalog binding consumes this owner without receiving a mutable reference to its policy table.
export function codingToolRequiredActionClasses(
  request: CodingToolActionRequest,
): readonly RuntimeActionClass[] {
  return Object.freeze([...requiredClasses(request)]);
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
      return connectorAllowed(envelope, request.scope);
    case "egress":
      return networkAllowed(envelope);
    case "skill":
    case "child-agent":
      return true;
  }
}

function commitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
  approved: boolean,
): boolean {
  if (request.phase === "propose" || request.phase === "reconcile") return true;
  if (request.phase !== "execute" || !approved) return false;
  const mode = envelope.authority.effectiveMode;
  const effect = codingWorkbenchPolicyEffectFor(mode, "delivery", "high");
  if (effect === "denied") return false;
  return (
    mode !== "autonomous-delivery" ||
    (isDraftToolRequest(request)
      ? deliveryAllowed(envelope, request.intent)
      : hasScope(envelope.authority.connectorScopes, "source-control.write"))
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
  if (request.operation === "ci") return connectorAllowed(envelope, "source-control.read");
  if (request.operation === "read" || request.operation === "write")
    return gitPolicyAllowed(envelope, request.operation);
  if (request.operation === "stage" && request.phase === "execute")
    return workspaceMediumRiskAllowed(envelope, approved);
  return true;
}

function gitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  operation: "read" | "write",
): boolean {
  return (
    operation === "read" || hasScope(envelope.authority.connectorScopes, "source-control.write")
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
  if (
    verifier === undefined ||
    context.runId === undefined ||
    (request.action !== "command" && request.action !== "verification") ||
    request.approvalProof === undefined
  ) {
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
  if (
    verifier === undefined ||
    context.runId === undefined ||
    (request.action !== "command" && request.action !== "verification")
  ) {
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

function consumeDeliveryLease(
  verifier: CodingToolApprovalProofVerifier | undefined,
  runId: string,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): object | undefined {
  return isDraftToolRequest(request)
    ? verifier?.consumeDelivery?.(runId, request)
    : verifier?.consumeCommit?.(runId, request);
}

function deliveryHasScopedApproval(
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): boolean {
  return request.intent === "commit" || isDraftToolRequest(request);
}
