#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  validatePublishApprovalReference(review, index, failures);
}

function validatePublishApprovalReference(review, index, failures) {
  if (process.env.KEIKO_REQUIRE_RELEASE_APPROVAL_REFERENCE !== "1") return;
  const reference = review.approvalReference;
  const parsed = parseGithubReviewReference(reference);
  if (parsed === undefined) {
    failures.push(
      failure(
        `entries[${String(index)}].review.approvalReference must use github-pr-review:<owner>/<repo>#<pr>#<review> for publish.`,
      ),
    );
    return;
  }
  validateGithubReviewApproval(parsed, index, failures);
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
  const path = `repos/${reference.repository}/pulls/${reference.pullRequest}/reviews/${reference.review}`;
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", stdio: "pipe" });
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
  for (const [index, entry] of entries.entries()) {
    if (!objectRecord(entry)) continue;
    recordUniqueId(entry, index, ids, failures);
    recordDefaultPatchNotes(entry, index, defaultNotes, failures);
  }
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
  for (const entry of current) {
    validateCurrentEntry(entry, rootManifest, failures);
  }
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
  return spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
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
