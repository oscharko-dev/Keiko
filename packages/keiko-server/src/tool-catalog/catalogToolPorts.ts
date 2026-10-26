import type {
  ToolAuthorityAvailability,
  ToolConsumerActionIdentity,
  ToolConsumerContext,
  ToolEffectGuard,
  ToolInvocationBudgetPort,
  ToolInvocationBudgetReservation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogDigest,
  CatalogProfile,
  ToolDescriptor,
  CatalogJsonValue,
  CatalogJsonObject,
  CompiledToolProjection,
  ToolRef,
  ToolResultPage,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ToolHandlerReadiness,
  BoundToolSet,
  OfferedToolSet,
  CatalogToolDispatchOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import type { ToolCatalog } from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import type { CodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import type { CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";

export type CatalogActionIdentity = ToolConsumerActionIdentity;
/** Legacy Coding scope; a non-Coding consumer supplies its own context without these fields. */
export interface CatalogTrustedContext extends ToolConsumerContext {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
  readonly workspaceRevision: string;
}
export interface CatalogConsumer {
  readonly context: ToolConsumerContext;
  readonly action: ToolConsumerActionIdentity;
  readonly guard: ToolEffectGuard;
}
export interface CodingCatalogConsumer extends CatalogConsumer {
  readonly context: CatalogTrustedContext;
  readonly action: CodingToolActionRequest;
  readonly guard: CodingToolMutationGuard;
}
export type CatalogHandlerContext<Consumer extends CatalogConsumer = CodingCatalogConsumer> =
  Consumer["context"] & {
    readonly invocationId: string;
    readonly signal: AbortSignal;
    readonly mutationGuard: Consumer["guard"];
    /** Existing handler ports must check this at the final effect boundary and honor false. */
    readonly beforeEffect: () => boolean;
    readonly pageSequence: number;
    readonly createCursor: () => string;
  };
export interface CatalogHandlerResult {
  readonly data: unknown;
  readonly page: ToolResultPage;
  readonly resultCount: number;
}
export interface CatalogToolHandlerBinding<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
> {
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
  readonly handlerId: string;
  readonly handlerVersion: number;
  readonly catalogAction: string;
  readonly readiness: () => ToolHandlerReadiness;
  /** Trusted representative action for availability; dispatch resolves the actual arguments. */
  readonly previewAction: (identity: CatalogActionIdentity) => Consumer["action"];
  readonly actionFor: (
    argumentsValue: CatalogJsonValue,
    identity: CatalogActionIdentity,
  ) => Consumer["action"];
  readonly execute: (
    argumentsValue: CatalogJsonValue,
    context: CatalogHandlerContext<Consumer>,
  ) => Promise<CatalogHandlerResult>;
}
/** Invocation-local behavior for a statically verified production handler identity. */
export interface CatalogToolExecutionOverride<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
> {
  readonly toolRef: ToolRef;
  /** Server-only codec for the exact private original-Read descriptor and actual bound profile. */
  readonly captureNativeReadAction?:
    ((value: CatalogJsonValue) => Consumer["action"] | undefined) | undefined;
  readonly actionFor: CatalogToolHandlerBinding<Consumer>["actionFor"];
  readonly execute: CatalogToolHandlerBinding<Consumer>["execute"];
}
export type CatalogToolBudgetReservation = ToolInvocationBudgetReservation;
export type CatalogToolBudgetPort<Consumer extends CatalogConsumer = CodingCatalogConsumer> =
  ToolInvocationBudgetPort<Consumer["context"]>;
export interface CatalogToolApprovalPort<Consumer extends CatalogConsumer = CodingCatalogConsumer> {
  readonly available: (request: Consumer["action"], context: Consumer["context"]) => boolean;
  readonly request: (
    request: Consumer["action"],
    context: Consumer["context"],
  ) => Promise<Consumer["action"] | undefined>;
}
export interface CatalogBoundAuthorityPort<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
> {
  readonly preview: (
    capability: string | undefined,
    request: Consumer["action"],
  ) => ToolAuthorityAvailability;
  readonly admit: (
    capability: string | undefined,
    request: Consumer["action"],
  ) =>
    | { readonly ok: true; readonly mutationGuard: Consumer["guard"] }
    | { readonly ok: false; readonly reason?: string | undefined };
}
/** The consumer owns action decoding; catalog admission, budgets and settlement stay shared. */
export interface CatalogConsumerPort<Consumer extends CatalogConsumer = CodingCatalogConsumer> {
  readonly scope: (context: Consumer["context"]) => CatalogJsonObject;
  readonly staleReason: "workspace-stale" | "consumer-stale";
  readonly requiredEffects: (request: Consumer["action"]) => ToolDescriptor["effects"];
  readonly captureAction: (
    handler: CatalogBoundHandler<Consumer>,
    captured: CatalogJsonValue,
    executionOverride: CatalogToolExecutionOverride<Consumer> | undefined,
    profile: CatalogProfile | undefined,
  ) => Consumer["action"] | undefined;
  readonly captureApprovedAction: (captured: CatalogJsonValue) => Consumer["action"] | undefined;
}
export interface CatalogBoundHandler<Consumer extends CatalogConsumer = CodingCatalogConsumer> {
  readonly descriptor: ToolDescriptor;
  readonly binding: CatalogToolHandlerBinding<Consumer> | undefined;
}
export interface CatalogToolBinderInput<Consumer extends CatalogConsumer = CodingCatalogConsumer> {
  readonly consumerPort: CatalogConsumerPort<Consumer>;
  readonly projection: CompiledToolProjection;
  readonly handlerBindings: readonly CatalogToolHandlerBinding<Consumer>[];
  readonly authorityPort: CatalogBoundAuthorityPort<Consumer>;
  readonly budgetPort: CatalogToolBudgetPort<Consumer>;
  readonly approvalPort: CatalogToolApprovalPort<Consumer>;
  readonly logPort: CatalogLifecycleLogPort;
}
export interface CatalogToolBinderOptions<
  Consumer extends CatalogConsumer = CodingCatalogConsumer,
> {
  readonly catalog: ToolCatalog;
  readonly context: () => Consumer["context"];
  readonly now: () => number;
  /** Production composition supplies unpredictable IDs with at least 128 bits of entropy. */
  readonly mintId: () => string;
  readonly invocationRegistry: CodingToolInvocationRegistry;
}
export interface CatalogToolBinder {
  readonly dispatchPage: (
    input: unknown,
    identity: CatalogActionIdentity,
    cursor: string,
  ) => Promise<CatalogToolDispatchOutcome>;
  readonly binding: () => BoundToolSet;
  readonly offer: () => OfferedToolSet;
  /** Build a live, invocation-local offer without enumerating unrelated catalog entries. */
  readonly offerTool: (toolRef: ToolRef) => OfferedToolSet;
  readonly dispatch: (
    input: unknown,
    identity: CatalogActionIdentity,
  ) => Promise<CatalogToolDispatchOutcome>;
}
export interface CatalogHandlerAvailability {
  readonly readiness: ToolHandlerReadiness;
  readonly authority: ToolAuthorityAvailability;
}

export type {
  BoundToolSet,
  OfferedToolSet,
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
