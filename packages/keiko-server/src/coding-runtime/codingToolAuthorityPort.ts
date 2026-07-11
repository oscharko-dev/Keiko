import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
} from "@oscharko-dev/keiko-contracts";

import type { CodingToolAuthorityPort } from "./codingToolFacadePorts.js";
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
}

export type CodingToolAuthorityContextProvider = () => CodingToolAuthorityContext;

export function createCodingToolAuthorityPort(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
): CodingToolAuthorityPort {
  return {
    admit: (capability, request): ReturnType<CodingToolAuthorityPort["admit"]> => {
      if (capability === undefined) return { ok: false, reason: "capability-missing" };
      const trusted = context();
      const preflight = authority.revalidateCapabilityForMutation({
        capability,
        adapterKind: trusted.adapterKind,
        liveFacts: trusted.liveFacts,
        workspaceRoot: trusted.workspaceRoot,
        deploymentCeiling: trusted.deploymentCeiling,
        nowIso: trusted.nowIso,
      });
      if (!preflight.ok || !actionAllowed(preflight.envelope, request)) {
        return { ok: false, reason: preflight.ok ? "action-not-authorized" : preflight.reason };
      }
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
        ? {
            ok: true,
            mutationGuard: {
              check: (): boolean => revalidate(authority, context, capability, request),
            },
          }
        : { ok: false, reason: resolved.reason };
    },
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
      authority: createCodingToolAuthorityPort(authority, context),
      delegate: createCodingToolGovernedDelegate(governedPorts),
    },
    options,
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
    patchBytes: request.action === "edit" ? request.patchBytes : 0,
    promptTokens: 0,
  };
}
