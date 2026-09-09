import { deepFreeze } from "./deep-freeze.js";
import type { CodingWorkbenchActionClass } from "./coding-workbench.js";

declare const canonicalToolIdBrand: unique symbol;
declare const catalogDigestBrand: unique symbol;
export type CanonicalToolId = string & { readonly [canonicalToolIdBrand]: true };
export type CatalogDigest = string & { readonly [catalogDigestBrand]: true };

export type CatalogJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CatalogJsonValue[]
  | { readonly [key: string]: CatalogJsonValue };
export type CatalogJsonObject = Readonly<Record<string, CatalogJsonValue>>;

/** Safety ceilings from ADR-0175; measured performance targets remain separately owned. */
export const TOOL_CATALOG_LIMITS = Object.freeze({
  maxArgumentBytes: 262_144,
  maxResultBytes: 262_144,
  maxSchemaDepth: 16,
  maxObjectKeys: 128,
  maxArrayItems: 1_000,
  maxStringBytes: 65_536,
  maxCursorBytes: 4_096,
  maxCursorLifetimeMs: 300_000,
  maxCompatibilityLifetimeMs: 604_800_000,
});

export interface ToolRef {
  readonly canonicalId: CanonicalToolId;
  readonly contractVersion: number;
}
export interface CatalogVersionRef {
  readonly id: string;
  readonly version: number;
}
export interface CatalogRuntimeRef {
  readonly id: string;
  readonly version: string;
}

/** Possible effects reuse the authoritative product vocabulary; they confer no permission. */
export type CatalogEffect = CodingWorkbenchActionClass;
export interface CatalogActionMapping {
  readonly action: string;
  readonly effects: readonly CatalogEffect[];
}
export interface CatalogHandlerRequirement {
  readonly id: string;
  readonly contractVersion: number;
}
export interface ToolResultBounds {
  readonly maxArgumentBytes: number;
  readonly maxResultBytes: number;
  readonly maxResultCount: number;
  readonly maxDurationMs: number;
}
export type CatalogIdempotency = "read-only" | "server-key-required";
export type CatalogCancellation = "cooperative" | "before-effect";

export interface ToolDescriptor {
  readonly toolRef: ToolRef;
  readonly description: string;
  readonly inputSchema: CatalogJsonObject;
  readonly resultSchema: CatalogJsonObject;
  readonly effects: readonly CatalogEffect[];
  readonly actionMapping: readonly CatalogActionMapping[];
  readonly policyReferences: readonly string[];
  readonly handlerRequirement: CatalogHandlerRequirement;
  readonly bounds: ToolResultBounds;
  readonly idempotency: CatalogIdempotency;
  readonly cancellation: CatalogCancellation;
  readonly descriptorDigest: CatalogDigest;
}
export type ToolDescriptorDeclaration = Omit<ToolDescriptor, "descriptorDigest">;

export interface CatalogProfileToolRef {
  readonly toolRef: ToolRef;
  readonly alias: string;
}
export interface CatalogNativeExtension {
  readonly alias: "question" | "todowrite";
  readonly contractVersion: 1;
}
export interface CatalogCompatibilityEndpoint {
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
}
export interface CatalogCompatibility {
  readonly from: CatalogCompatibilityEndpoint;
  readonly to: CatalogCompatibilityEndpoint;
  readonly profile: CatalogVersionRef;
  readonly adapter: CatalogRuntimeRef;
  readonly transformId: "identity-v1";
  readonly ownerIssue: number;
  readonly expiresAt: string;
  readonly removalIssue: number;
}
export interface CatalogProfile {
  readonly profile: CatalogVersionRef;
  readonly catalogRevision: CatalogDigest;
  readonly toolRefs: readonly CatalogProfileToolRef[];
  readonly nativeExtensions: readonly CatalogNativeExtension[];
  readonly adapterDialect: CatalogVersionRef;
  readonly adapterRuntime: CatalogRuntimeRef;
  readonly compatibility: readonly CatalogCompatibility[];
}
export type CatalogProfileDeclaration = Omit<CatalogProfile, "catalogRevision">;

export interface CompiledCatalogTool extends ToolDescriptor {
  readonly alias: string;
}
export interface CompiledToolProjection {
  readonly catalogRevision: CatalogDigest;
  readonly profile: CatalogVersionRef;
  readonly adapterDialect: CatalogVersionRef;
  readonly adapterRuntime: CatalogRuntimeRef;
  readonly tools: readonly CompiledCatalogTool[];
  readonly nativeExtensions: readonly CatalogNativeExtension[];
  readonly projectionDigest: CatalogDigest;
}
export interface CatalogManifest {
  readonly schemaVersion: 1;
  readonly catalogRevision: CatalogDigest;
  readonly profile: CatalogVersionRef;
  readonly projectionDigest: CatalogDigest;
  readonly toolRefs: readonly ToolRef[];
  readonly descriptorDigests: readonly CatalogDigest[];
  readonly bounds: readonly ToolResultBounds[];
  readonly compatibility: readonly CatalogCompatibility[];
}

export const TOOL_RESULT_REASONS = deepFreeze({
  completed: ["none"],
  denied: [
    "authority-invalid",
    "authority-expired",
    "authority-revoked",
    "hard-denial",
    "approval-required",
    "approval-rejected",
    "budget-exhausted",
    "workspace-denied",
    "effect-denied",
  ],
  invalid: [
    "unknown-tool",
    "unoffered-tool",
    "ambiguous-alias",
    "invalid-arguments",
    "version-mismatch",
    "projection-mismatch",
    "unsupported-capability",
    "cursor-invalid",
    "cursor-expired",
    "cursor-replayed",
    "workspace-stale",
    "replay-conflict",
    "recovery-required",
  ],
  busy: ["invocation-in-flight", "capacity-exhausted"],
  cancelled: ["explicit-cancellation", "parent-cancelled"],
  timeout: ["deadline-exceeded"],
  failed: [
    "handler-unavailable",
    "handler-mismatch",
    "handler-failed",
    "result-contract-failed",
    "effect-outcome-unknown",
    "budget-port-failed",
  ],
} as const);
export type ToolResultStatus = keyof typeof TOOL_RESULT_REASONS;
export type ToolResultReason<S extends ToolResultStatus = ToolResultStatus> =
  (typeof TOOL_RESULT_REASONS)[S][number];
export const TOOL_PAGE_REASONS = Object.freeze([
  "none",
  "result-cap",
  "byte-cap",
  "file-cap",
  "inventory-cap",
  "time-cap",
  "cancelled",
  "oversized-file",
  "denied-file",
  "stale-index",
] as const);
export interface ToolResultPage {
  readonly truncated: boolean;
  readonly reason: (typeof TOOL_PAGE_REASONS)[number];
  readonly cursor: string | null;
}
export interface ToolResultMetrics {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly resultCount: number;
  readonly durationMs: number;
}
interface ToolResultIdentity {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly toolRef: ToolRef | null;
  readonly projectionDigest: CatalogDigest | null;
  readonly effectStarted: boolean;
  readonly metrics: ToolResultMetrics;
}
type ToolFailureEnvelope = {
  readonly [S in Exclude<ToolResultStatus, "completed">]: ToolResultIdentity & {
    readonly status: S;
    readonly reason: ToolResultReason<S>;
    readonly page: null;
    readonly data: null;
  };
}[Exclude<ToolResultStatus, "completed">];
export type ToolResultEnvelope =
  | (ToolResultIdentity & {
      readonly status: "completed";
      readonly reason: "none";
      readonly page: ToolResultPage;
      readonly data: CatalogJsonValue;
    })
  | ToolFailureEnvelope;
