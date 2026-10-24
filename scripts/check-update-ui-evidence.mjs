import updateUiSourcePaths from "./lib/update-ui-evidence-sources.json" with { type: "json" };
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EVIDENCE_DIRECTORY = "docs/design-system/evidence/3405";
const EVIDENCE_RECORDS = [
  "manifest.json",
  "a11y-proof.json",
  "update-experience-fidelity-proof.json",
];

export const UPDATE_UI_SOURCE_PATHS = Object.freeze(updateUiSourcePaths);

export const UPDATE_UI_HARNESS_PATHS = Object.freeze([
  "tests/e2e/config/playwright.issue-1696-update-ui.config.ts",
  "tests/e2e/fixtures/keiko.e2e.config.json",
  "tests/e2e/support/evidence.ts",
  "tests/e2e/support/update-bff-outage-3405.mjs",
]);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function measureUpdateUiEvidenceInputs(repoRoot) {
  const measure = (paths) =>
    Object.fromEntries(paths.map((path) => [path, sha256File(resolve(repoRoot, path))]));
  return {
    sourceProvenanceVersion: 2,
    sourceFiles: Object.entries(measure(UPDATE_UI_SOURCE_PATHS)).map(([path, sha256]) => ({
      path,
      sha256,
    })),
    harnessProvenanceSha256: measure(UPDATE_UI_HARNESS_PATHS),
  };
}

function parseEvidenceRecord(repoRoot, name) {
  const path = resolve(repoRoot, EVIDENCE_DIRECTORY, name);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Updater UI evidence record ${name} is unreadable.`, { cause: error });
  }
}

function assertDigestMap(recordName, fieldName, actual, expected) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`Updater UI evidence ${recordName} has an invalid ${fieldName} map.`);
  }
  const actualPaths = Object.keys(actual).sort((left, right) => left.localeCompare(right, "en-US"));
  const expectedPaths = Object.keys(expected).sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Updater UI evidence ${recordName} has an unexpected ${fieldName} path set.`);
  }
  for (const path of expectedPaths) {
    if (actual[path] !== expected[path]) {
      throw new Error(
        `Updater UI evidence ${recordName} has a stale ${fieldName} digest for ${path}.`,
      );
    }
  }
}

function isSourceDigestRow(row) {
  return (
    row !== null &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    Object.keys(row).length === 2 &&
    typeof row.path === "string" &&
    typeof row.sha256 === "string"
  );
}
function sourceDigestMap(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Updater UI evidence has invalid sourceFiles");
  const seen = new Set();
  for (const row of rows) {
    if (!isSourceDigestRow(row))
      throw new TypeError("Updater UI evidence has an invalid sourceFiles entry");
    if (seen.has(row.path)) throw new Error("Updater UI evidence has a duplicate sourceFiles path");
    seen.add(row.path);
  }
  return Object.fromEntries(rows.map(({ path, sha256 }) => [path, sha256]));
}

export function checkUpdateUiEvidence(repoRoot = process.cwd()) {
  const expected = measureUpdateUiEvidenceInputs(repoRoot);
  for (const name of EVIDENCE_RECORDS) {
    const record = parseEvidenceRecord(repoRoot, name);
    if (record.sourceProvenanceVersion !== 2)
      throw new Error("Updater UI evidence has an unsupported source provenance version");
    assertDigestMap(
      name,
      "sourceFiles",
      sourceDigestMap(record.sourceFiles),
      sourceDigestMap(expected.sourceFiles),
    );
    assertDigestMap(
      name,
      "harnessProvenanceSha256",
      record.harnessProvenanceSha256,
      expected.harnessProvenanceSha256,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  checkUpdateUiEvidence();
  console.log("Updater UI evidence freshness: PASS");
}
