import { deepFreeze } from "./deep-freeze.js";
import type { CodingWorkbenchActionClass } from "./coding-workbench.js";
import type { ToolDefinition } from "./gateway.js";
import {
  EDITOR_AGENT_ACTION_MAX_BODY_BYTES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
} from "./editor-agent.js";

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

/** A catalog-compiled gateway definition retains its admitted recursive JSON schema. */
export interface CatalogGatewayToolDefinition extends ToolDefinition {
  readonly parameters: CatalogJsonObject;
}

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

/** The byte ceilings of one tool call's arguments: the whole call, and any one string in it. */
export interface ToolArgumentLimits {
  readonly maxArgumentBytes: number;
  readonly maxStringBytes: number;
}

/** The canonical id of the governed changeset edit, the one tool whose arguments are file content. */
export const GOVERNED_CHANGESET_EDIT_TOOL_ID = "keiko.changeset.edit";
/** The name the model and the coding runtime know the governed changeset edit by. */
export const GOVERNED_CHANGESET_EDIT_TOOL_ALIAS = "keiko_changeset_edit";
/**
 * The canonical ids of the legacy patch tools (`propose_patch`, `apply_patch`): their one argument
 * is a unified diff, the same content the changeset edit carries (owner decision, 2026-10-29, #4110).
 */
export const GOVERNED_PATCH_PROPOSE_TOOL_ID = "keiko.patch.propose";
export const GOVERNED_PATCH_APPLY_TOOL_ID = "keiko.patch.apply";

// The tools whose arguments are file content and so follow the shared patch ceiling.
const PATCH_CONTENT_TOOL_IDS: ReadonlySet<string> = new Set([
  GOVERNED_CHANGESET_EDIT_TOOL_ID,
  GOVERNED_PATCH_PROPOSE_TOOL_ID,
  GOVERNED_PATCH_APPLY_TOOL_ID,
]);

/** The ceilings every tool call is held to unless `toolArgumentLimits` names a larger one. */
export const GENERIC_TOOL_ARGUMENT_LIMITS: ToolArgumentLimits = Object.freeze({
  maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
  maxStringBytes: TOOL_CATALOG_LIMITS.maxStringBytes,
});

/**
 * The ceilings of one call whose arguments are file content: a `keiko_changeset_edit` call (owner
 * decision, 2026-10-28: Keiko refuses no coding data at 64 KiB) and, since the owner decision of
 * 2026-10-29 (#4110), a `propose_patch` or `apply_patch` call. They are the shared patch cap, not a
 * second figure: one `oldString`, `newString` or `diff` may carry up to
 * `EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES` (`GOVERNED_PATCH_MAX_BYTES`) UTF-8 bytes, and one call
 * may carry what one editor action may (`EDITOR_AGENT_ACTION_MAX_BODY_BYTES`: the old and new text
 * of a changeset at the cap, JSON escaping of quotes and line breaks, and a mebibyte of envelope).
 * The materialized diff stays bounded by the cap itself, so these remain runaway safeguards of the
 * wire, and the generic catalog ceilings are unchanged for every other tool.
 */
export const CHANGESET_EDIT_ARGUMENT_LIMITS: ToolArgumentLimits = Object.freeze({
  maxArgumentBytes: EDITOR_AGENT_ACTION_MAX_BODY_BYTES,
  maxStringBytes: EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
});

/** The argument ceilings of the tool with this canonical id. */
export function toolArgumentLimits(canonicalId: string): ToolArgumentLimits {
  return PATCH_CONTENT_TOOL_IDS.has(canonicalId)
    ? CHANGESET_EDIT_ARGUMENT_LIMITS
    : GENERIC_TOOL_ARGUMENT_LIMITS;
}

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

/**
 * The native ("keiko") adapter runtime every non-OpenCode dialect pins against. Its version names
 * the native tool-calling CONTRACT and moves only when that contract changes; it is deliberately
 * not the product version. Profile declarations carry this reference into `catalogRevision` and
 * `projectionDigest`, so while it followed the release number every version bump changed the identity
 * of a catalog in which no tool, schema or dialect had changed, and with it the manifest and the
 * container-measured evidence bound to that identity (#3565). It lives in the contracts leaf so the
 * tool catalog, the harness and the evidence tooling share ONE value instead of re-deriving it
 * (b3-25: three hand-copied literals once drifted apart on a bump).
 *
 * The value is frozen at what it was when it was decoupled from the release number, so the
 * decoupling itself changed no catalog identity. It is a contract version from here on and says
 * nothing about the product version that happens to ship it.
 */
export const NATIVE_TOOL_CATALOG_RUNTIME: CatalogRuntimeRef = Object.freeze({
  id: "keiko",
  version: "1.1.1",
});

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
  readonly alias: "question" | "execute";
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
    "consumer-stale",
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
    "provider-reported-error",
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
    readonly reason: Exclude<ToolResultReason<S>, "provider-reported-error">;
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
  | (ToolResultIdentity & {
      readonly status: "failed";
      readonly reason: "provider-reported-error";
      readonly page: null;
      readonly data: CatalogJsonObject;
    })
  | ToolFailureEnvelope;
