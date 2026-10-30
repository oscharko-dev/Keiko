// Read-only pull request list and detail for Keiko for Quality (ADR-0182, ADR-0086, Issue #4133).
//
// Two fixed GraphQL documents and nothing else. Neither is a mutation; the only variables are the
// repository owner and name (validated `owner/repo`), the page size or pull request number
// (validated integers) and the pagination cursor GitHub itself returned (validated shape). The
// dedicated command rules allow `gh api` only, and `isGitReviewPullRequestReadArgv` accepts exactly
// the argument vectors the two builders produce, byte for byte: any other GraphQL document, a
// mutation, an extra flag or a reordered argument is refused before a process starts. The pull
// request body is never requested. Every field of the response is untrusted display data and is
// projected through a strict parser.

import type {
  CommandRule,
  ReviewPullRequestCheckState,
  ReviewPullRequestDetail,
  ReviewPullRequestMergeableState,
  ReviewPullRequestReviewDecision,
  ReviewPullRequestSummary,
} from "@oscharko-dev/keiko-contracts";
import {
  REVIEW_PULL_REQUEST_PAGE_SIZE,
  REVIEW_PULL_REQUEST_TITLE_MAX_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { isGitHubOwnerAndRepo } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import {
  isGitObjectId,
  isSafeGitRefName,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";

const PULL_REQUEST_FIELDS =
  "number title isDraft createdAt updatedAt author{login} baseRefName baseRefOid headRefName " +
  "headRefOid headRepository{nameWithOwner} isCrossRepository additions deletions changedFiles " +
  "reviewDecision mergeable";

/** The fixed open pull request list document. Exported so tests can pin it byte for byte. */
export const GIT_REVIEW_PR_LIST_QUERY =
  "query($owner:String!,$name:String!,$pageSize:Int!,$cursor:String){repository(owner:$owner,name:$name)" +
  "{pullRequests(states:OPEN,first:$pageSize,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC})" +
  `{pageInfo{hasNextPage endCursor}nodes{${PULL_REQUEST_FIELDS} ` +
  "commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}";

/** The fixed pull request detail document. */
export const GIT_REVIEW_PR_DETAIL_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name)" +
  `{pullRequest(number:$number){${PULL_REQUEST_FIELDS} ` +
  "latestReviews(first:100){nodes{state}} " +
  "commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:1)" +
  "{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}}}}";

export const GIT_REVIEW_PULL_REQUEST_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  Object.freeze({
    executable: "gh",
    allowedSubcommands: Object.freeze(["api"]),
    forbidLeadingFlags: true,
    valueFlags: Object.freeze(["--hostname", "-f", "--raw-field", "-F", "--field"]),
    denyFlags: Object.freeze([
      "--input",
      "--paginate",
      "--slurp",
      "--method",
      "-X",
      "--header",
      "-H",
      "--jq",
      "-q",
      "--template",
      "-t",
      "--cache",
      "--include",
      "-i",
      "--preview",
      "-p",
      "--verbose",
    ]),
  }),
]);

export class GitReviewPullRequestArgvError extends TypeError {
  public constructor(operand: string) {
    super(`invalid pull request read operand: ${operand}`);
    this.name = "GitReviewPullRequestArgvError";
  }
}

const PR_NUMBER = /^[1-9]\d{0,9}$/u;
const CURSOR = /^[A-Za-z0-9+/=_:-]{1,256}$/u;
const PR_NUMBER_MAX = 2_147_483_647;

/** Whether a list request's operands are valid; the builder throws exactly when this is false. */
export function isValidPrListRequest(request: GitReviewPrListRequest): boolean {
  return (
    isGitHubOwnerAndRepo(request.ownerAndRepo) &&
    (request.cursor === undefined || CURSOR.test(request.cursor))
  );
}

/** Whether a detail request's operands are valid; the builder throws exactly when this is false. */
export function isValidPrDetailRequest(request: GitReviewPrDetailRequest): boolean {
  return (
    isGitHubOwnerAndRepo(request.ownerAndRepo) &&
    Number.isSafeInteger(request.number) &&
    request.number >= 1 &&
    request.number <= PR_NUMBER_MAX
  );
}

function ownerAndName(ownerAndRepo: string): readonly [string, string] {
  if (!isGitHubOwnerAndRepo(ownerAndRepo)) throw new GitReviewPullRequestArgvError("ownerAndRepo");
  const [owner, name] = ownerAndRepo.split("/");
  if (owner === undefined || name === undefined) {
    throw new GitReviewPullRequestArgvError("ownerAndRepo");
  }
  return [owner, name];
}

function graphqlEnvelope(query: string, owner: string, name: string): readonly string[] {
  return [
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ];
}

export interface GitReviewPrListRequest {
  readonly ownerAndRepo: string;
  readonly cursor?: string | undefined;
}

export function buildPrListOpenGraphqlArgv(request: GitReviewPrListRequest): readonly string[] {
  const [owner, name] = ownerAndName(request.ownerAndRepo);
  const cursor = request.cursor;
  if (cursor !== undefined && !CURSOR.test(cursor)) {
    throw new GitReviewPullRequestArgvError("cursor");
  }
  return [
    ...graphqlEnvelope(GIT_REVIEW_PR_LIST_QUERY, owner, name),
    "-F",
    `pageSize=${String(REVIEW_PULL_REQUEST_PAGE_SIZE)}`,
    ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]),
  ];
}

export interface GitReviewPrDetailRequest {
  readonly ownerAndRepo: string;
  readonly number: number;
}

export function buildPrDetailGraphqlArgv(request: GitReviewPrDetailRequest): readonly string[] {
  const [owner, name] = ownerAndName(request.ownerAndRepo);
  const number = request.number;
  if (!Number.isSafeInteger(number) || number < 1 || number > PR_NUMBER_MAX) {
    throw new GitReviewPullRequestArgvError("number");
  }
  return [
    ...graphqlEnvelope(GIT_REVIEW_PR_DETAIL_QUERY, owner, name),
    "-F",
    `number=${String(number)}`,
  ];
}

function valueAfter(argv: readonly string[], index: number, prefix: string): string | undefined {
  const token = argv[index];
  return token?.startsWith(prefix) === true ? token.slice(prefix.length) : undefined;
}

function rebuildFromArgv(argv: readonly string[]): readonly string[] | undefined {
  const owner = valueAfter(argv, 7, "owner=");
  const name = valueAfter(argv, 9, "name=");
  if (owner === undefined || name === undefined) return undefined;
  const ownerAndRepo = `${owner}/${name}`;
  if (argv[5] === `query=${GIT_REVIEW_PR_LIST_QUERY}`) {
    const cursor = argv.length > 12 ? valueAfter(argv, 13, "cursor=") : undefined;
    const request = { ownerAndRepo, cursor };
    return isValidPrListRequest(request) ? buildPrListOpenGraphqlArgv(request) : undefined;
  }
  const number = valueAfter(argv, 11, "number=");
  if (argv[5] !== `query=${GIT_REVIEW_PR_DETAIL_QUERY}` || number === undefined) return undefined;
  if (!PR_NUMBER.test(number)) return undefined;
  const request = { ownerAndRepo, number: Number(number) };
  return isValidPrDetailRequest(request) ? buildPrDetailGraphqlArgv(request) : undefined;
}

/**
 * True only for an argument vector one of the two builders produces: same documents, same flags,
 * same order, validated variables. Everything else, including any mutation, is refused.
 */
export function isGitReviewPullRequestReadArgv(argv: readonly string[]): boolean {
  const expected = rebuildFromArgv(argv);
  return (
    expected?.length === argv.length && expected.every((token, index) => token === argv[index])
  );
}

// ─── Response projection ─────────────────────────────────────────────────────

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function path(value: unknown, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) current = record(current)?.[key];
  return current;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const NAME_WITH_OWNER = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
// eslint-disable-next-line no-control-regex -- intentionally matches control characters to replace them
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/** Untrusted title text: control characters become spaces, then bounded by code points. */
export function boundedPullRequestTitle(value: string): string {
  const flattened = value.replace(CONTROL_CHARACTERS, " ").trim();
  return Array.from(flattened).slice(0, REVIEW_PULL_REQUEST_TITLE_MAX_CHARS).join("");
}

function isoTime(value: unknown): string | undefined {
  return typeof value === "string" && ISO_TIME.test(value) ? value : undefined;
}

function refName(value: unknown): string | undefined {
  return typeof value === "string" && !value.startsWith("refs/") && isSafeGitRefName(value)
    ? value
    : undefined;
}

function objectId(value: unknown): string | undefined {
  return isGitObjectId(value) ? value : undefined;
}

function authorLogin(value: unknown): string | null {
  const login = path(value, "login");
  return typeof login === "string" && LOGIN.test(login) ? login : null;
}

function headRepository(value: unknown): string | null {
  const name = path(value, "nameWithOwner");
  return typeof name === "string" && NAME_WITH_OWNER.test(name) ? name : null;
}

const REVIEW_DECISIONS: Readonly<Record<string, ReviewPullRequestReviewDecision>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
};

const MERGEABLE_STATES: Readonly<Record<string, ReviewPullRequestMergeableState>> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
};

const ROLLUP_STATES: Readonly<Record<string, ReviewPullRequestCheckState>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "error",
  PENDING: "pending",
  EXPECTED: "pending",
};

function lookup<T>(table: Readonly<Record<string, T>>, value: unknown, fallback: T): T {
  return typeof value === "string" && Object.hasOwn(table, value)
    ? (table[value] ?? fallback)
    : fallback;
}

function rollup(node: JsonRecord): JsonRecord | undefined {
  const commits = path(node, "commits", "nodes");
  const last = Array.isArray(commits) ? (commits as unknown[]).at(-1) : undefined;
  return record(path(last, "commit", "statusCheckRollup"));
}

interface Identity {
  readonly number: number;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
}

function identity(node: JsonRecord): Identity | undefined {
  const number = count(node.number);
  const baseRef = refName(node.baseRefName);
  const baseSha = objectId(node.baseRefOid);
  const headRef = refName(node.headRefName);
  const headSha = objectId(node.headRefOid);
  if (number === undefined || number < 1 || baseRef === undefined || headRef === undefined) {
    return undefined;
  }
  if (baseSha === undefined || headSha === undefined) return undefined;
  return { number, baseRef, baseSha, headRef, headSha };
}

interface Sizes {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

function sizes(node: JsonRecord): Sizes | undefined {
  const additions = count(node.additions);
  const deletions = count(node.deletions);
  const changedFiles = count(node.changedFiles);
  if (additions === undefined || deletions === undefined || changedFiles === undefined) {
    return undefined;
  }
  return { additions, deletions, changedFiles };
}

function displayFacts(
  node: JsonRecord,
): Omit<ReviewPullRequestSummary, keyof Identity | keyof Sizes> | undefined {
  const createdAt = isoTime(node.createdAt);
  const updatedAt = isoTime(node.updatedAt);
  if (typeof node.title !== "string" || typeof node.isDraft !== "boolean") return undefined;
  if (typeof node.isCrossRepository !== "boolean") return undefined;
  if (createdAt === undefined || updatedAt === undefined) return undefined;
  return {
    title: boundedPullRequestTitle(node.title),
    authorLogin: authorLogin(node.author),
    isDraft: node.isDraft,
    createdAt,
    updatedAt,
    headRepository: headRepository(node.headRepository),
    isCrossRepository: node.isCrossRepository,
    reviewDecision: lookup(REVIEW_DECISIONS, node.reviewDecision, "none"),
    mergeable: lookup(MERGEABLE_STATES, node.mergeable, "unknown"),
    checkState: lookup(ROLLUP_STATES, rollup(node)?.state, "none"),
  };
}

/** Projects one pull request node; `undefined` when any required fact is missing or unsafe. */
export function parseReviewPullRequestSummary(
  value: unknown,
): ReviewPullRequestSummary | undefined {
  const node = record(value);
  if (node === undefined) return undefined;
  const ids = identity(node);
  const counts = sizes(node);
  const facts = displayFacts(node);
  if (ids === undefined || counts === undefined || facts === undefined) return undefined;
  return { ...ids, ...facts, ...counts };
}

export interface GitReviewPrListPage {
  readonly pullRequests: readonly ReviewPullRequestSummary[];
  /** Nodes the strict projection refused (unsafe ref names, malformed facts). */
  readonly rejectedCount: number;
  readonly nextCursor: string | undefined;
}

function nextPageCursor(pageInfo: JsonRecord): string | undefined | null {
  if (pageInfo.hasNextPage !== true) return undefined;
  const cursor = pageInfo.endCursor;
  return typeof cursor === "string" && CURSOR.test(cursor) ? cursor : null;
}

/** Parses one list page; `undefined` when the envelope itself is malformed. */
export function parseReviewPullRequestListPage(value: unknown): GitReviewPrListPage | undefined {
  const connection = record(path(value, "data", "repository", "pullRequests"));
  const nodes = connection?.nodes;
  const pageInfo = record(connection?.pageInfo);
  if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") return undefined;
  const nextCursor = nextPageCursor(pageInfo);
  if (nextCursor === null) return undefined;
  const pullRequests = (nodes as unknown[])
    .map(parseReviewPullRequestSummary)
    .filter((entry): entry is ReviewPullRequestSummary => entry !== undefined);
  return { pullRequests, rejectedCount: nodes.length - pullRequests.length, nextCursor };
}

const PASSING_STATES: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING_STATES: ReadonlySet<string> = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

type CheckCounts = ReviewPullRequestDetail["checkCounts"];

function addCounts(
  totals: { passing: number; failing: number; pending: number },
  entries: unknown,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries as unknown[]) {
    const state = path(entry, "state");
    const value = count(path(entry, "count")) ?? 0;
    if (typeof state !== "string") continue;
    if (PASSING_STATES.has(state)) totals.passing += value;
    else if (FAILING_STATES.has(state)) totals.failing += value;
    else totals.pending += value;
  }
}

function checkCounts(node: JsonRecord): CheckCounts {
  const totals = { passing: 0, failing: 0, pending: 0 };
  const contexts = path(rollup(node), "contexts");
  addCounts(totals, path(contexts, "checkRunCountsByState"));
  addCounts(totals, path(contexts, "statusContextCountsByState"));
  return totals;
}

function approvalCount(node: JsonRecord): number {
  const reviews = path(node, "latestReviews", "nodes");
  if (!Array.isArray(reviews)) return 0;
  return (reviews as unknown[]).filter((review) => path(review, "state") === "APPROVED").length;
}

/**
 * Parses the detail response. `null` is a well-formed answer for a number the repository does not
 * have; `undefined` means the envelope or the pull request facts are malformed.
 */
export function parseReviewPullRequestDetail(
  value: unknown,
): ReviewPullRequestDetail | null | undefined {
  const repository = record(path(value, "data", "repository"));
  if (repository === undefined) return undefined;
  if (repository.pullRequest === null) return null;
  const node = record(repository.pullRequest);
  const summary = parseReviewPullRequestSummary(node);
  if (node === undefined || summary === undefined) return undefined;
  return { ...summary, checkCounts: checkCounts(node), approvalCount: approvalCount(node) };
}
