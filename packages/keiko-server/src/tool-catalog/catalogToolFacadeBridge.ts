import { randomUUID } from "node:crypto";
import type {
  CatalogJsonValue,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { captureCatalogJson, lookupCatalogTool } from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolActionRequest, CodingToolResult } from "../coding-runtime/codingToolIpc.js";
import type {
  CodingToolAuthorityPort,
  CodingToolFacadeInput,
  CodingToolMutationGuard,
} from "../coding-runtime/codingToolFacadePorts.js";
import type { CodingToolAuthorityPreview } from "../coding-runtime/codingToolAuthorityPort.js";
import type { CodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  isOpenCodeVerificationId,
  type OpenCodeGatewayHandlerCoverage,
} from "../coding-runtime/opencodeToolSchemas.js";
import type { OpenCodeOptionalToolName } from "../coding-runtime/opencodeLaunchProfile.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitToolLifecycleEvent, type CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";
import {
  catalogHandlerReadiness,
  computeHandlerSetDigest,
  type CatalogBoundHandler,
} from "./catalogToolBinder.js";
import {
  createCatalogToolBinderFromPreparation,
  deriveCatalogBindingPreparation,
  prepareCatalogToolBinder,
} from "./catalogToolDispatch.js";
import type {
  CatalogActionIdentity,
  CatalogHandlerContext,
  CatalogHandlerResult,
  CatalogToolBudgetPort,
  CatalogToolExecutionOverride,
  CatalogToolHandlerBinding,
  CatalogTrustedContext,
} from "./catalogToolPorts.js";
import { CatalogDispatchFault } from "./catalogToolRuntimeAuthority.js";

const OPENCODE_CATALOG_ADVERTISEMENT = createOpenCodeGatewayToolCatalogAdvertisement(0);
const OPENCODE_CATALOG_DESCRIPTORS = OPENCODE_CATALOG_ADVERTISEMENT.projection.tools.flatMap(
  (tool) => {
    const descriptor = lookupCatalogTool(OPENCODE_CATALOG_ADVERTISEMENT.catalog, tool.toolRef);
    return descriptor === undefined ? [] : [descriptor];
  },
);
const OPENCODE_DESCRIPTOR_BY_ID: ReadonlyMap<string, ToolDescriptor> = new Map(
  OPENCODE_CATALOG_DESCRIPTORS.map((descriptor) => [descriptor.toolRef.canonicalId, descriptor]),
);

export interface CanonicalCatalogContext {
  readonly runId: string;
  readonly correlationId: string;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
  readonly workspaceRevision: string;
  readonly authorityExpiresAt: string;
  readonly now: number;
}

export interface CanonicalCatalogFacadeBridgeInput {
  readonly authority: CodingToolAuthorityPort;
  readonly previewAuthority: CodingToolAuthorityPreview;
  readonly invocationRegistry: CodingToolInvocationRegistry;
  readonly context: () => CanonicalCatalogContext | undefined;
  readonly logPort: CatalogLifecycleLogPort;
  readonly approvalAvailable: boolean;
  readonly budgetPort?: CatalogToolBudgetPort | undefined;
  readonly unavailableOptionalTools?: () => ReadonlySet<OpenCodeOptionalToolName>;
}

export interface CanonicalCatalogFacadeBridge {
  readonly covers: (request: CodingToolActionRequest) => boolean;
  readonly recordUnbound: (request: CodingToolActionRequest, input: CodingToolFacadeInput) => void;
  readonly execute: (
    request: CodingToolActionRequest,
    input: CodingToolFacadeInput,
    run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
  ) => Promise<CodingToolResult>;
}

interface CatalogAction {
  readonly toolId: string;
  readonly arguments: CatalogJsonValue;
}

function workspaceCatalogAction(request: CodingToolActionRequest): CatalogAction | undefined {
  if (request.action === "read")
    return request.startLine === undefined || request.maxLines === undefined
      ? undefined
      : {
          toolId: "keiko.workspace.read",
          arguments: {
            relativePath: request.relativePath,
            startLine: request.startLine,
            maxLines: request.maxLines,
          },
        };
  if (request.action === "discover")
    return {
      toolId: "keiko.workspace.discover",
      arguments: { query: request.query, maxResults: request.maxResults },
    };
  if (request.action !== "search" || request.repositoryRequest.kind !== "search") return undefined;
  const value = request.repositoryRequest;
  return {
    toolId: "keiko.repo.search",
    arguments: {
      mode: value.mode,
      query: value.query,
      caseSensitive: value.caseSensitive,
      includeGlobs: value.includeGlobs,
      excludeGlobs: value.excludeGlobs,
      maxResults: value.maxResults,
    },
  };
}

function editCatalogAction(
  request: Extract<CodingToolActionRequest, { readonly action: "edit" }>,
): CatalogAction {
  return {
    toolId: "keiko.changeset.edit",
    arguments: captureCatalogJson({
      changeset: {
        ...request.changeset,
        selectedFiles:
          request.changeset.selectedFiles ?? request.changeset.files.map((file) => file.file),
      },
    }),
  };
}

// Exhaustive translation from the closed IPC action union into canonical catalog actions.
// eslint-disable-next-line complexity -- each branch names one contract-owned action variant
function catalogActionFor(request: CodingToolActionRequest): CatalogAction | undefined {
  if (request.action === "read" || request.action === "discover" || request.action === "search")
    return workspaceCatalogAction(request);
  if (request.action === "edit") return editCatalogAction(request);
  switch (request.action) {
    case "verification":
      return isOpenCodeVerificationId(request.verifierId)
        ? {
            toolId: "keiko.verification.run",
            arguments: {
              verifierId: request.verifierId,
              targetPath: request.targetPath ?? "",
            },
          }
        : undefined;
    case "egress":
      return { toolId: "keiko.research.fetch", arguments: { target: request.target } };
    case "skill":
      return { toolId: "keiko.skill.invoke", arguments: { skillId: request.skillId } };
    case "child-agent":
      return {
        toolId: "keiko.child.run",
        arguments: { objective: request.objective, maxToolCalls: request.maxToolCalls },
      };
    case "git":
      return gitCatalogAction(request);
    case "delivery":
      return deliveryCatalogAction(request);
    default:
      return undefined;
  }
}

function gitCatalogAction(
  request: Extract<CodingToolActionRequest, { readonly action: "git" }>,
): CatalogAction | undefined {
  if (request.operation === "status") return { toolId: "keiko.git.status", arguments: {} };
  if (request.operation === "diff")
    return {
      toolId: "keiko.git.diff",
      arguments: { scope: request.scope, paths: [...request.paths] },
    };
  if (request.operation === "ci")
    return {
      toolId: "keiko.ci.status",
      arguments: { forceFresh: request.forceFresh ?? false },
    };
  if (request.operation !== "stage") return undefined;
  return request.phase === "propose"
    ? { toolId: "keiko.git.stage", arguments: { paths: [...request.paths] } }
    : {
        toolId: "keiko.git.execute",
        arguments: { kind: "stage", proposalId: request.proposalId },
      };
}

function deliveryCatalogAction(
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): CatalogAction | undefined {
  if (request.intent === "merge" || request.phase === undefined || request.phase === "reconcile")
    return undefined;
  if (request.phase === "execute")
    return request.proposalId === undefined
      ? undefined
      : {
          toolId: "keiko.git.execute",
          arguments: { kind: request.intent, proposalId: request.proposalId },
        };
  if (request.intent === "commit")
    return request.message === undefined
      ? undefined
      : { toolId: "keiko.git.commit", arguments: { message: request.message } };
  if (request.intent === "push") return { toolId: "keiko.git.push", arguments: {} };
  return request.title === undefined
    ? undefined
    : { toolId: "keiko.git.pullrequest", arguments: { title: request.title } };
}

type RequestIdentity = Readonly<{ actionId: string; idempotencyKey: string }>;

function workspaceRepresentative(
  canonicalId: string,
  base: RequestIdentity,
): CodingToolActionRequest | undefined {
  if (canonicalId === "keiko.workspace.discover")
    return { ...base, action: "discover", query: "*", maxResults: 1 };
  if (canonicalId === "keiko.workspace.read")
    return { ...base, action: "read", relativePath: "README.md", startLine: 1, maxLines: 1 };
  if (canonicalId !== "keiko.repo.search") return undefined;
  return {
    ...base,
    action: "search",
    repositoryRequest: {
      kind: "search",
      mode: "literal",
      query: "x",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults: 1,
    },
  };
}

function auxiliaryRepresentative(
  canonicalId: string,
  base: RequestIdentity,
): CodingToolActionRequest | undefined {
  if (canonicalId === "keiko.verification.run")
    return { ...base, action: "verification", verifierId: "test" };
  if (canonicalId === "keiko.research.fetch")
    return { ...base, action: "egress", target: "https://example.invalid/" };
  if (canonicalId === "keiko.skill.invoke")
    return { ...base, action: "skill", skillId: "skl_fixture@1" };
  if (canonicalId === "keiko.child.run")
    return { ...base, action: "child-agent", objective: "inspect", maxToolCalls: 1 };
  return undefined;
}

function deliveryRepresentative(
  canonicalId: string,
  base: RequestIdentity,
): CodingToolActionRequest {
  if (canonicalId === "keiko.git.status") return { ...base, action: "git", operation: "status" };
  if (canonicalId === "keiko.git.diff")
    return { ...base, action: "git", operation: "diff", scope: "working-tree", paths: ["a"] };
  if (canonicalId === "keiko.git.stage")
    return { ...base, action: "git", operation: "stage", phase: "propose", paths: ["a"] };
  if (canonicalId === "keiko.git.commit")
    return { ...base, action: "delivery", intent: "commit", phase: "propose", message: "change" };
  if (canonicalId === "keiko.git.push")
    return { ...base, action: "delivery", intent: "push", phase: "propose" };
  if (canonicalId === "keiko.git.pullrequest")
    return {
      ...base,
      action: "delivery",
      intent: "pull-request",
      phase: "propose",
      title: "Change",
    };
  if (canonicalId === "keiko.git.execute")
    return { ...base, action: "git", operation: "stage", phase: "execute", proposalId: "stage-1" };
  return { ...base, action: "git", operation: "ci", forceFresh: false };
}

function representative(
  canonicalId: string,
  identity: CatalogActionIdentity,
): CodingToolActionRequest {
  const base = { actionId: identity.actionId, idempotencyKey: identity.idempotencyKey };
  const workspace = workspaceRepresentative(canonicalId, base);
  if (workspace !== undefined) return workspace;
  if (canonicalId === "keiko.changeset.edit")
    return {
      ...base,
      action: "edit",
      changeset: {
        patch: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
        files: [{ file: "a", expectedContentHash: "0".repeat(64) }],
        selectedFiles: ["a"],
      },
    };
  return auxiliaryRepresentative(canonicalId, base) ?? deliveryRepresentative(canonicalId, base);
}

function optionalUnavailable(
  canonicalId: string,
  unavailable: ReadonlySet<OpenCodeOptionalToolName>,
): boolean {
  return (
    (canonicalId === "keiko.research.fetch" && unavailable.has("keiko_research_fetch")) ||
    (canonicalId === "keiko.skill.invoke" && unavailable.has("keiko_skill")) ||
    (canonicalId === "keiko.child.run" && unavailable.has("keiko_child_agent"))
  );
}

function receiptBudget(): CatalogToolBudgetPort {
  const live = new Set<string>();
  return {
    available: (_descriptor, context): boolean => !context.signal.aborted,
    reserve: (
      _descriptor,
      context,
      invocationId,
    ): { readonly reservationId: string } | undefined => {
      if (context.signal.aborted || live.has(invocationId)) return undefined;
      live.add(invocationId);
      return { reservationId: invocationId };
    },
    check: (reservation, context): boolean =>
      !context.signal.aborted && live.has(reservation.reservationId),
    commit: (reservation): void => {
      live.delete(reservation.reservationId);
    },
    release: (reservation): void => {
      live.delete(reservation.reservationId);
    },
  };
}

function trustedContext(
  context: CanonicalCatalogContext,
  input: CodingToolFacadeInput,
): CatalogTrustedContext | undefined {
  if (input.capability === undefined) return undefined;
  const signal = input.signal ?? new AbortController().signal;
  return {
    runId: context.runId,
    correlationId: context.correlationId,
    workspaceRoot: context.workspaceRoot,
    workspaceIdentity: context.workspaceIdentity,
    workspaceRevision: context.workspaceRevision,
    authority: input.capability,
    authorityExpiresAt: context.authorityExpiresAt,
    deadlineAt: context.authorityExpiresAt,
    signal,
  };
}

function bindingFor(
  descriptor: ToolDescriptor,
  request: CodingToolActionRequest,
  run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
  recordResult: (result: CodingToolResult) => void,
  unavailable: () => ReadonlySet<OpenCodeOptionalToolName>,
): CatalogToolHandlerBinding {
  return {
    toolRef: descriptor.toolRef,
    descriptorDigest: descriptor.descriptorDigest,
    handlerId: descriptor.handlerRequirement.id,
    handlerVersion: descriptor.handlerRequirement.contractVersion,
    catalogAction: descriptor.actionMapping[0]?.action ?? "",
    readiness: () =>
      optionalUnavailable(descriptor.toolRef.canonicalId, unavailable()) ? "unavailable" : "ready",
    previewAction: (identity) => representative(descriptor.toolRef.canonicalId, identity),
    actionFor: (_argumentsValue, identity) =>
      descriptor.toolRef.canonicalId === catalogActionFor(request)?.toolId
        ? { ...request, actionId: identity.actionId, idempotencyKey: identity.idempotencyKey }
        : representative(descriptor.toolRef.canonicalId, identity),
    execute: async (
      _argumentsValue,
      context: CatalogHandlerContext,
    ): Promise<CatalogHandlerResult> => {
      const result = await run(context.signal, context.mutationGuard);
      recordResult(result);
      if (result.status === "failed") throw new CatalogDispatchFault("failed", "handler-failed");
      return {
        data: captureCatalogJson(result),
        resultCount: 1,
        page: { truncated: false, reason: "none", cursor: null },
      };
    },
  };
}

function executionOverride(
  descriptor: ToolDescriptor,
  request: CodingToolActionRequest,
  run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
  recordResult: (result: CodingToolResult) => void,
): CatalogToolExecutionOverride {
  return {
    toolRef: descriptor.toolRef,
    actionFor: (_argumentsValue, identity) => ({
      ...request,
      actionId: identity.actionId,
      idempotencyKey: identity.idempotencyKey,
    }),
    execute: async (_argumentsValue, context): Promise<CatalogHandlerResult> => {
      const result = await run(context.signal, context.mutationGuard);
      recordResult(result);
      if (result.status === "failed") throw new CatalogDispatchFault("failed", "handler-failed");
      return {
        data: captureCatalogJson(result),
        resultCount: 1,
        page: { truncated: false, reason: "none", cursor: null },
      };
    },
  };
}

type CatalogDispatchOutcome = Awaited<
  ReturnType<ReturnType<typeof createCatalogToolBinderFromPreparation>["dispatch"]>
>;

function preservedExecutedResult(
  outcome: CatalogDispatchOutcome,
  executed: CodingToolResult | undefined,
): CodingToolResult | undefined {
  if (outcome.kind === "replayed") return undefined;
  if (outcome.result.status === "completed" && executed !== undefined) return executed;
  if (
    outcome.result.status === "failed" &&
    outcome.result.reason === "handler-failed" &&
    executed?.status === "failed"
  ) {
    return executed;
  }
  return undefined;
}

function resultFor(
  outcome: CatalogDispatchOutcome,
  executed: CodingToolResult | undefined,
): CodingToolResult {
  if (outcome.kind === "replayed") return { status: "denied", evidence: [] };
  const preserved = preservedExecutedResult(outcome, executed);
  if (preserved !== undefined) return preserved;
  if (outcome.result.status !== "completed") {
    return { status: outcome.result.status, evidence: [] };
  }
  return { status: "failed", evidence: [] };
}

function expiredResult(request: CodingToolActionRequest): CodingToolResult {
  return request.action === "search"
    ? { status: "failed", evidence: [], reasonCode: "search-authority-revoked" }
    : { status: "denied", evidence: [] };
}

function emitExpiredBinding(
  advertisement: ReturnType<typeof createOpenCodeGatewayToolCatalogAdvertisement>,
  context: CanonicalCatalogContext,
  logPort: CatalogLifecycleLogPort,
): void {
  emitToolLifecycleEvent(logPort, {
    op: "tool-catalog.bind-unavailable",
    correlationId: context.correlationId,
    catalogRevision: advertisement.projection.catalogRevision,
    profile: advertisement.projection.profile,
    projectionDigest: advertisement.projection.projectionDigest,
    readiness: "unavailable",
    reason: "authority-expired",
  });
}

function composedBindings(
  descriptors: readonly ToolDescriptor[],
  request: CodingToolActionRequest,
  run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
  recordResult: (result: CodingToolResult) => void,
  unavailable: ReadonlySet<OpenCodeOptionalToolName>,
): readonly CatalogToolHandlerBinding[] {
  return descriptors.flatMap((descriptor) =>
    optionalUnavailable(descriptor.toolRef.canonicalId, unavailable)
      ? []
      : [bindingFor(descriptor, request, run, recordResult, () => unavailable)],
  );
}

function preparedBindings(
  request: CodingToolActionRequest,
  unavailable: () => ReadonlySet<OpenCodeOptionalToolName>,
): readonly CatalogToolHandlerBinding[] {
  return OPENCODE_CATALOG_DESCRIPTORS.map((descriptor) =>
    bindingFor(
      descriptor,
      request,
      (): Promise<CodingToolResult> =>
        Promise.reject(new CatalogDispatchFault("failed", "handler-unavailable")),
      () => undefined,
      unavailable,
    ),
  );
}

/** The same concrete OpenCode handler composition used for dispatch, projected for advertisement. */
export function createCanonicalOpenCodeHandlerCoverage(
  unavailable: ReadonlySet<OpenCodeOptionalToolName>,
): OpenCodeGatewayHandlerCoverage {
  const advertisement = OPENCODE_CATALOG_ADVERTISEMENT;
  const descriptors = OPENCODE_CATALOG_DESCRIPTORS;
  const fallback = representative("keiko.workspace.discover", {
    actionId: "coverage",
    idempotencyKey: "coverage",
  });
  const bindings = composedBindings(
    descriptors,
    fallback,
    (): Promise<CodingToolResult> =>
      Promise.reject(new CatalogDispatchFault("failed", "handler-unavailable")),
    () => undefined,
    unavailable,
  );
  const handlers: readonly CatalogBoundHandler[] = descriptors.map((descriptor) => ({
    descriptor,
    binding: bindings.find(
      (binding) => binding.toolRef.canonicalId === descriptor.toolRef.canonicalId,
    ),
  }));
  return {
    readinessByToolId: new Map(
      handlers.map((handler) => [
        handler.descriptor.toolRef.canonicalId,
        catalogHandlerReadiness(handler),
      ]),
    ),
    handlerSetDigest: computeHandlerSetDigest(advertisement.projection, handlers),
  };
}

interface PreparedDispatchBinder {
  readonly preparation: ReturnType<typeof prepareCatalogToolBinder>;
  readonly preparationFor: (
    unavailable: ReadonlySet<OpenCodeOptionalToolName>,
  ) => ReturnType<typeof prepareCatalogToolBinder>;
}

function unavailableKey(unavailable: ReadonlySet<OpenCodeOptionalToolName>): string {
  return [...unavailable].sort(compareStrings).join(",");
}

function prepareDispatchBinder(
  bridgeInput: CanonicalCatalogFacadeBridgeInput,
): PreparedDispatchBinder {
  const fallback = representative("keiko.workspace.discover", {
    actionId: "catalog-composition",
    idempotencyKey: "catalog-composition",
  });
  const preparation = prepareCatalogToolBinder(
    {
      projection: OPENCODE_CATALOG_ADVERTISEMENT.projection,
      handlerBindings: preparedBindings(
        fallback,
        bridgeInput.unavailableOptionalTools ??
          ((): ReadonlySet<OpenCodeOptionalToolName> => new Set()),
      ),
      authorityPort: {
        preview: bridgeInput.previewAuthority,
        admit: bridgeInput.authority.admit,
      },
      budgetPort: bridgeInput.budgetPort ?? receiptBudget(),
      approvalPort: {
        available: () => bridgeInput.approvalAvailable,
        request: () => Promise.resolve(undefined),
      },
      logPort: bridgeInput.logPort,
    },
    OPENCODE_CATALOG_ADVERTISEMENT.catalog,
  );
  const preparationsByAvailability = new Map<string, typeof preparation>([["", preparation]]);
  const preparationFor = (
    unavailable: ReadonlySet<OpenCodeOptionalToolName>,
  ): typeof preparation => {
    const key = unavailableKey(unavailable);
    const cached = preparationsByAvailability.get(key);
    if (cached !== undefined) return cached;
    const unavailableToolRefs = preparation.handlers.flatMap((handler) =>
      optionalUnavailable(handler.descriptor.toolRef.canonicalId, unavailable)
        ? [handler.descriptor.toolRef]
        : [],
    );
    const variant = deriveCatalogBindingPreparation(preparation, unavailableToolRefs);
    preparationsByAvailability.set(key, variant);
    return variant;
  };
  preparationFor(bridgeInput.unavailableOptionalTools?.() ?? new Set());
  return { preparation, preparationFor };
}

function createDispatchBinder(
  bridgeInput: CanonicalCatalogFacadeBridgeInput,
  prepared: PreparedDispatchBinder,
  descriptor: ToolDescriptor,
  request: CodingToolActionRequest,
  facadeInput: CodingToolFacadeInput,
  run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
  recordResult: (result: CodingToolResult) => void,
): ReturnType<typeof createCatalogToolBinderFromPreparation> {
  const current = bridgeInput.context();
  if (current === undefined) throw new TypeError("Catalog context unavailable");
  const unavailable = bridgeInput.unavailableOptionalTools?.() ?? new Set();
  return createCatalogToolBinderFromPreparation(
    prepared.preparationFor(unavailable),
    {
      catalog: OPENCODE_CATALOG_ADVERTISEMENT.catalog,
      context: () => {
        const live = bridgeInput.context();
        const trusted = live === undefined ? undefined : trustedContext(live, facadeInput);
        if (trusted === undefined) throw new TypeError("Catalog context unavailable");
        return trusted;
      },
      now: () => bridgeInput.context()?.now ?? current.now,
      mintId: randomUUID,
      invocationRegistry: bridgeInput.invocationRegistry,
    },
    executionOverride(descriptor, request, run, recordResult),
  );
}

async function executeCanonical(
  bridgeInput: CanonicalCatalogFacadeBridgeInput,
  preparation: PreparedDispatchBinder,
  request: CodingToolActionRequest,
  facadeInput: CodingToolFacadeInput,
  run: (signal: AbortSignal, mutationGuard: CodingToolMutationGuard) => Promise<CodingToolResult>,
): Promise<CodingToolResult> {
  const action = catalogActionFor(request);
  const current = bridgeInput.context();
  if (action === undefined || current === undefined) return { status: "denied", evidence: [] };
  if (trustedContext(current, facadeInput) === undefined) return { status: "denied", evidence: [] };
  if (Date.parse(current.authorityExpiresAt) <= current.now) {
    emitExpiredBinding(OPENCODE_CATALOG_ADVERTISEMENT, current, bridgeInput.logPort);
    return expiredResult(request);
  }
  const descriptor = OPENCODE_DESCRIPTOR_BY_ID.get(action.toolId);
  if (descriptor === undefined) return { status: "denied", evidence: [] };
  let executed: CodingToolResult | undefined;
  const binder = createDispatchBinder(
    bridgeInput,
    preparation,
    descriptor,
    request,
    facadeInput,
    run,
    (result) => {
      executed = result;
    },
  );
  const offer = binder.offerTool(descriptor.toolRef);
  const outcome = await binder.dispatch(
    {
      kind: "bound",
      toolRef: descriptor.toolRef,
      projectionDigest: OPENCODE_CATALOG_ADVERTISEMENT.projection.projectionDigest,
      offerId: offer.offerId,
      arguments: action.arguments,
    },
    { actionId: request.actionId, idempotencyKey: request.idempotencyKey },
  );
  return resultFor(outcome, executed);
}

function recordUnbound(
  bridgeInput: CanonicalCatalogFacadeBridgeInput,
  request: CodingToolActionRequest,
): void {
  const context = bridgeInput.context();
  bridgeInput.logPort.primary.write({
    category: "security",
    op: "tool-catalog.dispatch-unbound",
    correlationId: context?.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: { action: request.action },
  });
}

export function createCanonicalCatalogFacadeBridge(
  bridgeInput: CanonicalCatalogFacadeBridgeInput,
): CanonicalCatalogFacadeBridge {
  const preparation = prepareDispatchBinder(bridgeInput);
  return {
    covers: (request): boolean => catalogActionFor(request) !== undefined,
    recordUnbound: (request, _facadeInput): void => {
      recordUnbound(bridgeInput, request);
    },
    execute: (request, facadeInput, run): Promise<CodingToolResult> =>
      executeCanonical(bridgeInput, preparation, request, facadeInput, run),
  };
}
