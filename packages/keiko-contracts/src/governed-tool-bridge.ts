import type {
  CatalogCompatibility,
  CatalogDigest,
  CatalogJsonValue,
  CatalogProfile,
  CompiledToolProjection,
  ToolDescriptor,
  ToolRef,
} from "./governed-tool-catalog.js";
import type { ToolCallMetadata } from "./tools.js";
import type {
  BoundToolInvocation,
  CatalogToolDispatchOutcome,
  OfferedToolSet,
} from "./governed-tool-lifecycle.js";

/** Content identity only. The server's handler/authority owners still decide availability. */
export interface ToolCatalogSource {
  readonly catalogRevision: CatalogDigest;
  readonly descriptors: readonly ToolDescriptor[];
  readonly profiles: readonly CatalogProfile[];
  readonly compatibility: readonly CatalogCompatibility[];
}
export interface ToolInvocationBinding {
  readonly catalog: ToolCatalogSource;
  readonly projection: CompiledToolProjection;
  readonly offered: OfferedToolSet;
}
export interface ToolInvocationBudgetReservation {
  readonly reservationId: string;
}
/** Accounting is supplied by the run owner; a binder never creates another run counter. */
export interface ToolInvocationBudgetPort<Context> {
  readonly available: (descriptor: ToolDescriptor, context: Context) => boolean;
  readonly reserve: (
    descriptor: ToolDescriptor,
    context: Context,
    invocationId: string,
  ) => ToolInvocationBudgetReservation | undefined;
  readonly check: (reservation: ToolInvocationBudgetReservation, context: Context) => boolean;
  readonly commit: (reservation: ToolInvocationBudgetReservation) => void;
  readonly release: (reservation: ToolInvocationBudgetReservation) => void;
}
export interface GovernedToolCallRequest {
  readonly toolCallId: string;
  readonly invocation: BoundToolInvocation;
  readonly signal: AbortSignal;
}
/** Trusted handler evidence has no output/argument body and is scoped to the active invocation. */
export interface ToolHandlerExecutionEvidence {
  readonly toolRef: ToolRef;
  readonly toolCallId: string;
  readonly durationMs: number;
  readonly commandExecuted: boolean;
  readonly metadata?: ToolCallMetadata;
}
export interface WorkspaceCatalogHandlerCall {
  readonly toolCallId: string;
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
  readonly arguments: CatalogJsonValue;
  readonly signal: AbortSignal;
  readonly beforeEffect: () => boolean;
  readonly observeExecution: (evidence: ToolHandlerExecutionEvidence) => void;
}
/** Governed tool execution accepts only a server-bound canonical invocation. */
export interface CatalogToolPort {
  readonly kind: "catalog";
  readonly offer: () => GatewayToolCatalogAdvertisement;
  readonly execute: (request: GovernedToolCallRequest) => Promise<CatalogToolDispatchOutcome>;
}
export type GatewayToolCatalogAdvertisement = ToolInvocationBinding & { readonly kind: "bound" };
