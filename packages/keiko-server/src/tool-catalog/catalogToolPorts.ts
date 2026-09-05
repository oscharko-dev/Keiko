import type {
  ToolInvocationBudgetPort,
  ToolInvocationBudgetReservation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogDigest,
  CatalogJsonValue,
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
import type {
  CodingToolAuthorityAvailability,
  CodingToolAuthorityPreview,
} from "../coding-runtime/codingToolAuthorityPort.js";
import type {
  CodingToolAuthorityPort,
  CodingToolMutationGuard,
} from "../coding-runtime/codingToolFacadePorts.js";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import type { CodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import type { CatalogLifecycleLogPort } from "./catalogToolLifecycle.js";

export interface CatalogActionIdentity {
  readonly actionId: string;
  readonly idempotencyKey: string;
}
/** Server composition supplies this context. It is never accepted as model/browser arguments. */
export interface CatalogTrustedContext {
  readonly runId: string;
  readonly correlationId: string;
  readonly parentCorrelationId?: string;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: string;
  readonly workspaceRevision: string;
  readonly authority: string;
  readonly authorityExpiresAt: string;
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
}
export interface CatalogHandlerContext extends CatalogTrustedContext {
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly mutationGuard: CodingToolMutationGuard;
  /** Existing handler ports must check this at the final effect boundary and honor false. */
  readonly beforeEffect: () => boolean;
  readonly pageSequence: number;
  readonly createCursor: () => string;
}
export interface CatalogHandlerResult {
  readonly data: unknown;
  readonly page: ToolResultPage;
  readonly resultCount: number;
}
export interface CatalogToolHandlerBinding {
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
  readonly handlerId: string;
  readonly handlerVersion: number;
  readonly catalogAction: string;
  readonly readiness: () => ToolHandlerReadiness;
  /** Trusted representative action for availability; dispatch resolves the actual arguments. */
  readonly previewAction: (identity: CatalogActionIdentity) => CodingToolActionRequest;
  readonly actionFor: (
    argumentsValue: CatalogJsonValue,
    identity: CatalogActionIdentity,
  ) => CodingToolActionRequest;
  readonly execute: (
    argumentsValue: CatalogJsonValue,
    context: CatalogHandlerContext,
  ) => Promise<CatalogHandlerResult>;
}
export type CatalogToolBudgetReservation = ToolInvocationBudgetReservation;
export type CatalogToolBudgetPort = ToolInvocationBudgetPort<CatalogTrustedContext>;
export interface CatalogToolApprovalPort {
  readonly available: (request: CodingToolActionRequest, context: CatalogTrustedContext) => boolean;
  readonly request: (
    request: CodingToolActionRequest,
    context: CatalogTrustedContext,
  ) => Promise<CodingToolActionRequest | undefined>;
}
export interface CatalogBoundAuthorityPort {
  readonly preview: CodingToolAuthorityPreview;
  readonly admit: CodingToolAuthorityPort["admit"];
}
export interface CatalogToolBinderInput {
  readonly projection: CompiledToolProjection;
  readonly handlerBindings: readonly CatalogToolHandlerBinding[];
  readonly authorityPort: CatalogBoundAuthorityPort;
  readonly budgetPort: CatalogToolBudgetPort;
  readonly approvalPort: CatalogToolApprovalPort;
  readonly logPort: CatalogLifecycleLogPort;
}
export interface CatalogToolBinderOptions {
  readonly catalog: ToolCatalog;
  readonly context: () => CatalogTrustedContext;
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
  readonly dispatch: (
    input: unknown,
    identity: CatalogActionIdentity,
  ) => Promise<CatalogToolDispatchOutcome>;
}
export interface CatalogHandlerAvailability {
  readonly readiness: ToolHandlerReadiness;
  readonly authority: CodingToolAuthorityAvailability;
}

export type {
  BoundToolSet,
  OfferedToolSet,
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
