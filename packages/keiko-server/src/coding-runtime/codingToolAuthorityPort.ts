import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
} from "@oscharko-dev/keiko-contracts";

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
  readonly reserveEditDelegation?: boolean | undefined;
}

interface RuntimeCodingToolFacadeOptions extends CodingToolFacadeOptions {
  readonly reserveEditDelegation?: boolean | undefined;
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
  requireProducerBinding: boolean,
  reserveEditDelegation: boolean,
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
  if (request.action === "edit" && !reserveEditDelegation) {
    return guarded(authority, context, capability, request, binding);
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
    ? guarded(authority, context, capability, request, binding)
    : { ok: false, reason: resolved.reason };
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
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const mutationGuard = {
    check: (): boolean => revalidate(authority, context, capability, request),
    resolveParentAuthority: (): CodingWorkbenchAuthorityEnvelope | undefined =>
      revalidateEnvelope(authority, context, capability, request)?.authority,
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
        requireProducerBinding: true,
        reserveEditDelegation: options.reserveEditDelegation === true,
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
  return revalidateEnvelope(authority, context, capability, request) !== undefined;
}

function revalidateEnvelope(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
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
  return resolved.ok && actionAllowed(resolved.envelope, request) ? resolved.envelope : undefined;
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
): boolean {
  return (
    hasClasses(envelope.authority.actionClasses, requiredClasses(request)) &&
    additionalPolicyAllowed(envelope, request)
  );
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
    return [request.operation === "read" ? "workspace-read" : "workspace-write"];
  }
  return STATIC_REQUIRED_CLASSES[request.action];
}

// The extra policy beyond the required action class, one exhaustive case per governed action.
// Keeping every action's disposition in a single compiler-checked switch is what makes this
// authority decision auditable in one read; splitting it would hide half of the allow/deny surface
// in a second function.
// eslint-disable-next-line complexity -- exhaustive authority switch, see above
function additionalPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
): boolean {
  switch (request.action) {
    case "read":
    case "discover":
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
    case "skill":
    case "child-agent":
      return true;
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
