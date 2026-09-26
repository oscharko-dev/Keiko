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

export const UPDATE_UI_SOURCE_PATHS = Object.freeze([
  "packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNotice.tsx",
  "packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx",
  "packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.module.css",
  "packages/keiko-ui/src/app/components/desktop/update/update-copy.ts",
  "packages/keiko-ui/src/app/globals.css",
  "packages/keiko-ui/src/lib/api.ts",
  "packages/keiko-ui/src/lib/i18n-messages.de.ts",
  "packages/keiko-ui/src/lib/i18n-messages.en.ts",
]);

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
    sourceSha256: measure(UPDATE_UI_SOURCE_PATHS),
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

export function checkUpdateUiEvidence(repoRoot = process.cwd()) {
  const expected = measureUpdateUiEvidenceInputs(repoRoot);
  for (const name of EVIDENCE_RECORDS) {
    const record = parseEvidenceRecord(repoRoot, name);
    assertDigestMap(name, "sourceSha256", record.sourceSha256, expected.sourceSha256);
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
