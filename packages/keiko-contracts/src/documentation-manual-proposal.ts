// Epic #1852 — indexable HTML manual proposal contracts (child issues #1865–#1870).
//
// This module is the consent boundary that turns the governed documentation browser (Epic #1851,
// ADR-0113) from a passive viewer into a *proposed* Knowledge Pod source candidate. It adds the
// wire contracts, deterministic detection heuristic, bounded scope preview, already-indexed matcher,
// and approved-handoff shape that later crawler/indexing work (Epic #1853) consumes.
//
// Non-negotiable invariants (ADR-0113 + Epic #1852):
//   * Opening or classifying a page is NEVER consent to crawl or index it. Every proposal defaults to
//     `approvalRequired: true` / `approved: false`.
//   * Pre-consent detection and preview are PURE over the user-entered target string and its WHATWG-URL
//     classification. They perform no filesystem read, no network egress, no page-body fetch, no model
//     call, and no recursive link discovery. There is nothing here to crawl.
//   * Nothing crossing the wire carries a raw HTML body, query string, fragment, credential, cookie,
//     private local path, or provider endpoint. Target summaries are modelled separately from raw URLs
//     and are redacted with the shared text-safety primitives.
//   * The contract fails closed: an unparseable target, an unsupported scheme, an embedded credential,
//     or an unknown page shape resolves to a non-approvable state, never to "ready to index".

import {
  classifyDocumentationTarget,
  DOCUMENTATION_NAVIGATION_REASONS,
  DOCUMENTATION_TARGET_MAX_LENGTH,
  type DocumentationNavigationReason,
  type DocumentationTargetClass,
} from "./documentation-browser.js";
import type { KnowledgePodSummary } from "./local-knowledge-pods.js";
import {
  containsAbsolutePath,
  redactAbsolutePaths,
  stripUnsafeFormatChars,
} from "./text-safety.js";

export const DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION = "1" as const;

// ─── Source kind ────────────────────────────────────────────────────────────────────

// A local-file manual and an intranet/loopback HTTP manual are different security boundaries: the
// former needs explicit local file/folder approval before any read; the latter is same-origin/
// path-prefix scoped. The source kind is carried so the (future) crawler epic can enforce the right
// boundary without re-deriving it.
export const DOCUMENTATION_MANUAL_SOURCE_KINDS = ["html-manual-local", "html-manual-http"] as const;

export type DocumentationManualSourceKind = (typeof DOCUMENTATION_MANUAL_SOURCE_KINDS)[number];

// ─── Proposal state ─────────────────────────────────────────────────────────────────

// Closed set of proposal states. Approvable states can lead to an explicit consent action; every
// other state is a governed limitation that the UI must render without offering approval.
export const DOCUMENTATION_MANUAL_PROPOSAL_STATES = [
  // Detection has not run for the current target.
  "not-evaluated",
  // Strong signal this is a static HTML manual (index entry, or html document under a docs path).
  "likely-manual",
  // Some signal this could be a manual; the user must review the scope before approving.
  "probable-manual",
  // A local file manual candidate that additionally requires explicit local file/folder approval.
  "requires-local-file-approval",
  // The scheme/target class is not a manual Keiko will offer to index (public or unsupported).
  "unsupported",
  // The target was rejected fail-closed (embedded credential, malformed request).
  "denied",
  // The target needs authentication Keiko will not collect or replay.
  "authentication-required",
  // A Knowledge Pod already covers this manual's normalized root; offer the existing pod instead.
  "already-indexed",
  // Detection ran but the target shape is dynamic/unknown or a backend is unavailable; not offered.
  "degraded",
] as const;

export type DocumentationManualProposalState =
  (typeof DOCUMENTATION_MANUAL_PROPOSAL_STATES)[number];

// Approvable states are the ONLY states for which the UI may surface a consent action. Everything
// else is informational/remediation only (child issue #1869).
const APPROVABLE_PROPOSAL_STATES: ReadonlySet<DocumentationManualProposalState> = new Set([
  "likely-manual",
  "probable-manual",
  "requires-local-file-approval",
]);

/** True only for proposal states that may lead to an explicit indexing consent action. */
export function isApprovableProposalState(state: DocumentationManualProposalState): boolean {
  return APPROVABLE_PROPOSAL_STATES.has(state);
}

// ─── Reason codes ───────────────────────────────────────────────────────────────────

// Machine reason codes explaining a proposal state. The UI owns the human copy; the contract owns the
// closed reason set so the UI never parses a raw URL/exception to decide what to say.
export const DOCUMENTATION_MANUAL_PROPOSAL_REASONS = [
  "index-html-entry",
  "documentation-path-pattern",
  "html-document-extension",
  "directory-style-target",
  "intranet-manual-host",
  "loopback-documentation-server",
  "local-file-manual-candidate",
  "external-target-not-offered",
  "unsupported-scheme",
  "credentials-in-target",
  "authentication-required",
  "dynamic-or-action-page",
  "unknown-page-shape",
  "already-indexed-pod",
  "backend-unavailable",
  "invalid-target",
] as const;

export type DocumentationManualProposalReason =
  (typeof DOCUMENTATION_MANUAL_PROPOSAL_REASONS)[number];

export type DocumentationManualConfidence = "high" | "medium" | "low" | "none";

// ─── Detection result (pure, URL-shape only) ─────────────────────────────────────────

export interface DocumentationManualDetection {
  readonly state: DocumentationManualProposalState;
  readonly sourceKind: DocumentationManualSourceKind | null;
  readonly confidence: DocumentationManualConfidence;
  readonly reasons: readonly DocumentationManualProposalReason[];
}

// ─── Bounded scope preview (advisory, no egress) ─────────────────────────────────────

// Advisory posture toward a site owner's robots.txt. It is a preference signal for crawlers, NOT an
// access-control mechanism, and it is NOT fetched pre-consent — the field records the policy Keiko's
// later crawler will honour, so the user can see it before approving.
export type DocumentationManualRobotsPosture = "honor-robots-txt" | "not-applicable";

// Redaction-safe classes of link the (future) crawl will refuse. Reported as reason codes only; the UI
// renders counts/labels, never raw denied URLs.
export const DOCUMENTATION_MANUAL_DENIED_LINK_CLASSES = [
  "cross-origin",
  "outside-path-prefix",
  "unsupported-scheme",
  "credentialed-url",
  "path-traversal",
] as const;

export type DocumentationManualDeniedLinkClass =
  (typeof DOCUMENTATION_MANUAL_DENIED_LINK_CLASSES)[number];

// `cross-origin` and `outside-path-prefix` are HTTP-origin/path-scope concepts that do not exist for a
// local-file manual (there is no origin and the path is never exposed, per `pathPrefixSummary`).
// Reporting them for `html-manual-local` would be a misleading exclusion in the pre-consent preview.
const LOCAL_FILE_DENIED_LINK_CLASSES: readonly DocumentationManualDeniedLinkClass[] = [
  "unsupported-scheme",
  "credentialed-url",
  "path-traversal",
];

// Bounded, explicit crawl limits. These are the caps the later indexing epic will enforce; surfacing
// them pre-consent is the trust contract of child issue #1867. They are declarations, not the result
// of any sampling run.
export interface DocumentationManualScopeLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly maxLinkSample: number;
  readonly timeoutMs: number;
  readonly followRedirects: false;
}

// The default governed limits. Small and conservative; the crawler epic may narrow but not widen them.
export const DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS: DocumentationManualScopeLimits =
  Object.freeze({
    maxPages: 200,
    maxDepth: 4,
    maxBytes: 25_000_000,
    maxLinkSample: 64,
    timeoutMs: 15_000,
    followRedirects: false,
  });

export interface DocumentationManualScopePreview {
  readonly sourceKind: DocumentationManualSourceKind;
  // Redacted origin: `scheme://host[:port]` or the literal "local file". Never a path/query/credential.
  readonly originSummary: string;
  // Redacted path-prefix shape: "/" for a root-scoped manual, "/…" for a sub-path scope, null for
  // local-file (whose path is never exposed).
  readonly pathPrefixSummary: string | null;
  // Human-safe pod name proposal derived only from already-redacted material (host or a generic label).
  readonly proposedPodName: string;
  // Estimated page count is only knowable by sampling, which is deferred until consent — so it is
  // always null pre-consent. The field is present so the UI can state "not yet sampled" honestly.
  readonly estimatedPageCount: null;
  readonly limits: DocumentationManualScopeLimits;
  readonly deniedLinkClasses: readonly DocumentationManualDeniedLinkClass[];
  readonly robotsPosture: DocumentationManualRobotsPosture;
}

// ─── Proposal + approval handoff ─────────────────────────────────────────────────────

export interface DocumentationIndexingProposal {
  readonly schemaVersion: typeof DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION;
  readonly state: DocumentationManualProposalState;
  readonly targetClass: DocumentationTargetClass;
  readonly sourceKind: DocumentationManualSourceKind | null;
  readonly confidence: DocumentationManualConfidence;
  readonly reasons: readonly DocumentationManualProposalReason[];
  readonly originSummary: string;
  readonly pathPrefixSummary: string | null;
  // Present only for approvable proposals; null for every non-approvable state.
  readonly scopePreview: DocumentationManualScopePreview | null;
  // Set only for the already-indexed state: the safe id of the pod that already covers this root.
  readonly alreadyIndexedPodId: string | null;
  // Consent is always explicitly required and never pre-granted.
  readonly approvalRequired: true;
  readonly approved: false;
}

// The minimal, redaction-safe consent record handed to the future crawler epic (#1853). It proves the
// user approved a bounded scope; it carries an opaque source fingerprint (a hash — never the raw root)
// so a later indexing run can de-duplicate, and the redacted summaries + scope limits it was approved
// under. It is transient: producing it starts no crawl and writes no index state.
export interface DocumentationIndexingApproval {
  readonly schemaVersion: typeof DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION;
  readonly approved: true;
  readonly sourceKind: DocumentationManualSourceKind;
  // Opaque, content-free fingerprint of the normalized root (computed downstream with a hash helper).
  readonly sourceFingerprint: string;
  readonly originSummary: string;
  readonly pathPrefixSummary: string | null;
  readonly proposedPodName: string;
  readonly limits: DocumentationManualScopeLimits;
}

// ─── URL-shape heuristic helpers (pure) ──────────────────────────────────────────────

const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"] as const;
const INDEX_ENTRY_NAMES = ["index.html", "index.htm", "index.xhtml", "default.html"] as const;
const DOCUMENTATION_PATH_TOKENS = [
  "/docs",
  "/doc/",
  "/manual",
  "/handbook",
  "/guide",
  "/help",
  "/wiki",
  "/documentation",
  "/reference",
  "/api-docs",
] as const;
// Dynamic/interactive endpoints that are never a static manual entry point.
const ACTION_PATH_TOKENS = [
  "/login",
  "/logout",
  "/signin",
  "/sign-in",
  "/signout",
  "/sign-out",
  "/auth",
  "/oauth",
  "/session",
  "/action",
  "/search",
] as const;

function lastPathSegment(pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function hasHtmlDocumentExtension(pathname: string): boolean {
  const segment = lastPathSegment(pathname).toLowerCase();
  return HTML_EXTENSIONS.some((extension) => segment.endsWith(extension));
}

function isIndexEntry(pathname: string): boolean {
  return INDEX_ENTRY_NAMES.includes(lastPathSegment(pathname).toLowerCase() as never);
}

// Segment-anchored, not a raw substring test: `/docsarchive/foo.html` must NOT match `/docs` the way
// `/docs/foo.html` does. Each token is normalised to a bare segment name (strip leading/trailing
// slashes) and compared against the path split on `/`, so a token only matches a whole segment.
function hasDocumentationPathToken(pathname: string): boolean {
  const segments = pathname.toLowerCase().split("/");
  return DOCUMENTATION_PATH_TOKENS.some((token) => {
    const bareToken = token.replace(/^\/|\/$/gu, "");
    return segments.includes(bareToken);
  });
}

// Segment-anchored for the same reason as hasDocumentationPathToken: `/docs/authoring-guide.html`
// must NOT match `/auth` the way `/auth/callback` does.
function hasActionPathToken(pathname: string): boolean {
  const segments = pathname.toLowerCase().split("/");
  return ACTION_PATH_TOKENS.some((token) => {
    const bareToken = token.replace(/^\/|\/$/gu, "");
    return segments.includes(bareToken);
  });
}

function isDirectoryStyle(pathname: string): boolean {
  // Root, or a trailing slash, or a final segment with no file extension — a folder-style manual root.
  if (pathname === "" || pathname === "/" || pathname.endsWith("/")) return true;
  return !lastPathSegment(pathname).includes(".");
}

// ─── Detection (pure over the user-entered target) ───────────────────────────────────

function detectHttpManual(
  pathname: string,
  targetClass: DocumentationTargetClass,
): DocumentationManualDetection {
  const hostReason: DocumentationManualProposalReason =
    targetClass === "loopback" ? "loopback-documentation-server" : "intranet-manual-host";
  if (hasActionPathToken(pathname)) {
    return {
      state: "degraded",
      sourceKind: null,
      confidence: "none",
      reasons: ["dynamic-or-action-page"],
    };
  }
  if (isIndexEntry(pathname)) {
    return {
      state: "likely-manual",
      sourceKind: "html-manual-http",
      confidence: "high",
      reasons: ["index-html-entry", hostReason],
    };
  }
  if (hasHtmlDocumentExtension(pathname) && hasDocumentationPathToken(pathname)) {
    return {
      state: "likely-manual",
      sourceKind: "html-manual-http",
      confidence: "high",
      reasons: ["html-document-extension", "documentation-path-pattern", hostReason],
    };
  }
  return detectHttpManualWeakSignals(pathname, hostReason);
}

function detectHttpManualWeakSignals(
  pathname: string,
  hostReason: DocumentationManualProposalReason,
): DocumentationManualDetection {
  const reasons: DocumentationManualProposalReason[] = [];
  if (hasHtmlDocumentExtension(pathname)) reasons.push("html-document-extension");
  if (hasDocumentationPathToken(pathname)) reasons.push("documentation-path-pattern");
  if (isDirectoryStyle(pathname)) reasons.push("directory-style-target");
  if (reasons.length > 0) {
    return {
      state: "probable-manual",
      sourceKind: "html-manual-http",
      confidence: "medium",
      reasons: [...reasons, hostReason],
    };
  }
  return {
    state: "probable-manual",
    sourceKind: "html-manual-http",
    confidence: "low",
    reasons: ["unknown-page-shape", hostReason],
  };
}

function detectLocalFileManual(pathname: string): DocumentationManualDetection {
  const isIndex = isIndexEntry(pathname);
  const isHtmlDocument = hasHtmlDocumentExtension(pathname);
  if (!isIndex && !isHtmlDocument) {
    return {
      state: "degraded",
      sourceKind: null,
      confidence: "none",
      reasons: ["unknown-page-shape"],
    };
  }
  return {
    state: "requires-local-file-approval",
    sourceKind: "html-manual-local",
    confidence: "medium",
    reasons: ["local-file-manual-candidate", "html-document-extension"],
  };
}

/**
 * Deterministically detect whether a user-entered documentation target looks like a static HTML
 * manual. Pure: classifies the target with the WHATWG URL parser and inspects only the URL SHAPE
 * (scheme, host class, path pattern). It performs no filesystem read, no network egress, no page-body
 * inspection, and no model call — there is nothing to crawl. Fails closed: credentials, unsupported
 * schemes, public targets, and action pages never resolve to an approvable manual.
 */
export function detectIndexableManual(rawTarget: unknown): DocumentationManualDetection {
  const classification = classifyDocumentationTarget(rawTarget);
  if (!classification.ok) {
    return detectionForClassificationFailure(classification.reason);
  }
  if (typeof rawTarget !== "string") {
    return {
      state: "degraded",
      sourceKind: null,
      confidence: "none",
      reasons: ["unknown-page-shape"],
    };
  }
  const pathname = safePathname(rawTarget);
  switch (classification.targetClass) {
    case "local-file":
      return detectLocalFileManual(pathname);
    case "loopback":
    case "intranet-http":
      return detectHttpManual(pathname, classification.targetClass);
    case "external-http":
      return {
        state: "unsupported",
        sourceKind: null,
        confidence: "none",
        reasons: ["external-target-not-offered"],
      };
    case "unsupported-scheme":
      return {
        state: "unsupported",
        sourceKind: null,
        confidence: "none",
        reasons: ["unsupported-scheme"],
      };
  }
}

/**
 * Override an otherwise-approvable detection to `authentication-required` when the caller reports
 * that the last navigation to this same target required credentials Keiko will not collect or
 * replay. Fails closed toward the stricter state: a detection that is already non-approvable (e.g.
 * `denied`, `unsupported`) is left as-is, since that state is already at least as restrictive.
 */
export function applyAuthenticationRequiredOverride(
  detection: DocumentationManualDetection,
  lastNavigationReason: DocumentationNavigationReason | null | undefined,
): DocumentationManualDetection {
  if (lastNavigationReason !== "authentication-required") return detection;
  if (!isApprovableProposalState(detection.state)) return detection;
  return {
    state: "authentication-required",
    sourceKind: null,
    confidence: "none",
    reasons: ["authentication-required"],
  };
}

function detectionForClassificationFailure(
  reason: "invalid-target" | "unsupported-scheme" | "credentials-in-target",
): DocumentationManualDetection {
  if (reason === "credentials-in-target") {
    return {
      state: "denied",
      sourceKind: null,
      confidence: "none",
      reasons: ["credentials-in-target"],
    };
  }
  if (reason === "unsupported-scheme") {
    return {
      state: "unsupported",
      sourceKind: null,
      confidence: "none",
      reasons: ["unsupported-scheme"],
    };
  }
  return { state: "degraded", sourceKind: null, confidence: "none", reasons: ["invalid-target"] };
}

function safePathname(rawTarget: string): string {
  try {
    return new URL(rawTarget.trim()).pathname;
  } catch {
    return "";
  }
}

// ─── Redacted summary derivation (pure) ──────────────────────────────────────────────

function redactSummary(value: string): string {
  return redactAbsolutePaths(stripUnsafeFormatChars(value));
}

/** Redacted origin summary: the safe `scheme://host[:port]` for http(s), "local file" otherwise. */
export function summarizeManualOrigin(rawTarget: unknown): string {
  if (typeof rawTarget !== "string") return "unavailable";
  try {
    const parsed = new URL(rawTarget.trim());
    if (parsed.protocol === "file:") return "local file";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return redactSummary(parsed.origin);
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

/** Redacted path-prefix shape: null for local files, "/" for a root scope, "/…" for a sub-path scope. */
export function summarizeManualPathPrefix(rawTarget: unknown): string | null {
  if (typeof rawTarget !== "string") return null;
  try {
    const parsed = new URL(rawTarget.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.pathname === "" || parsed.pathname === "/" ? "/" : "/…";
  } catch {
    return null;
  }
}

function proposedPodName(sourceKind: DocumentationManualSourceKind, originSummary: string): string {
  if (sourceKind === "html-manual-local") return "Local HTML manual";
  return redactSummary(`${originSummary} — HTML manual`);
}

// ─── Scope preview builder (pure) ────────────────────────────────────────────────────

/**
 * Build the bounded, redacted scope preview for an approvable manual proposal. Pure: it declares the
 * governed limits, the denied link classes the later crawl will refuse, and a proposed pod name; it
 * samples nothing and reads nothing. `estimatedPageCount` is always null because sampling is deferred
 * until after consent.
 */
export function buildManualScopePreview(input: {
  readonly sourceKind: DocumentationManualSourceKind;
  readonly originSummary: string;
  readonly pathPrefixSummary: string | null;
  readonly limits?: DocumentationManualScopeLimits;
}): DocumentationManualScopePreview {
  const limits = input.limits ?? DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS;
  const robotsPosture: DocumentationManualRobotsPosture =
    input.sourceKind === "html-manual-http" ? "honor-robots-txt" : "not-applicable";
  return {
    sourceKind: input.sourceKind,
    originSummary: redactSummary(input.originSummary),
    pathPrefixSummary: input.pathPrefixSummary,
    proposedPodName: proposedPodName(input.sourceKind, input.originSummary),
    estimatedPageCount: null,
    limits,
    deniedLinkClasses:
      input.sourceKind === "html-manual-local"
        ? LOCAL_FILE_DENIED_LINK_CLASSES
        : DOCUMENTATION_MANUAL_DENIED_LINK_CLASSES,
    robotsPosture,
  };
}

// ─── Already-indexed matcher (pure) ──────────────────────────────────────────────────

/**
 * Find a Knowledge Pod that already covers a manual's normalized root, matched only on the opaque
 * source fingerprint (never a raw path/URL). Returns the first ready pod whose `manualSourceFingerprint`
 * equals `fingerprint`, or null. The fingerprint is computed downstream with a hash helper — this
 * matcher stays pure and content-free.
 */
export function findIndexedManualForFingerprint(
  fingerprint: string,
  pods: readonly KnowledgePodSummary[],
): KnowledgePodSummary | null {
  if (fingerprint.length === 0) return null;
  for (const pod of pods) {
    if (pod.manualSourceFingerprint === fingerprint && pod.readiness === "ready") {
      return pod;
    }
  }
  return null;
}

// ─── Proposal builder (pure) ─────────────────────────────────────────────────────────

/**
 * Assemble a redacted indexing proposal from a pure detection result and the redacted summaries. A
 * scope preview is attached only for approvable states; every other state carries a null preview and no
 * pod reference (the caller sets `alreadyIndexedPodId` for the already-indexed override).
 */
export function buildDocumentationIndexingProposal(input: {
  readonly detection: DocumentationManualDetection;
  readonly targetClass: DocumentationTargetClass;
  readonly originSummary: string;
  readonly pathPrefixSummary: string | null;
  readonly limits?: DocumentationManualScopeLimits;
}): DocumentationIndexingProposal {
  const { detection } = input;
  const scopePreview =
    isApprovableProposalState(detection.state) && detection.sourceKind !== null
      ? buildManualScopePreview({
          sourceKind: detection.sourceKind,
          originSummary: input.originSummary,
          pathPrefixSummary: input.pathPrefixSummary,
          ...(input.limits !== undefined ? { limits: input.limits } : {}),
        })
      : null;
  return {
    schemaVersion: DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
    state: detection.state,
    targetClass: input.targetClass,
    sourceKind: detection.sourceKind,
    confidence: detection.confidence,
    reasons: detection.reasons,
    originSummary: redactSummary(input.originSummary),
    pathPrefixSummary: input.pathPrefixSummary,
    scopePreview,
    alreadyIndexedPodId: null,
    approvalRequired: true,
    approved: false,
  };
}

/**
 * Re-shape a proposal into the already-indexed state, pointing the user at the existing pod instead of
 * creating a duplicate. Drops the scope preview (there is nothing to approve) and clears the source
 * kind confidence to `none` while keeping a stable reason code.
 */
export function asAlreadyIndexedProposal(
  proposal: DocumentationIndexingProposal,
  podId: string,
): DocumentationIndexingProposal {
  return {
    ...proposal,
    state: "already-indexed",
    confidence: "none",
    reasons: ["already-indexed-pod"],
    scopePreview: null,
    alreadyIndexedPodId: podId,
  };
}

// ─── Request validation (BFF trust boundary) ─────────────────────────────────────────

export interface DocumentationManualProposalRequest {
  readonly schemaVersion: typeof DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION;
  readonly target: string;
  // The reason returned by the most recent navigate call for this same target, if any. Lets the
  // caller report that the target required authentication so a proposal/approval is never offered
  // for a target the user was just told Keiko will not sign in to (child issue #1869). Absent or
  // null when no prior navigation result is available.
  readonly lastNavigationReason: DocumentationNavigationReason | null;
}

export type DocumentationManualProposalParse =
  | { readonly ok: true; readonly value: DocumentationManualProposalRequest }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an untrusted proposal/approve request. Enforces the same bounded-target invariants as the
 * navigation request: a non-empty target string within the length cap. The target itself is
 * re-classified and never echoed back verbatim.
 */
const KNOWN_NAVIGATION_REASONS: ReadonlySet<string> = new Set(DOCUMENTATION_NAVIGATION_REASONS);

function parseLastNavigationReason(
  value: unknown,
  errors: string[],
): DocumentationNavigationReason | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && KNOWN_NAVIGATION_REASONS.has(value)) {
    return value as DocumentationNavigationReason;
  }
  errors.push("lastNavigationReason must be a known navigation reason or null");
  return null;
}

export function parseManualProposalRequest(value: unknown): DocumentationManualProposalParse {
  if (!isRecord(value)) return { ok: false, errors: ["request must be an object"] };
  const target = value.target;
  const errors: string[] = [];
  if (typeof target !== "string" || target.length === 0) {
    errors.push("target must be a non-empty string");
  } else if (target.length > DOCUMENTATION_TARGET_MAX_LENGTH) {
    errors.push(`target must be at most ${String(DOCUMENTATION_TARGET_MAX_LENGTH)} characters`);
  }
  const lastNavigationReason = parseLastNavigationReason(value.lastNavigationReason, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
      target: target as string,
      lastNavigationReason,
    },
  };
}

// ─── Output validation (defence-in-depth redaction guards) ───────────────────────────

const ALLOWED_PATH_PREFIX_SHAPES: ReadonlySet<string> = new Set(["/", "/…"]);

// A redacted summary is safe when it is stable under format-char stripping, carries no absolute path,
// contains no userinfo (`@`), query (`?`), or fragment (`#`), and carries no embedded newline/carriage
// return. A bare `scheme://host[:port]` origin and a host-derived pod label are intentionally allowed;
// a path/query/credential is not. These fields are always single-line, so — unlike other evidence
// surfaces that legitimately preserve TAB/LF/CR — `stripUnsafeFormatChars` alone is not a strong enough
// check here: it deliberately preserves LF/CR, which would otherwise let a header-injection-shaped
// value (e.g. an embedded `\r\nX-Injected: …`) round-trip as "safe".
function isDocumentationRedactionSafe(value: string): boolean {
  if (stripUnsafeFormatChars(value) !== value) return false;
  if (containsAbsolutePath(value)) return false;
  if (value.includes("\n") || value.includes("\r")) return false;
  return !value.includes("@") && !value.includes("?") && !value.includes("#");
}

function pushIfUnsafeText(value: string, field: string, errors: string[]): void {
  if (!isDocumentationRedactionSafe(value)) {
    errors.push(`${field} must be redaction-safe (no path, credential, query, or fragment)`);
  }
}

function pushIfUnsafePathPrefix(value: string | null, field: string, errors: string[]): void {
  if (value !== null && !ALLOWED_PATH_PREFIX_SHAPES.has(value)) {
    errors.push(`${field} must be null, "/", or "/…"`);
  }
}

export type DocumentationManualValidation =
  { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

// `estimatedPageCount: null` and `limits.followRedirects: false` are literal types the compiler already
// pins, so they need no runtime check. This backstop guards the fields a builder bug (or tampered wire
// data) could still make unsafe: the redacted string summaries and the state/scope-preview relationship.
function validateScopePreviewSafety(
  preview: DocumentationManualScopePreview | null,
  errors: string[],
): void {
  if (preview === null) return;
  pushIfUnsafeText(preview.proposedPodName, "scopePreview.proposedPodName", errors);
  pushIfUnsafeText(preview.originSummary, "scopePreview.originSummary", errors);
  pushIfUnsafePathPrefix(preview.pathPrefixSummary, "scopePreview.pathPrefixSummary", errors);
}

function validateProposalScopePresence(
  proposal: DocumentationIndexingProposal,
  errors: string[],
): void {
  const approvable = isApprovableProposalState(proposal.state);
  if (approvable && proposal.scopePreview === null) {
    errors.push("approvable proposals must carry a scope preview");
  }
  if (!approvable && proposal.scopePreview !== null) {
    errors.push("non-approvable proposals must not carry a scope preview");
  }
  if (proposal.state !== "already-indexed" && proposal.alreadyIndexedPodId !== null) {
    errors.push("alreadyIndexedPodId is only valid for the already-indexed state");
  }
}

/**
 * Redaction backstop for a proposal before it crosses the wire: no raw path/credential/query/fragment
 * in any summary, and an approvable state always carries a scope preview while a non-approvable state
 * never does. Consent is a compile-time literal (`approved: false`), so it needs no runtime check.
 */
export function validateDocumentationIndexingProposal(
  proposal: DocumentationIndexingProposal,
): DocumentationManualValidation {
  const errors: string[] = [];
  pushIfUnsafeText(proposal.originSummary, "proposal.originSummary", errors);
  pushIfUnsafePathPrefix(proposal.pathPrefixSummary, "proposal.pathPrefixSummary", errors);
  validateProposalScopePresence(proposal, errors);
  validateScopePreviewSafety(proposal.scopePreview, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Redaction backstop for an approval handoff before it is emitted to the (future) crawler epic. The
 * fingerprint must be a non-empty redaction-safe token and every summary redaction-safe. Consent
 * (`approved: true`) is a compile-time literal.
 */
export function validateDocumentationIndexingApproval(
  approval: DocumentationIndexingApproval,
): DocumentationManualValidation {
  const errors: string[] = [];
  if (approval.sourceFingerprint.length === 0) {
    errors.push("approval.sourceFingerprint must be a non-empty token");
  } else {
    pushIfUnsafeText(approval.sourceFingerprint, "approval.sourceFingerprint", errors);
  }
  pushIfUnsafeText(approval.proposedPodName, "approval.proposedPodName", errors);
  pushIfUnsafeText(approval.originSummary, "approval.originSummary", errors);
  pushIfUnsafePathPrefix(approval.pathPrefixSummary, "approval.pathPrefixSummary", errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
