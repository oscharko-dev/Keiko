import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReleaseImpactBreakingException,
  ReleaseImpactCatalog,
  ReleaseImpactEntry,
  ReleaseImpactStateImpact,
  ReleaseImpactReview,
} from "@oscharko-dev/keiko-contracts";
import {
  RELEASE_IMPACT_CATEGORIES,
  RELEASE_IMPACT_PRIORITIES,
  RELEASE_IMPACT_PUBLISH_GATES,
  RELEASE_IMPACT_REMEDIATIONS,
} from "@oscharko-dev/keiko-contracts";
import { isRecord, isStableVersionString } from "./update-preflight-registry.js";

const RELEASE_IMPACT_USER_VISIBLE_CHANGES = [
  "none",
  "observable",
  "behavioral",
  "security",
  "compatibility",
] as const;

const bundledCatalogCache = new Map<string, ReleaseImpactCatalog | undefined>();

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => isEnumValue(item, allowed));
}

function isReleaseImpactStateImpact(value: unknown): value is ReleaseImpactStateImpact {
  return (
    isRecord(value) &&
    isString(value.store) &&
    isString(value.description) &&
    isEnumValue(value.remediation, RELEASE_IMPACT_REMEDIATIONS) &&
    isBoolean(value.userActionRequired)
  );
}

function isReleaseImpactReview(value: unknown): value is ReleaseImpactReview {
  return (
    isRecord(value) &&
    isEnumValue(value.status, ["pending", "reviewed"] as const) &&
    isString(value.reviewer) &&
    isString(value.reviewedAt) &&
    isBoolean(value.humanApproved) &&
    isString(value.approvalReference) &&
    isString(value.rationale)
  );
}

function isReleaseImpactBreakingException(value: unknown): value is ReleaseImpactBreakingException {
  return (
    isRecord(value) &&
    isString(value.rationale) &&
    isString(value.warningText) &&
    isBoolean(value.verifiedCarryForward) &&
    (value.carryForwardPath === undefined || isString(value.carryForwardPath))
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalBreakingException(
  value: unknown,
): value is ReleaseImpactBreakingException | undefined {
  return value === undefined || isReleaseImpactBreakingException(value);
}

export function bundledCatalogSearchRoots(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots: string[] = [];
  let current = here;
  for (;;) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function stringFields(entry: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof entry[field] === "string");
}

function booleanFields(entry: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof entry[field] === "boolean");
}

function hasBundledCatalogIdentity(entry: Record<string, unknown>): boolean {
  return (
    isString(entry.id) &&
    stringFields(entry, ["packageName", "packageVersion", "releaseTag", "userVisibleSummary"]) &&
    isStableVersionString(entry.packageVersion) &&
    booleanFields(entry, [
      "internalOnly",
      "observableImpact",
      "defaultPatchNotes",
      "oneClickEligible",
      "userActionRequired",
    ]) &&
    entry.registry === "https://registry.npmjs.org/" &&
    entry.distTag === "latest"
  );
}

function hasBundledCatalogEnums(entry: Record<string, unknown>): boolean {
  return (
    isEnumValue(entry.releaseNoteCategory, RELEASE_IMPACT_CATEGORIES) &&
    isEnumValue(entry.releaseNotePriority, RELEASE_IMPACT_PRIORITIES) &&
    isEnumValue(entry.userVisibleChange, RELEASE_IMPACT_USER_VISIBLE_CHANGES) &&
    isEnumValue(entry.remediation, RELEASE_IMPACT_REMEDIATIONS)
  );
}

function hasBundledCatalogArrays(entry: Record<string, unknown>): boolean {
  return (
    isStringArray(entry.releaseNoteBullets) &&
    isStringArray(entry.affectedStateStores) &&
    isStringArray(entry.supportedFrom) &&
    entry.supportedFrom.every(isStableVersionString) &&
    isEnumArray(entry.publishGates, RELEASE_IMPACT_PUBLISH_GATES) &&
    Array.isArray(entry.stateImpact) &&
    entry.stateImpact.every(isReleaseImpactStateImpact)
  );
}

function hasBundledCatalogOptionalFields(entry: Record<string, unknown>): boolean {
  return (
    isOptionalBreakingException(entry.breakingException) &&
    isOptionalString(entry.correctionOf) &&
    isOptionalString(entry.correctionRationale) &&
    isOptionalStringArray(entry.supersedes)
  );
}

export function isBundledCatalogEntry(entry: unknown): entry is ReleaseImpactEntry {
  if (!isRecord(entry)) return false;
  return (
    hasBundledCatalogIdentity(entry) &&
    hasBundledCatalogEnums(entry) &&
    hasBundledCatalogArrays(entry) &&
    isReleaseImpactReview(entry.review) &&
    hasBundledCatalogOptionalFields(entry)
  );
}

export function validateBundledCatalog(raw: unknown): ReleaseImpactCatalog | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    return undefined;
  }
  const entries = raw.entries.filter(isBundledCatalogEntry);
  return { schemaVersion: 1, entries };
}

export function readBundledCatalogFromDisk(): ReleaseImpactCatalog | undefined {
  for (const root of bundledCatalogSearchRoots()) {
    const candidate = join(root, "release-impact.catalog.json");
    if (!existsSync(candidate)) continue;
    const cached = bundledCatalogCache.get(candidate);
    if (cached !== undefined || bundledCatalogCache.has(candidate)) {
      return cached;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      const validated = validateBundledCatalog(parsed);
      bundledCatalogCache.set(candidate, validated);
      return validated;
    } catch {
      bundledCatalogCache.set(candidate, undefined);
      return undefined;
    }
  }
  return undefined;
}
