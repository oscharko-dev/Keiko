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
const unsafePublicContentPatterns = [
  {
    label: "absolute local filesystem path",
    patterns: [
      /(?:^|[\s(["'`])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\|\\\\[A-Za-z0-9_.-]+\\)/u,
    ],
  },
  {
    label: "secret-like token",
    patterns: [
      /\bsk-[\w-]{8,}\b/u,
      /\bghp_\w{12,}\b/u,
      /\bgithub_pat_\w{12,}\b/u,
      /\bnpm_\w{12,}\b/u,
      /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
      /\bAKIA[0-9A-Z]{16}\b/u,
    ],
  },
  {
    label: "private key material",
    patterns: [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  },
];

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

// Whitespace runs around the "(#123)" marker are bounded (rather than left unbounded with
// `\s*`) so a long non-matching run of whitespace cannot force quadratic backtracking (S8786);
// 64 characters comfortably exceeds any whitespace run that occurs in authored release-note
// text. This bound never loses information even for longer runs: any leftover whitespace it
// doesn't reach is still fully collapsed by the unconditional `\s{2,}` step immediately below
// (that step has no trailing required literal, so it cannot backtrack superlinearly regardless
// of run length -- it is the same non-lossy, non-backtracking shape as `\s+` in normalizedNote).
const MAX_SANITIZED_WHITESPACE_RUN = 64;

function sanitizeUserFacingText(value) {
  // Order matters here: the general whitespace collapse runs BEFORE the punctuation-adjacent
  // trims, so by the time those trims run, no gap can be more than a single leftover space --
  // which lets them use a tiny, genuinely non-lossy `\s?` bound instead of a large-but-still-
  // finite one. (An earlier version bounded them directly to `\s{1,64}` and ran the collapse
  // afterward; for a whitespace run longer than 64 characters immediately before a mid-string
  // `,`/`.`/`;`/`:`, that bounded regex could only reach the last 64 characters of the run,
  // leaving a residual space that the later collapse shrank to `' '` instead of removing --
  // e.g. `"Alpha" + " ".repeat(200) + "; Beta"` produced `"Alpha ; Beta"` instead of
  // `"Alpha; Beta"`. Collapsing first removes that failure mode entirely, for any run length.)
  return value
    .replace(/https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/giu, "")
    .replace(/\b(?:issues?|prs?|pull requests?)\s*#\d+\b/giu, "")
    .replace(
      new RegExp(
        String.raw`\s{0,${MAX_SANITIZED_WHITESPACE_RUN}}\(#\d+\)\s{0,${MAX_SANITIZED_WHITESPACE_RUN}}`,
        "gu",
      ),
      " ",
    )
    .replace(/#\d+\b/gu, "")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s?([,.;:])/gu, "$1")
    .trim()
    .replace(/\s?([.!?])$/u, "$1");
}

const TRACE_REFERENCE_PATTERNS = [
  /https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/giu,
  /\b(?:issues?|prs?|pull requests?)\s*#\d+\b/giu,
  /#\d+\b/gu,
];

function extractTraceReferences(value) {
  const matches = TRACE_REFERENCE_PATTERNS.flatMap((pattern) =>
    [...value.matchAll(pattern)].map((match) => ({
      end: (match.index ?? 0) + match[0].length,
      reference: match[0].trim(),
      start: match.index ?? 0,
    })),
  ).sort((left, right) => left.start - right.start || right.end - left.end);
  const references = new Set();
  let consumedUntil = 0;
  for (const match of matches) {
    if (match.start < consumedUntil) continue;
    references.add(match.reference);
    consumedUntil = match.end;
  }
  return [...references];
}

// Stable versions publish under latest; prerelease versions (semver with a prerelease
// suffix) publish under beta, so their notes come from the beta catalog entry.
function expectedDistTagForVersion(version) {
  return typeof version === "string" && version.includes("-") ? "beta" : "latest";
}

function currentReleaseEntries(catalog, rootManifest) {
  return catalog.entries.filter(
    (entry) =>
      objectRecord(entry) &&
      entry.packageName === rootManifest.name &&
      entry.packageVersion === rootManifest.version &&
      entry.distTag === expectedDistTagForVersion(rootManifest.version),
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

function publicTechnicalEntries(entries) {
  return userFacingEntries(entries);
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

function addGroupedBullet(groups, key, text) {
  const group = groups.get(key) ?? [];
  if (!group.some((bullet) => normalizedNote(bullet) === normalizedNote(text))) {
    group.push(text);
  }
  groups.set(key, group);
}

function addPortableReleasePromotion(groups, options) {
  if (options.portableReleasePromotion !== true) return;
  addGroupedBullet(
    groups,
    "normal\u0000new-additions",
    "Keiko now ships first-class portable downloads for Windows x64, macOS arm64, and macOS x64 so users can download once and start from the bundled launcher; npm remains available for developer and compatibility workflows.",
  );
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
  addPortableReleasePromotion(groups, options);
  const technicalEntries = publicTechnicalEntries(entries);
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

  lines.push(
    "<details>",
    "<summary>Technical release metadata</summary>",
    "",
    `- Package: \`${rootManifest.name}@${rootManifest.version}\``,
    `- Release tag: \`v${rootManifest.version}\``,
    `- npm dist-tag: \`${options.tag ?? "latest"}\``,
    `- Registry: \`${options.registry ?? "https://registry.npmjs.org/"}\``,
    `- Generated by: \`npm run release:publish\``,
    "",
    "Structured impact entries:",
  );
  for (const entry of technicalEntries) {
    lines.push(...renderTechnicalEntry(entry));
  }
  lines.push("", "</details>");
  return lines.join("\n");
}

function publicContentFailures(notes) {
  const failures = [];
  for (const { label, patterns } of unsafePublicContentPatterns) {
    if (patterns.some((pattern) => pattern.test(notes))) {
      failures.push(`release-impact: generated release notes contain ${label}.`);
    }
  }
  return failures;
}

export function renderReleaseImpactNotes(catalog, rootManifest, options = {}) {
  const validation = validateReleaseImpactCatalog(catalog, rootManifest, {
    previousCatalog: options.previousCatalog,
  });
  if (!validation.ok) return { failures: validation.failures, notes: "", ok: false };

  const entries = currentReleaseEntries(catalog, rootManifest).filter(
    (entry) => !correctionEntry(entry),
  );
  const notes = renderNotes(entries, rootManifest, options);
  const failures = publicContentFailures(notes);
  if (failures.length > 0) return { failures, notes: "", ok: false };
  return { failures: [], notes, ok: true };
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
