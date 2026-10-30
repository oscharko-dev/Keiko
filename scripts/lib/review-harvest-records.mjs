// The pure half of the review harvest (Issue #4132, ADR-0182 D9): turn raw GitHub review threads
// into body-free, labelable records and assemble the versioned dataset with its content digest.
//
// Ported in meaning from the retired Keiko for Quality reviewer (oscharko-dev/Keiko-for-Quality
// v0.25.0, `corpus/harvest-lib.mjs`, `corpus/arena-lib.mjs`, `corpus/precision-gate-lib.mjs`),
// with one deliberate inversion: the retired harvest kept every comment body and therefore could
// never be committed. This one reads a body exactly once, to classify it and to digest it, and
// stores neither the text nor any login, email or token. What leaves this module is the producer
// enum, the anchor, the resolution state, the reply classification, whether the anchored region
// changed later in the same pull request, and a SHA-256 digest of the root body for duplicate
// detection. `tallyRecordKeys` exists so a test can prove that closed key set over a whole dataset.
//
// Labels (hit, false alarm, ...) are NOT assigned here. They are a pure function of these facts and
// live once, in `packages/keiko-evaluations/src/review/labels.ts`, so the replay, the precision gate
// and the baseline read the same rule.

import { compareStrings } from "./compare-strings.mjs";
import { sha256 } from "./digest.mjs";

const REVIEW_HARVEST_SCHEMA_VERSION = 1;

/** Every producer a thread can be attributed to, in reporting order. */
export const REVIEW_PRODUCERS = Object.freeze([
  "keiko-for-quality",
  "coderabbit",
  "codex",
  "qodo",
  "human",
  "other",
]);

export const REPLY_CLASSIFICATIONS = Object.freeze(["refuted", "fixed", "unclassified"]);
export const REGION_CHANGES = Object.freeze([
  "changed",
  "unchanged",
  "no-later-commit",
  "unavailable",
]);

/** Line tolerance of the region-change rule, ported unchanged (`ACTED_UPON_LINE_TOLERANCE`). */
const REGION_CHANGE_TOLERANCE_LINES = 3;

const REVIEW_HARVEST_RULES = Object.freeze({
  regionChange: "first-parent-own-commits-carried-anchor-v1",
  regionChangeToleranceLines: REGION_CHANGE_TOLERANCE_LINES,
  replyClassification: "first-foreign-reply-earliest-phrase-v1",
  producerAttribution: "graphql-bot-login-or-user-typename-v1",
});

// GraphQL logins of the bot producers. GraphQL reports a GitHub App without the REST `[bot]`
// suffix; the suffix is stripped anyway so a REST-shaped fixture cannot misattribute.
const BOT_PRODUCERS = new Map([
  ["keiko-for-quality", "keiko-for-quality"],
  ["coderabbitai", "coderabbit"],
  ["chatgpt-codex-connector", "codex"],
  ["qodo-code-review", "qodo"],
]);

const FULL_COMMIT_OID = /^[0-9a-f]{40}$/u;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
const NOTICE_MARKER = "was not fully reviewed";

/** Phrases a reader uses when the finding was wrong (ported unchanged). */
const REFUTED_PHRASES = [
  /\brefut(ed|ing|es)\b/i,
  /\bnot applicable\b/i,
  /\bno longer applies\b/i,
  /\bfalse positive\b/i,
  /\balready (handles|handled|exists|guards|guarded|does|covered)\b/i,
  /\bincorrect (premise|claim|reading)\b/i,
  /\bthis is (wrong|mistaken)\b/i,
];

/** Phrases a reader uses when the finding was right and the code changed (ported unchanged). */
const FIXED_PHRASES = [
  /\bfixed\b/i,
  /\bapplied\b/i,
  /\baddressed\b/i,
  /\bimplemented\b/i,
  /\bcorrected\b/i,
  /\bdone in\b/i,
];

function normalizedLogin(author) {
  const login = typeof author?.login === "string" ? author.login : "";
  return login.replace(/\[bot\]$/iu, "").toLowerCase();
}

/**
 * The producer of one comment. A known bot login counts only when GraphQL reports a `Bot`
 * account; any `User` is human; everything else (other bots, deleted accounts) is `other`.
 */
export function classifyProducer(author) {
  if (author === null || author === undefined) return "other";
  const known = BOT_PRODUCERS.get(normalizedLogin(author));
  if (known !== undefined && author.__typename === "Bot") return known;
  return author.__typename === "User" ? "human" : "other";
}

function earliestMatch(text, patterns) {
  let best = Number.POSITIVE_INFINITY;
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found !== null && found.index < best) best = found.index;
  }
  return best;
}

/**
 * One reply, classified. Whichever verdict appears first wins ("Fixed in abc — the guard was
 * missing" versus "Refuted: applying this would ..."). A reply nothing matches is `unclassified`,
 * never `fixed`: the classifier never guesses in a finding's favour.
 */
export function classifyReply(body) {
  if (typeof body !== "string" || body.trim() === "") return "unclassified";
  const refuted = earliestMatch(body, REFUTED_PHRASES);
  const fixed = earliestMatch(body, FIXED_PHRASES);
  if (refuted === Number.POSITIVE_INFINITY && fixed === Number.POSITIVE_INFINITY) {
    return "unclassified";
  }
  return refuted <= fixed ? "refuted" : "fixed";
}

/** True for the retired reviewer's own coverage notice, which is not a finding. */
export function isReviewNotice(producer, body) {
  return (
    producer === "keiko-for-quality" && typeof body === "string" && body.includes(NOTICE_MARKER)
  );
}

/**
 * The hunks of a `-U0` unified diff. An omitted count means one line, per the unified diff format.
 */
export function parseUnifiedHunks(diffText) {
  const hunks = [];
  for (const line of String(diffText).split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (match === null) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

// The old-side lines a hunk covers. A pure insertion (count 0) still occupies its boundary line,
// so the tolerance window centres on something rather than matching everywhere.
function oldSpan(hunk) {
  return { start: hunk.oldStart, end: hunk.oldStart + Math.max(hunk.oldCount, 1) - 1 };
}

/**
 * Whether one change touched the anchored region: a file-level anchor is touched by any hunk; a
 * line anchor by a hunk whose old-side span overlaps it within `tolerance` lines; a binary or
 * whole-file change touches everything.
 */
export function regionTouched(change, anchor, tolerance = REGION_CHANGE_TOLERANCE_LINES) {
  if (change.kind === "whole-file") return true;
  if (anchor.fileLevel) return change.hunks.length > 0;
  return change.hunks.some((hunk) => {
    const span = oldSpan(hunk);
    return span.start <= anchor.endLine + tolerance && span.end >= anchor.startLine - tolerance;
  });
}

function hunkPosition(hunk, anchor) {
  if (hunk.oldCount === 0) {
    if (hunk.oldStart < anchor.startLine) return "before";
    return hunk.oldStart >= anchor.endLine ? "after" : "inside";
  }
  if (hunk.oldStart + hunk.oldCount - 1 < anchor.startLine) return "before";
  return hunk.oldStart > anchor.endLine ? "after" : "inside";
}

/**
 * Carries a line anchor across one change into the child's line numbers: hunks above it shift
 * it, hunks inside it stretch it over their new lines, hunks below it leave it alone. This is how
 * an anchor follows its code through the commits of a pull request.
 */
export function carryAnchor(anchor, change) {
  if (anchor.fileLevel || change.kind !== "hunks") return anchor;
  let offset = 0;
  let stretch = 0;
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = 0;
  for (const hunk of change.hunks) {
    const position = hunkPosition(hunk, anchor);
    if (position === "before") offset += hunk.newCount - hunk.oldCount;
    if (position !== "inside") continue;
    stretch += hunk.newCount - hunk.oldCount;
    startLine = Math.min(startLine, hunk.newStart);
    endLine = Math.max(endLine, hunk.newStart + Math.max(hunk.newCount, 1) - 1);
  }
  const start = Math.max(1, Math.min(anchor.startLine + offset, startLine));
  const end = Math.max(start, anchor.endLine + offset + stretch, endLine);
  return { startLine: start, endLine: end, fileLevel: false };
}

/**
 * Whether the pull request's own later commits touched the anchored region. `history` walks the
 * first-parent chain from the reviewed commit to the head: each own commit is checked against the
 * anchor as carried to that point; a merge commit (the base branch flowing in) only carries the
 * anchor, because a change the base brought is not the pull request acting on the finding. A
 * rewritten history (the reviewed commit is not on the chain) falls back to one cumulative diff.
 */
export function regionChangedInHistory(history, anchor, tolerance = REGION_CHANGE_TOLERANCE_LINES) {
  if (history.kind === "cumulative") return regionTouched(history.change, anchor, tolerance);
  let carried = anchor;
  for (const step of history.steps) {
    if (!step.merge && regionTouched(step.change, carried, tolerance)) return true;
    carried = carryAnchor(carried, step.change);
  }
  return false;
}

function commitOid(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !FULL_COMMIT_OID.test(value)) {
    throw new TypeError(`review harvest: ${label} must be a 40-hex commit oid or null`);
  }
  return value;
}

function positiveLine(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The anchored range at the reviewed commit, preferring the original (outdate-proof) position. */
export function anchorOf(thread) {
  const end = positiveLine(thread.originalLine);
  if (thread.subjectType === "FILE" || end === null) {
    return { startLine: null, endLine: null, fileLevel: true };
  }
  const start = positiveLine(thread.originalStartLine) ?? end;
  return { startLine: Math.min(start, end), endLine: Math.max(start, end), fileLevel: false };
}

/**
 * `changed` / `unchanged` by the pull request's own commits between the reviewed commit and its
 * final head; `no-later-commit` when the head is the reviewed commit; `unavailable` when git
 * cannot answer (a commit is missing, or the anchor is on the base side, whose coordinates the
 * history does not carry). Unavailable is a measurement failure, never read as unchanged.
 */
export function regionChangeOf({ anchor, side, path, reviewedCommit, headCommit, probe }) {
  if (reviewedCommit === null || headCommit === null || side !== "right") return "unavailable";
  if (reviewedCommit === headCommit) return "no-later-commit";
  const history = probe({ from: reviewedCommit, to: headCommit, path });
  if (history.kind === "unavailable") return "unavailable";
  return regionChangedInHistory(history, anchor) ? "changed" : "unchanged";
}

function firstForeignReply(comments, root) {
  const rootLogin = normalizedLogin(root.author);
  const reply = comments.slice(1).find((comment) => normalizedLogin(comment.author) !== rootLogin);
  if (reply === undefined) return null;
  return { classification: classifyReply(reply.body), producer: classifyProducer(reply.author) };
}

function requireString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`review harvest: ${label} must be a non-empty string`);
  }
  return value;
}

function threadRecord(thread, root, producer, context) {
  const anchor = anchorOf(thread);
  const side = thread.diffSide === "LEFT" ? "left" : "right";
  const path = requireString(thread.path, "thread path");
  const reviewedCommit = commitOid(root.originalCommit?.oid, "reviewed commit");
  return {
    id: requireString(thread.id, "thread id"),
    producer,
    path,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    fileLevel: anchor.fileLevel,
    side,
    reviewedCommit,
    resolved: thread.isResolved === true,
    outdated: thread.isOutdated === true,
    reply: firstForeignReply(thread.comments.nodes, root),
    regionChange: regionChangeOf({ ...context, anchor, side, path, reviewedCommit }),
    bodyDigest: `sha256:${sha256(typeof root.body === "string" ? root.body : "")}`,
  };
}

/** One raw GraphQL thread: a body-free record, a notice to count, or nothing (no comments). */
export function normalizeThread(thread, context) {
  const root = thread.comments.nodes[0];
  if (root === undefined) return { kind: "empty" };
  const producer = classifyProducer(root.author);
  if (isReviewNotice(producer, root.body)) return { kind: "notice", producer };
  return { kind: "thread", record: threadRecord(thread, root, producer, context) };
}

function producersInOrder(set) {
  return REVIEW_PRODUCERS.filter((producer) => set.has(producer));
}

/** One raw GraphQL pull request whose connections are complete: its record and notice counts. */
export function normalizePullRequest(pullRequest, probe) {
  const headCommit = commitOid(pullRequest.headRefOid, "head commit");
  const context = { headCommit, probe };
  const threads = [];
  const notices = {};
  const reviewers = new Set(
    pullRequest.reviews.nodes.map((review) => classifyProducer(review.author)),
  );
  for (const thread of pullRequest.reviewThreads.nodes) {
    const normalized = normalizeThread(thread, context);
    if (normalized.kind === "notice")
      notices[normalized.producer] = (notices[normalized.producer] ?? 0) + 1;
    if (normalized.kind !== "thread") continue;
    threads.push(normalized.record);
    reviewers.add(normalized.record.producer);
  }
  threads.sort((left, right) => compareStrings(left.id, right.id));
  return {
    record: {
      number: pullRequest.number,
      state: String(pullRequest.state).toLowerCase(),
      headCommit,
      baseCommit: commitOid(pullRequest.baseRefOid, "base commit"),
      reviewedBy: producersInOrder(reviewers),
      threads,
    },
    notices,
  };
}

/** Adds one pull request's notice counts into a running total. */
export function addNoticeCounts(total, counts) {
  const next = { ...total };
  for (const [producer, count] of Object.entries(counts))
    next[producer] = (next[producer] ?? 0) + count;
  return next;
}

function canonicalMember(key, value) {
  return `${JSON.stringify(key)}:${canonicalJson(value)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(compareStrings);
    return `{${keys.map((key) => canonicalMember(key, value[key])).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The content digest of a dataset body (everything except the `digest` field itself). */
export function reviewHarvestDatasetDigest(content) {
  return `sha256:${sha256(canonicalJson(content))}`;
}

function populationOf(pullRequests) {
  const numbers = pullRequests.map((pullRequest) => pullRequest.number);
  return {
    states: ["merged", "closed"],
    pullRequestCount: numbers.length,
    firstPullRequest: numbers[0] ?? null,
    lastPullRequest: numbers.at(-1) ?? null,
  };
}

/**
 * The versioned dataset. It carries no wall-clock value, so the same GitHub state yields the same
 * bytes and the same digest; the run's time and command live in the baseline document instead.
 */
export function buildReviewHarvestDataset({ repository, pullRequests, excludedNoticeThreads }) {
  const sorted = [...pullRequests].sort((left, right) => left.number - right.number);
  const notices = Object.fromEntries(
    REVIEW_PRODUCERS.map((producer) => [producer, excludedNoticeThreads[producer] ?? 0]),
  );
  const content = {
    schemaVersion: REVIEW_HARVEST_SCHEMA_VERSION,
    repository,
    rules: REVIEW_HARVEST_RULES,
    population: populationOf(sorted),
    excludedNoticeThreads: notices,
    pullRequests: sorted,
  };
  return { ...content, digest: reviewHarvestDatasetDigest(content) };
}

/** True when the dataset's recorded digest matches its content. */
export function verifyReviewHarvestDataset(dataset) {
  const { digest, ...content } = dataset;
  return typeof digest === "string" && digest === reviewHarvestDatasetDigest(content);
}

function collectKeys(value, path, keys) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, `${path}[]`, keys);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    keys.add(`${path}.${key}`);
    collectKeys(child, `${path}.${key}`, keys);
  }
}

/** Every key path the dataset uses, so a test can pin the closed, body-free key set. */
export function tallyRecordKeys(dataset) {
  const keys = new Set();
  collectKeys(dataset, "$", keys);
  return [...keys].sort(compareStrings);
}
