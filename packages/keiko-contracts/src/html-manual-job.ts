// Wire contract for the live HTML Manual Knowledge Pod create/refresh job (Issue #2063).
//
// The BFF runs `createHtmlManualPod` / `refreshHtmlManualPod` (keiko-local-knowledge) as an
// in-process background job and projects its body-free `HtmlManualIndexingProgress` onto this wire
// type so the UI can poll live progress. Body-free by construction: it carries only a job id, an
// operation/state/phase, non-negative counts, and closed reason+generic-guidance remediation pairs —
// never a raw page path, URL, page body, crawl fingerprint, or diagnostic string.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports; pure types and pure
// validators only. The two REQUEST validators are the inbound trust boundary the route enforces.

import { isSafeManualOrigin, isSafeManualPathPrefix } from "./html-manual-source.js";
import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";

export const HTML_MANUAL_POD_JOB_SCHEMA_VERSION = "1" as const;

export const HTML_MANUAL_POD_JOB_OPERATIONS = ["create", "refresh"] as const;
export type HtmlManualPodJobOperation = (typeof HTML_MANUAL_POD_JOB_OPERATIONS)[number];

// running: crawl/index in flight. succeeded: terminal, pod usable AND the approved manual is fully
// covered. partial: terminal, a usable pod exists but pages of the approved manual were skipped or
// failed — the counts and remediations say which class of gap, and the operator must not read it as a
// clean import. failed: terminal, prior pod (if any) left intact and nothing usable was produced.
//
// `partial` exists because "some vectors landed" is not "the import succeeded": before it, a crawl
// that dropped pages or an index that failed some documents still settled as `succeeded` and showed a
// success message (0.3.0 audit).
export const HTML_MANUAL_POD_JOB_STATES = ["running", "succeeded", "partial", "failed"] as const;
export type HtmlManualPodJobState = (typeof HTML_MANUAL_POD_JOB_STATES)[number];

// Mirrors the domain `ManualIndexingPhase` projection (manual-pod-progress.ts).
export const HTML_MANUAL_POD_JOB_PHASES = [
  "crawling",
  "ready",
  "degraded",
  "cancelled",
  "empty",
] as const;
export type HtmlManualPodJobPhase = (typeof HTML_MANUAL_POD_JOB_PHASES)[number];

export interface HtmlManualPodJobCrawl {
  readonly discovered: number;
  readonly accepted: number;
  readonly deniedCount: number;
  readonly bytesFetched: number;
}

export interface HtmlManualPodJobIndexing {
  readonly totalDocuments: number;
  readonly processedDocuments: number;
  readonly failedDocuments: number;
  readonly skippedDocuments: number;
  readonly vectorsPersisted: number;
}

// A closed reason code + generic operator guidance. Both strings are body-free (the reason is a
// crawl deny/remediation code; the guidance is a fixed template) — never a URL, path, or page body.
export interface HtmlManualPodJobRemediation {
  readonly reason: string;
  readonly guidance: string;
}

// The polled job projection. Server-produced (outbound); the UI reads it read-only.
export interface HtmlManualPodJob {
  readonly schemaVersion: typeof HTML_MANUAL_POD_JOB_SCHEMA_VERSION;
  readonly jobId: string;
  readonly operation: HtmlManualPodJobOperation;
  readonly state: HtmlManualPodJobState;
  readonly phase: HtmlManualPodJobPhase;
  readonly capsuleId: string;
  readonly sourceId: string;
  readonly crawl: HtmlManualPodJobCrawl;
  readonly indexing: HtmlManualPodJobIndexing | null;
  readonly remediations: readonly HtmlManualPodJobRemediation[];
  readonly startedAt: number;
  readonly updatedAt: number;
}

// ─── Inbound request contracts (the route trust boundary) ────────────────────────

// Refresh an existing HTML manual pod. Scope is reconstructed server-side from persisted state; the
// caller may never supply or widen a scope, only name the capsule + source to refresh.
export interface HtmlManualPodRefreshRequest {
  readonly capsuleId: string;
  readonly sourceId: string;
}

// Create a new HTTP HTML manual pod. The caller approves the origin + path prefix (the crawl scope);
// the server derives the source, allocates the capsule/source ids, and indexes with the configured
// embedding identity. Only the http scope is exposed here (a local-manual create is not a product
// trigger surface).
export interface HtmlManualPodCreateRequest {
  readonly displayName: string;
  readonly origin: string;
  readonly pathPrefix: string | null;
}

const MAX_DISPLAY_NAME_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A capsule/source id is an opaque, bounded, path-safe token: it becomes part of a storage reference,
// so `/`, `..`, whitespace, and control characters are rejected (allowlist, not denylist).
function isSafeManualPodId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  return /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function isSafeDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_DISPLAY_NAME_LENGTH;
}

function onlyKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): string[] {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  return extra === undefined ? [] : [`${field} must not include ${extra}`];
}

export function validateHtmlManualPodRefreshRequest(
  input: unknown,
): LocalKnowledgeValidation<HtmlManualPodRefreshRequest> {
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  const errors = onlyKnownKeys(input, ["capsuleId", "sourceId"], "request");
  if (!isSafeManualPodId(input.capsuleId)) errors.push("capsuleId must be a safe id token");
  if (!isSafeManualPodId(input.sourceId)) errors.push("sourceId must be a safe id token");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as HtmlManualPodRefreshRequest };
}

// Normalise + validate an optional path prefix: undefined/null -> null; a string is scope-checked;
// any other type is rejected.
function validateOptionalPathPrefix(value: unknown, errors: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isSafeManualPathPrefix(value)) {
    errors.push("pathPrefix must be a safe path prefix or null");
    return null;
  }
  return value;
}

export function validateHtmlManualPodCreateRequest(
  input: unknown,
): LocalKnowledgeValidation<HtmlManualPodCreateRequest> {
  if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
  const errors = onlyKnownKeys(input, ["displayName", "origin", "pathPrefix"], "request");
  const { displayName, origin } = input;
  if (!isSafeDisplayName(displayName)) {
    errors.push("displayName must be a non-empty bounded name");
  }
  if (typeof origin !== "string" || !isSafeManualOrigin(origin)) {
    errors.push("origin must be a safe https/http origin");
  }
  const pathPrefix = validateOptionalPathPrefix(input.pathPrefix, errors);
  if (errors.length > 0 || typeof displayName !== "string" || typeof origin !== "string") {
    return { ok: false, errors: errors.length > 0 ? errors : ["request is invalid"] };
  }
  return { ok: true, value: { displayName, origin, pathPrefix } };
}
