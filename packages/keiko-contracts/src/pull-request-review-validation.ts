// Runtime validation for the Keiko for Quality review contracts (ADR-0182, Issue #4131).
//
// Every validator takes `unknown`, rejects unknown fields and returns either the normalized value
// or a list of typed issues. Display text is NFC-normalized and stripped of bidirectional and
// zero-width format characters; control characters are rejected rather than stripped, so a
// hostile value is refused instead of silently rewritten.

import { isRecord } from "./contract-validation-primitives.js";
import { isGitObjectId, isSafeGitRefName } from "./git-repository.js";
import { hasControlCharacter, stripUnsafeFormatChars } from "./text-safety.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import {
  COUNTER_CHECK_REASON_CODES,
  COUNTER_CHECK_VERDICTS,
  FINDING_DISMISSAL_REASONS,
  REVIEW_DECISION_NOTE_MAX_CHARS,
  REVIEW_DISPLAY_REF_MAX_CHARS,
  REVIEW_EVIDENCE_MAX_ENTRIES,
  REVIEW_EVIDENCE_MIN_ENTRIES,
  REVIEW_EVIDENCE_ROLES,
  REVIEW_FAILURE_MODE_TEXT_MAX_CHARS,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_TEXT_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_CLIENT_REQUEST_ID_MAX_CHARS,
  REVIEW_LINE_MAX,
  REVIEW_MODEL_ID_MAX_CHARS,
  REVIEW_PRESENTED_FINDINGS_MAX,
  REVIEW_PULL_REQUEST_NUMBER_MAX,
  REVIEW_REPOSITORY_ID_MAX_CHARS,
  REVIEW_RUN_ID_MAX_CHARS,
  REVIEW_SETTLEMENT_REASONS,
  REVIEW_ALLOWED_MODEL_IDS_MAX,
  REVIEW_OPERATOR_ENV_VARIABLES,
  REVIEW_REPOSITORY_PRESETS_MAX,
  REVIEW_SETTINGS_SCHEMA_VERSION,
  type CounterCheckVerdict,
  type FindingDecision,
  type ReviewEvidence,
  type ReviewFailureMode,
  type ReviewFindingRecord,
  type ReviewFindingReport,
  type ReviewModelPolicy,
  type ReviewOperatorConfig,
  type ReviewOperatorConfigIssue,
  type ReviewOperatorConfigKey,
  type ReviewPairQualificationStartRequest,
  type ReviewRepositoryPreset,
  type ReviewRunSettlement,
  type ReviewSettingsDocument,
  type ReviewSettingsUpdateRequest,
  type ReviewRunStartRequest,
  type ReviewTarget,
} from "./pull-request-review.js";

export const REVIEW_CONTRACT_ISSUE_CODES = [
  "not-an-object",
  "unknown-field",
  "missing-field",
  "wrong-type",
  "too-long",
  "empty",
  "control-character",
  "invalid-path",
  "invalid-line-range",
  "invalid-evidence-count",
  "unknown-enum-value",
  "invalid-object-id",
  "invalid-ref-name",
  "invalid-identifier",
  "invalid-number",
  "invalid-fingerprint",
  "inconsistent-fields",
] as const;
export type ReviewContractIssueCode = (typeof REVIEW_CONTRACT_ISSUE_CODES)[number];

export interface ReviewContractIssue {
  readonly code: ReviewContractIssueCode;
  /** Dotted field path, e.g. `evidence.2.file`. Never echoes the rejected value. */
  readonly path: string;
}

export type ReviewContractValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ReviewContractIssue[] };

type Issues = ReviewContractIssue[];
type Fields = Record<string, unknown>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

// ─── Primitive checks ────────────────────────────────────────────────────────

function own(record: Fields, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function checkKeys(
  record: Fields,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: Issues,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push({ code: "unknown-field", path: join(path, key) });
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) issues.push({ code: "missing-field", path: join(path, key) });
  }
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${String(key)}`;
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push({ code: "unknown-enum-value", path });
  }
}

function checkBoolean(value: unknown, path: string, issues: Issues): void {
  if (value !== undefined && typeof value !== "boolean") issues.push({ code: "wrong-type", path });
}

function checkIdentifier(value: unknown, maxChars: number, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string") issues.push({ code: "wrong-type", path });
  else if (value.length > maxChars) issues.push({ code: "too-long", path });
  else if (!SAFE_IDENTIFIER.test(value)) issues.push({ code: "invalid-identifier", path });
}

function checkObjectId(value: unknown, path: string, issues: Issues): void {
  if (value !== undefined && !isGitObjectId(value)) {
    issues.push({ code: "invalid-object-id", path });
  }
}

function checkRefName(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.startsWith("refs/") || !isSafeGitRefName(value)) {
    issues.push({ code: "invalid-ref-name", path });
  }
}

/**
 * A provider-reported branch name of a pull request target: display data only (Keiko fetches
 * `refs/pull/<n>/head` and reviews SHAs), so any name GitHub accepts is representable, but it must
 * be non-empty, bounded and free of control, bidi and zero-width characters. It is never passed to
 * Git as an argument.
 */
function checkDisplayRefName(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  const valid =
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REVIEW_DISPLAY_REF_MAX_CHARS &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    stripUnsafeFormatChars(value) === value;
  if (!valid) issues.push({ code: "invalid-ref-name", path });
}

function checkInteger(value: unknown, max: number, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    issues.push({ code: "invalid-number", path });
  }
}

/**
 * Normalizes untrusted display text: NFC, then bidirectional and zero-width format characters
 * removed. Control characters are refused, not stripped; `multiline` admits TAB, LF and CR.
 */
function normalizeText(
  value: unknown,
  maxChars: number,
  options: { readonly multiline: boolean },
  path: string,
  issues: Issues,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({ code: "wrong-type", path });
    return undefined;
  }
  // Checked before stripping: `stripUnsafeFormatChars` would silently remove C0/C1 controls.
  const probe = options.multiline ? value.replace(/[\t\n\r]/gu, " ") : value;
  const normalized = stripUnsafeFormatChars(value.normalize("NFC"));
  if (hasControlCharacter(probe)) issues.push({ code: "control-character", path });
  else if (normalized.trim().length === 0) issues.push({ code: "empty", path });
  else if (normalized.length > maxChars) issues.push({ code: "too-long", path });
  return normalized;
}

function checkPath(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string") issues.push({ code: "wrong-type", path });
  else if (hasControlCharacter(value) || stripUnsafeFormatChars(value) !== value) {
    issues.push({ code: "control-character", path });
  } else if (!isPortableWorkspaceRelativePath(value)) issues.push({ code: "invalid-path", path });
}

function checkLineRange(record: Fields, path: string, issues: Issues): void {
  const start = own(record, "startLine");
  const end = own(record, "endLine");
  checkInteger(start, REVIEW_LINE_MAX, join(path, "startLine"), issues);
  checkInteger(end, REVIEW_LINE_MAX, join(path, "endLine"), issues);
  if (typeof start === "number" && typeof end === "number" && end < start) {
    issues.push({ code: "invalid-line-range", path: join(path, "endLine") });
  }
}

function finish<T>(value: T, issues: Issues): ReviewContractValidation<T> {
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

function notAnObject<T>(path: string): ReviewContractValidation<T> {
  return { ok: false, issues: [{ code: "not-an-object", path: path === "" ? "$" : path }] };
}

// ─── Review target ───────────────────────────────────────────────────────────

const RANGE_TARGET_KEYS = ["kind", "repositoryId", "baseSha", "headSha", "baseRef", "headRef"];
const PULL_REQUEST_TARGET_KEYS = [...RANGE_TARGET_KEYS, "provider", "number", "isCrossRepository"];

export function validateReviewTarget(value: unknown): ReviewContractValidation<ReviewTarget> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  const kind = own(value, "kind");
  if (kind !== "pull-request" && kind !== "local-range") {
    return { ok: false, issues: [{ code: "unknown-enum-value", path: "kind" }] };
  }
  const keys = kind === "pull-request" ? PULL_REQUEST_TARGET_KEYS : RANGE_TARGET_KEYS;
  checkKeys(value, keys, [], "", issues);
  checkIdentifier(
    own(value, "repositoryId"),
    REVIEW_REPOSITORY_ID_MAX_CHARS,
    "repositoryId",
    issues,
  );
  checkObjectId(own(value, "baseSha"), "baseSha", issues);
  checkObjectId(own(value, "headSha"), "headSha", issues);
  // A local range names refs Keiko resolves with Git; a pull request reports display names only.
  const checkRef = kind === "local-range" ? checkRefName : checkDisplayRefName;
  checkRef(own(value, "baseRef"), "baseRef", issues);
  checkRef(own(value, "headRef"), "headRef", issues);
  if (kind === "pull-request") {
    checkEnum(own(value, "provider"), ["github"], "provider", issues);
    checkInteger(own(value, "number"), REVIEW_PULL_REQUEST_NUMBER_MAX, "number", issues);
    checkBoolean(own(value, "isCrossRepository"), "isCrossRepository", issues);
  }
  return finish({ ...value } as unknown as ReviewTarget, issues);
}

// ─── Run id and settlement ───────────────────────────────────────────────────

export function isReviewRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= REVIEW_RUN_ID_MAX_CHARS &&
    SAFE_IDENTIFIER.test(value)
  );
}

export function validateReviewRunSettlement(
  value: unknown,
): ReviewContractValidation<ReviewRunSettlement> {
  if (!isRecord(value)) return notAnObject("");
  const kind = own(value, "kind");
  if (typeof kind !== "string" || !Object.hasOwn(REVIEW_SETTLEMENT_REASONS, kind)) {
    return { ok: false, issues: [{ code: "unknown-enum-value", path: "kind" }] };
  }
  const reasons: readonly string[] =
    REVIEW_SETTLEMENT_REASONS[kind as keyof typeof REVIEW_SETTLEMENT_REASONS];
  const issues: Issues = [];
  checkKeys(value, reasons.length === 0 ? ["kind"] : ["kind", "reason"], [], "", issues);
  if (reasons.length > 0) checkEnum(own(value, "reason"), reasons, "reason", issues);
  return finish({ ...value } as unknown as ReviewRunSettlement, issues);
}

// ─── Evidence and findings ───────────────────────────────────────────────────

const EVIDENCE_KEYS = ["file", "startLine", "endLine", "role"];

function validateEvidenceList(
  value: unknown,
  path: string,
  issues: Issues,
  options: { readonly minEntries: number },
): readonly ReviewEvidence[] {
  if (!Array.isArray(value)) {
    issues.push({ code: "wrong-type", path });
    return [];
  }
  if (value.length < options.minEntries || value.length > REVIEW_EVIDENCE_MAX_ENTRIES) {
    issues.push({ code: "invalid-evidence-count", path });
  }
  return value.map((entry: unknown, index): ReviewEvidence => {
    const entryPath = join(path, index);
    if (!isRecord(entry)) {
      issues.push({ code: "not-an-object", path: entryPath });
      return entry as ReviewEvidence;
    }
    checkKeys(entry, EVIDENCE_KEYS, [], entryPath, issues);
    checkPath(own(entry, "file"), join(entryPath, "file"), issues);
    checkLineRange(entry, entryPath, issues);
    checkEnum(own(entry, "role"), REVIEW_EVIDENCE_ROLES, join(entryPath, "role"), issues);
    return { ...entry } as unknown as ReviewEvidence;
  });
}

function validateFailureMode(
  value: unknown,
  path: string,
  issues: Issues,
): ReviewFailureMode | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ code: "not-an-object", path });
    return undefined;
  }
  checkKeys(value, ["trigger", "detection", "coveredByChange"], [], path, issues);
  const text = { multiline: true };
  const max = REVIEW_FAILURE_MODE_TEXT_MAX_CHARS;
  const trigger = normalizeText(own(value, "trigger"), max, text, join(path, "trigger"), issues);
  const detection = normalizeText(
    own(value, "detection"),
    max,
    text,
    join(path, "detection"),
    issues,
  );
  checkBoolean(own(value, "coveredByChange"), join(path, "coveredByChange"), issues);
  return { ...value, trigger, detection } as unknown as ReviewFailureMode;
}

const REPORT_REQUIRED_KEYS = [
  "file",
  "startLine",
  "endLine",
  "title",
  "condition",
  "mechanism",
  "consequence",
  "remedy",
  "category",
  "severity",
  "evidence",
];
const REPORT_PROSE_KEYS = ["condition", "mechanism", "consequence", "remedy"] as const;

function validateReportFields(value: Fields, path: string, issues: Issues): ReviewFindingReport {
  checkKeys(value, REPORT_REQUIRED_KEYS, ["failureMode"], path, issues);
  checkPath(own(value, "file"), join(path, "file"), issues);
  checkLineRange(value, path, issues);
  const title = normalizeText(
    own(value, "title"),
    REVIEW_FINDING_TITLE_MAX_CHARS,
    { multiline: false },
    join(path, "title"),
    issues,
  );
  const prose = Object.fromEntries(
    REPORT_PROSE_KEYS.map((key) => [
      key,
      normalizeText(
        own(value, key),
        REVIEW_FINDING_TEXT_MAX_CHARS,
        { multiline: true },
        join(path, key),
        issues,
      ),
    ]),
  );
  checkEnum(own(value, "category"), REVIEW_FINDING_CATEGORIES, join(path, "category"), issues);
  checkEnum(own(value, "severity"), REVIEW_FINDING_SEVERITIES, join(path, "severity"), issues);
  const evidence = validateEvidenceList(own(value, "evidence"), join(path, "evidence"), issues, {
    minEntries: REVIEW_EVIDENCE_MIN_ENTRIES,
  });
  const failureMode = validateFailureMode(
    own(value, "failureMode"),
    join(path, "failureMode"),
    issues,
  );
  const report = { ...value, title, ...prose, evidence };
  return (failureMode === undefined ? report : { ...report, failureMode }) as ReviewFindingReport;
}

/** Validates one `keiko_review_report` argument: the Reviewer's candidate finding. */
export function validateReviewFindingReport(
  value: unknown,
): ReviewContractValidation<ReviewFindingReport> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  const report = validateReportFields(value, "", issues);
  const hasDefect = report.evidence.some(
    (entry) => isRecord(entry) && own(entry, "role") === "defect",
  );
  if (Array.isArray(own(value, "evidence")) && !hasDefect) {
    issues.push({ code: "inconsistent-fields", path: "evidence" });
  }
  return finish(report, issues);
}

export function isReviewFindingFingerprint(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function checkFingerprint(value: unknown, path: string, issues: Issues): void {
  if (value !== undefined && !isReviewFindingFingerprint(value)) {
    issues.push({ code: "invalid-fingerprint", path });
  }
}

const VERDICT_KEYS = ["findingFingerprint", "verdict", "evidence", "reasonCode"];

function validateVerdictFields(value: Fields, path: string, issues: Issues): CounterCheckVerdict {
  checkKeys(value, VERDICT_KEYS, [], path, issues);
  checkFingerprint(own(value, "findingFingerprint"), join(path, "findingFingerprint"), issues);
  const verdict = own(value, "verdict");
  checkEnum(verdict, COUNTER_CHECK_VERDICTS, join(path, "verdict"), issues);
  checkEnum(own(value, "reasonCode"), COUNTER_CHECK_REASON_CODES, join(path, "reasonCode"), issues);
  const evidence = validateEvidenceList(own(value, "evidence"), join(path, "evidence"), issues, {
    minEntries: verdict === "confirmed" ? REVIEW_EVIDENCE_MIN_ENTRIES : 0,
  });
  if (verdict === "confirmed" && own(value, "reasonCode") !== "defect-reproduced-in-code") {
    issues.push({ code: "inconsistent-fields", path: join(path, "reasonCode") });
  }
  return { ...value, evidence } as unknown as CounterCheckVerdict;
}

/** Validates a Counter-checker verdict. A confirmation must carry its own code evidence. */
export function validateCounterCheckVerdict(
  value: unknown,
): ReviewContractValidation<CounterCheckVerdict> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  return finish(validateVerdictFields(value, "", issues), issues);
}

const RECORD_KEYS = ["fingerprint", "report", "presented"];

function checkPresentation(value: Fields, verdict: unknown, issues: Issues): void {
  const presented = own(value, "presented");
  const rank = own(value, "presentationRank");
  checkBoolean(presented, "presented", issues);
  checkInteger(rank, REVIEW_PRESENTED_FINDINGS_MAX, "presentationRank", issues);
  const confirmed = isRecord(verdict) && own(verdict, "verdict") === "confirmed";
  if (presented === true && (!confirmed || rank === undefined)) {
    issues.push({ code: "inconsistent-fields", path: "presented" });
  }
  if (presented === false && rank !== undefined) {
    issues.push({ code: "inconsistent-fields", path: "presentationRank" });
  }
}

function validateRecordVerdict(
  value: unknown,
  fingerprint: unknown,
  issues: Issues,
): CounterCheckVerdict | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ code: "not-an-object", path: "verdict" });
    return undefined;
  }
  if (own(value, "findingFingerprint") !== fingerprint) {
    issues.push({ code: "inconsistent-fields", path: "verdict.findingFingerprint" });
  }
  return validateVerdictFields(value, "verdict", issues);
}

/** Validates the server record of one candidate finding: only confirmed findings are presented. */
export function validateReviewFindingRecord(
  value: unknown,
): ReviewContractValidation<ReviewFindingRecord> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  checkKeys(value, RECORD_KEYS, ["verdict", "presentationRank"], "", issues);
  const fingerprint = own(value, "fingerprint");
  checkFingerprint(fingerprint, "fingerprint", issues);
  const rawReport = own(value, "report");
  const report = isRecord(rawReport)
    ? validateReportFields(rawReport, "report", issues)
    : undefined;
  if (!isRecord(rawReport)) issues.push({ code: "not-an-object", path: "report" });
  const rawVerdict = own(value, "verdict");
  const verdict = validateRecordVerdict(rawVerdict, fingerprint, issues);
  checkPresentation(value, rawVerdict, issues);
  const record = { ...value, report, ...(verdict === undefined ? {} : { verdict }) };
  return finish(record as unknown as ReviewFindingRecord, issues);
}

// ─── Decisions and model policy ──────────────────────────────────────────────

/** Validates a person's finding decision; the optional note is private content. */
export function validateFindingDecision(value: unknown): ReviewContractValidation<FindingDecision> {
  if (!isRecord(value)) return notAnObject("");
  const decision = own(value, "decision");
  if (decision !== "accepted" && decision !== "dismissed" && decision !== "fixed") {
    return { ok: false, issues: [{ code: "unknown-enum-value", path: "decision" }] };
  }
  const issues: Issues = [];
  const required = decision === "dismissed" ? ["decision", "reason"] : ["decision"];
  checkKeys(value, required, ["note"], "", issues);
  if (decision === "dismissed") {
    checkEnum(own(value, "reason"), FINDING_DISMISSAL_REASONS, "reason", issues);
  }
  const note = normalizeText(
    own(value, "note"),
    REVIEW_DECISION_NOTE_MAX_CHARS,
    { multiline: true },
    "note",
    issues,
  );
  const decided = note === undefined ? { ...value } : { ...value, note };
  return finish(decided as unknown as FindingDecision, issues);
}

export function isReviewModelId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= REVIEW_MODEL_ID_MAX_CHARS && MODEL_ID.test(value)
  );
}

function checkModelId(value: unknown, path: string, issues: Issues): void {
  if (value === undefined) return;
  if (typeof value !== "string") issues.push({ code: "wrong-type", path });
  else if (value.length > REVIEW_MODEL_ID_MAX_CHARS) issues.push({ code: "too-long", path });
  else if (!MODEL_ID.test(value)) issues.push({ code: "invalid-identifier", path });
}

/** Validates the model ids bound to the Reviewer and Counter-checker roles. */
export function validateReviewModelPolicy(
  value: unknown,
): ReviewContractValidation<ReviewModelPolicy> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  checkKeys(value, ["reviewerModelId", "counterCheckerModelId"], [], "", issues);
  checkModelId(own(value, "reviewerModelId"), "reviewerModelId", issues);
  checkModelId(own(value, "counterCheckerModelId"), "counterCheckerModelId", issues);
  return finish({ ...value } as unknown as ReviewModelPolicy, issues);
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function checkClientRequestId(value: unknown, issues: Issues): void {
  if (typeof value !== "string") issues.push({ code: "wrong-type", path: "clientRequestId" });
  else if (value.length > REVIEW_CLIENT_REQUEST_ID_MAX_CHARS) {
    issues.push({ code: "too-long", path: "clientRequestId" });
  } else if (!CLIENT_REQUEST_ID.test(value)) {
    issues.push({ code: "invalid-identifier", path: "clientRequestId" });
  }
}

function validateTargetRequest(value: unknown, issues: Issues): void {
  if (!isRecord(value)) {
    issues.push({ code: "not-an-object", path: "target" });
    return;
  }
  const kind = own(value, "kind");
  if (kind === "pull-request") {
    checkKeys(value, ["kind", "number"], [], "target", issues);
    const number = own(value, "number");
    if (number === undefined) return;
    checkInteger(number, REVIEW_PULL_REQUEST_NUMBER_MAX, "target.number", issues);
    return;
  }
  if (kind === "local-range") {
    checkKeys(value, ["kind", "baseRef", "headRef"], [], "target", issues);
    checkRefName(own(value, "baseRef"), "target.baseRef", issues);
    checkRefName(own(value, "headRef"), "target.headRef", issues);
    return;
  }
  issues.push({ code: "unknown-enum-value", path: "target.kind" });
}

/**
 * Validates a `POST /api/git-review/runs` body. The key set is closed: evaluation switches such as
 * a disabled counter-check or a role swap are refused as unknown fields, never honoured.
 */
export function validateReviewRunStartRequest(
  value: unknown,
): ReviewContractValidation<ReviewRunStartRequest> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  const required = ["target", "reviewerModelId", "counterCheckerModelId", "clientRequestId"];
  checkKeys(value, required, ["dryRun"], "", issues);
  validateTargetRequest(own(value, "target"), issues);
  checkModelId(own(value, "reviewerModelId"), "reviewerModelId", issues);
  checkModelId(own(value, "counterCheckerModelId"), "counterCheckerModelId", issues);
  checkClientRequestId(own(value, "clientRequestId"), issues);
  checkBoolean(own(value, "dryRun"), "dryRun", issues);
  return finish({ ...value } as unknown as ReviewRunStartRequest, issues);
}

// ─── Model policy and review settings (Issue #4137) ─────────────────────────

/**
 * A review-rules path a repository may configure: portable, repository-relative, no `.` or `..`
 * segment, no control, bidirectional or zero-width character. Anything else could name a file
 * outside the tree, so it is refused rather than normalized.
 */
export function isReviewRulesFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !hasControlCharacter(value) &&
    stripUnsafeFormatChars(value) === value &&
    isPortableWorkspaceRelativePath(value)
  );
}

/** A content-free repository id as the review routes address repositories. */
export function isReviewRepositoryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= REVIEW_REPOSITORY_ID_MAX_CHARS &&
    SAFE_IDENTIFIER.test(value)
  );
}

type EnvLookup = Readonly<Record<string, string | undefined>>;

const OPERATOR_FILE_KEYS: ReadonlySet<string> = new Set([
  "enabled",
  "reviewerModelId",
  "counterCheckerModelId",
  "allowedReviewModelIds",
  "lockModelPolicy",
  "rulesFilePath",
  "repositories",
]);

interface OperatorValue {
  readonly value: unknown;
  readonly source: "file" | "environment";
}

/** The environment value of `key` when set (non-empty after trimming), else the file value. */
function operatorValue(
  block: Fields,
  env: EnvLookup,
  key: keyof typeof REVIEW_OPERATOR_ENV_VARIABLES,
): OperatorValue | undefined {
  const raw = env[REVIEW_OPERATOR_ENV_VARIABLES[key]]?.trim();
  if (raw !== undefined && raw.length > 0) return { value: raw, source: "environment" };
  return Object.hasOwn(block, key) ? { value: block[key], source: "file" } : undefined;
}

function operatorBoolean(entry: OperatorValue | undefined): boolean | undefined | "invalid" {
  if (entry === undefined) return undefined;
  if (typeof entry.value === "boolean") return entry.value;
  if (entry.source === "environment" && (entry.value === "true" || entry.value === "false")) {
    return entry.value === "true";
  }
  return "invalid";
}

function operatorModelIds(
  entry: OperatorValue | undefined,
): readonly string[] | undefined | "invalid" {
  if (entry === undefined) return undefined;
  const list =
    entry.source === "environment" && typeof entry.value === "string"
      ? entry.value.split(",").map((item) => item.trim())
      : entry.value;
  if (!Array.isArray(list) || list.length === 0 || list.length > REVIEW_ALLOWED_MODEL_IDS_MAX) {
    return "invalid";
  }
  const ids = list as readonly unknown[];
  const valid = ids.every(isReviewModelId) && new Set(ids).size === ids.length;
  return valid ? ids : "invalid";
}

function operatorPresets(
  value: unknown,
): Readonly<Record<string, ReviewRepositoryPreset>> | "invalid" {
  if (!isRecord(value)) return "invalid";
  const entries = Object.entries(value);
  if (entries.length > REVIEW_REPOSITORY_PRESETS_MAX) return "invalid";
  const presets: Record<string, ReviewRepositoryPreset> = {};
  for (const [repositoryId, preset] of entries) {
    if (!isReviewRepositoryId(repositoryId) || !isRecord(preset)) return "invalid";
    const keys = Object.keys(preset);
    if (keys.some((key) => key !== "rulesFilePath")) return "invalid";
    const rulesFilePath = own(preset, "rulesFilePath");
    if (rulesFilePath !== undefined && !isReviewRulesFilePath(rulesFilePath)) return "invalid";
    presets[repositoryId] = rulesFilePath === undefined ? {} : { rulesFilePath };
  }
  return presets;
}

interface OperatorDraft {
  enabled: boolean;
  lockModelPolicy: boolean;
  reviewerModelId?: string;
  counterCheckerModelId?: string;
  allowedReviewModelIds?: readonly string[];
  rulesFilePath?: string;
  repositories: Readonly<Record<string, ReviewRepositoryPreset>>;
  readonly issues: ReviewOperatorConfigIssue[];
}

function noteIssue(
  draft: OperatorDraft,
  key: ReviewOperatorConfigKey,
  entry: OperatorValue | undefined,
): void {
  draft.issues.push({ key, source: entry?.source ?? "file" });
}

function applySwitches(draft: OperatorDraft, block: Fields, env: EnvLookup): void {
  const enabledEntry = operatorValue(block, env, "enabled");
  const enabled = operatorBoolean(enabledEntry);
  if (enabled === "invalid") noteIssue(draft, "enabled", enabledEntry);
  else draft.enabled = enabled ?? false;
  const lockEntry = operatorValue(block, env, "lockModelPolicy");
  const lock = operatorBoolean(lockEntry);
  if (lock === "invalid") {
    noteIssue(draft, "lockModelPolicy", lockEntry);
    draft.lockModelPolicy = true;
  } else draft.lockModelPolicy = lock ?? false;
}

function applyModels(draft: OperatorDraft, block: Fields, env: EnvLookup): void {
  const allowedEntry = operatorValue(block, env, "allowedReviewModelIds");
  const allowed = operatorModelIds(allowedEntry);
  if (allowed === "invalid") noteIssue(draft, "allowedReviewModelIds", allowedEntry);
  else if (allowed !== undefined) draft.allowedReviewModelIds = allowed;
  const allowlist = allowed === "invalid" ? undefined : allowed;
  for (const key of ["reviewerModelId", "counterCheckerModelId"] as const) {
    const entry = operatorValue(block, env, key);
    if (entry === undefined) continue;
    const value = entry.value;
    const valid = isReviewModelId(value) && (allowlist === undefined || allowlist.includes(value));
    if (valid) draft[key] = value;
    else noteIssue(draft, key, entry);
  }
}

function applyRules(draft: OperatorDraft, block: Fields, env: EnvLookup): void {
  const rulesEntry = operatorValue(block, env, "rulesFilePath");
  if (rulesEntry !== undefined) {
    if (isReviewRulesFilePath(rulesEntry.value)) draft.rulesFilePath = rulesEntry.value;
    else noteIssue(draft, "rulesFilePath", rulesEntry);
  }
  if (!Object.hasOwn(block, "repositories")) return;
  const presets = operatorPresets(block.repositories);
  if (presets === "invalid") noteIssue(draft, "repositories", undefined);
  else draft.repositories = presets;
}

/**
 * Parses the operator's `review` section of `keiko.config.json` with its environment overrides
 * (`REVIEW_OPERATOR_ENV_VARIABLES`). It never throws: every invalid explicit value (a wrong type, an
 * unsafe id or path, a default outside the allowlist, an unknown key) becomes a closed issue and
 * the value is left out, so the gateway configuration keeps loading while the review policy fails
 * closed. An absent section with no override is the default: disabled, unlocked, unrestricted.
 */
export function parseReviewOperatorConfig(raw: unknown, env: EnvLookup = {}): ReviewOperatorConfig {
  const draft: OperatorDraft = {
    enabled: false,
    lockModelPolicy: false,
    repositories: {},
    issues: [],
  };
  const block = raw === undefined ? {} : raw;
  if (!isRecord(block)) {
    draft.issues.push({ key: "review", source: "file" });
    return { ...draft };
  }
  if (Object.keys(block).some((key) => !OPERATOR_FILE_KEYS.has(key))) {
    draft.issues.push({ key: "review", source: "file" });
  }
  applySwitches(draft, block, env);
  applyModels(draft, block, env);
  applyRules(draft, block, env);
  return { ...draft };
}

function checkNullableModelId(record: Fields, key: string, issues: Issues): void {
  const value = own(record, key);
  if (value !== null) checkModelId(value, key, issues);
}

function checkRevision(value: unknown, path: string, issues: Issues, min: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    issues.push({ code: "invalid-number", path });
  }
}

function checkRulesFilePath(value: unknown, path: string, issues: Issues): void {
  if (value === undefined || value === null) return;
  if (!isReviewRulesFilePath(value)) issues.push({ code: "invalid-path", path });
}

const SETTINGS_UPDATE_KEYS = [
  "expectedRevision",
  "reviewerModelId",
  "counterCheckerModelId",
  "rulesFilePath",
];

/** Validates a `PUT /api/git-review/settings` body; the key set is closed. */
export function validateReviewSettingsUpdateRequest(
  value: unknown,
): ReviewContractValidation<ReviewSettingsUpdateRequest> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  checkKeys(value, [], SETTINGS_UPDATE_KEYS, "", issues);
  checkRevision(own(value, "expectedRevision"), "expectedRevision", issues, 0);
  checkNullableModelId(value, "reviewerModelId", issues);
  checkNullableModelId(value, "counterCheckerModelId", issues);
  checkRulesFilePath(own(value, "rulesFilePath"), "rulesFilePath", issues);
  return finish<ReviewSettingsUpdateRequest>({ ...value }, issues);
}

/** Validates a stored settings document read back from disk; anything else is not trusted. */
export function validateReviewSettingsDocument(
  value: unknown,
): ReviewContractValidation<ReviewSettingsDocument> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  const optional = ["reviewerModelId", "counterCheckerModelId", "rulesFilePath", "updatedAt"];
  checkKeys(value, ["schemaVersion", "repositoryId", "revision"], optional, "", issues);
  if (own(value, "schemaVersion") !== REVIEW_SETTINGS_SCHEMA_VERSION) {
    issues.push({ code: "unknown-enum-value", path: "schemaVersion" });
  }
  if (!isReviewRepositoryId(own(value, "repositoryId"))) {
    issues.push({ code: "invalid-identifier", path: "repositoryId" });
  }
  checkRevision(own(value, "revision"), "revision", issues, 1);
  checkModelId(own(value, "reviewerModelId"), "reviewerModelId", issues);
  checkModelId(own(value, "counterCheckerModelId"), "counterCheckerModelId", issues);
  checkRulesFilePath(own(value, "rulesFilePath"), "rulesFilePath", issues);
  const updatedAt = own(value, "updatedAt");
  if (updatedAt !== undefined && (typeof updatedAt !== "string" || updatedAt.length > 64)) {
    issues.push({ code: "wrong-type", path: "updatedAt" });
  }
  return finish({ ...value } as unknown as ReviewSettingsDocument, issues);
}

/** Validates a `POST /api/git-review/pair-qualifications` body; the key set is closed. */
export function validateReviewPairQualificationStartRequest(
  value: unknown,
): ReviewContractValidation<ReviewPairQualificationStartRequest> {
  if (!isRecord(value)) return notAnObject("");
  const issues: Issues = [];
  checkKeys(value, ["reviewerModelId", "counterCheckerModelId"], [], "", issues);
  checkModelId(own(value, "reviewerModelId"), "reviewerModelId", issues);
  checkModelId(own(value, "counterCheckerModelId"), "counterCheckerModelId", issues);
  return finish({ ...value } as unknown as ReviewPairQualificationStartRequest, issues);
}
