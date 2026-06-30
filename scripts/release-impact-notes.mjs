import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { releaseImpactCatalogFile, validateReleaseImpactCatalog } from "./check-release-impact.mjs";

const priorityOrder = ["critical", "high", "normal", "low", "internal"];
const categoryOrder = [
  "critical-security",
  "state-or-compatibility-changes",
  "update-notes",
  "new-additions",
  "improvements",
  "fixes",
  "ui-polish",
  "internal-only",
];
const priorityLabels = new Map([
  ["critical", "Critical"],
  ["high", "High"],
  ["normal", "Normal"],
  ["low", "Low"],
  ["internal", "Internal"],
]);
const categoryLabels = new Map([
  ["critical-security", "Critical Security"],
  ["state-or-compatibility-changes", "State and Compatibility"],
  ["update-notes", "Update Notes"],
  ["new-additions", "New Additions"],
  ["improvements", "Improvements"],
  ["fixes", "Fixes"],
  ["ui-polish", "UI Polish"],
  ["internal-only", "Internal Only"],
]);

function readJson(root, relativePath, failures) {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    failures.push(`release-impact: ${relativePath} is missing.`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`release-impact: ${relativePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedNote(note) {
  return note.trim().replace(/\s+/gu, " ").toLowerCase();
}

function sanitizeUserFacingText(value) {
  return value
    .replace(/https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/giu, "")
    .replace(/\b(?:issues?|prs?|pull requests?)\s*#\d+\b/giu, "")
    .replace(/\s*\(#\d+\)\s*/gu, " ")
    .replace(/#\d+\b/gu, "")
    .replace(/\s+([,.;:])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .replace(/\s+([.!?])$/u, "$1");
}

function extractTraceReferences(value) {
  const references = new Set();
  for (const match of value.matchAll(
    /(https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+|\b(?:issues?|prs?|pull requests?)\s*#\d+\b|#\d+\b)/giu,
  )) {
    references.add(match[0].trim());
  }
  return [...references];
}

function currentReleaseEntries(catalog, rootManifest) {
  return catalog.entries.filter(
    (entry) =>
      objectRecord(entry) &&
      entry.packageName === rootManifest.name &&
      entry.packageVersion === rootManifest.version &&
      entry.distTag === "latest",
  );
}

function correctionEntry(entry) {
  return entry.correctionOf !== undefined || entry.supersedes !== undefined;
}

function orderIndex(values, value) {
  const index = values.indexOf(value);
  return index === -1 ? values.length : index;
}

function compareEntries(left, right) {
  const priorityDelta =
    orderIndex(priorityOrder, left.releaseNotePriority) -
    orderIndex(priorityOrder, right.releaseNotePriority);
  if (priorityDelta !== 0) return priorityDelta;
  const categoryDelta =
    orderIndex(categoryOrder, left.releaseNoteCategory) -
    orderIndex(categoryOrder, right.releaseNoteCategory);
  if (categoryDelta !== 0) return categoryDelta;
  return left.id.localeCompare(right.id);
}

function groupKey(entry) {
  return `${entry.releaseNotePriority}\u0000${entry.releaseNoteCategory}`;
}

function groupHeading(key) {
  const [priority, category] = key.split("\u0000");
  return `${priorityLabels.get(priority) ?? priority} · ${categoryLabels.get(category) ?? category}`;
}

function compareGroupKeys(left, right) {
  const [leftPriority, leftCategory] = left.split("\u0000");
  const [rightPriority, rightCategory] = right.split("\u0000");
  const priorityDelta =
    orderIndex(priorityOrder, leftPriority) - orderIndex(priorityOrder, rightPriority);
  if (priorityDelta !== 0) return priorityDelta;
  return orderIndex(categoryOrder, leftCategory) - orderIndex(categoryOrder, rightCategory);
}

function userFacingEntries(entries) {
  return entries
    .filter(
      (entry) =>
        entry.defaultPatchNotes === true &&
        (entry.internalOnly !== true || entry.observableImpact === true),
    )
    .sort(compareEntries);
}

function noteText(entry, bullet) {
  const sanitized = sanitizeUserFacingText(bullet);
  if (sanitized.length > 0) return sanitized;
  return sanitizeUserFacingText(entry.userVisibleSummary ?? "");
}

function groupedBullets(entries) {
  const seen = new Set();
  const groups = new Map();
  for (const entry of userFacingEntries(entries)) {
    for (const bullet of entry.releaseNoteBullets) {
      const text = noteText(entry, bullet);
      if (text.length === 0) continue;
      const normalized = normalizedNote(text);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const key = groupKey(entry);
      const group = groups.get(key) ?? [];
      group.push(text);
      groups.set(key, group);
    }
  }
  return groups;
}

function traceability(entry) {
  const references = new Set([`catalog:${entry.id}`, `review:${entry.review.approvalReference}`]);
  for (const bullet of entry.releaseNoteBullets) {
    for (const reference of extractTraceReferences(bullet)) {
      references.add(`source:${reference}`);
    }
  }
  return [...references].join("; ");
}

function formatList(values) {
  return values.length === 0 ? "none" : values.join(", ");
}

function renderTechnicalEntry(entry) {
  return [
    `- \`${entry.id}\`: ${entry.releaseNotePriority} / ${entry.releaseNoteCategory}; ` +
      `supported from ${entry.supportedFrom.join(", ")}; affected state stores ` +
      `${formatList(entry.affectedStateStores)}; remediation ${entry.remediation}; ` +
      `default patch notes ${entry.defaultPatchNotes ? "yes" : "no"}; ` +
      `traceability ${traceability(entry)}`,
  ];
}

function renderNotes(entries, rootManifest, options) {
  const groups = groupedBullets(entries);
  const lines = [`## Keiko ${rootManifest.version} Release Notes`, ""];

  if (groups.size === 0) {
    lines.push("No user-facing release-impact notes are marked for this release.", "");
  } else {
    for (const [key, bullets] of [...groups.entries()].sort(([left], [right]) =>
      compareGroupKeys(left, right),
    )) {
      lines.push(`### ${groupHeading(key)}`);
      for (const bullet of bullets) lines.push(`- ${bullet}`);
      lines.push("");
    }
  }

  lines.push("<details>");
  lines.push("<summary>Technical release metadata</summary>");
  lines.push("");
  lines.push(`- Package: \`${rootManifest.name}@${rootManifest.version}\``);
  lines.push(`- Release tag: \`v${rootManifest.version}\``);
  lines.push(`- npm dist-tag: \`${options.tag ?? "latest"}\``);
  lines.push(`- Registry: \`${options.registry ?? "https://registry.npmjs.org/"}\``);
  lines.push(`- Generated by: \`npm run release:publish\``);
  lines.push("");
  lines.push("Structured impact entries:");
  for (const entry of entries.sort(compareEntries)) {
    lines.push(...renderTechnicalEntry(entry));
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

export function renderReleaseImpactNotes(catalog, rootManifest, options = {}) {
  const validation = validateReleaseImpactCatalog(catalog, rootManifest, {
    previousCatalog: options.previousCatalog,
  });
  if (!validation.ok) return { failures: validation.failures, notes: "", ok: false };

  const entries = currentReleaseEntries(catalog, rootManifest).filter(
    (entry) => !correctionEntry(entry),
  );
  return { failures: [], notes: renderNotes(entries, rootManifest, options), ok: true };
}

export function renderReleaseImpactNotesFromRoot(root, options = {}) {
  const failures = [];
  const rootManifest = readJson(root, "package.json", failures);
  const catalog = readJson(root, releaseImpactCatalogFile, failures);
  if (rootManifest === undefined || catalog === undefined) {
    return { failures, notes: "", ok: false };
  }
  return renderReleaseImpactNotes(catalog, rootManifest, options);
}
