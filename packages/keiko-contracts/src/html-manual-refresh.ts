// Redacted change-summary contract for HTML Manual Knowledge Pod refresh (Epic #1856, Issue #1890).
//
// Body-free projection of what an explicit refresh changed. It carries only counts, closed reason
// codes, an opaque crawl-run fingerprint, and a timestamp — never a raw page path, URL, body, or
// diagnostic string. Mirrors the redaction posture of `HtmlManualSourceSummary` and the pod-set
// readiness reason-code pattern.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports; pure types and pure
// validators only (no IO, no clock, no hashing, no randomness). The `crawlRunFingerprint` is
// computed downstream in keiko-local-knowledge (the leaf contracts layer cannot hash) and only
// VERIFIED here.

import type { HtmlManualSourceKind } from "./html-manual-source.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const HTML_MANUAL_REFRESH_SCHEMA_VERSION = "1" as const;

// Terminal outcome of a refresh run. `unchanged`/`updated` are healthy; `partial` completed with
// failed or denied pages; `failed`/`cancelled` did not complete and MUST leave the prior pod usable.
export const MANUAL_REFRESH_OUTCOMES = [
  "unchanged",
  "updated",
  "partial",
  "failed",
  "cancelled",
] as const;
export type ManualRefreshOutcome = (typeof MANUAL_REFRESH_OUTCOMES)[number];

// Whether removed-page detection could run this refresh. A full-width refresh that reaches the crawl
// page limit cannot distinguish "removed upstream" from "beyond the page budget", so removal is
// reported as not-evaluated rather than under-counted (mirrors the indexing prune guard at the
// maxFiles ceiling).
export const MANUAL_REFRESH_REMOVAL_DETECTIONS = ["evaluated", "not-evaluated-page-limit"] as const;
export type ManualRefreshRemovalDetection = (typeof MANUAL_REFRESH_REMOVAL_DETECTIONS)[number];

// Closed reason-code taxonomy explaining a non-trivial refresh state. Rendered via the guidance map
// below; never carries a URL or path.
export const MANUAL_REFRESH_REASON_CODES = [
  "scope-preserved",
  "scope-limit-reached",
  "removal-detection-skipped",
  "pages-added",
  "pages-changed",
  "pages-removed",
  "pages-failed",
  "links-denied",
  "embedding-incompatible",
  "crawl-empty",
  "crawl-cancelled",
  "index-failed",
] as const;
export type ManualRefreshReasonCode = (typeof MANUAL_REFRESH_REASON_CODES)[number];

// Generic, body-free operator guidance keyed by reason code. Never references a specific URL/path.
export const MANUAL_REFRESH_REASON_GUIDANCE: Readonly<Record<ManualRefreshReasonCode, string>> = {
  "scope-preserved": "Refresh reused the originally approved manual scope and limits.",
  "scope-limit-reached": "The refresh reached a crawl limit; some pages were not visited.",
  "removal-detection-skipped":
    "The crawl reached its page limit, so removed pages could not be detected this run.",
  "pages-added": "New pages were discovered and indexed.",
  "pages-changed": "Existing pages changed and were re-indexed.",
  "pages-removed": "Pages that are no longer reachable were removed from the pod.",
  "pages-failed":
    "Some pages could not be re-indexed and may be temporarily unsearchable; a future successful refresh will retry them.",
  "links-denied": "Some links were skipped because they fell outside the approved scope.",
  "embedding-incompatible":
    "The embedding model changed; re-index the manual to refresh its vectors.",
  "crawl-empty": "The refresh crawl found no indexable pages.",
  "crawl-cancelled":
    "The refresh was cancelled. Pages not yet reached are unaffected; a page already being re-indexed at that moment may be temporarily unsearchable until a future successful refresh.",
  "index-failed":
    "Indexing failed during refresh. Pages that were being re-indexed at the time of failure may be temporarily unsearchable until a future successful refresh repairs them.",
};

// Per-category counts. Every value is a non-negative integer; no path or content ever appears.
export interface ManualRefreshChangeCounts {
  readonly addedPages: number;
  readonly changedPages: number;
  readonly removedPages: number;
  readonly unchangedPages: number;
  readonly failedPages: number;
  readonly deniedLinks: number;
}

// The redacted, browser-safe change summary persisted per source and surfaced to diagnostics/UI.
export interface ManualRefreshChangeSummary {
  readonly schemaVersion: typeof HTML_MANUAL_REFRESH_SCHEMA_VERSION;
  readonly outcome: ManualRefreshOutcome;
  readonly sourceKind: HtmlManualSourceKind;
  readonly counts: ManualRefreshChangeCounts;
  readonly removalDetection: ManualRefreshRemovalDetection;
  // Opaque, content-free hash of the refreshed page set (hash of the sorted per-page fingerprints).
  // Two refresh outcomes with the same fingerprint indexed the identical page set.
  readonly crawlRunFingerprint: string;
  readonly reasonCodes: readonly ManualRefreshReasonCode[];
  readonly refreshedAt: number;
}

// ─── Validation (hand-written guards; no zod, mirrors html-manual-source.ts) ─────
const COUNT_KEYS: readonly (keyof ManualRefreshChangeCounts)[] = [
  "addedPages",
  "changedPages",
  "removedPages",
  "unchangedPages",
  "failedPages",
  "deniedLinks",
];

// The complete, known key set of `ManualRefreshChangeSummary`. Anything else on the input is
// rejected rather than silently carried through — mirrors the `onlyKeys` guard every sibling
// redaction validator in local-knowledge-pods.ts applies to its own object fields.
const REFRESH_SUMMARY_KEYS: readonly (keyof ManualRefreshChangeSummary)[] = [
  "schemaVersion",
  "outcome",
  "sourceKind",
  "counts",
  "removalDetection",
  "crawlRunFingerprint",
  "reasonCodes",
  "refreshedAt",
];

function isRefreshRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// Rejects any object carrying a property outside `allowed`. Fail-closed: an unexpected field on a
// redacted, browser-facing contract is treated as a validation error, not silently dropped or
// passed through — a corrupt or tampered record must never smuggle an extra raw-content field.
function onlyKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(`${field} must not include ${key}`);
      return;
    }
  }
}

function pushEnum(
  errors: string[],
  field: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${field} must be one of ${allowed.join("|")}`);
  }
}

// A redaction-safe opaque fingerprint token: non-empty, bounded, and shaped exactly like the
// `<algorithm>:<base64url-digest>` token `computeManualCrawlRunFingerprint` produces (e.g.
// `sha256:AbC-_123`). Allowlist, not denylist: only unreserved base64url characters plus the single
// `:` separator are accepted, so an obfuscated or percent-encoded path/URL string — which contains
// no whitespace, slash, or `@`/`#`/`?` but is not a real fingerprint — cannot slip through via an
// unlisted character. The character class is linear (no backtracking).
function isSafeFingerprint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  return /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u.test(value);
}

function validateRefreshCounts(input: unknown, errors: string[]): void {
  if (!isRefreshRecord(input)) {
    errors.push("refreshSummary.counts must be an object");
    return;
  }
  onlyKnownKeys(input, COUNT_KEYS, "refreshSummary.counts", errors);
  for (const key of COUNT_KEYS) {
    if (!isNonNegativeInteger(input[key])) {
      errors.push(`refreshSummary.counts.${key} must be a non-negative integer`);
    }
  }
}

function validateRefreshReasonCodes(input: unknown, errors: string[]): void {
  if (!Array.isArray(input)) {
    errors.push("refreshSummary.reasonCodes must be an array");
    return;
  }
  const seen = new Set<string>();
  for (const code of input) {
    if (
      typeof code !== "string" ||
      !(MANUAL_REFRESH_REASON_CODES as readonly string[]).includes(code)
    ) {
      errors.push(
        `refreshSummary.reasonCodes entry must be one of ${MANUAL_REFRESH_REASON_CODES.join("|")}`,
      );
      return;
    }
    if (seen.has(code)) {
      errors.push("refreshSummary.reasonCodes entries must be unique");
      return;
    }
    seen.add(code);
  }
}

function validateRefreshIdentity(input: Record<string, unknown>, errors: string[]): void {
  if (input.schemaVersion !== HTML_MANUAL_REFRESH_SCHEMA_VERSION) {
    errors.push('refreshSummary.schemaVersion must be the literal "1"');
  }
  if (!isSafeFingerprint(input.crawlRunFingerprint)) {
    errors.push("refreshSummary.crawlRunFingerprint must be a redaction-safe opaque token");
  }
  if (
    typeof input.refreshedAt !== "number" ||
    !Number.isFinite(input.refreshedAt) ||
    input.refreshedAt < 0
  ) {
    errors.push("refreshSummary.refreshedAt must be a finite non-negative number");
  }
}

function validateRefreshEnums(input: Record<string, unknown>, errors: string[]): void {
  pushEnum(errors, "refreshSummary.outcome", input.outcome, MANUAL_REFRESH_OUTCOMES);
  pushEnum(errors, "refreshSummary.sourceKind", input.sourceKind, [
    "html-manual-local",
    "html-manual-http",
  ]);
  pushEnum(
    errors,
    "refreshSummary.removalDetection",
    input.removalDetection,
    MANUAL_REFRESH_REMOVAL_DETECTIONS,
  );
}

export function validateManualRefreshChangeSummary(
  input: unknown,
): LocalKnowledgeValidation<ManualRefreshChangeSummary> {
  if (!isRefreshRecord(input)) {
    return { ok: false, errors: ["refreshSummary must be an object"] };
  }
  const errors: string[] = [];
  onlyKnownKeys(input, REFRESH_SUMMARY_KEYS, "refreshSummary", errors);
  validateRefreshIdentity(input, errors);
  validateRefreshEnums(input, errors);
  validateRefreshCounts(input.counts, errors);
  validateRefreshReasonCodes(input.reasonCodes, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as ManualRefreshChangeSummary };
}
