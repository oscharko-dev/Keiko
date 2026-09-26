// End-to-end test of the CLI wrapper itself (scripts/generate-code-task-acceptance.mjs): the
// pure projection is unit-tested in code-task-acceptance.test.mjs, but the wrapper's own
// argument handling, JSON reads, contract validation, and output write ran in no suite. The
// script executes at module top level, so each case imports it with a fresh cache-busting query
// and a prepared process.argv.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_URL = pathToFileURL(
  join(process.cwd(), "scripts", "generate-code-task-acceptance.mjs"),
).href;
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

const roots = [];
const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stageInputs() {
  const root = mkdtempSync(join(tmpdir(), "keiko-acceptance-cli-"));
  roots.push(root);
  const descriptorPath = join(root, "descriptor.json");
  const receiptsPath = join(root, "receipts.json");
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      epicIssue: 2473,
      childIssue: 2387,
      scenarios: [
        {
          scenarioId: "research-skills-child-unit-contracts",
          evidenceClass: "unit-contract",
          platform: "linux-x64",
        },
      ],
      salvage: [
        {
          sourceBranch: "claude/issue-2387-research-skills",
          sourceSha: COMMIT_SHA,
          path: "packages/keiko-contracts/src/code-task-auxiliary.ts",
          disposition: "taken-verbatim",
          reshaping: { outcome: "absent" },
        },
      ],
      knownLimitations: [],
    }),
    "utf8",
  );
  writeFileSync(
    receiptsPath,
    JSON.stringify([
      {
        scenarioId: "research-skills-child-unit-contracts",
        outcome: "passed",
        recordedAt: "2026-07-16T12:00:00Z",
        digest: DIGEST,
      },
    ]),
    "utf8",
  );
  return { root, descriptorPath, receiptsPath };
}

describe("generate-code-task-acceptance CLI", () => {
  it("reads descriptor and receipts, validates, and writes the contribution", async () => {
    const { root, descriptorPath, receiptsPath } = stageInputs();
    const outputPath = join(root, "contribution.json");
    process.argv = [
      process.execPath,
      "generate-code-task-acceptance.mjs",
      "--descriptor",
      descriptorPath,
      "--receipts",
      receiptsPath,
      "--commit",
      COMMIT_SHA,
      "--tree",
      TREE_SHA,
      "--cleanup-root",
      join(root, "absent-cleanup"),
      "--output",
      outputPath,
    ];
    await import(`${SCRIPT_URL}?case=happy`);
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(written.sourceCommitSha).toBe(COMMIT_SHA);
    expect(written.scenarios).toHaveLength(1);
    expect(written.scenarios[0].outcome).toBe("passed");
  });

  it("fails loudly when a required argument is missing", async () => {
    process.argv = [process.execPath, "generate-code-task-acceptance.mjs"];
    await expect(import(`${SCRIPT_URL}?case=missing`)).rejects.toThrow(/missing --descriptor/u);
  });
});
