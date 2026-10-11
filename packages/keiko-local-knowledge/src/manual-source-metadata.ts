import { pathToFileURL } from "node:url";
import type {
  DocumentationManualScopeLimits,
  DocumentId,
  HtmlManualSource,
  HtmlManualSourceKind,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { validateHtmlManualSource } from "@oscharko-dev/keiko-contracts/runtime/html-manual-source";
import { validateManualRefreshChangeSummary } from "@oscharko-dev/keiko-contracts/runtime/html-manual-refresh";
import { isSafeStorageReference } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-paths";

import { listCapsuleSources } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

export const HTML_MANUAL_SOURCE_SCOPE_VERSION = 1 as const;

// Structural replacement for `value.replace(/\/+$/u, "")` (Sonar S8786): an unanchored
// character-class quantifier anchored only at `$` forces the engine to retry the match at every
// position inside a run of "/" when the string does not end in "/" — O(n^2) on a long slash run
// (e.g. many slashes followed by one non-slash character). A single backward scan over the
// trailing run is O(n) and strips exactly the same characters for every input.
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

interface HtmlManualSourceMetadataRow {
  readonly capsule_id: string;
  readonly source_id: string;
  readonly source_kind: HtmlManualSourceKind;
  readonly source_fingerprint: string;
  readonly root_path: string | null;
  readonly entry_path: string | null;
  readonly origin: string | null;
  readonly path_prefix: string | null;
  // Approved crawl limits (Epic #1856, Issue #1890) — persisted so an explicit refresh reproduces
  // the exact bounded crawl without widening scope. Nullable for rows written before v27.
  readonly max_pages: number | null;
  readonly max_depth: number | null;
  readonly max_bytes: number | null;
  readonly max_link_sample: number | null;
  readonly timeout_ms: number | null;
  readonly follow_redirects: number | null;
  readonly source_scope_version: number | null;
  readonly last_refreshed_at: number | null;
  readonly last_crawl_run_id: string | null;
  readonly last_change_summary_json: string | null;
}

interface DocumentTargetRow {
  readonly document_path: string;
  readonly safe_display_name: string;
}

export interface HtmlManualSourceMetadata {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly sourceKind: HtmlManualSourceKind;
  readonly sourceFingerprint: string;
  readonly rootPath?: string;
  readonly entryPath?: string;
  readonly origin?: string;
  readonly pathPrefix?: string | null;
  // Approved crawl limits, present once the row has been written at schema v27+. Absent for a
  // legacy pre-v27 row (a refresh then falls back to the governed defaults). See #1890.
  readonly limits?: DocumentationManualScopeLimits;
  // Refresh-time compatibility gate for the approved crawl-scope shape. v27 legacy rows may omit
  // it; known rows are written as HTML_MANUAL_SOURCE_SCOPE_VERSION and refresh fails closed on any
  // future, unsupported value.
  readonly sourceScopeVersion?: number;
  // Additive refresh bookkeeping (#1856). Present only after at least one refresh has run.
  readonly lastRefreshedAt?: number;
  readonly lastCrawlRunId?: string;
  readonly lastChangeSummaryJson?: string;
}

export type HtmlManualCitationTargetFailureReason =
  | "source-metadata-unavailable"
  | "citation-lineage-mismatch"
  | "target-outside-approved-scope"
  | "target-unsupported";

export type HtmlManualCitationTargetResolution =
  | {
      readonly ok: true;
      readonly target: string;
      readonly sourceKind: HtmlManualSourceKind;
      readonly pageTitle: string;
      readonly safePageId: string;
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: HtmlManualCitationTargetFailureReason };

type TargetForMetadataResolution =
  | { readonly ok: true; readonly target: string }
  | {
      readonly ok: false;
      readonly reason: Extract<
        HtmlManualCitationTargetFailureReason,
        "target-outside-approved-scope" | "target-unsupported"
      >;
    };

export interface ResolveHtmlManualCitationTargetInput {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly anchorId?: string;
}

type ManualMetadataFailureCode =
  | "HTML_MANUAL_SOURCE_INVALID"
  | "HTML_MANUAL_SUMMARY_INVALID_JSON"
  | "HTML_MANUAL_SUMMARY_INVALID_SHAPE"
  | "HTML_MANUAL_SUMMARY_NONCANONICAL";

class ManualMetadataValidationError extends TypeError {
  readonly code: ManualMetadataFailureCode;
  constructor(code: ManualMetadataFailureCode) {
    super("manual-metadata-validation-failed");
    this.code = code;
  }
}

interface CapturedManualScope {
  readonly kinds: readonly HtmlManualSourceKind[];
  readonly rootPath: string | null;
  readonly entryPath: string | null | undefined;
  readonly origin: string | null;
  readonly pathPrefix: string | null;
}

interface CapturedManualSource {
  readonly kind: HtmlManualSourceKind;
  readonly fingerprint: string;
  readonly fields: CapturedManualScope;
  readonly createdAt: number;
  readonly limits: Omit<DocumentationManualScopeLimits, "followRedirects">;
}

function captureManualScope(scope: HtmlManualSource["scope"]): CapturedManualScope {
  const rootKind = scope.kind;
  const rootPath = rootKind === "html-manual-local" ? scope.rootPath : null;
  const entryKind = scope.kind;
  const entryPath = entryKind === "html-manual-local" ? scope.entryPath : null;
  const originKind = scope.kind;
  const origin = originKind === "html-manual-http" ? scope.origin : null;
  const prefixKind = scope.kind;
  const pathPrefix = prefixKind === "html-manual-http" ? scope.pathPrefix : null;
  return {
    kinds: [rootKind, entryKind, originKind, prefixKind],
    rootPath,
    entryPath,
    origin,
    pathPrefix,
  };
}

function captureManualSource(
  store: KnowledgeStore,
  source: HtmlManualSource,
  scope: HtmlManualSource["scope"],
  limits: DocumentationManualScopeLimits,
): CapturedManualSource {
  const kind = scope.kind;
  const fingerprint = source.sourceFingerprint;
  const fields = captureManualScope(scope);
  const createdAt = store._internal.now();
  const capturedLimits = {
    maxPages: limits.maxPages,
    maxDepth: limits.maxDepth,
    maxBytes: limits.maxBytes,
    maxLinkSample: limits.maxLinkSample,
    timeoutMs: limits.timeoutMs,
  };
  // These three extra observations qualify previously trusted typed input at the writer.
  const schemaVersion = source.schemaVersion;
  const proposedPodName = source.proposedPodName;
  const followRedirects = limits.followRedirects;
  const selectedScope =
    kind === "html-manual-local"
      ? { kind, rootPath: fields.rootPath, entryPath: fields.entryPath }
      : { kind, origin: fields.origin, pathPrefix: fields.pathPrefix };
  const checked = validateHtmlManualSource({
    schemaVersion,
    scope: selectedScope,
    limits: { ...capturedLimits, followRedirects },
    sourceFingerprint: fingerprint,
    proposedPodName,
  });
  if (!fields.kinds.every((observed) => observed === kind) || !checked.ok)
    throw new ManualMetadataValidationError("HTML_MANUAL_SOURCE_INVALID");
  return { kind, fingerprint, fields, createdAt, limits: capturedLimits };
}

// The checked captured values are bound without rereading the original mutable source.
export function persistHtmlManualSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  source: HtmlManualSource,
): void {
  const scope = source.scope;
  const limits = source.limits;
  const statement = store._internal.db.prepare(
    [
      "INSERT OR REPLACE INTO html_manual_sources (",
      "  capsule_id, source_id, source_kind, source_fingerprint, root_path, entry_path,",
      "  origin, path_prefix, created_at, max_pages, max_depth, max_bytes, max_link_sample,",
      "  timeout_ms, follow_redirects, source_scope_version",
      ") VALUES (:capsule_id, :source_id, :source_kind, :source_fingerprint, :root_path,",
      "  :entry_path, :origin, :path_prefix, :created_at, :max_pages, :max_depth, :max_bytes,",
      "  :max_link_sample, :timeout_ms, :follow_redirects, :source_scope_version)",
    ].join(" "),
  );
  const captured = captureManualSource(store, source, scope, limits);
  statement.run({
    capsule_id: capsuleId,
    source_id: sourceId,
    source_kind: captured.kind,
    source_fingerprint: captured.fingerprint,
    root_path: captured.fields.rootPath,
    entry_path: captured.fields.entryPath ?? null,
    origin: captured.fields.origin,
    path_prefix: captured.fields.pathPrefix,
    created_at: captured.createdAt,
    max_pages: captured.limits.maxPages,
    max_depth: captured.limits.maxDepth,
    max_bytes: captured.limits.maxBytes,
    max_link_sample: captured.limits.maxLinkSample,
    timeout_ms: captured.limits.timeoutMs,
    follow_redirects: 0,
    source_scope_version: HTML_MANUAL_SOURCE_SCOPE_VERSION,
  });
}

export interface HtmlManualRefreshState {
  readonly lastRefreshedAt: number;
  readonly lastCrawlRunId: string;
  readonly changeSummaryJson: string;
}

function validateCapturedSummary(bytes: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new ManualMetadataValidationError("HTML_MANUAL_SUMMARY_INVALID_JSON");
  }
  const checked = validateManualRefreshChangeSummary(parsed);
  if (!checked.ok) throw new ManualMetadataValidationError("HTML_MANUAL_SUMMARY_INVALID_SHAPE");
  if (JSON.stringify(checked.value) !== bytes)
    throw new ManualMetadataValidationError("HTML_MANUAL_SUMMARY_NONCANONICAL");
}

// Only this metadata UPDATE is refused atomically; earlier refresh apply work is not rolled back.
export function updateHtmlManualRefreshState(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  state: HtmlManualRefreshState,
): void {
  const statement = store._internal.db.prepare(
    [
      "UPDATE html_manual_sources SET",
      "  last_refreshed_at = :last_refreshed_at,",
      "  last_crawl_run_id = :last_crawl_run_id,",
      "  last_change_summary_json = :last_change_summary_json",
      "WHERE capsule_id = :capsule_id AND source_id = :source_id",
    ].join(" "),
  );
  const lastRefreshedAt = state.lastRefreshedAt;
  const lastCrawlRunId = state.lastCrawlRunId;
  const bytes = state.changeSummaryJson;
  validateCapturedSummary(bytes);
  statement.run({
    capsule_id: capsuleId,
    source_id: sourceId,
    last_refreshed_at: lastRefreshedAt,
    last_crawl_run_id: lastCrawlRunId,
    last_change_summary_json: bytes,
  });
}

export function readHtmlManualSourceMetadata(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): HtmlManualSourceMetadata | undefined {
  const row = store._internal.db
    .prepare(
      "SELECT * FROM html_manual_sources WHERE capsule_id = :capsuleId AND source_id = :sourceId",
    )
    .get({ capsuleId, sourceId }) as HtmlManualSourceMetadataRow | undefined;
  return row === undefined ? undefined : rowToMetadata(row);
}

// Reconstruct the approved crawl limits from a persisted row. Returns undefined for a legacy
// pre-v27 row (any limit column NULL) so the caller can fall back to the governed defaults.
function limitsFromRow(
  row: HtmlManualSourceMetadataRow,
): DocumentationManualScopeLimits | undefined {
  if (
    row.max_pages === null ||
    row.max_depth === null ||
    row.max_bytes === null ||
    row.max_link_sample === null ||
    row.timeout_ms === null ||
    row.follow_redirects === null
  ) {
    return undefined;
  }
  return {
    maxPages: row.max_pages,
    maxDepth: row.max_depth,
    maxBytes: row.max_bytes,
    maxLinkSample: row.max_link_sample,
    timeoutMs: row.timeout_ms,
    // The governed limits contract pins followRedirects to the literal `false`; a manual crawl never
    // follows redirects. The 0/1 column exists only for a possible future governed override.
    followRedirects: false,
  };
}

function rowToMetadata(row: HtmlManualSourceMetadataRow): HtmlManualSourceMetadata {
  const limits = limitsFromRow(row);
  return {
    capsuleId: row.capsule_id as KnowledgeCapsuleId,
    sourceId: row.source_id as KnowledgeSourceId,
    sourceKind: row.source_kind,
    sourceFingerprint: row.source_fingerprint,
    ...(row.root_path !== null ? { rootPath: row.root_path } : {}),
    ...(row.entry_path !== null ? { entryPath: row.entry_path } : {}),
    ...(row.origin !== null ? { origin: row.origin } : {}),
    ...(row.path_prefix !== null ? { pathPrefix: row.path_prefix } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(row.source_scope_version !== null ? { sourceScopeVersion: row.source_scope_version } : {}),
    ...(row.last_refreshed_at !== null ? { lastRefreshedAt: row.last_refreshed_at } : {}),
    ...(row.last_crawl_run_id !== null ? { lastCrawlRunId: row.last_crawl_run_id } : {}),
    ...(row.last_change_summary_json !== null
      ? { lastChangeSummaryJson: row.last_change_summary_json }
      : {}),
  };
}

export function resolveHtmlManualCitationTarget(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
): HtmlManualCitationTargetResolution {
  const metadata = readHtmlManualSourceMetadata(store, input.capsuleId, input.sourceId);
  if (metadata === undefined) return { ok: false, reason: "source-metadata-unavailable" };
  const document = readDocumentTarget(store, input);
  if (document === undefined) return { ok: false, reason: "citation-lineage-mismatch" };
  const relativePath = documentRelativePath(store, input, document.document_path);
  if (relativePath === undefined) return { ok: false, reason: "target-outside-approved-scope" };
  const target = targetForMetadata(metadata, relativePath, input.anchorId);
  if (!target.ok) return target;
  return {
    ok: true,
    target: target.target,
    sourceKind: metadata.sourceKind,
    pageTitle: document.safe_display_name,
    safePageId: String(input.documentId),
    relativePath,
  };
}

function readDocumentTarget(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
): DocumentTargetRow | undefined {
  return store._internal.db
    .prepare(
      [
        "SELECT document_path, safe_display_name FROM documents",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId AND id = :documentId",
      ].join(" "),
    )
    .get({
      capsuleId: input.capsuleId,
      sourceId: input.sourceId,
      documentId: input.documentId,
    }) as DocumentTargetRow | undefined;
}

function documentRelativePath(
  store: KnowledgeStore,
  input: ResolveHtmlManualCitationTargetInput,
  documentPath: string,
): string | undefined {
  const source = listCapsuleSources(store, input.capsuleId).find(
    (candidate) => candidate.id === input.sourceId,
  );
  if (source === undefined) return undefined;
  const relative = relativePathForSource(source, documentPath);
  return relative !== undefined && isSafeStorageReference(relative) ? relative : undefined;
}

function relativePathForSource(source: KnowledgeSource, documentPath: string): string | undefined {
  const scope = source.scope;
  if (scope.kind !== "files" && scope.kind !== "folder") return undefined;
  const root = stripTrailingSlashes(scope.rootPath);
  const prefix = `${root}/`;
  if (documentPath.startsWith(prefix)) return documentPath.slice(prefix.length);
  return isSafeStorageReference(documentPath) ? documentPath : undefined;
}

function targetForMetadata(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
  anchorId: string | undefined,
): TargetForMetadataResolution {
  const target =
    metadata.sourceKind === "html-manual-http"
      ? httpTarget(metadata, relativePath)
      : localTarget(metadata, relativePath);
  if (!target.ok || anchorId === undefined) return target;
  const url = new URL(target.target);
  url.hash = anchorId;
  return { ok: true, target: url.href };
}

function httpTarget(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
): TargetForMetadataResolution {
  if (metadata.origin === undefined) return { ok: false, reason: "target-unsupported" };
  const url = new URL(relativePath, `${metadata.origin}/`);
  // Epic #1854 audit hardening — an upstream gate (relativePathForSource, scope.kind
  // "files"/"folder" with a synthetic-root-prefix strip) already prevents an attacker-shaped
  // absolute-URL relativePath from reaching this function in production, but this boundary must
  // fail closed on its own rather than rely solely on that caller always sanitizing first.
  if (url.origin !== new URL(`${metadata.origin}/`).origin) {
    return { ok: false, reason: "target-outside-approved-scope" };
  }
  if (!isWithinApprovedHttpPath(url.pathname, metadata.pathPrefix)) {
    return { ok: false, reason: "target-outside-approved-scope" };
  }
  return { ok: true, target: url.href };
}

function isWithinApprovedHttpPath(pathname: string, prefix: string | null | undefined): boolean {
  if (prefix === undefined || prefix === null || prefix.length === 0 || prefix === "/") return true;
  const withoutTrailingSlash = stripTrailingSlashes(prefix);
  const normalized = withoutTrailingSlash.startsWith("/")
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function localTarget(
  metadata: HtmlManualSourceMetadata,
  relativePath: string,
): TargetForMetadataResolution {
  if (metadata.rootPath?.startsWith("/") !== true) {
    return { ok: false, reason: "target-unsupported" };
  }
  return {
    ok: true,
    target: pathToFileURL(`${stripTrailingSlashes(metadata.rootPath)}/${relativePath}`).href,
  };
}
