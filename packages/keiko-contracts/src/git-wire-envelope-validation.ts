// Shared scalar, envelope and parse-result admission for read-only Git responses. Schema versions
// remain at each wire owner, and message admission stays explicitly selected by response kind.

export const GIT_REPOSITORY_STATES = ["available", "unavailable", "unsafe", "error"] as const;

export type GitRepositoryState = (typeof GIT_REPOSITORY_STATES)[number];

export const GIT_UNAVAILABLE_REASONS = [
  "not-a-repository",
  "git-missing",
  "repository-root-outside-root",
  "unknown",
] as const;
export type GitUnavailableReason = (typeof GIT_UNAVAILABLE_REASONS)[number];

// The wire `reason` shape every git-*.ts response envelope declares: GitUnavailableReason widened
// with the two failure classes only the route layer can detect (unsafe ownership, a raw git error).
export type GitWireUnavailableReason = GitUnavailableReason | "unsafe-repository" | "git-error";

const GIT_WIRE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  ...GIT_UNAVAILABLE_REASONS,
  "unsafe-repository",
  "git-error",
]);

// Shared by git-history.ts, git-repository-summary.ts, and git-sync.ts (KEIKO-0310): each of those
// declares the identical `reason?: GitWireUnavailableReason` field but, until this fix, none of the
// five validators in this file's territory checked it against the closed union at all.
export function isGitWireUnavailableReason(value: unknown): value is GitWireUnavailableReason {
  return typeof value === "string" && GIT_WIRE_UNAVAILABLE_REASONS.has(value);
}

// Shared bound for the free-text `message` field carried by GitHistoryResponse,
// GitRepositoryStatusResponse, and GitRepositorySummary. The real producer (keiko-server
// gitRoutes.ts genericUnavailable/unavailableBranchList) only ever assigns short, fixed English
// sentences (<100 chars); this cap is generous headroom for that, not a measured maximum, so a
// stricter validator here can never reject the current producer's output while still bounding a
// field the audit flagged as the one most likely to carry raw, unbounded git error/stderr text.
export const GIT_MESSAGE_MAX_CHARS = 1_024 as const;

export function isBoundedGitMessage(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= GIT_MESSAGE_MAX_CHARS &&
      !value.includes("\u0000"))
  );
}

function isGitRepositoryState(input: unknown): input is GitRepositoryState {
  return typeof input === "string" && new Set<string>(GIT_REPOSITORY_STATES).has(input);
}

export function isGitWireRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function isGitWireBoolean(input: unknown): input is boolean {
  return typeof input === "boolean";
}

export function isGitWireNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

export function isString(input: unknown): input is string {
  return typeof input === "string";
}

export function rejectGitEnvelopeField(reasons: string[], reason: string): false {
  reasons.push(reason);
  return false;
}

export function validateGitReadIdentity(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
  schemaVersion: string,
): boolean {
  let valid = true;
  if (input.schemaVersion !== schemaVersion)
    valid = rejectGitEnvelopeField(reasons, "schemaVersion invalid");
  if (!isString(input.root)) valid = rejectGitEnvelopeField(reasons, "root must be a string");
  if (!isGitRepositoryState(input.state)) valid = rejectGitEnvelopeField(reasons, "state invalid");
  return valid;
}

export function validateGitWireEnvelopeOptionals(
  input: Readonly<Record<string, unknown>>,
  reasons: string[],
  checkMessage: boolean,
): boolean {
  let valid = true;
  if (input.reason !== undefined && !isGitWireUnavailableReason(input.reason)) {
    valid = rejectGitEnvelopeField(reasons, "reason invalid");
  }
  if (checkMessage && input.message !== undefined && !isBoundedGitMessage(input.message)) {
    valid = rejectGitEnvelopeField(reasons, "message must be a bounded string when present");
  }
  if (input.repositoryRoot !== undefined && !isString(input.repositoryRoot)) {
    valid = rejectGitEnvelopeField(reasons, "repositoryRoot must be a string when present");
  }
  return valid;
}

export interface GitRepositoryValidationOk {
  readonly ok: true;
}

export interface GitRepositoryValidationFail {
  readonly ok: false;
  readonly reasons: readonly string[];
}

export type GitRepositoryValidation = GitRepositoryValidationOk | GitRepositoryValidationFail;

export interface GitRepositoryParseOk<T> {
  readonly ok: true;
  readonly value: T;
}

export type GitRepositoryParseResult<T> = GitRepositoryParseOk<T> | GitRepositoryValidationFail;

export function parseGitWireResponse<Response>(
  input: unknown,
  admit: (
    input: Readonly<Record<string, unknown>>,
    reasons: string[],
  ) => input is Readonly<Record<string, unknown>> & Response,
): GitRepositoryParseResult<Response> {
  if (!isGitWireRecord(input)) return { ok: false, reasons: ["response must be an object"] };
  const reasons: string[] = [];
  return admit(input, reasons) ? { ok: true, value: input } : { ok: false, reasons };
}

export function gitWireValidationVerdict(
  parsed: GitRepositoryParseResult<unknown>,
): GitRepositoryValidation {
  return parsed.ok ? { ok: true } : parsed;
}
