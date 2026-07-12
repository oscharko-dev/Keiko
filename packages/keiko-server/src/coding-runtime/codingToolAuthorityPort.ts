import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingToolAuthorityPort,
  CodingToolProducerBinding,
} from "./codingToolFacadePorts.js";
import type { CodingToolFacade, CodingToolFacadeOptions } from "./codingToolFacadePorts.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import {
  createCodingToolGovernedDelegate,
  type CodingToolGovernedPorts,
} from "./codingToolGovernedDelegate.js";
import type { CodingToolActionRequest } from "./codingToolIpc.js";
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
  readonly requireProducerBinding?: boolean | undefined;
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
      admit(authority, context, capability, request, options.requireProducerBinding === true),
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
  requireProducerBinding: boolean,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const trusted = context();
  const binding = producerBinding(trusted);
  if (requireProducerBinding && binding === undefined) {
    return { ok: false, reason: "producer-binding-missing" };
  }
  const preflight = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  if (!preflight.ok || !actionAllowed(preflight.envelope, request))
    return { ok: false, reason: preflight.ok ? "action-not-authorized" : preflight.reason };
  if (request.action === "edit") return guarded(authority, context, capability, request, binding);
  const resolved = authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    delegationId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    usage: delegationUsage(request),
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  return resolved.ok
    ? guarded(authority, context, capability, request, binding)
    : { ok: false, reason: resolved.reason };
}

function guarded(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  binding: CodingToolProducerBinding | undefined,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const mutationGuard = {
    check: (): boolean => revalidate(authority, context, capability, request),
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
  options: CodingToolFacadeOptions = {},
): CodingToolFacade {
  return createCodingToolFacade(
    {
      authority: createCodingToolAuthorityPort(authority, context, {
        requireProducerBinding: true,
      }),
      delegate: createCodingToolGovernedDelegate(governedPorts),
    },
    { ...options, requireInvocationRegistryForEdits: true },
  );
}

function revalidate(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
): boolean {
  const trusted = context();
  const resolved = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  return resolved.ok && actionAllowed(resolved.envelope, request);
}

function actionAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
): boolean {
  return (
    hasClasses(envelope.authority.actionClasses, requiredClasses(request)) &&
    additionalPolicyAllowed(envelope, request)
  );
}

function requiredClasses(
  request: CodingToolActionRequest,
): readonly CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["actionClasses"][number][] {
  switch (request.action) {
    case "read":
      return ["workspace-read"];
    case "edit":
      return ["workspace-write"];
    case "command":
      return ["command-execution"];
    case "verification":
      return ["verification"];
    case "git":
      return [request.operation === "read" ? "workspace-read" : "workspace-write"];
    case "delivery":
      return ["delivery-substrate"];
    case "connector":
      return ["connector-access", "network-egress"];
    case "egress":
      return ["network-egress"];
  }
}

function additionalPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
): boolean {
  switch (request.action) {
    case "read":
    case "edit":
    case "verification":
      return true;
    case "command":
      return commandAllowed(envelope, request.commandId);
    case "git":
      return gitPolicyAllowed(envelope, request.operation);
    case "delivery":
      return deliveryAllowed(envelope, request.intent);
    case "connector":
      return connectorAllowed(envelope, request.scope);
    case "egress":
      return networkAllowed(envelope);
  }
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
): boolean {
  const policy = envelope.authority.commandPolicy;
  if (policy.mode === "deny" || policy.requirePerCommandApproval || policy.deny.includes(commandId))
    return false;
  return policy.mode !== "allowlisted" || policy.allow.includes(commandId);
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
