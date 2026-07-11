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
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:/_-]{0,95}$/u;
const URL_DETECTION_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/u;
const REDACTED_SUMMARY_PATTERN =
  /^(?:redacted-(?:url|path|command-log|content|auth|credential))(?:-(?:redacted-(?:url|path|command-log|content|auth|credential)))*$/u;
const SECRET_PATTERN =
  /\b(?:api[_-]?key|password|secret|token|sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/iu;
const BEARER_CREDENTIAL_DETECTION_PATTERN = /\bBearer\s+[^\s"'`<>]+/iu;
const AUTHORIZATION_BEARER_DETECTION_PATTERN = /\bauthorization\s*[:=]\s*bearer\s+[^\s"'`<>]+/iu;
const KEY_VALUE_SECRET_DETECTION_PATTERN =
  /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*[^\s"'`<>]+/iu;
const SECRET_TOKEN_DETECTION_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/iu;
const COMMAND_LOG_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|npx|git|bash|zsh|node)\s+[^\n\r]+/iu;
const DIFF_PATTERN = /(?:^diff --git\s|^@@\s|^\+\+\+\s|^---\s)/mu;
const REDACTED_URL_TOKEN = "redacted-url";
const REDACTED_PATH_TOKEN = "redacted-path";
const REDACTED_COMMAND_LOG_TOKEN = "redacted-command-log";
const REDACTED_CONTENT_TOKEN = "redacted-content";
const REDACTED_BEARER_TOKEN = "redacted-auth";
const REDACTED_SECRET_TOKEN = "redacted-credential";
const APPROVED_EVIDENCE_TOKENS = new Set<string>([
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
  "runtime-state",
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
  "codex-cli-adapter",
  "codex-access-token",
  "codex-login",
  "codex-login-device-auth",
  "codex-login-with-access-token",
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
  "policy-allowed-local-install",
  "unsupported-headless",
  "openai-api-key-through-gateway",
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
  "file",
  "edit",
  "file-edit",
  "verification-command",
  "commit",
  "push",
  "pull",
  "pull-request",
  "merge",
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
  return (
    typeof value === "string" && ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
  );
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
    APPROVED_EVIDENCE_TOKENS.has(token) || /^[0-9]+$/u.test(token) || /^[A-Z]{2,8}$/u.test(token)
  );
}

function isApprovedEvidenceLabel(value: string): boolean {
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
