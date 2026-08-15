import {
  containsAbsolutePath,
  containsPseudoRoleMarker,
  stripUnsafeFormatChars,
} from "./text-safety.js";
import {
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { isCodeTaskIsoInstant } from "./code-task-acceptance.js";

export type CodingWorkbenchEvidenceKind =
  "run" | "permission" | "diff" | "verification" | "artifact" | "failure";

export const CODING_WORKBENCH_EVIDENCE_KINDS: readonly CodingWorkbenchEvidenceKind[] =
  Object.freeze([
    "run",
    "permission",
    "diff",
    "verification",
    "artifact",
    "failure",
  ] as const satisfies readonly CodingWorkbenchEvidenceKind[]);

export interface CodingWorkbenchEvidenceRecord {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly recordId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly kind: CodingWorkbenchEvidenceKind;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly artifactLabel?: string | undefined;
  readonly safeSummary?: string | undefined;
  readonly digest?: string | undefined;
  readonly byteCount?: number | undefined;
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly denied?: boolean | undefined;
}

const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:/_-]{0,95}$/u;
const URL_DETECTION_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/u;
const REDACTED_SUMMARY_PATTERN =
  /^(?:redacted-(?:url|path|command-log|content|auth|credential))(?:-(?:redacted-(?:url|path|command-log|content|auth|credential)))*$/u;
const SECRET_PATTERN =
  /\b(?:api[_-]?key|password|secret|token|sk-[\w-]{8,}|gh[opusr]_\w{8,}|github_pat_\w{8,})\b/iu;
const BEARER_CREDENTIAL_DETECTION_PATTERN = /\bBearer\s+[^\s"'`<>]+/iu;
const AUTHORIZATION_BEARER_DETECTION_PATTERN = /\bauthorization\s*[:=]\s*bearer\s+[^\s"'`<>]+/iu;
const KEY_VALUE_SECRET_DETECTION_PATTERN =
  /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*[^\s"'`<>]+/iu;
const SECRET_TOKEN_DETECTION_PATTERN = /\b(?:sk-[\w-]{8,}|gh[opusr]_\w{8,}|github_pat_\w{8,})\b/iu;
const COMMAND_LOG_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|npx|git|bash|zsh|node)\s+[^\n\r]+/iu;
const DIFF_PATTERN = /(?:^diff --git\s|^@@\s|^\+\+\+\s|^---\s)/mu;
const REDACTED_URL_TOKEN = "redacted-url";
const REDACTED_PATH_TOKEN = "redacted-path";
const REDACTED_COMMAND_LOG_TOKEN = "redacted-command-log";
const REDACTED_CONTENT_TOKEN = "redacted-content";
const REDACTED_BEARER_TOKEN = "redacted-auth";
const REDACTED_SECRET_TOKEN = "redacted-credential";
// KEIKO-0376: this used to be one Set (APPROVED_EVIDENCE_TOKENS) consulted only by
// isApprovedEvidenceToken, which is called per SEGMENT after isApprovedEvidenceLabel splits the
// candidate on `/[/._-]/u`. A segment can therefore never itself contain '/', '.', '_' or '-', so
// every hyphenated/dotted whole-string entry that used to live in that one Set was unreachable
// dead code -- and any legitimate composite literal missing even one constituent segment word
// (e.g. "governed-assist": "assist" was never an approved segment) was wrongly rejected despite
// appearing to be allow-listed. Split into two vocabularies with two different lookup shapes:
//   - APPROVED_EVIDENCE_SEGMENTS: separator-free words, consulted by isApprovedEvidenceToken
//     against each split segment, exactly as before.
//   - APPROVED_EVIDENCE_LITERALS: whole hyphenated/dotted strings, checked as a direct membership
//     test in isApprovedEvidenceLabel BEFORE the segment split runs.
// Neither Set bypasses hasDisallowedEvidenceContent: isCodingWorkbenchEvidenceSafeText still ANDs
// it in unconditionally, so approving a label's *shape* here can never approve its *content* --
// see the exclusion note on APPROVED_EVIDENCE_LITERALS below for the three composites this keeps
// out on purpose.
export const APPROVED_EVIDENCE_SEGMENTS = new Set<string>([
  "approval",
  "accepted",
  "artifact",
  "assisted",
  "autonomous",
  "allowlist",
  "allowlisted",
  "access",
  "adapter",
  // Issue #2244 (ADR-0128 D4): the `knowledge-base.read|write` connector scope labels split into
  // ["knowledge", "base", "read|write"] under the segment rule, and "read"/"write" are already
  // approved. Both segments are inert vocabulary words: neither can compose into a secret, URL,
  // path, or command fragment, and every label still passes the secret/URL/path detectors in
  // `isCodingWorkbenchEvidenceSafeText` regardless of token approval.
  "base",
  "knowledge",
  // Issue #2386: the runtime-question surface labels its content-free signal events (e.g.
  // `event-question-1`). "question" is an inert product vocabulary word — question text itself
  // never enters evidence, and the label still passes every secret/URL/path detector.
  "question",
  // Issue #2387: the three auxiliary-capability event surfaces label their content-free lifecycle
  // events (e.g. `event-research-1`, `event-skill-1`, `event-child-1`). Like "question" these are
  // inert product-vocabulary words; the research query, skill body, and child scratch never enter
  // evidence, and the labels still pass every secret/URL/path detector.
  "research",
  "skill",
  "child",
  "branch",
  "browser",
  "busy",
  "chatgpt",
  "cli",
  "codex",
  "coding",
  "command",
  "content",
  "connector",
  "control",
  "contracts",
  "connected",
  "degraded",
  "denied",
  "denial",
  "delivery",
  "dev",
  "device",
  "digest",
  "disabled",
  "ev",
  "event",
  "external",
  "execution",
  "expired",
  "failed",
  "failure",
  "gateway",
  "governed",
  "green",
  "head",
  "headless",
  "health",
  "human",
  "id",
  "install",
  "issue",
  "key",
  "keiko",
  "label",
  "local",
  "login",
  "main",
  "model",
  "missing",
  "mutating",
  "network",
  "node",
  "npm",
  "of",
  "openai",
  "operator",
  "out",
  "curl",
  "permission",
  "perm",
  "policy",
  "prefix",
  "produced",
  "profile",
  "proof",
  "read",
  "ready",
  "record",
  "redacted",
  "requested",
  "required",
  "revoked",
  "risk",
  "review",
  "run",
  "runner",
  "runtime",
  "evt",
  "sidecar",
  "sdk",
  "source",
  "scope",
  "scoped",
  "started",
  "status",
  "stale",
  "store",
  "stopped",
  "stdin",
  "subscription",
  "supervised",
  "task",
  "through",
  "tracker",
  "unknown",
  "ui",
  "url",
  "verification",
  "workbench",
  "workspace",
  "write",
  "workflow",
  "file",
  "edit",
  "commit",
  "push",
  "pull",
  "merge",
  // "request", "system", "mutation": NOT part of the original 184-entry table, added because a
  // real, currently-reachable producer needs them as standalone segments, not just as part of a
  // pre-registered literal. codingRuntimeManager.ts's supervisedEvidenceContext (called from
  // supervisedMutationEvent for every CodingWorkbenchSupervisedActionKind except
  // file-edit/verification-command) builds
  // `recordId: \`coding-runtime-${active.context.runId}-${label}\`` -- a dynamic string that can
  // never equal a fixed APPROVED_EVIDENCE_LITERALS entry because it embeds the run id. That
  // recordId is validated by isCodingWorkbenchEvidenceSafeText via
  // validateCodingWorkbenchEvidenceRecord (supervisedCodingPolicy.ts), which throws on failure, so
  // it can only ever pass through the segment-split path. Before this addition, any supervised
  // action with actionKind "pull-request" or "system-mutation" threw at evidence-validation time
  // in production (pull-request needs "request"; system-mutation needs both "system" and
  // "mutation") -- a pre-existing, currently-reachable bug this fix also closes. The other 11
  // words the audit record flagged as possibly missing ("assist", "state", "substrate",
  // "deployment", "managed", "unsupported", "code", "os", "owned", "by", "with") were traced
  // exhaustively across every dynamic-template call site in keiko-server and keiko-contracts and
  // found to be unnecessary: every real caller assigns either a fixed pre-registered literal or a
  // value validated by its own dedicated closed-enum check, never a runtime concatenation
  // involving one of those 11 words, so they are deliberately NOT added here.
  "request",
  "system",
  "mutation",
]);

// The 57 hyphenated/dotted whole-string entries the old Set carried, minus exactly 3 (see below).
// Every one of these is a real, declared literal from a canonical enum source in this package
// (coding-workbench.ts / coding-workbench-codex-auth.ts) or an existing evidence-kind label, not
// an invented value -- verified against those declarations, not re-derived from them, so this
// list cannot silently drift into approving a shape the product never actually emits.
//
// EXCLUDED ON PURPOSE, with evidence, not by oversight: "codex-access-token",
// "codex-login-with-access-token", and "openai-api-key-through-gateway" are real enum literals
// (CodingWorkbenchCodexAuthMethod, the commandLabelFor() derivation of the same, and
// CodingWorkbenchModelSource respectively) but each contains a bare `token` or `api-key` word
// that SECRET_PATTERN legitimately matches (`\btoken\b`, `\bapi[-_]?key\b`) -- confirmed by
// running the actual pattern against all 57 candidates, not assumed. Two independent reasons this
// stays excluded rather than added-and-bypassed:
//   1. hasDisallowedEvidenceContent must never be short-circuited by allowlist membership --
//      an allowlist hit answers "is this an approved shape", never "skip the content check". Real
//      credentials can and do look like enum-shaped strings; a per-value carve-out around a secret
//      heuristic is exactly the kind of hole that erodes a trust boundary over time.
//   2. It is also unnecessary: traced every real production caller of the three literals above --
//      `authMethod`/`method` (coding-workbench-codex-auth.ts:208,299,329), `commandLabel`
//      (coding-workbench-codex-auth.ts:351), and `modelSource`
//      (coding-workbench-evidence.ts, validateEvidenceMetadataFields) -- and all three fields are
//      validated by their own dedicated closed-enum `isOneOf` check, never by
//      isCodingWorkbenchEvidenceSafeText. None of the three ever needs to pass this guard in
//      practice. Adding them here anyway, knowing the content check would always veto them, would
//      recreate the exact "looks approved, can never actually pass" trap this finding exists to
//      remove — just relocated instead of eliminated.
export const APPROVED_EVIDENCE_LITERALS = new Set<string>([
  "runtime-state",
  "codex-cli-adapter",
  "codex-login",
  "codex-login-device-auth",
  "delivery-runner",
  "disabled-by-deployment",
  "failed-login",
  "chatgpt-browser-login",
  "chatgpt-device-code",
  "keiko-codex-runtime-state",
  "keiko-sidecar",
  "keiko-owned-state",
  "managed-sidecar-runtime",
  "os-credential-store",
  "unsupported-headless",
  "chatgpt-codex-subscription-profile",
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
  "branch-allowlist",
  "connector-access-requested",
  "artifact-produced",
  "failure-redacted",
  "human-approval",
  "policy-review",
  "verification-green",
  "workspace-read",
  "workspace-write",
  "file-edit",
  "verification-command",
  "pull-request",
  "connector-write",
  "external-write",
  "system-mutation",
  "out-of-scope-file-edit",
  "scoped-file-edit",
  "allowlisted-verification-command",
  "unknown-command-denied",
  "mutating-command-denied",
  "approval-required",
  "approval-proof-missing",
  "approval-proof-stale",
  "approval-proof-accepted",
  "operator-denied",
  "operator-stopped",
  "redacted-failure",
  "command-execution",
  "delivery-substrate",
  "source-control",
  "source-control.read",
  "source-control.write",
  "issue-tracker",
  "issue-tracker.read",
  "issue-tracker.write",
  // Not one of the original 57 -- found while deriving the KEIKO-0376 acceptance test straight
  // from CODING_WORKBENCH_ACTION_CLASSES (coding-workbench.ts): "network-egress" was never in the
  // old allowlist under either vocabulary, and unlike "connector-access" (which happens to
  // decompose into two pre-approved segments) its second segment "egress" was never approved on
  // its own either, so this evidence label has been silently rejected since the action class was
  // introduced. Added as a literal, verified clean against hasDisallowedEvidenceContent.
  "network-egress",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isSafeIntegerOrZero(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoInstant(value: unknown): value is string {
  return isCodeTaskIsoInstant(value);
}

function validateAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .forEach((key) => errors.push(`${path}.${key} is not allowed`));
}

function validateEvidenceIdentityFields(record: Record<string, unknown>, errors: string[]): void {
  if (record.recordId === undefined) {
    errors.push("record.recordId is required");
  } else if (!isCodingWorkbenchEvidenceSafeText(record.recordId)) {
    errors.push("record.recordId must be content-free evidence-safe text");
  }
  if (record.runId === undefined) {
    errors.push("record.runId is required");
  } else if (!isCodingWorkbenchEvidenceSafeText(record.runId)) {
    errors.push("record.runId must be content-free evidence-safe text");
  }
}

function validateEvidenceMetadataFields(record: Record<string, unknown>, errors: string[]): void {
  if (record.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isIsoInstant(record.occurredAt)) {
    errors.push("record.occurredAt must be an ISO-8601 UTC instant");
  }
  if (!isOneOf(record.kind, CODING_WORKBENCH_EVIDENCE_KINDS)) {
    errors.push("record.kind is invalid");
  }
  if (!isOneOf(record.effectiveMode, CODING_WORKBENCH_MODES)) {
    errors.push("record.effectiveMode is invalid");
  }
  if (!isOneOf(record.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)) {
    errors.push("record.runtimeSource is invalid");
  }
  if (!isOneOf(record.modelSource, CODING_WORKBENCH_MODEL_SOURCES)) {
    errors.push("record.modelSource is invalid");
  }
}

function validateDigest(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    errors.push(`${path} must be a 64-character lowercase hex digest`);
  }
}

const CODING_WORKBENCH_EVIDENCE_RECORD_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "recordId",
  "runId",
  "occurredAt",
  "kind",
  "effectiveMode",
  "runtimeSource",
  "modelSource",
  "artifactLabel",
  "safeSummary",
  "digest",
  "byteCount",
  "fileCount",
  "addedLines",
  "deletedLines",
  "passedCount",
  "failedCount",
  "skippedCount",
  "denied",
] as const);

function validateOptionalSafeEvidenceTextField(
  record: Record<string, unknown>,
  key: "artifactLabel" | "safeSummary",
  errors: string[],
): void {
  const value = record[key];
  if (value !== undefined && !isCodingWorkbenchEvidenceSafeText(value)) {
    errors.push(`record.${key} must be content-free evidence-safe text`);
  }
}

function validateOptionalDigestField(record: Record<string, unknown>, errors: string[]): void {
  if (record.digest !== undefined) {
    validateDigest(record.digest, "record.digest", errors);
  }
}

function validateOptionalNonNegativeIntegerFields(
  record: Record<string, unknown>,
  errors: string[],
): void {
  const keys = [
    "byteCount",
    "fileCount",
    "addedLines",
    "deletedLines",
    "passedCount",
    "failedCount",
    "skippedCount",
  ] as const;
  keys.forEach((key) => {
    if (record[key] !== undefined && !isSafeIntegerOrZero(record[key])) {
      errors.push(`record.${key} must be a non-negative safe integer`);
    }
  });
}

function validateOptionalBooleanField(
  record: Record<string, unknown>,
  key: "denied",
  errors: string[],
): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean") {
    errors.push(`record.${key} must be a boolean`);
  }
}

function validateEvidenceCommon(record: Record<string, unknown>, errors: string[]): void {
  validateEvidenceIdentityFields(record, errors);
  validateEvidenceMetadataFields(record, errors);
}

function isSafeEvidenceLabel(value: string): boolean {
  return SAFE_LABEL_PATTERN.test(value) && !/[\r\n\t]/u.test(value);
}

function isKnownRedactionSummary(value: string): boolean {
  return REDACTED_SUMMARY_PATTERN.test(value);
}

function isApprovedEvidenceToken(token: string): boolean {
  return (
    APPROVED_EVIDENCE_SEGMENTS.has(token) || /^\d+$/u.test(token) || /^[A-Z]{2,8}$/u.test(token)
  );
}

// Checks only the label's SHAPE (is it one of the pre-registered composite literals, or does it
// decompose into approved segments). Content safety is a separate, unconditional concern: every
// caller of this function reaches it through isCodingWorkbenchEvidenceSafeText, which ANDs in
// !hasDisallowedEvidenceContent(value) regardless of what this function returns (KEIKO-0376) --
// an approved shape can never bypass that check.
function isApprovedEvidenceLabel(value: string): boolean {
  if (APPROVED_EVIDENCE_LITERALS.has(value)) return true;
  if (!isSafeEvidenceLabel(value)) return false;
  if (value.endsWith("/")) {
    const prefix = value.slice(0, -1);
    return prefix.length > 0 && !prefix.endsWith("/") && isApprovedEvidenceLabel(prefix);
  }
  return value
    .split(/[/._-]/u)
    .filter((segment) => segment.length > 0)
    .every((segment) => isApprovedEvidenceToken(segment));
}

function addRedactionToken(summaryTokens: Set<string>, token: string): void {
  summaryTokens.add(token);
}

function addRedactionTokenIfMatched(
  summaryTokens: Set<string>,
  token: string,
  value: string,
  pattern: RegExp,
): void {
  if (pattern.test(value)) {
    summaryTokens.add(token);
  }
}

function addSecretRedactionTokens(summaryTokens: Set<string>, value: string): void {
  addRedactionTokenIfMatched(
    summaryTokens,
    REDACTED_BEARER_TOKEN,
    value,
    BEARER_CREDENTIAL_DETECTION_PATTERN,
  );
  addRedactionTokenIfMatched(
    summaryTokens,
    REDACTED_BEARER_TOKEN,
    value,
    AUTHORIZATION_BEARER_DETECTION_PATTERN,
  );
  addRedactionTokenIfMatched(
    summaryTokens,
    REDACTED_SECRET_TOKEN,
    value,
    KEY_VALUE_SECRET_DETECTION_PATTERN,
  );
  addRedactionTokenIfMatched(
    summaryTokens,
    REDACTED_SECRET_TOKEN,
    value,
    SECRET_TOKEN_DETECTION_PATTERN,
  );
  if (/\b(?:api[_-]?key|password|secret|token)\b/iu.test(value)) {
    summaryTokens.add(REDACTED_SECRET_TOKEN);
  }
}

function buildRedactionSummary(value: string): string {
  const summaryTokens = new Set<string>();
  const sanitized = stripUnsafeFormatChars(value);
  addRedactionTokenIfMatched(summaryTokens, REDACTED_CONTENT_TOKEN, sanitized, DIFF_PATTERN);
  addRedactionTokenIfMatched(
    summaryTokens,
    REDACTED_COMMAND_LOG_TOKEN,
    sanitized,
    COMMAND_LOG_PATTERN,
  );
  addRedactionTokenIfMatched(summaryTokens, REDACTED_URL_TOKEN, sanitized, URL_DETECTION_PATTERN);
  if (containsAbsolutePath(sanitized)) {
    addRedactionToken(summaryTokens, REDACTED_PATH_TOKEN);
  }
  addSecretRedactionTokens(summaryTokens, sanitized);
  if (summaryTokens.size === 0) {
    addRedactionToken(summaryTokens, REDACTED_CONTENT_TOKEN);
  }
  return Array.from(summaryTokens).join("-");
}

export function hasDisallowedEvidenceContent(value: string): boolean {
  return (
    URL_DETECTION_PATTERN.test(value) ||
    SECRET_PATTERN.test(value) ||
    BEARER_CREDENTIAL_DETECTION_PATTERN.test(value) ||
    AUTHORIZATION_BEARER_DETECTION_PATTERN.test(value) ||
    KEY_VALUE_SECRET_DETECTION_PATTERN.test(value) ||
    SECRET_TOKEN_DETECTION_PATTERN.test(value) ||
    DIFF_PATTERN.test(value) ||
    COMMAND_LOG_PATTERN.test(value)
  );
}

export function isCodingWorkbenchEvidenceSafeText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const stripped = stripUnsafeFormatChars(value);
  if (stripped !== value || stripped.trim() !== value) return false;
  return (
    (isKnownRedactionSummary(value) || isApprovedEvidenceLabel(value)) &&
    !containsAbsolutePath(value) &&
    !containsPseudoRoleMarker(value) &&
    !hasDisallowedEvidenceContent(value)
  );
}

export function redactCodingWorkbenchEvidenceText(value: string): string {
  if (isCodingWorkbenchEvidenceSafeText(value)) return value;
  const redacted = buildRedactionSummary(value);
  return isCodingWorkbenchEvidenceSafeText(redacted) ? redacted : REDACTED_CONTENT_TOKEN;
}

export function validateCodingWorkbenchEvidenceRecord(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchEvidenceRecord> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["evidence record must be an object"] };
  }
  const errors: string[] = [];
  validateAllowedKeys(value, CODING_WORKBENCH_EVIDENCE_RECORD_KEYS, "record", errors);
  validateEvidenceCommon(value, errors);
  validateOptionalSafeEvidenceTextField(value, "artifactLabel", errors);
  validateOptionalSafeEvidenceTextField(value, "safeSummary", errors);
  validateOptionalDigestField(value, errors);
  validateOptionalNonNegativeIntegerFields(value, errors);
  validateOptionalBooleanField(value, "denied", errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchEvidenceRecord };
}
