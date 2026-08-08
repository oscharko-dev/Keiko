#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

export const releaseImpactCatalogFile = "release-impact.catalog.json";
export const releaseImpactSchemaVersion = 1;
export const releaseImpactBaselineVersion = "0.2.0";

const repoRoot = resolve(import.meta.dirname, "..");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const releaseCategories = new Set([
  "critical-security",
  "update-notes",
  "state-or-compatibility-changes",
  "new-additions",
  "improvements",
  "fixes",
  "ui-polish",
  "internal-only",
]);
const releasePriorities = new Set(["critical", "high", "normal", "low", "internal"]);
const remediations = new Set([
  "no-action-required",
  "restart-required",
  "repair-required",
  "local-knowledge-reindex-required",
  "migration-required",
  "manual-review-required",
]);
const userVisibleChanges = new Set([
  "none",
  "observable",
  "behavioral",
  "security",
  "compatibility",
]);
const publishGates = new Set([
  "version-consistency",
  "publish-manifests",
  "release-impact",
  "workspace-supply-chain",
  "package-surface",
  "qi-supply-chain",
  "install-smoke",
]);
const requiredStablePublishGates = [
  "version-consistency",
  "publish-manifests",
  "release-impact",
  "workspace-supply-chain",
  "package-surface",
  "qi-supply-chain",
];
const releaseOwners = new Set(["release-owner"]);

function failure(message) {
  return `release-impact: ${message}`;
}

function readJson(root, relativePath, failures) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    failures.push(failure(`${relativePath} is missing.`));
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(failure(`${relativePath} is not valid JSON: ${error.message}`));
    return undefined;
  }
}

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(entry, field, index, failures) {
  if (!nonEmptyString(entry[field])) {
    failures.push(failure(`entries[${String(index)}].${field} must be a non-empty string.`));
  }
}

function requireBoolean(entry, field, index, failures) {
  if (typeof entry[field] !== "boolean") {
    failures.push(failure(`entries[${String(index)}].${field} must be true or false.`));
  }
}

function requireEnum(entry, field, values, index, failures) {
  if (!values.has(entry[field])) {
    failures.push(
      failure(
        `entries[${String(index)}].${field} has unsupported value ${JSON.stringify(entry[field])}.`,
      ),
    );
  }
}

function requireStringArray(entry, field, index, failures, options = {}) {
  const value = entry[field];
  if (!stringArray(value) || (options.nonEmpty === true && value.length === 0)) {
    failures.push(failure(`entries[${String(index)}].${field} must be a string array.`));
  }
}

function normalizedNote(note) {
  return note.trim().replace(/\s+/gu, " ").toLowerCase();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateStateImpact(entry, index, failures) {
  if (!Array.isArray(entry.stateImpact)) {
    failures.push(failure(`entries[${String(index)}].stateImpact must be an array.`));
    return;
  }
  for (const [stateIndex, stateImpact] of entry.stateImpact.entries()) {
    validateStateImpactRecord(entry, stateImpact, index, stateIndex, failures);
  }
}

function validateStateImpactRecord(entry, stateImpact, index, stateIndex, failures) {
  const prefix = `entries[${String(index)}].stateImpact[${String(stateIndex)}]`;
  if (!objectRecord(stateImpact)) {
    failures.push(failure(`${prefix} must be an object.`));
    return;
  }
  for (const field of ["store", "description"]) {
    if (!nonEmptyString(stateImpact[field])) {
      failures.push(failure(`${prefix}.${field} must be a non-empty string.`));
    }
  }
  if (!remediations.has(stateImpact.remediation)) {
    failures.push(failure(`${prefix}.remediation must use the ADR-0099 remediation set.`));
  }
  if (typeof stateImpact.userActionRequired !== "boolean") {
    failures.push(failure(`${prefix}.userActionRequired must be true or false.`));
  }
  if (stateImpact.userActionRequired && stateImpact.remediation === "no-action-required") {
    failures.push(failure(`${prefix} contradicts user action with no-action remediation.`));
  }
  if (
    stringArray(entry.affectedStateStores) &&
    !entry.affectedStateStores.includes(stateImpact.store)
  ) {
    failures.push(failure(`${prefix}.store must also appear in affectedStateStores.`));
  }
}

function validateReview(entry, index, failures) {
  const review = entry.review;
  if (!objectRecord(review)) {
    failures.push(failure(`entries[${String(index)}].review must be an object.`));
    return;
  }
  for (const field of ["reviewer", "reviewedAt", "rationale", "approvalReference"]) {
    if (!nonEmptyString(review[field])) {
      failures.push(failure(`entries[${String(index)}].review.${field} must be non-empty.`));
    }
  }
  if (nonEmptyString(review.reviewer) && !releaseOwners.has(review.reviewer)) {
    failures.push(
      failure(`entries[${String(index)}].review.reviewer must be a trusted release owner.`),
    );
  }
  if (!["pending", "reviewed"].includes(review.status)) {
    failures.push(failure(`entries[${String(index)}].review.status must be pending or reviewed.`));
  }
  if (review.status !== "reviewed" || review.humanApproved !== true) {
    failures.push(failure(`entries[${String(index)}] must have human release-owner review.`));
  }
  validatePublishApprovalReference(entry, review, index, failures);
}

/**
 * Structural half of the approval evidence: every retained entry must carry a well-formed
 * reference. The LIVE GitHub verification runs only for the release currently being published
 * (see validateApprovalReferenceLive) — historical approvals are mutable GitHub artifacts, and a
 * later edit or deletion must never brick every future publish of an append-only catalog
 * (review finding on #3028).
 */
function validatePublishApprovalReference(entry, review, index, failures) {
  if (process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE !== "1") return;
  const reference = review.approvalReference;
  if (
    parseGithubReviewReference(reference) === undefined &&
    parseGithubIssueCommentReference(reference) === undefined
  ) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference must use github-pr-review:<owner>/<repo>#<pr>#<review> or github-issue-comment:<owner>/<repo>#<issue>#<comment> for publish.`,
      ),
    );
  }
}

/** Live GitHub verification of the approval artifact for the release being published NOW. */
function validateApprovalReferenceLive(entry, index, failures) {
  if (process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE !== "1") return;
  const reference = objectRecord(entry.review) ? entry.review.approvalReference : undefined;
  const parsed = parseGithubReviewReference(reference);
  if (parsed !== undefined) {
    validateGithubReviewApproval(parsed, index, failures);
    return;
  }
  // Owner-directed second evidence form (2026-08-08): GitHub refuses self-approval of one's own
  // pull requests, so a solo release owner can never mint the pr-review artifact. The
  // issue-comment form keeps the gate's intent — a durable, GitHub-verified approval artifact by
  // an allowed release owner — and is held to the same strictness: verified through the GitHub
  // API, author allow-listed, and bound to the exact package version by a literal phrase.
  const comment = parseGithubIssueCommentReference(reference);
  if (comment !== undefined) {
    validateGithubIssueCommentApproval(entry, comment, index, failures);
  }
}

function parseGithubReviewReference(reference) {
  const match = /^github-pr-review:([^#/\s]+\/[^#/\s]+)#(\d+)#(\d+)$/u.exec(reference);
  if (match === null) return undefined;
  return {
    repository: match[1],
    pullRequest: match[2],
    review: match[3],
  };
}

function parseGithubIssueCommentReference(reference) {
  const match = /^github-issue-comment:([^#/\s]+\/[^#/\s]+)#(\d+)#(\d+)$/u.exec(reference);
  if (match === null) return undefined;
  return {
    repository: match[1],
    issue: match[2],
    comment: match[3],
  };
}

/**
 * The literal, version-bound phrase an approval comment must carry. Derived from the catalog
 * entry under validation — the record being approved — never re-read from disk, so the phrase can
 * only ever bind to the exact package identity the gate is judging. Exported so test fixtures
 * derive the phrase from this producer instead of hand-rebuilding the template (review finding on
 * #3037).
 */
export function publishApprovalPhrase(entry) {
  return `Approved-for-publish: ${String(entry.packageName)}@${String(entry.packageVersion)}`;
}

function validateGithubIssueCommentApproval(entry, reference, index, failures) {
  const repository = currentRepository();
  if (repository === undefined || reference.repository !== repository) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference must reference the current GitHub repository.`,
      ),
    );
    return;
  }
  const comment = readGithubIssueComment(reference);
  if (comment === undefined) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference could not be verified through GitHub.`,
      ),
    );
    return;
  }
  validateGithubIssueCommentState(entry, comment, reference, index, failures);
}

function validateGithubIssueCommentState(entry, comment, reference, index, failures) {
  const issueUrl = typeof comment.issue_url === "string" ? comment.issue_url : "";
  if (!issueUrl.endsWith(`/issues/${reference.issue}`)) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference comment must belong to the referenced issue.`,
      ),
    );
  }
  const phrase = publishApprovalPhrase(entry);
  // The phrase must stand on a line of its own: a substring match would accept a comment that
  // QUOTES the marker in a denial ("DO NOT use Approved-for-publish: ...") as an affirmative
  // approval (review finding on #3028).
  const standsAlone =
    typeof comment.body === "string" && phraseStandsOnPlainLine(comment.body, phrase);
  if (!standsAlone) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference comment must carry "${phrase}" on a line of its own.`,
      ),
    );
  }
  const allowedLogins = allowedReleaseOwnerLogins();
  if (allowedLogins.length === 0) {
    failures.push(failure("KEIKO_RELEASE_OWNER_GITHUB_LOGINS must list allowed release owners."));
    return;
  }
  if (!allowedLogins.includes(comment.user?.login)) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference comment author must be an allowed release owner.`,
      ),
    );
  }
}

/**
 * True only when the phrase stands on a plain Markdown line of its own: outside every code fence
 * and outside every blockquote. A fenced example ("```\nApproved-for-publish: ...\n```") or a
 * quoted line ("> Approved-for-publish: ...") documents the phrase — it never grants the approval
 * (review finding on #3037).
 */
function fenceDelimiter(line) {
  const match = /^(`{3,}|~{3,})/u.exec(line);
  return match?.[1];
}

// A fence closes only on the SAME marker type at the same-or-greater length with nothing after
// it (CommonMark) — a `~~~` line inside a backtick fence is fenced CONTENT, not a closer, and
// treating it as one would let a fenced example approve a publish.
function closesFence(openFence, line, delimiter) {
  return (
    delimiter !== undefined &&
    delimiter[0] === openFence[0] &&
    delimiter.length >= openFence.length &&
    line.slice(delimiter.length).trim() === ""
  );
}

// Four-plus leading spaces or a tab make a CommonMark indented CODE BLOCK: like a fenced
// example, an indented line documents the phrase and never grants the approval — so the RAW
// line is judged before trimming, which would erase exactly that distinction (review finding on
// #3037). Up to three leading spaces is ordinary paragraph indentation and stays eligible.
function isIndentedCodeLine(rawLine) {
  // Tabs expand to the next 4-column stop (CommonMark), so " \t" reaches column 4 exactly like
  // four spaces — indentation is judged in COLUMNS, not characters (review finding on #3037).
  let columns = 0;
  for (const char of rawLine) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

// Raw-HTML blocks render as code or markup, never as an affirmative statement: a phrase inside
// <pre>/<script>/<style>/<textarea> (CommonMark HTML block type 1 — runs to its closing tag,
// blank lines included) or any other "<"-opened block (types 6/7 — run to the next blank line)
// must never approve (review finding on #3037).
function htmlBlockContextLine(line, state) {
  if (state.inHtmlPre) {
    if (/<\/(?:pre|script|style|textarea)>/iu.test(line)) state.inHtmlPre = false;
    return true;
  }
  if (/^<(?:pre|script|style|textarea)\b/iu.test(line)) {
    if (!/<\/(?:pre|script|style|textarea)>/iu.test(line)) state.inHtmlPre = true;
    return true;
  }
  if (state.inHtmlBlock) {
    // A blank line ends a type-6/7 block; the blank itself is still block context.
    if (line === "") state.inHtmlBlock = false;
    return true;
  }
  if (line.startsWith("<")) {
    state.inHtmlBlock = true;
    return true;
  }
  return false;
}

// One walker step: mutates the fence/blockquote state and reports whether the line is Markdown
// CONTEXT (fenced, indented code, blockquote or its CommonMark lazy continuation — a non-blank
// line directly after a "> ..." line still renders inside the quote; only a blank line ends it)
// rather than a plain top-level line (review findings on #3037).
// An HTML comment renders NOTHING — a phrase inside `<!-- ... -->` is invisible on GitHub and
// must never approve (review finding on #3037). Single-line comments never equal the bare
// phrase; only the multi-line block state needs tracking.
function htmlCommentContextLine(line, state) {
  const isContext = state.inHtmlComment || line.includes("<!--") || line.includes("-->");
  if (!isContext) return false;
  // Walk EVERY marker on the line in order — a single "-->" followed by "<!--" closes one
  // comment and opens the next, so judging only the first marker would end the comment state
  // while GitHub still renders the following lines invisibly (review finding on #3037). A line
  // carrying any marker is never the bare phrase itself, so context lines always skip.
  let index = 0;
  for (;;) {
    if (state.inHtmlComment) {
      const close = line.indexOf("-->", index);
      if (close === -1) break;
      state.inHtmlComment = false;
      index = close + 3;
    } else {
      const open = line.indexOf("<!--", index);
      if (open === -1) break;
      state.inHtmlComment = true;
      index = open + 4;
    }
  }
  return true;
}

// Blockquotes AND list items share the paragraph-continuation rule: a non-blank line directly
// after them still renders inside the container (lazy continuation), so an instructional
// "- To approve, use:" list can never smuggle the marker (review finding on #3037). Only a
// blank line ends the container.
function containerContextLine(line, state) {
  if (line.startsWith(">") || /^(?:[-*+]|\d{1,9}[.)])\s/u.test(line) || state.inContainer) {
    state.inContainer = true;
    return true;
  }
  return false;
}

function approvalContextLine(rawLine, state) {
  const line = rawLine.trim();
  const delimiter = fenceDelimiter(line);
  // The OPEN FENCE is judged first: fenced content is opaque, so an unclosed `<!--` (or any
  // other marker) inside a fence must not open comment/block state that would outlive the fence
  // (review finding on #3037).
  if (state.openFence !== undefined) {
    // CommonMark allows at most three columns of indentation before a closing fence — a
    // four-plus-column (or tabbed) would-be closer is fenced CONTENT, so it is judged on the
    // RAW line: trimming first would close the fence early and let the next column-zero line
    // approve while GitHub still renders it fenced (review finding on #3037).
    if (!isIndentedCodeLine(rawLine) && closesFence(state.openFence, line, delimiter)) {
      state.openFence = undefined;
    }
    return true;
  }
  if (htmlCommentContextLine(line, state)) return true;
  if (htmlBlockContextLine(line, state)) return true;
  if (line === "") {
    state.inContainer = false;
    state.inHtmlBlock = false;
    return true;
  }
  if (isIndentedCodeLine(rawLine)) return true;
  if (delimiter !== undefined) {
    state.openFence = delimiter;
    return true;
  }
  if (containerContextLine(line, state)) return true;
  return false;
}

function phraseStandsOnPlainLine(body, phrase) {
  const state = {
    openFence: undefined,
    inContainer: false,
    inHtmlComment: false,
    inHtmlPre: false,
    inHtmlBlock: false,
  };
  for (const rawLine of body.split("\n")) {
    if (approvalContextLine(rawLine, state)) continue;
    // The marker must start at COLUMN ZERO: any leading indentation can place it inside a list
    // item's child paragraph or other continuation context (review finding on #3037) — the
    // documented contract is an unindented line of its own.
    if (rawLine.trimEnd() === phrase) return true;
  }
  return false;
}

function readGithubIssueComment(reference) {
  return readGithubResource(`repos/${reference.repository}/issues/comments/${reference.comment}`);
}

function validateGithubReviewApproval(reference, index, failures) {
  const repository = currentRepository();
  if (repository === undefined || reference.repository !== repository) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference must reference the current GitHub repository.`,
      ),
    );
    return;
  }
  const review = readGithubReview(reference);
  if (review === undefined) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference could not be verified through GitHub.`,
      ),
    );
    return;
  }
  validateGithubReviewState(review, index, failures);
}

function currentRepository() {
  if (
    typeof process.env.GITHUB_REPOSITORY === "string" &&
    process.env.GITHUB_REPOSITORY.includes("/")
  ) {
    return process.env.GITHUB_REPOSITORY;
  }
  const result = git(repoRoot, ["remote", "get-url", "origin"]);
  if (result.status !== 0) return undefined;
  return githubRepositoryFromRemote(result.stdout);
}

function githubRepositoryFromRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  if (httpsMatch !== null) return httpsMatch[1];
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(trimmed);
  return sshMatch?.[1];
}

function readGithubReview(reference) {
  return readGithubResource(
    `repos/${reference.repository}/pulls/${reference.pullRequest}/reviews/${reference.review}`,
  );
}

let githubResourceReader = readGithubResourceFromHost;

/** Test seam: swap the GitHub reader for a callback's duration, always restoring it. */
export function withGithubResourceReader(reader, callback) {
  const previous = githubResourceReader;
  githubResourceReader = reader;
  try {
    return callback();
  } finally {
    githubResourceReader = previous;
  }
}

function readGithubResource(path) {
  return githubResourceReader(path);
}

function readGithubResourceFromHost(path) {
  let executable;
  try {
    executable = resolveHostExecutable("gh");
  } catch {
    return undefined;
  }
  const result = spawnSync(executable, ["api", path], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function allowedReleaseOwnerLogins() {
  const value = process.env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function validateGithubReviewState(review, index, failures) {
  if (review.state !== "APPROVED") {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference must point to an APPROVED review.`,
      ),
    );
  }
  const allowedLogins = allowedReleaseOwnerLogins();
  if (allowedLogins.length === 0) {
    failures.push(failure("KEIKO_RELEASE_OWNER_GITHUB_LOGINS must list allowed release owners."));
    return;
  }
  if (!allowedLogins.includes(review.user?.login)) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference reviewer must be an allowed release owner.`,
      ),
    );
  }
}

function validateBreakingException(entry, index, failures) {
  if (entry.breakingException === undefined) return;
  if (!objectRecord(entry.breakingException)) {
    failures.push(failure(`entries[${String(index)}].breakingException must be an object.`));
    return;
  }
  for (const field of ["rationale", "warningText"]) {
    if (!nonEmptyString(entry.breakingException[field])) {
      failures.push(failure(`entries[${String(index)}].breakingException.${field} is required.`));
    }
  }
  if (entry.oneClickEligible && entry.breakingException.verifiedCarryForward !== true) {
    failures.push(
      failure(
        `entries[${String(index)}] cannot be one-click eligible without carry-forward proof.`,
      ),
    );
  }
  if (
    entry.breakingException.verifiedCarryForward &&
    !nonEmptyString(entry.breakingException.carryForwardPath)
  ) {
    failures.push(
      failure(`entries[${String(index)}].breakingException.carryForwardPath is required.`),
    );
  }
}

function validateEntryShape(entry, index, failures) {
  if (!objectRecord(entry)) {
    failures.push(failure(`entries[${String(index)}] must be an object.`));
    return;
  }
  for (const field of [
    "id",
    "packageName",
    "packageVersion",
    "registry",
    "releaseTag",
    "userVisibleSummary",
    "remediation",
  ]) {
    requireString(entry, field, index, failures);
  }
  for (const field of [
    "userActionRequired",
    "internalOnly",
    "observableImpact",
    "defaultPatchNotes",
    "oneClickEligible",
  ]) {
    requireBoolean(entry, field, index, failures);
  }
  requireEnum(entry, "releaseNoteCategory", releaseCategories, index, failures);
  requireEnum(entry, "releaseNotePriority", releasePriorities, index, failures);
  requireEnum(entry, "userVisibleChange", userVisibleChanges, index, failures);
  requireEnum(entry, "remediation", remediations, index, failures);
  requireStringArray(entry, "affectedStateStores", index, failures);
  requireStringArray(entry, "supportedFrom", index, failures, { nonEmpty: true });
  requireStringArray(entry, "releaseNoteBullets", index, failures, { nonEmpty: true });
  requireStringArray(entry, "publishGates", index, failures, { nonEmpty: true });
  validateStateImpact(entry, index, failures);
  validateReview(entry, index, failures);
  validateBreakingException(entry, index, failures);
}

function validateEntrySemantics(entry, index, failures) {
  validateReleaseBinding(entry, index, failures);
  validateSupportedFrom(entry, index, failures);
  validatePublishGateNames(entry, index, failures);
}

function validateReleaseBinding(entry, index, failures) {
  if (!semverPattern.test(entry.packageVersion)) {
    failures.push(failure(`entries[${String(index)}].packageVersion must be a semantic version.`));
  }
  if (entry.releaseTag !== `v${entry.packageVersion}`) {
    failures.push(failure(`entries[${String(index)}].releaseTag must equal v<packageVersion>.`));
  }
  const expectedTag = expectedDistTagForVersion(entry.packageVersion);
  if (entry.distTag !== expectedTag) {
    failures.push(
      failure(
        `entries[${String(index)}].distTag must be ${expectedTag} for ` +
          `${expectedTag === "beta" ? "prerelease versions" : "v1 updates"}.`,
      ),
    );
  }
  if (entry.registry !== "https://registry.npmjs.org/") {
    failures.push(
      failure(`entries[${String(index)}].registry must be https://registry.npmjs.org/.`),
    );
  }
}

function validateSupportedFrom(entry, index, failures) {
  if (stringArray(entry.supportedFrom)) {
    for (const version of entry.supportedFrom) {
      if (!semverPattern.test(version)) {
        failures.push(
          failure(`entries[${String(index)}].supportedFrom contains invalid version ${version}.`),
        );
      }
    }
  }
}

function validatePublishGateNames(entry, index, failures) {
  if (stringArray(entry.publishGates)) {
    for (const gate of entry.publishGates) {
      if (!publishGates.has(gate)) {
        failures.push(
          failure(`entries[${String(index)}].publishGates contains unknown gate ${gate}.`),
        );
      }
    }
  }
}

function validateContradictions(entry, index, failures) {
  validateUserActionRemediation(entry, index, failures);
  validateStateImpactCategory(entry, index, failures);
  validateInternalOnlyVisibility(entry, index, failures);
  validateExceptionRequirements(entry, index, failures);
  validateCorrectionMetadata(entry, index, failures);
}

function validateUserActionRemediation(entry, index, failures) {
  if (entry.userActionRequired && entry.remediation === "no-action-required") {
    failures.push(
      failure(`entries[${String(index)}] requires user action but has no remediation.`),
    );
  }
}

function validateStateImpactCategory(entry, index, failures) {
  const stateImpact = Array.isArray(entry.stateImpact) ? entry.stateImpact : [];
  if (entry.releaseNoteCategory === "state-or-compatibility-changes" && stateImpact.length === 0) {
    failures.push(
      failure(
        `entries[${String(index)}] must declare stateImpact for state or compatibility changes.`,
      ),
    );
  }
}

function validateInternalOnlyVisibility(entry, index, failures) {
  if (entry.internalOnly && !entry.observableImpact && entry.defaultPatchNotes) {
    failures.push(
      failure(
        `entries[${String(index)}] internal-only metadata must stay out of default patch notes.`,
      ),
    );
  }
  if (entry.internalOnly && !entry.observableImpact && entry.userVisibleChange !== "none") {
    failures.push(
      failure(
        `entries[${String(index)}] internal-only non-observable metadata cannot be user-visible.`,
      ),
    );
  }
}

function validateExceptionRequirements(entry, index, failures) {
  const exceptionRequired =
    entry.releaseNoteCategory === "critical-security" ||
    entry.releaseNotePriority === "critical" ||
    entry.remediation === "manual-review-required";
  if (exceptionRequired && !objectRecord(entry.breakingException)) {
    failures.push(
      failure(
        `entries[${String(index)}] requires breakingException metadata for critical or manual-review updates.`,
      ),
    );
  }
}

function validateCorrectionMetadata(entry, index, failures) {
  if (
    (entry.correctionOf !== undefined || entry.supersedes !== undefined) &&
    !nonEmptyString(entry.correctionRationale)
  ) {
    failures.push(
      failure(`entries[${String(index)}] correction records require correctionRationale.`),
    );
  }
}

function validateEntry(entry, index, failures) {
  validateEntryShape(entry, index, failures);
  if (!objectRecord(entry)) return;
  validateEntrySemantics(entry, index, failures);
  validateContradictions(entry, index, failures);
}

function validateCatalogShape(catalog, failures) {
  if (!objectRecord(catalog)) {
    failures.push(failure("catalog root must be an object."));
    return false;
  }
  if (catalog.schemaVersion !== releaseImpactSchemaVersion) {
    failures.push(failure(`schemaVersion must be ${String(releaseImpactSchemaVersion)}.`));
  }
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    failures.push(failure("entries must be a non-empty array."));
    return false;
  }
  return true;
}

function validateDuplicates(entries, failures) {
  const ids = new Set();
  const defaultNotes = new Map();
  const approvalReferences = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!objectRecord(entry)) continue;
    recordUniqueId(entry, index, ids, failures);
    recordDefaultPatchNotes(entry, index, defaultNotes, failures);
    recordUniqueApprovalReference(entry, index, approvalReferences, failures);
  }
}

/**
 * One issue-comment approval artifact authorizes exactly one catalog record: copying an existing
 * owner comment reference into a newly appended entry would smuggle unreviewed metadata past the
 * publish gate (review finding on #3028). Scoped to the issue-comment form deliberately —
 * unchanged staging contracts reuse their historical PR-review reference across versions by
 * documented practice (see the 0.3.0 staging-contract entry's rationale).
 */
function recordUniqueApprovalReference(entry, index, approvalReferences, failures) {
  const reference = objectRecord(entry.review) ? entry.review.approvalReference : undefined;
  if (!nonEmptyString(reference) || !reference.startsWith("github-issue-comment:")) return;
  const previous = approvalReferences.get(reference);
  if (previous !== undefined) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference duplicates entries[${String(previous)}] — one approval artifact cannot authorize two catalog records.`,
      ),
    );
    return;
  }
  approvalReferences.set(reference, index);
}

function validateCorrectionReferences(entries, failures) {
  const byId = new Map();
  for (const entry of entries) {
    if (objectRecord(entry) && nonEmptyString(entry.id)) byId.set(entry.id, entry);
  }
  for (const [index, entry] of entries.entries()) {
    if (!objectRecord(entry)) continue;
    validateSingleCorrectionReference(entry, index, byId, failures);
    validateSupersedingReferences(entry, index, byId, failures);
  }
}

function validateSingleCorrectionReference(entry, index, byId, failures) {
  if (entry.correctionOf === undefined) return;
  validateCorrectionTarget(entry, index, "correctionOf", entry.correctionOf, byId, failures);
}

function validateSupersedingReferences(entry, index, byId, failures) {
  if (entry.supersedes === undefined) return;
  if (!stringArray(entry.supersedes) || entry.supersedes.length === 0) {
    failures.push(
      failure(`entries[${String(index)}].supersedes must be a non-empty string array.`),
    );
    return;
  }
  for (const targetId of entry.supersedes) {
    validateCorrectionTarget(entry, index, "supersedes", targetId, byId, failures);
  }
}

function validateCorrectionTarget(entry, index, field, targetId, byId, failures) {
  if (!nonEmptyString(targetId)) {
    failures.push(failure(`entries[${String(index)}].${field} must reference a catalog entry id.`));
    return;
  }
  if (targetId === entry.id) {
    failures.push(failure(`entries[${String(index)}].${field} must not reference itself.`));
    return;
  }
  const target = byId.get(targetId);
  if (target === undefined) {
    failures.push(failure(`entries[${String(index)}].${field} references unknown id ${targetId}.`));
    return;
  }
  if (!sameReleaseKey(entry, target)) {
    failures.push(
      failure(`entries[${String(index)}].${field} must reference the same package release.`),
    );
  }
}

function sameReleaseKey(left, right) {
  return (
    left.packageName === right.packageName &&
    left.packageVersion === right.packageVersion &&
    left.distTag === right.distTag
  );
}

function recordUniqueId(entry, index, ids, failures) {
  if (!nonEmptyString(entry.id)) return;
  if (ids.has(entry.id)) {
    failures.push(failure(`entries[${String(index)}].id duplicates ${entry.id}.`));
  }
  ids.add(entry.id);
}

function recordDefaultPatchNotes(entry, index, defaultNotes, failures) {
  if (!entry.defaultPatchNotes || !Array.isArray(entry.releaseNoteBullets)) return;
  for (const note of entry.releaseNoteBullets) {
    const normalized = normalizedNote(String(note));
    const previous = defaultNotes.get(normalized);
    if (previous !== undefined) {
      failures.push(
        failure(
          `entries[${String(index)}] duplicates patch note from entries[${String(previous)}].`,
        ),
      );
    }
    defaultNotes.set(normalized, index);
  }
}

function validateCurrentPackage(catalog, rootManifest, failures) {
  if (!objectRecord(rootManifest)) return;
  const current = catalog.entries.filter((entry) => currentPackageEntry(entry, rootManifest));
  const primary = current.filter((entry) => !correctionEntry(entry));
  if (primary.length === 0) {
    failures.push(
      failure(
        `${rootManifest.name}@${rootManifest.version} has no ` +
          `${expectedDistTagForVersion(rootManifest.version)} catalog entry.`,
      ),
    );
    return;
  }
  catalog.entries.forEach((entry, index) => {
    if (!currentPackageEntry(entry, rootManifest)) return;
    validateCurrentEntry(entry, rootManifest, failures);
    validateApprovalReferenceLive(entry, index, failures);
  });
}

// Stable versions publish under the latest dist-tag; prerelease versions (semver with a
// prerelease suffix, e.g. 0.2.15-beta.0) publish under beta per the release/publish workflow.
function expectedDistTagForVersion(version) {
  return typeof version === "string" && version.includes("-") ? "beta" : "latest";
}

function currentPackageEntry(entry, rootManifest) {
  return (
    objectRecord(entry) &&
    entry.packageName === rootManifest.name &&
    entry.packageVersion === rootManifest.version &&
    entry.distTag === expectedDistTagForVersion(rootManifest.version)
  );
}

function correctionEntry(entry) {
  return (
    objectRecord(entry) && (entry.correctionOf !== undefined || entry.supersedes !== undefined)
  );
}

function validateCurrentEntry(entry, rootManifest, failures) {
  if (entry.releaseTag !== `v${rootManifest.version}`) {
    failures.push(
      failure(`${rootManifest.name}@${rootManifest.version} is not tied to its release tag.`),
    );
  }
  if (
    !stringArray(entry.supportedFrom) ||
    !entry.supportedFrom.includes(releaseImpactBaselineVersion)
  ) {
    failures.push(
      failure(
        `${rootManifest.name}@${rootManifest.version} must include supportedFrom ${releaseImpactBaselineVersion}.`,
      ),
    );
  }
  if (!stringArray(entry.publishGates)) return;
  for (const gate of requiredStablePublishGates) {
    if (!entry.publishGates.includes(gate)) {
      failures.push(
        failure(`${rootManifest.name}@${rootManifest.version} must record publish gate ${gate}.`),
      );
    }
  }
}

function validateCatalogBundled(rootManifest, failures) {
  if (!objectRecord(rootManifest)) return;
  if (
    !Array.isArray(rootManifest.files) ||
    !rootManifest.files.includes(releaseImpactCatalogFile)
  ) {
    failures.push(failure(`package.json files must include ${releaseImpactCatalogFile}.`));
  }
}

function validateAppendOnly(catalog, previousCatalog, failures) {
  if (previousCatalog === undefined) return;
  if (!objectRecord(previousCatalog) || !Array.isArray(previousCatalog.entries)) {
    failures.push(failure("previous published catalog must contain an entries array."));
    return;
  }
  const currentById = new Map(
    catalog.entries
      .filter((entry) => objectRecord(entry) && nonEmptyString(entry.id))
      .map((entry) => [entry.id, entry]),
  );
  for (const previousEntry of previousCatalog.entries) {
    validatePublishedEntryRetained(previousEntry, currentById, failures);
  }
}

function validatePublishedEntryRetained(previousEntry, currentById, failures) {
  if (!objectRecord(previousEntry) || !nonEmptyString(previousEntry.id)) return;
  const currentEntry = currentById.get(previousEntry.id);
  if (currentEntry === undefined) {
    failures.push(failure(`published entry ${previousEntry.id} must remain in the catalog.`));
    return;
  }
  if (stableJson(currentEntry) !== stableJson(previousEntry)) {
    failures.push(failure(`published entry ${previousEntry.id} changed in place.`));
  }
}

function git(root, args) {
  return spawnSync(resolveHostExecutable("git"), args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function parseStableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareStableVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function previousReleaseTag(root, currentVersion) {
  const current = parseStableVersion(currentVersion);
  if (current === undefined) return undefined;
  const result = git(root, ["tag", "--list", "v[0-9]*", "--sort=-version:refname"]);
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .find((tag) => previousStableTag(tag, current));
}

function previousStableTag(tag, current) {
  const parsed = parseStableVersion(tag);
  return parsed !== undefined && compareStableVersions(parsed, current) < 0;
}

function readPreviousPublishedCatalog(root, currentVersion, failures) {
  const tag = previousReleaseTag(root, currentVersion);
  if (tag === undefined) return undefined;
  const result = git(root, ["show", `${tag}:${releaseImpactCatalogFile}`]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    failures.push(
      failure(`${tag}:${releaseImpactCatalogFile} is not valid JSON: ${error.message}`),
    );
    return undefined;
  }
}

export function validateReleaseImpactCatalog(catalog, rootManifest, options = {}) {
  const failures = [];
  if (!validateCatalogShape(catalog, failures)) return { failures, ok: false };
  for (const [index, entry] of catalog.entries.entries()) {
    validateEntry(entry, index, failures);
  }
  validateDuplicates(catalog.entries, failures);
  validateCorrectionReferences(catalog.entries, failures);
  validateCurrentPackage(catalog, rootManifest, failures);
  validateCatalogBundled(rootManifest, failures);
  validateAppendOnly(catalog, options.previousCatalog, failures);
  return { failures, ok: failures.length === 0 };
}

export function validateReleaseImpactRoot(root = repoRoot, options = {}) {
  const failures = [];
  const rootManifest = readJson(root, "package.json", failures);
  const catalog = readJson(root, releaseImpactCatalogFile, failures);
  if (rootManifest === undefined || catalog === undefined) {
    return { failures, ok: false };
  }
  const previousCatalog =
    options.previousCatalog ?? readPreviousPublishedCatalog(root, rootManifest.version, failures);
  const result = validateReleaseImpactCatalog(catalog, rootManifest, { previousCatalog });
  return { failures: [...failures, ...result.failures], ok: failures.length === 0 && result.ok };
}

function runCli() {
  if (process.argv.includes("--publish")) {
    process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE = "1";
  }
  const result = validateReleaseImpactRoot();
  if (!result.ok) {
    console.error("release-impact: FAIL");
    for (const message of result.failures) {
      console.error(`  - ${message}`);
    }
    process.exit(1);
  }
  console.log(
    "release-impact: PASS - current package version has reviewed update-impact metadata.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
