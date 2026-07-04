#!/usr/bin/env node
// ADR registry integrity gate (GEN-DOC-ADR-002 / GEN-DOC-ADR-005, Step 10).
//
// Enforces three invariants over docs/adr so bare "ADR-NNNN" citations across the
// codebase resolve unambiguously and the decision index stays trustworthy:
//   1. UNIQUE NUMBERING  — no ADR number is claimed by more than one file.
//   2. INDEX COMPLETENESS — every on-disk ADR file is linked from docs/adr/README.md.
//   3. NO ORPHAN LINKS    — every ADR file referenced by README.md exists on disk.
//
// Exit code 0 when all invariants hold, 1 (with a report) otherwise. Designed to FAIL on
// the pre-Step-10 tree (duplicate 0058-0069 numbering + unindexed ADRs) and pass once the
// numbering collision is resolved and the index is complete.
//
// Exported as `checkAdrRegistry(adrDir)` so scripts/__tests__ can drive it over fixtures.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADR_FILE = /^ADR-(\d{4})-.*\.md$/;

/** ADR files that are deliberately not part of the reviewer decision index. Keep empty
 *  unless a specific ADR is intentionally excluded — an entry here is an explicit waiver. */
const INDEX_EXCLUSIONS = new Set();

// 1. unique numbering — no ADR number is claimed by more than one file.
function duplicateNumberProblems(files) {
  const byNumber = new Map();
  for (const name of files) {
    const num = ADR_FILE.exec(name)[1];
    byNumber.set(num, [...(byNumber.get(num) ?? []), name]);
  }
  return [...byNumber.entries()]
    .sort()
    .filter(([, names]) => names.length > 1)
    .map(
      ([num, names]) =>
        `ADR-${num} is claimed by ${names.length} files: ${names.sort().join(", ")}`,
    );
}

// Parse the ADR file names README.md links to.
function readmeLinkTargets(adrDir) {
  const readme = readFileSync(join(adrDir, "README.md"), "utf8");
  const linkTarget = /\]\((?:\.\/)?(ADR-\d{4}-[^)]*\.md)(?:#[^)]*)?\)/g;
  return new Set([...readme.matchAll(linkTarget)].map((m) => m[1]));
}

/**
 * Validate the ADR registry rooted at `adrDir` (which must contain a README.md index).
 * Returns the list of human-readable problems; an empty list means the registry is valid.
 */
export function checkAdrRegistry(adrDir) {
  const files = readdirSync(adrDir)
    .filter((name) => ADR_FILE.test(name))
    .sort();
  if (files.length === 0) {
    return ["No ADR files found — wrong path or empty registry."];
  }

  const linkedFiles = readmeLinkTargets(adrDir);
  const onDisk = new Set(files);

  return [
    ...duplicateNumberProblems(files),
    // 2. index completeness — every on-disk ADR file must be linked.
    ...files
      .filter((name) => !INDEX_EXCLUSIONS.has(name) && !linkedFiles.has(name))
      .map((name) => `ADR file not indexed in docs/adr/README.md: ${name}`),
    // 3. no orphan links — every README ADR link must resolve to an existing file.
    ...[...linkedFiles]
      .sort()
      .filter((target) => !onDisk.has(target))
      .map((target) => `docs/adr/README.md links a missing ADR file: ${target}`),
  ];
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  const adrDir = join(repoRoot, "docs", "adr");
  const problems = checkAdrRegistry(adrDir);
  if (problems.length > 0) {
    console.error("check:adr-index FAILED\n");
    for (const line of problems) console.error("  - " + line);
    console.error(
      `\n${problems.length} ADR registry problem(s). Fix docs/adr numbering/index and re-run.`,
    );
    process.exit(1);
  }
  const numbers = new Set(
    readdirSync(adrDir)
      .filter((name) => ADR_FILE.test(name))
      .map((name) => ADR_FILE.exec(name)[1]),
  );
  console.log(
    `check:adr-index OK — ${numbers.size} unique ADR numbers, all indexed, no orphan links.`,
  );
}

// Run as a CLI unless imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
