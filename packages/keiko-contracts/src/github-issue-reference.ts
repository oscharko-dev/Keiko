// The ONE GitHub issue reference parser (#3385).
//
// Three regexes used to describe "a GitHub issue reference", one per surface: the context-pack
// route validated `ownerAndRepo` and `objectId` as separate fields, the connector re-validated them
// before building a `gh api` argv, and the editor's connected-context provider scanned chat text
// for `owner/repo#n`. They agreed on the happy path and disagreed at the edges — one accepted an
// owner ending in a hyphen, one accepted a ten-digit number the runtime contract bounds lower, and
// none of them could accept the thing a user actually pastes: a full issue URL. This module is the
// single owner of that vocabulary; the three surfaces import it, so the accept/reject boundary
// cannot drift between them again.
//
// Everything here is pure and content-free. The input is untrusted browser or chat text; the
// output is a typed `{ ownerAndRepo, issueNumber }` or a closed rejection, never a rewritten string.
// A URL is parsed from its RAW characters on purpose: `new URL("https://github.com/o/r/../x/...")`
// would resolve the traversal and silently address another repository, so the segments are taken
// exactly as written and each one must satisfy the strict segment rule.

// This module is a dependency-free leaf on purpose: `coding-workbench-runtime.ts` re-exports its
// runtime surface (so the server and the browser reach it through the existing
// `runtime/coding-workbench-runtime` subpath), and a leaf cannot close a cycle back through it.

/** Transport bound on one pasted reference: a URL, `owner/repo#n` or `#n`, never a document. */
export const GITHUB_ISSUE_REFERENCE_MAX_CHARS = 512;

/**
 * GitHub issue numbers are positive and, in practice, far below this bound. The same value bounds
 * `issueBinding.issueNumber` as `CODING_WORKBENCH_ISSUE_NUMBER_MAX` in
 * `coding-workbench-runtime-api.ts`; `github-issue-reference.test.ts` pins the two equal so a
 * reference the parser accepts can never be a number the binding validator refuses.
 */
export const GITHUB_ISSUE_NUMBER_MAX = 1_000_000_000;

export interface GitHubIssueReference {
  /**
   * `owner/repo` exactly as the caller wrote it. GitHub treats both segments case-insensitively,
   * so equality is decided through `canonicalGitHubOwnerAndRepo`, never by string comparison.
   */
  readonly ownerAndRepo: string;
  /** Positive, bounded by `GITHUB_ISSUE_NUMBER_MAX`. */
  readonly issueNumber: number;
}

/**
 * Why an input is not an issue reference. Closed, so a surface can render an actionable state
 * ("that is a pull request", "only github.com is supported") instead of a generic rejection, and
 * so no reason can be invented at a call site.
 */
export type GitHubIssueReferenceRejection =
  | "empty"
  | "malformed"
  | "unsupported-host"
  | "pull-request"
  | "invalid-repository"
  | "invalid-number"
  | "repository-required";

export const GITHUB_ISSUE_REFERENCE_REJECTIONS: readonly GitHubIssueReferenceRejection[] =
  Object.freeze([
    "empty",
    "malformed",
    "unsupported-host",
    "pull-request",
    "invalid-repository",
    "invalid-number",
    "repository-required",
  ] as const);

export type GitHubIssueReferenceParseResult =
  | { readonly ok: true; readonly reference: GitHubIssueReference }
  | { readonly ok: false; readonly rejection: GitHubIssueReferenceRejection };

export interface ParseGitHubIssueReferenceOptions {
  /**
   * The repository a bare `#n` or `n` is relative to — the checkout's own server-resolved remote,
   * never a value the same untrusted input supplied. Absent, the relative forms are rejected with
   * `repository-required` rather than guessed.
   */
  readonly boundOwnerAndRepo?: string | undefined;
}

// GitHub login rule: 1–39 characters, alphanumerics and hyphens, no leading or trailing hyphen.
const OWNER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
// Repository rule: 1–100 characters from the documented set. `.` and `..` are legal by the
// character class and are the two traversal spellings, so they are refused by name.
const REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/u;
// ASCII digits only, no leading zero. `\d` is ASCII-only in JavaScript even under `u`, but the
// explicit class states the intent: a fullwidth "１２" is not a number here.
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/u;
const ISSUE_URL_PREFIX = "https://github.com/";
const RELATIVE_PREFIX = "#";

export function isGitHubOwnerAndRepo(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repository] = parts;
  return (
    owner !== undefined &&
    repository !== undefined &&
    OWNER_SEGMENT.test(owner) &&
    REPOSITORY_SEGMENT.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
}

/** The bounded positive issue number a string spells, or undefined when it spells none. */
export function parseGitHubIssueNumber(value: string): number | undefined {
  if (!ISSUE_NUMBER.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= GITHUB_ISSUE_NUMBER_MAX ? parsed : undefined;
}

/** The form two references are compared and digested in: GitHub's case-insensitive identity. */
export function canonicalGitHubOwnerAndRepo(value: string): string {
  return value.toLowerCase();
}

export function sameGitHubOwnerAndRepo(left: string, right: string): boolean {
  return canonicalGitHubOwnerAndRepo(left) === canonicalGitHubOwnerAndRepo(right);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function reject(rejection: GitHubIssueReferenceRejection): GitHubIssueReferenceParseResult {
  return { ok: false, rejection };
}

function accept(ownerAndRepo: string, issueNumber: number): GitHubIssueReferenceParseResult {
  return { ok: true, reference: { ownerAndRepo, issueNumber } };
}

function referenceFor(ownerAndRepo: string, number: string): GitHubIssueReferenceParseResult {
  if (!isGitHubOwnerAndRepo(ownerAndRepo)) return reject("invalid-repository");
  const issueNumber = parseGitHubIssueNumber(number);
  return issueNumber === undefined ? reject("invalid-number") : accept(ownerAndRepo, issueNumber);
}

// `https://github.com/<owner>/<repo>/issues/<n>` and nothing else: no query, no fragment, no
// trailing slash, no port, no userinfo, no other host. The scheme and host are compared
// case-insensitively because both are case-insensitive by specification; the path is not, because
// a path segment is part of the repository identity and is validated as written.
function parseIssueUrl(input: string): GitHubIssueReferenceParseResult {
  if (!input.slice(0, ISSUE_URL_PREFIX.length).toLowerCase().startsWith(ISSUE_URL_PREFIX)) {
    return reject("unsupported-host");
  }
  const path = input.slice(ISSUE_URL_PREFIX.length);
  if (path.includes("?") || path.includes("#")) return reject("malformed");
  const segments = path.split("/");
  if (segments.length !== 4) return reject("malformed");
  const [owner, repository, kind, number] = segments;
  if (kind === "pull") return reject("pull-request");
  if (kind !== "issues") return reject("malformed");
  return referenceFor(`${owner ?? ""}/${repository ?? ""}`, number ?? "");
}

// `<owner>/<repo>#<n>`: exactly one `#`, with the repository on its left and the number on its right.
function parseOwnerRepoForm(input: string): GitHubIssueReferenceParseResult {
  const separator = input.indexOf(RELATIVE_PREFIX);
  if (separator <= 0 || input.indexOf(RELATIVE_PREFIX, separator + 1) !== -1) {
    return reject("malformed");
  }
  return referenceFor(input.slice(0, separator), input.slice(separator + 1));
}

// `#<n>` or `<n>`, relative to the bound repository. The bound repository is server-resolved and
// is still validated: a caller cannot make a rejected spelling acceptable by binding it.
function parseRelativeForm(
  input: string,
  options: ParseGitHubIssueReferenceOptions,
): GitHubIssueReferenceParseResult {
  const number = input.startsWith(RELATIVE_PREFIX) ? input.slice(1) : input;
  if (parseGitHubIssueNumber(number) === undefined) return reject("invalid-number");
  const bound = options.boundOwnerAndRepo;
  if (bound === undefined || bound.length === 0) return reject("repository-required");
  return referenceFor(bound, number);
}

/**
 * Parse one user-supplied GitHub issue reference.
 *
 * Accepted forms: a full `https://github.com/<owner>/<repo>/issues/<n>` URL, `<owner>/<repo>#<n>`,
 * and — only when `boundOwnerAndRepo` is supplied — `#<n>` or `<n>`. Surrounding whitespace is
 * ignored; nothing else is normalised. A pull-request URL is refused by name so the caller can say
 * so, and every other URL that is not exactly an issue on github.com is refused as either an
 * unsupported host or malformed.
 */
export function parseGitHubIssueReference(
  input: string,
  options: ParseGitHubIssueReferenceOptions = {},
): GitHubIssueReferenceParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return reject("empty");
  if (trimmed.length > GITHUB_ISSUE_REFERENCE_MAX_CHARS || hasControlCharacter(trimmed)) {
    return reject("malformed");
  }
  if (trimmed.includes("://")) return parseIssueUrl(trimmed);
  if (trimmed.startsWith(RELATIVE_PREFIX) || ISSUE_NUMBER.test(trimmed)) {
    return parseRelativeForm(trimmed, options);
  }
  return parseOwnerRepoForm(trimmed);
}

// The candidate shape a free-text scan looks for. Deliberately looser than the parser (it only has
// to FIND a candidate); every candidate is then admitted or refused by `parseGitHubIssueReference`,
// so the scan cannot accept a reference the parser would reject. Bounded quantifiers keep the scan
// linear in the text length.
const TEXT_CANDIDATE = /([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})#([0-9]{1,10})/gu;

/**
 * Every `owner/repo#n` reference in a free-text query, in order of appearance, at most `limit`.
 * Duplicates are returned as they occur; the caller owns de-duplication because it owns the key.
 */
export function findGitHubIssueReferences(
  text: string,
  limit: number,
): readonly GitHubIssueReference[] {
  const references: GitHubIssueReference[] = [];
  if (limit <= 0) return references;
  for (const [, ownerAndRepo, number] of text.matchAll(TEXT_CANDIDATE)) {
    if (ownerAndRepo === undefined || number === undefined) continue;
    const parsed = parseGitHubIssueReference(`${ownerAndRepo}#${number}`);
    if (!parsed.ok) continue;
    references.push(parsed.reference);
    if (references.length === limit) break;
  }
  return references;
}
