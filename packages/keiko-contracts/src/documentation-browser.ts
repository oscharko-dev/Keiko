// Epic #1851 — governed documentation browser contracts (child issue #1860).
//
// Browser-safe, additive wire contracts that let the Keiko UI represent a documentation-browser
// navigation attempt WITHOUT exposing unsafe page content and WITHOUT implying that any crawl,
// index, retrieval, or model call has happened. This milestone is browser-only: the contracts
// describe target classification and governed navigation outcomes, never raw HTML bodies, cookies,
// credentials, token-bearing URLs, private local paths, or provider endpoints.
//
// Design (see ADR-0113):
//   * Target classification is a pure WHATWG-URL function — no filesystem, no network.
//   * Only redacted origin/path summaries cross the wire; query, fragment, and userinfo are dropped
//     so a URL that carries a token or credential never appears in browser-facing state.
//   * Navigation outcomes are a closed, UI-owned reason set. Low-level browser/network errors are
//     mapped to these reasons BEFORE rendering so the UI never interprets a raw Node/CDP error.
//   * The contract fails closed: unknown schemes, hosts, and error reasons resolve to unsupported or
//     degraded outcomes, never to an "allowed"/"loaded" state.

import { redactAbsolutePaths, stripUnsafeFormatChars } from "./text-safety.js";

export const DOCUMENTATION_BROWSER_SCHEMA_VERSION = "1" as const;

// Longest target string the BFF will accept. Bounds the request body independently of the
// transport cap and keeps a pathological URL out of logs/evidence.
export const DOCUMENTATION_TARGET_MAX_LENGTH = 4096 as const;

// ─── Target classification ────────────────────────────────────────────────────────

// The class of a user-entered documentation target. `unsupported-scheme` is the fail-closed bucket
// for anything that is not an http(s) or file target (mailto:, javascript:, data:, ftp:, …).
export const DOCUMENTATION_TARGET_CLASSES = [
  "local-file",
  "loopback",
  "intranet-http",
  "external-http",
  "unsupported-scheme",
] as const;

export type DocumentationTargetClass = (typeof DOCUMENTATION_TARGET_CLASSES)[number];

export interface DocumentationTargetClassificationOk {
  readonly ok: true;
  // Class of the parsed target.
  readonly targetClass: DocumentationTargetClass;
  // Redacted origin summary safe to display: `scheme://host[:port]` for http(s), the literal
  // string "local file" for file targets. Never contains a path, query, fragment, or credential.
  readonly originSummary: string;
  // Redacted path shape hint for http(s) targets: "/" when the path is empty or root, "/…" when a
  // non-root path is present. Never the real path. `null` for non-http targets.
  readonly pathSummary: string | null;
}

export interface DocumentationTargetClassificationFail {
  readonly ok: false;
  // Why the target could not be classified. Both reasons render as governed limitations, never as a
  // loadable target.
  readonly reason: "invalid-target" | "unsupported-scheme" | "credentials-in-target";
}

export type DocumentationTargetClassification =
  DocumentationTargetClassificationOk | DocumentationTargetClassificationFail;

// ─── Navigation outcome reasons ─────────────────────────────────────────────────────

// Closed set of governed navigation outcomes. The UI owns the human copy for each; the contract
// owns the machine reason + severity so the UI never parses a raw browser/network error string.
export const DOCUMENTATION_NAVIGATION_REASONS = [
  // The target is a loopback document and a browser backend is configured, so a live preview can be
  // opened through the existing governed browser session. This is the only outcome that can lead to
  // rendered content in this milestone.
  "preview-available",
  // The target is a supported class (local file or intranet manual) but inline rendering is
  // intentionally deferred to a later, separately governed milestone. Navigation succeeded as far as
  // classification; nothing was crawled, captured, indexed, or persisted.
  "rendering-deferred",
  // Embedding is refused — by Keiko's own frame policy and/or the page's X-Frame-Options /
  // frame-ancestors. Keiko does not bypass either policy.
  "frame-embedding-refused",
  // The target requires authentication Keiko will not collect or replay.
  "authentication-required",
  // A configured proxy/firewall blocked the attempt. Keiko respects enterprise policy and does not
  // route around it.
  "proxy-or-firewall-blocked",
  // The host could not be resolved.
  "host-unreachable",
  // The attempt exceeded the governed time budget.
  "request-timed-out",
  // The target exceeded the governed size budget.
  "content-too-large",
  // The scheme is not supported for documentation browsing.
  "unsupported-scheme",
  // A public/external target that this governed surface does not open.
  "unsupported-external-target",
  // A local file target could not be opened within the approved scope.
  "local-file-scope-unavailable",
  // No browser backend is configured, so even loopback preview is unavailable.
  "browser-backend-unavailable",
  // The request itself was malformed or carried an unsafe value.
  "invalid-target",
  // Fail-closed default: navigation failed for a reason that could not be mapped. Rendered as a
  // generic governed limitation, never as success.
  "navigation-failed",
] as const;

export type DocumentationNavigationReason = (typeof DOCUMENTATION_NAVIGATION_REASONS)[number];

export type DocumentationReasonSeverity = "ready" | "limitation" | "error";

// Severity lets the UI pick tone/iconography without hard-coding a branch per reason. `ready` is the
// preview-available happy path; `limitation` is an expected governed boundary (deferred/blocked/
// unsupported); `error` is a failed attempt the user may retry.
export const DOCUMENTATION_NAVIGATION_REASON_SEVERITY: Readonly<
  Record<DocumentationNavigationReason, DocumentationReasonSeverity>
> = Object.freeze({
  "preview-available": "ready",
  "rendering-deferred": "limitation",
  "frame-embedding-refused": "limitation",
  "authentication-required": "limitation",
  "proxy-or-firewall-blocked": "limitation",
  "unsupported-scheme": "limitation",
  "unsupported-external-target": "limitation",
  "local-file-scope-unavailable": "limitation",
  "browser-backend-unavailable": "limitation",
  "host-unreachable": "error",
  "request-timed-out": "error",
  "content-too-large": "error",
  "invalid-target": "error",
  "navigation-failed": "error",
});

// ─── Navigation request / result ────────────────────────────────────────────────────

export interface DocumentationNavigationRequest {
  readonly schemaVersion: typeof DOCUMENTATION_BROWSER_SCHEMA_VERSION;
  // Raw user-entered target. The BFF re-validates and classifies it; it is never echoed back
  // verbatim in the result.
  readonly target: string;
  // Optional CDP port for the loopback preview path. Absent means "classify only".
  readonly cdpPort?: number;
}

// Capability flags the UI uses to decide which affordances to enable. `indexingProposalAvailable` was
// hard-`false` in the #1851 browser-only milestone; Epic #1852 widens it to a boolean that is true only
// for proposal-eligible target classes (local file, loopback, intranet manuals). It gates whether the
// UI may OFFER to check a target for indexing — it never implies a proposal was accepted or a manual
// was crawled or indexed (both remain explicit, consent-gated, later steps).
export interface DocumentationBrowserCapability {
  readonly previewAvailable: boolean;
  readonly backendAvailable: boolean;
  readonly indexingProposalAvailable: boolean;
}

export interface DocumentationNavigationResult {
  readonly schemaVersion: typeof DOCUMENTATION_BROWSER_SCHEMA_VERSION;
  readonly targetClass: DocumentationTargetClass;
  readonly originSummary: string;
  readonly pathSummary: string | null;
  readonly reason: DocumentationNavigationReason;
  readonly severity: DocumentationReasonSeverity;
  readonly capability: DocumentationBrowserCapability;
}

export interface DocumentationNavigationParseOk {
  readonly ok: true;
  readonly value: DocumentationNavigationRequest;
}

export interface DocumentationNavigationParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type DocumentationNavigationParse =
  DocumentationNavigationParseOk | DocumentationNavigationParseFail;

// ─── Primitive guards ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;
const INTRANET_SUFFIXES = [".local", ".internal", ".intranet", ".lan", ".corp", ".home"] as const;

function parseIpv4Octets(host: string): readonly number[] | null {
  const match = IPV4_PATTERN.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

function isLoopbackIpv4(octets: readonly number[]): boolean {
  return octets[0] === 127;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function classifyIpv4(octets: readonly number[]): DocumentationTargetClass {
  if (isLoopbackIpv4(octets)) return "loopback";
  return isPrivateIpv4(octets) ? "intranet-http" : "external-http";
}

// Classify a named (non-IPv4) host: unique-local/link-local IPv6 prefixes, single-label names, and
// *.local/*.internal/… suffixes are intranet-class; every other dotted public name is external.
function classifyNamedHost(lower: string): DocumentationTargetClass {
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) {
    return "intranet-http";
  }
  if (!lower.includes(".")) return "intranet-http";
  if (INTRANET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "intranet-http";
  return "external-http";
}

const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;

// Unwrap an IPv4-mapped IPv6 literal (WHATWG URL normalises `::ffff:127.0.0.1` to the compressed hex
// form `::ffff:7f00:1`) back to its embedded IPv4 octets so it classifies identically to the
// dotted-decimal address it represents, instead of falling through to the named-host branch.
function parseIpv4MappedIpv6Octets(lower: string): readonly number[] | null {
  const match = IPV4_MAPPED_IPV6_PATTERN.exec(lower);
  if (match === null) return null;
  const [highWord, lowWord] = match.slice(1).map((part) => Number.parseInt(part, 16));
  if (highWord === undefined || lowWord === undefined) return null;
  return [highWord >> 8, highWord & 0xff, lowWord >> 8, lowWord & 0xff];
}

// Classify the host of an http(s) target. Loopback and private/link-local ranges plus single-label
// and *.local/*.internal/… names are treated as intranet-class; everything else is external.
function classifyHttpHost(rawHost: string): DocumentationTargetClass {
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1") return "loopback";
  const mappedOctets = parseIpv4MappedIpv6Octets(lower);
  if (mappedOctets !== null) return classifyIpv4(mappedOctets);
  const octets = parseIpv4Octets(lower);
  return octets !== null ? classifyIpv4(octets) : classifyNamedHost(lower);
}

function summarizeHttpOrigin(parsed: URL): string {
  // parsed.origin is `scheme://host[:port]` with no path/query/fragment/userinfo — exactly the safe
  // summary we want. Strip any format-spoofing code points defensively.
  return stripUnsafeFormatChars(parsed.origin);
}

function summarizeHttpPath(parsed: URL): string {
  return parsed.pathname === "" || parsed.pathname === "/" ? "/" : "/…";
}

// ─── Target classification ────────────────────────────────────────────────────────

/**
 * Classify a user-entered documentation target with the WHATWG URL parser. Pure: no filesystem, no
 * network. Fails closed — credentials, unknown schemes, and unparseable input never resolve to a
 * loadable class. Never returns a path, query, fragment, or credential in any summary.
 */
export function classifyDocumentationTarget(raw: unknown): DocumentationTargetClassification {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "invalid-target" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid-target" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentials-in-target" };
  }
  if (parsed.protocol === "file:") {
    // Never expose the local path; a file target is summarised as a class label only.
    return { ok: true, targetClass: "local-file", originSummary: "local file", pathSummary: null };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const targetClass = classifyHttpHost(parsed.hostname);
    return {
      ok: true,
      targetClass,
      originSummary: summarizeHttpOrigin(parsed),
      pathSummary: summarizeHttpPath(parsed),
    };
  }
  return { ok: false, reason: "unsupported-scheme" };
}

// ─── Low-level error mapping ────────────────────────────────────────────────────────

const ERROR_CODE_TO_REASON: Readonly<Record<string, DocumentationNavigationReason>> = Object.freeze(
  {
    // keiko-tools BrowserToolError codes
    BROWSER_UNAVAILABLE: "browser-backend-unavailable",
    CHROME_UNREACHABLE: "browser-backend-unavailable",
    ORIGIN_NOT_ALLOWED: "unsupported-external-target",
    SCHEME_NOT_ALLOWED: "unsupported-scheme",
    REDIRECT_BLOCKED: "unsupported-external-target",
    NAV_TIMEOUT: "request-timed-out",
    BAD_URL: "invalid-target",
    BAD_PORT: "invalid-target",
    PAYLOAD_TOO_LARGE: "content-too-large",
    // Node/undici network errno
    ENOTFOUND: "host-unreachable",
    EAI_AGAIN: "host-unreachable",
    ECONNREFUSED: "proxy-or-firewall-blocked",
    ECONNRESET: "proxy-or-firewall-blocked",
    EHOSTUNREACH: "proxy-or-firewall-blocked",
    ENETUNREACH: "proxy-or-firewall-blocked",
    ETIMEDOUT: "request-timed-out",
    UND_ERR_CONNECT_TIMEOUT: "request-timed-out",
  },
);

/**
 * Map a low-level browser/network error code or HTTP status to a governed navigation reason. Fails
 * closed: an unrecognised code becomes `navigation-failed`, never a success/ready outcome.
 */
export function mapBrowserErrorToDocumentationReason(
  code: string | number | null | undefined,
): DocumentationNavigationReason {
  if (typeof code === "number") {
    if (code === 401 || code === 403 || code === 407) return "authentication-required";
    if (code === 413) return "content-too-large";
    return "navigation-failed";
  }
  if (typeof code !== "string" || code.length === 0) return "navigation-failed";
  return ERROR_CODE_TO_REASON[code] ?? "navigation-failed";
}

/**
 * Resolve the default navigation reason for a successfully classified target when no live browser or
 * network error occurred. Only a loopback target with a configured backend is preview-eligible; every
 * other class resolves to a governed limitation, never to a rendered/loaded state.
 */
export function resolveDocumentationNavigationReason(
  targetClass: DocumentationTargetClass,
  backendAvailable: boolean,
): DocumentationNavigationReason {
  switch (targetClass) {
    case "loopback":
      return backendAvailable ? "preview-available" : "browser-backend-unavailable";
    case "local-file":
    case "intranet-http":
      return "rendering-deferred";
    case "external-http":
      return "unsupported-external-target";
    case "unsupported-scheme":
      return "unsupported-scheme";
  }
}

// ─── Request validation ─────────────────────────────────────────────────────────────

function collectNavigationRequestErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const target = value.target;
  if (typeof target !== "string" || target.length === 0) {
    errors.push("target must be a non-empty string");
  } else if (target.length > DOCUMENTATION_TARGET_MAX_LENGTH) {
    errors.push(`target must be at most ${String(DOCUMENTATION_TARGET_MAX_LENGTH)} characters`);
  }
  if (value.cdpPort !== undefined) {
    const port = value.cdpPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
      errors.push("cdpPort must be an integer in the range 1024-65535");
    }
  }
  return errors;
}

/**
 * Parse an untrusted documentation navigation request at the BFF trust boundary. Returns a
 * discriminated result: one error string per failed invariant, or the normalised request.
 */
export function parseDocumentationNavigationRequest(value: unknown): DocumentationNavigationParse {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = collectNavigationRequestErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const port = value.cdpPort;
  return {
    ok: true,
    value: {
      schemaVersion: DOCUMENTATION_BROWSER_SCHEMA_VERSION,
      target: value.target as string,
      ...(typeof port === "number" ? { cdpPort: port } : {}),
    },
  };
}

// Proposal-eligible target classes (Epic #1852). A local file, loopback documentation server, or
// intranet manual MAY be offered for indexing review; a public/external target and an unsupported
// scheme never are. Eligibility only gates whether the UI shows the "check for indexing" affordance —
// it is not detection and it is not consent.
export function isIndexingProposalEligibleClass(targetClass: DocumentationTargetClass): boolean {
  return (
    targetClass === "local-file" || targetClass === "loopback" || targetClass === "intranet-http"
  );
}

// ─── Result construction ──────────────────────────────────────────────────────────

export interface DocumentationNavigationResultInput {
  readonly targetClass: DocumentationTargetClass;
  readonly originSummary: string;
  readonly pathSummary: string | null;
  readonly reason: DocumentationNavigationReason;
  readonly backendAvailable: boolean;
}

/**
 * Assemble a redacted navigation result. Applies defence-in-depth redaction to the origin summary
 * (strip format-spoofing code points, redact any absolute-path-shaped tail) and derives the preview
 * capability from the reason so the UI cannot be told a preview exists for a limitation/error state.
 */
export function buildDocumentationNavigationResult(
  input: DocumentationNavigationResultInput,
): DocumentationNavigationResult {
  const previewAvailable = input.reason === "preview-available";
  return {
    schemaVersion: DOCUMENTATION_BROWSER_SCHEMA_VERSION,
    targetClass: input.targetClass,
    originSummary: redactAbsolutePaths(stripUnsafeFormatChars(input.originSummary)),
    pathSummary: input.pathSummary,
    reason: input.reason,
    severity: DOCUMENTATION_NAVIGATION_REASON_SEVERITY[input.reason],
    capability: {
      previewAvailable,
      backendAvailable: input.backendAvailable,
      indexingProposalAvailable: isIndexingProposalEligibleClass(input.targetClass),
    },
  };
}
