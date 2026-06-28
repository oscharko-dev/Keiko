// Governed commit-MESSAGE policy contracts (Issue #475, Epic #470). Ownership: the deterministic,
// content-free validation of a commit message draft against a server-resolved message policy
// (conventional-commit shape, an optional issue-key requirement, an optional DCO sign-off trailer,
// and a subject-length ceiling). The validator takes message content IN and returns typed violation
// CODES OUT only — it never stores, echoes, or returns any fragment of the message, so the result is
// content-free by construction (a violation code is a closed-vocabulary token, not message text).
//
// Disjoint from git-delivery.ts (the action model + risk + lifecycle envelope), git-commit-intent.ts
// (the deterministic commit-intent heuristics over a content-free change summary), and the server
// gate that consumes this validator. The POLICY is resolved server-side from trusted configuration
// and is never client-asserted; this leaf only defines its shape and the pure validation function.
//
// Leaf-package rules (ADR-0019, ADR-0062): pure types, frozen const tables, and pure functions only.
// No IO, no clock, no crypto, no randomness. Relative imports end in ".js". The issue-key rule is a
// CONFIG string compiled inside the validator via `new RegExp`; it is guarded against an empty
// pattern (which disables the rule) and the patterns shipped in the default policy are linear (no
// nested quantifiers), avoiding catastrophic backtracking (the CodeQL ReDoS gate).

// Pinned schema version. A breaking change adds a NEW literal member; this one is never mutated.
export const GIT_COMMIT_POLICY_SCHEMA_VERSION = "1" as const;

// ─── Policy config (content-free; server-resolved) ──────────────────────────────────────────────

export interface GitCommitConventionalCommitRule {
  readonly enabled: boolean;
  readonly allowedTypes: readonly string[];
}

export interface GitCommitIssueKeyRule {
  // A RULE string compiled inside the validator. An empty pattern disables the rule.
  readonly enabled: boolean;
  readonly pattern: string;
}

export interface GitCommitMessagePolicy {
  readonly conventionalCommit: GitCommitConventionalCommitRule;
  readonly requireIssueKey: GitCommitIssueKeyRule;
  // True when a DCO `Signed-off-by:` trailer is mandatory.
  readonly requireSignoff: boolean;
  readonly subjectMaxLength: number;
}

// ─── Violation vocabulary (AC2) ─────────────────────────────────────────────────────────────────

export type GitCommitMessageViolationCode =
  | "empty-subject"
  | "missing-conventional-prefix"
  | "disallowed-type"
  | "subject-too-long"
  | "missing-issue-key"
  | "missing-signoff";

export const GIT_COMMIT_MESSAGE_VIOLATION_CODES: readonly GitCommitMessageViolationCode[] = [
  "empty-subject",
  "missing-conventional-prefix",
  "disallowed-type",
  "subject-too-long",
  "missing-issue-key",
  "missing-signoff",
] as const;

// ─── Validation result (content-free: codes only, never message text) ────────────────────────────

export type GitCommitMessageValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly GitCommitMessageViolationCode[] };

// ─── Default policy (matches this repository's own commit style) ──────────────────────────────────

export const KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY: GitCommitMessagePolicy = {
  conventionalCommit: {
    enabled: true,
    allowedTypes: [
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "build",
      "ci",
      "perf",
      "style",
      "revert",
    ],
  },
  requireIssueKey: { enabled: false, pattern: "" },
  requireSignoff: false,
  subjectMaxLength: 72,
};

// ─── Private predicate helpers ────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

// ─── Conventional-commit parse (linear, ReDoS-safe) ───────────────────────────────────────────────
// `type(scope)?!?: subject`. The scope body excludes parentheses and the subject is a single bounded
// `.+`; neither sub-pattern nests an unbounded quantifier inside another, so matching is linear.

const CONVENTIONAL_SUBJECT_RE = /^([a-zA-Z]+)(\([^()]*\))?(!)?: (.+)$/;

interface ParsedConventionalSubject {
  readonly type: string;
  readonly hasPrefix: true;
}

function parseConventionalSubject(subject: string): ParsedConventionalSubject | undefined {
  const match = CONVENTIONAL_SUBJECT_RE.exec(subject);
  if (match === null) {
    return undefined;
  }
  const type = match[1];
  if (type === undefined) {
    return undefined;
  }
  return { type, hasPrefix: true };
}

// ─── Message structure (subject = first line; body = the remainder) ───────────────────────────────

interface MessageStructure {
  readonly subject: string;
  readonly hasSignoff: boolean;
}

const SIGNOFF_RE = /^Signed-off-by: .+$/m;

function parseMessageStructure(message: string): MessageStructure {
  const newlineIndex = message.indexOf("\n");
  const subject = newlineIndex === -1 ? message : message.slice(0, newlineIndex);
  return { subject: subject.trim(), hasSignoff: SIGNOFF_RE.test(message) };
}

// ─── Per-rule checks (each returns at most one violation code) ────────────────────────────────────

function checkConventional(
  subject: string,
  rule: GitCommitConventionalCommitRule,
): GitCommitMessageViolationCode | undefined {
  if (!rule.enabled) {
    return undefined;
  }
  const parsed = parseConventionalSubject(subject);
  if (parsed === undefined) {
    return "missing-conventional-prefix";
  }
  if (!rule.allowedTypes.includes(parsed.type)) {
    return "disallowed-type";
  }
  return undefined;
}

function checkSubjectLength(
  subject: string,
  maxLength: number,
): GitCommitMessageViolationCode | undefined {
  return subject.length > maxLength ? "subject-too-long" : undefined;
}

function checkIssueKey(
  message: string,
  rule: GitCommitIssueKeyRule,
): GitCommitMessageViolationCode | undefined {
  if (!rule.enabled || rule.pattern.length === 0) {
    return undefined;
  }
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern);
  } catch {
    // The rule is enabled but its pattern is not a valid regex (operator misconfiguration). Keep the
    // validator total (a pure function must never throw on a well-typed input) AND fail closed: a key
    // requirement that cannot be evaluated must block rather than silently pass.
    return "missing-issue-key";
  }
  return re.test(message) ? undefined : "missing-issue-key";
}

function checkSignoff(
  hasSignoff: boolean,
  required: boolean,
): GitCommitMessageViolationCode | undefined {
  if (!required) {
    return undefined;
  }
  return hasSignoff ? undefined : "missing-signoff";
}

// ─── Validator (PURE; content in, codes out) ──────────────────────────────────────────────────────

export function validateGitCommitMessage(
  message: string,
  policy: GitCommitMessagePolicy,
): GitCommitMessageValidation {
  const { subject, hasSignoff } = parseMessageStructure(message);
  if (subject.length === 0) {
    return { ok: false, violations: ["empty-subject"] };
  }
  const candidates: readonly (GitCommitMessageViolationCode | undefined)[] = [
    checkConventional(subject, policy.conventionalCommit),
    checkSubjectLength(subject, policy.subjectMaxLength),
    checkIssueKey(message, policy.requireIssueKey),
    checkSignoff(hasSignoff, policy.requireSignoff),
  ];
  const violations = candidates.filter(
    (code): code is GitCommitMessageViolationCode => code !== undefined,
  );
  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ─── Exported guards ────────────────────────────────────────────────────────────────────────────

export const isGitCommitMessageViolationCode = isInSet(GIT_COMMIT_MESSAGE_VIOLATION_CODES);

function isConventionalRule(value: unknown): value is GitCommitConventionalCommitRule {
  return isRecord(value) && isBoolean(value.enabled) && isStringArray(value.allowedTypes);
}

function isIssueKeyRule(value: unknown): value is GitCommitIssueKeyRule {
  return isRecord(value) && isBoolean(value.enabled) && isString(value.pattern);
}

export function isGitCommitMessagePolicy(value: unknown): value is GitCommitMessagePolicy {
  return (
    isRecord(value) &&
    isConventionalRule(value.conventionalCommit) &&
    isIssueKeyRule(value.requireIssueKey) &&
    isBoolean(value.requireSignoff) &&
    isNonNegativeInteger(value.subjectMaxLength)
  );
}

function isViolationArray(value: unknown): value is readonly GitCommitMessageViolationCode[] {
  return Array.isArray(value) && value.every(isGitCommitMessageViolationCode);
}

export function isGitCommitMessageValidation(value: unknown): value is GitCommitMessageValidation {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return true;
  }
  return value.ok === false && isViolationArray(value.violations);
}
