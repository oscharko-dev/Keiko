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

/** Finite migration consumers; issue 3415 removes this vocabulary and the legacy arm. */
export const LEGACY_NATIVE_TOOL_CONSUMERS = Object.freeze([
  "native-harness",
  "workspace-tool-host",
  "cli-run",
  "server-run-engine",
  "sdk",
] as const);
export type LegacyNativeToolConsumer = (typeof LEGACY_NATIVE_TOOL_CONSUMERS)[number];

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
/** Server-held migration evidence; never read from model arguments or provider output. */
export interface LegacyNativeToolSession {
  readonly consumer: LegacyNativeToolConsumer;
  readonly profile: { readonly id: "legacy-native"; readonly version: 1 };
  readonly catalogRevision: CatalogDigest;
  readonly projectionDigest: CatalogDigest;
  readonly offerId: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly ownerIssue: 3409;
  readonly removalIssue: 3415;
}
export interface LegacyNamedToolInvocation {
  readonly kind: "legacy-name";
  readonly name: string;
  readonly arguments: CatalogJsonValue;
}
export type ToolInvocationBridge = BoundToolInvocation | LegacyNamedToolInvocation;
export interface GovernedToolCallRequest {
  readonly toolCallId: string;
  readonly invocation: ToolInvocationBridge;
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
/** Additive ToolPort capability. New callers must use this arm and cannot fall back on absence. */
export interface CatalogToolPort {
  readonly kind: "catalog";
  readonly offer: () => GatewayToolCatalogAdvertisement;
  readonly execute: (request: GovernedToolCallRequest) => Promise<CatalogToolDispatchOutcome>;
}
export type GatewayToolCatalogAdvertisement = ToolInvocationBinding &
  (
    | { readonly kind: "bound"; readonly legacySession?: never }
    | { readonly kind: "legacy-native"; readonly legacySession: LegacyNativeToolSession }
  );
