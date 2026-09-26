// HTML Manual Knowledge Pod source contract (Epic #1853, Issue #1871).
//
// This module bridges the redacted consent handoff produced by Epic #1852
// (`DocumentationIndexingApproval`) into an internal Local Knowledge crawl source that the
// crawler (#1872–#1875) consumes and that maps onto the EXISTING `KnowledgeSourceScope`,
// capsule, indexing, and Knowledge Pod summary machinery — no second store, no parallel
// retrieval path.
//
// Two representations live side by side, following the same split the rest of the Local
// Knowledge surface uses:
//   • `HtmlManualCrawlScope` / `HtmlManualSource` are INTERNAL, unredacted runtime state (they
//     carry the raw local root or the raw intranet origin). Like `KnowledgeSourceScope`, they
//     stay inside the local-knowledge runtime and are never sent to a browser surface.
//   • `HtmlManualSourceSummary` is the redacted, browser-safe projection — counts/labels/hashes
//     only, mirroring the redaction posture of `DocumentationIndexingApproval`.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports; pure types and
// pure validators only (no IO, no clock, no hashing, no randomness). The opaque
// `sourceFingerprint` is computed downstream in `keiko-server` (the leaf contracts layer cannot
// hash) and is only VERIFIED here.

import {
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  type DocumentationIndexingApproval,
  type DocumentationManualScopeLimits,
  type DocumentationManualSourceKind,
} from "./documentation-manual-proposal.js";
import type { KnowledgeSourceScope } from "./local-knowledge.js";
import { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";
import { LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS } from "./local-knowledge-file-selection.js";
import { containsAbsolutePath, stripUnsafeFormatChars } from "./text-safety.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const HTML_MANUAL_SOURCE_SCHEMA_VERSION = "1" as const;
export const HTML_MANUAL_SOURCE_KIND_TAG_PREFIX = "keiko-html-manual-source-kind:" as const;
export const HTML_MANUAL_SOURCE_FINGERPRINT_TAG_PREFIX =
  "keiko-html-manual-source-fingerprint:" as const;

// Include globs used when an HTML manual is indexed through the existing folder-scope
// discovery path. KEIKO-0948: derived from LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS so
// adding a new HTML extension to the parser registry automatically widens the manual crawler's
// include set — no second hand-listed table to keep in sync.
export const HTML_MANUAL_INCLUDE_GLOBS: readonly string[] = Object.freeze(
  LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS.map((ext) => `**/*.${ext}`),
);

// ─── Internal (unredacted) crawl scope ──────────────────────────────────────────
// `kind` is intentionally the same literal set as `DocumentationManualSourceKind` so the
// approval's `sourceKind` and the scope discriminant cannot drift.
//
// The `html-manual-local` variant is intentionally NOT exposed by any live server route
// for this release (#2906 KEIKO-0554). The domain-layer fetcher exists in keiko-local-knowledge
// (`createWorkspaceFsManualFetcher`) with TOCTOU-hardening comments and unit tests, but
// keiko-server's `fetcherFor` unconditionally constructs the HTTP fetcher and manual-pod-routes
// exposes no local-root selection input. Wiring the local kind through a live route requires
// (1) branching in `fetcherFor` on the scope discriminant, (2) route-layer workspace
// authorization equivalent to `resolveRegisteredOrManagedWorkspaceRoot`, and (3) an
// end-to-end symlink-escape negative test. Until all three land, the local variant is
// declaration-only.
export type HtmlManualCrawlScope =
  | {
      readonly kind: "html-manual-local";
      // Workspace-relative safe path to the manual root (validated by `isSafeScopePath`).
      readonly rootPath: string;
      // Seed page relative to `rootPath` the link-graph crawl starts from (e.g. "index.html").
      // A safe relative storage reference; when omitted the crawler defaults to "index.html".
      readonly entryPath?: string;
    }
  | {
      readonly kind: "html-manual-http";
      // Canonical origin `scheme://host[:port]`, no path/query/fragment/credentials.
      readonly origin: string;
      // Same-origin path prefix the crawl is confined to. `null` means the origin root.
      readonly pathPrefix: string | null;
    };

export type HtmlManualSourceKind = HtmlManualCrawlScope["kind"];

export interface HtmlManualSourceTagMetadata {
  readonly sourceKind?: HtmlManualSourceKind;
  readonly sourceFingerprint?: string;
}

// A fully specified, bounded crawl input derived from an approved manual proposal. Internal
// runtime state: it carries the raw root/origin and therefore never crosses a browser wire.
export interface HtmlManualSource {
  readonly schemaVersion: typeof HTML_MANUAL_SOURCE_SCHEMA_VERSION;
  readonly scope: HtmlManualCrawlScope;
  readonly limits: DocumentationManualScopeLimits;
  // Opaque, content-free hash of the normalized root (computed downstream, verified here).
  readonly sourceFingerprint: string;
  // Redacted, already-safe display label carried through from the approval.
  readonly proposedPodName: string;
}

// Redacted, browser-safe projection of an `HtmlManualSource`. No raw path, origin path,
// credential, query, or fragment — only the same redaction-safe summaries the approval carries.
export interface HtmlManualSourceSummary {
  readonly sourceKind: DocumentationManualSourceKind;
  readonly originSummary: string;
  readonly pathPrefixSummary: string | null;
  readonly sourceFingerprint: string;
  readonly proposedPodName: string;
}

// ─── Origin / path-prefix safety (pure) ─────────────────────────────────────────
function parseManualOrigin(origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  return url;
}

// A safe manual origin is exactly the canonical origin `scheme://host[:port]` (no trailing
// path, no userinfo, no query/fragment). Requiring string equality with `URL.origin` rejects
// `http://host/some/path` and credentialed forms in one check.
export function isSafeManualOrigin(origin: string): boolean {
  const url = parseManualOrigin(origin);
  return url !== null && origin === url.origin;
}

// A safe manual path prefix is `null` (origin root) or an absolute-style same-origin prefix
// with no traversal, credential, query, or fragment markers. It stays internal, but is still
// validated so a tampered scope cannot smuggle a query token or a `..` escape.
// NUL, the query/fragment delimiters, an embedded credential separator, and the Windows separator.
const MANUAL_PATH_PREFIX_FORBIDDEN: readonly string[] = ["\0", "?", "#", "@", "\\"];

export function isSafeManualPathPrefix(prefix: string | null): boolean {
  if (prefix === null) return true;
  if (prefix.length === 0 || !prefix.startsWith("/")) return false;
  // A prefix beginning `//` (or `/\`, which browsers normalise to `//`) is a protocol-relative
  // reference, not a path: resolved against the approved origin it names a DIFFERENT authority
  // (`new URL("//attacker.example/x", "https://intranet.local")` is `https://attacker.example/x`).
  // Certifying that as a same-origin prefix would be an approval-scope escape, so it is rejected
  // here rather than left to each consumer to re-check.
  if (prefix.startsWith("//") || prefix.startsWith("/\\")) return false;
  if (MANUAL_PATH_PREFIX_FORBIDDEN.some((character) => prefix.includes(character))) return false;
  return !prefix.split("/").includes("..");
}

// ─── Redaction-safe display text (mirrors documentation-manual-proposal backstop) ──
function isManualRedactionSafe(value: string): boolean {
  if (stripUnsafeFormatChars(value) !== value) return false;
  if (containsAbsolutePath(value)) return false;
  return !value.includes("@") && !value.includes("?") && !value.includes("#");
}

// ─── Scope validation ───────────────────────────────────────────────────────────
function validateLocalScope(input: Record<string, unknown>, errors: string[]): void {
  if (typeof input.rootPath !== "string" || !isSafeScopePath(input.rootPath)) {
    errors.push("scope.rootPath is unsafe or empty");
  }
  if (
    input.entryPath !== undefined &&
    (typeof input.entryPath !== "string" || !isSafeStorageReference(input.entryPath))
  ) {
    errors.push("scope.entryPath must be a safe relative path when set");
  }
}

function validateHttpScope(input: Record<string, unknown>, errors: string[]): void {
  if (typeof input.origin !== "string" || !isSafeManualOrigin(input.origin)) {
    errors.push(
      "scope.origin must be a canonical scheme://host[:port] with no path or credentials",
    );
  }
  const prefix = input.pathPrefix;
  if (prefix !== null && typeof prefix !== "string") {
    errors.push("scope.pathPrefix must be a string or null");
  } else if (!isSafeManualPathPrefix(prefix)) {
    errors.push(
      "scope.pathPrefix must be a same-origin path with no traversal, query, or fragment",
    );
  }
}

export function validateHtmlManualCrawlScope(
  input: unknown,
): LocalKnowledgeValidation<HtmlManualCrawlScope> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["scope must be an object"] };
  }
  const record = input as Record<string, unknown>;
  const errors: string[] = [];
  if (record.kind === "html-manual-local") {
    validateLocalScope(record, errors);
  } else if (record.kind === "html-manual-http") {
    validateHttpScope(record, errors);
  } else {
    return { ok: false, errors: ["scope.kind must be html-manual-local or html-manual-http"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: record as unknown as HtmlManualCrawlScope };
}

// ─── Limits validation (narrow-only against the governed defaults) ──────────────
function isPositiveIntWithin(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

export function validateHtmlManualScopeLimits(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return ["limits must be an object"];
  }
  const limits = input as Record<string, unknown>;
  const errors: string[] = [];
  const bounds = DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS;
  if (!isPositiveIntWithin(limits.maxPages, bounds.maxPages)) errors.push("limits.maxPages");
  if (!isPositiveIntWithin(limits.maxDepth, bounds.maxDepth)) errors.push("limits.maxDepth");
  if (!isPositiveIntWithin(limits.maxBytes, bounds.maxBytes)) errors.push("limits.maxBytes");
  if (!isPositiveIntWithin(limits.maxLinkSample, bounds.maxLinkSample)) {
    errors.push("limits.maxLinkSample");
  }
  if (!isPositiveIntWithin(limits.timeoutMs, bounds.timeoutMs)) errors.push("limits.timeoutMs");
  if (limits.followRedirects !== false) errors.push("limits.followRedirects");
  return errors.map((field) => `${field} must not widen the governed default`);
}

// ─── HtmlManualSource validation ────────────────────────────────────────────────
function validateSourceIdentity(record: Record<string, unknown>, errors: string[]): void {
  if (record.schemaVersion !== HTML_MANUAL_SOURCE_SCHEMA_VERSION) {
    errors.push('source.schemaVersion must be the literal "1"');
  }
  if (typeof record.sourceFingerprint !== "string" || record.sourceFingerprint.length === 0) {
    errors.push("source.sourceFingerprint must be a non-empty token");
  } else if (!isManualRedactionSafe(record.sourceFingerprint)) {
    errors.push("source.sourceFingerprint must be redaction-safe");
  }
  if (
    typeof record.proposedPodName !== "string" ||
    !isManualRedactionSafe(record.proposedPodName)
  ) {
    errors.push("source.proposedPodName must be a redaction-safe label");
  }
}

export function validateHtmlManualSource(
  input: unknown,
): LocalKnowledgeValidation<HtmlManualSource> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["source must be an object"] };
  }
  const record = input as Record<string, unknown>;
  const errors: string[] = [];
  const scopeResult = validateHtmlManualCrawlScope(record.scope);
  if (!scopeResult.ok) errors.push(...scopeResult.errors);
  errors.push(...validateHtmlManualScopeLimits(record.limits));
  validateSourceIdentity(record, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: record as unknown as HtmlManualSource };
}

// ─── Approval → source bridge (fail-closed) ─────────────────────────────────────
export interface DeriveHtmlManualSourceInput {
  // The redacted consent handoff produced by Epic #1852. Its `sourceFingerprint`, `sourceKind`,
  // and `limits` are the governance tokens.
  readonly approval: DocumentationIndexingApproval;
  // The raw (internal) crawl scope the server resolved from the approved target.
  readonly scope: HtmlManualCrawlScope;
  // The fingerprint the server recomputed from the raw scope. Must equal the approval's, proving
  // the raw scope is the one the user actually approved.
  readonly computedFingerprint: string;
}

// Represent an approved manual as an internal crawl source. Fails closed when the recomputed
// fingerprint or the source kind do not match the approval — a crawler must never operate on a
// scope the user did not approve. Because contracts cannot hash, the caller supplies the
// recomputed fingerprint; this function only checks equality.
export function deriveHtmlManualSource(
  input: DeriveHtmlManualSourceInput,
): LocalKnowledgeValidation<HtmlManualSource> {
  const { approval, scope, computedFingerprint } = input;
  const errors: string[] = [];
  if (scope.kind !== approval.sourceKind) {
    errors.push("scope.kind must match the approved sourceKind");
  }
  if (computedFingerprint.length === 0 || computedFingerprint !== approval.sourceFingerprint) {
    errors.push("computedFingerprint must match the approved sourceFingerprint");
  }
  if (errors.length > 0) return { ok: false, errors };
  return validateHtmlManualSource({
    schemaVersion: HTML_MANUAL_SOURCE_SCHEMA_VERSION,
    scope,
    limits: approval.limits,
    sourceFingerprint: approval.sourceFingerprint,
    proposedPodName: approval.proposedPodName,
  });
}

// ─── Redacted browser projection ────────────────────────────────────────────────
function manualPathPrefixSummary(scope: HtmlManualCrawlScope): string | null {
  if (scope.kind === "html-manual-local") return null;
  return scope.pathPrefix === null || scope.pathPrefix === "/" ? "/" : "/…";
}

// Project an internal source onto the redaction-safe summary a browser surface may render. The
// raw local root and the origin path never appear: local sources collapse to "local file";
// http sources expose only the canonical origin and a "/" or "/…" path shape.
export function summarizeHtmlManualSource(source: HtmlManualSource): HtmlManualSourceSummary {
  const { scope } = source;
  const originSummary = scope.kind === "html-manual-local" ? "local file" : scope.origin;
  return {
    sourceKind: scope.kind,
    originSummary,
    pathPrefixSummary: manualPathPrefixSummary(scope),
    sourceFingerprint: source.sourceFingerprint,
    proposedPodName: source.proposedPodName,
  };
}

// ─── Mapping onto existing KnowledgeSourceScope ─────────────────────────────────
// A local HTML manual reuses the existing `folder` scope: the same walker, extractor, HTML
// parser, chunker, indexer, and Knowledge Pod summary path a folder source already flows
// through. No new scope kind is added to `KnowledgeSourceScope`.
export function htmlManualLocalFolderScope(scope: {
  readonly kind: "html-manual-local";
  readonly rootPath: string;
}): KnowledgeSourceScope {
  return {
    kind: "folder",
    rootPath: scope.rootPath,
    recursive: true,
    includeGlobs: HTML_MANUAL_INCLUDE_GLOBS,
  };
}

// A crawl (local or http) that has already resolved its bounded set of reachable pages maps
// onto the existing `files` scope: only the link-reachable pages are indexed, never the whole
// tree. `rootPath` is the manual root (a real workspace-relative path for local manuals, or a
// synthetic virtual root for http manuals backed by an in-memory workspace fs); `files` are the
// reachable page paths relative to that root. Returns `null` when the inputs are unsafe so the
// caller fails closed instead of building an unusable scope.
export function htmlManualReachableFilesScope(
  rootPath: string,
  files: readonly string[],
): KnowledgeSourceScope | null {
  if (!isSafeScopePath(rootPath) || files.length === 0) return null;
  for (const file of files) {
    if (!isSafeStorageReference(file)) return null;
  }
  return { kind: "files", rootPath, files: [...files] };
}

export function htmlManualSourceKindTag(kind: HtmlManualSourceKind): string {
  return `${HTML_MANUAL_SOURCE_KIND_TAG_PREFIX}${kind}`;
}

export function htmlManualSourceFingerprintTag(sourceFingerprint: string): string {
  return `${HTML_MANUAL_SOURCE_FINGERPRINT_TAG_PREFIX}${sourceFingerprint}`;
}

// KEIKO-0785: fail closed instead of last-write-wins. An empty fingerprint suffix is a defect on
// the producer side, not a valid absent-fingerprint signal — omit the field so downstream code
// can distinguish "no fingerprint" from "empty fingerprint". Two conflicting kind tags on the
// same manifest is also a defect the parser must not silently paper over: neither wins.
interface TagCollector<T> {
  value: T | undefined;
  conflict: boolean;
}

function absorbConflictingValue<T>(collector: TagCollector<T>, next: T): void {
  if (collector.value !== undefined && collector.value !== next) {
    collector.conflict = true;
    return;
  }
  collector.value = next;
}

function parseKindTag(tag: string, kindCollector: TagCollector<HtmlManualSourceKind>): boolean {
  if (tag === htmlManualSourceKindTag("html-manual-local")) {
    absorbConflictingValue(kindCollector, "html-manual-local");
    return true;
  }
  if (tag === htmlManualSourceKindTag("html-manual-http")) {
    absorbConflictingValue(kindCollector, "html-manual-http");
    return true;
  }
  return false;
}

function parseFingerprintTag(tag: string, fingerprintCollector: TagCollector<string>): boolean {
  if (!tag.startsWith(HTML_MANUAL_SOURCE_FINGERPRINT_TAG_PREFIX)) return false;
  const suffix = tag.slice(HTML_MANUAL_SOURCE_FINGERPRINT_TAG_PREFIX.length);
  if (suffix.length > 0) absorbConflictingValue(fingerprintCollector, suffix);
  return true;
}

export function parseHtmlManualSourceTagMetadata(
  tags: readonly string[],
): HtmlManualSourceTagMetadata {
  const kindCollector: TagCollector<HtmlManualSourceKind> = { value: undefined, conflict: false };
  const fingerprintCollector: TagCollector<string> = { value: undefined, conflict: false };
  for (const tag of tags) {
    if (parseKindTag(tag, kindCollector)) continue;
    parseFingerprintTag(tag, fingerprintCollector);
  }
  return {
    ...(kindCollector.value !== undefined && !kindCollector.conflict
      ? { sourceKind: kindCollector.value }
      : {}),
    ...(fingerprintCollector.value !== undefined && !fingerprintCollector.conflict
      ? { sourceFingerprint: fingerprintCollector.value }
      : {}),
  };
}
