import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildCodeTaskAcceptanceContribution } from "../lib/code-task-acceptance.mjs";

const { validateCodeTaskAcceptanceContribution } =
  await import("../../packages/keiko-contracts/dist/index.js");

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);
const ALT_DIGEST = "d".repeat(64);
const DESCRIPTOR_PATH = new URL("../../docs/acceptance/code-task-2387.json", import.meta.url);

function scenarioReceipt(scenarioId, digest = DIGEST) {
  return {
    scenarioId,
    outcome: "passed",
    recordedAt: "2026-07-16T12:00:00Z",
    digest,
  };
}

function minimalDescriptor() {
  return {
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
  };
}

describe("buildCodeTaskAcceptanceContribution", () => {
  it("joins descriptor scenarios with their receipts", () => {
    const descriptor = minimalDescriptor();
    const contribution = buildCodeTaskAcceptanceContribution({
      descriptor,
      receipts: [scenarioReceipt("research-skills-child-unit-contracts")],
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      cleanupResidue: false,
    });

    expect(contribution.kind).toBe("code-task-acceptance-contribution");
    expect(contribution.schemaVersion).toBe(1);
    expect(contribution.epicIssue).toBe(2473);
    expect(contribution.childIssue).toBe(2387);
    expect(contribution.sourceCommitSha).toBe(COMMIT_SHA);
    expect(contribution.sourceTreeSha).toBe(TREE_SHA);
    expect(contribution.scenarios[0].outcome).toBe("passed");
    expect(contribution.scenarios[0].recordedAt).toBe("2026-07-16T12:00:00Z");
    expect(contribution.scenarios[0].artifactDigests).toEqual([DIGEST]);
    expect(contribution.scenarios[0].receiptDigest).toEqual({ outcome: "known", value: DIGEST });
    expect(contribution.salvage[0].verifiedAtSha).toBe(COMMIT_SHA);
    expect(contribution.cleanup).toEqual({ state: "complete" });
  });

  it("stamps every salvage row with the source-commit sha", () => {
    const descriptor = {
      ...minimalDescriptor(),
      salvage: [
        {
          sourceBranch: "claude/issue-2387-research-skills",
          sourceSha: COMMIT_SHA,
          path: "packages/keiko-contracts/src/code-task-auxiliary.ts",
          disposition: "taken-verbatim",
          reshaping: { outcome: "absent" },
        },
        {
          sourceBranch: "claude/issue-2387-research-skills",
          sourceSha: COMMIT_SHA,
          path: "packages/keiko-server/src/coding-runtime/researchEgressPort.ts",
          disposition: "reshaped",
          reshaping: { outcome: "known", value: "tightened request binding" },
        },
      ],
    };
    const contribution = buildCodeTaskAcceptanceContribution({
      descriptor,
      receipts: [scenarioReceipt("research-skills-child-unit-contracts")],
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      cleanupResidue: false,
    });

    for (const row of contribution.salvage) {
      expect(row.verifiedAtSha).toBe(COMMIT_SHA);
    }
    expect(contribution.salvage).toHaveLength(2);
  });

  it("throws when the receipts array is empty and any scenario is declared", () => {
    expect(() =>
      buildCodeTaskAcceptanceContribution({
        descriptor: minimalDescriptor(),
        receipts: [],
        sourceCommitSha: COMMIT_SHA,
        sourceTreeSha: TREE_SHA,
        cleanupResidue: false,
      }),
    ).toThrow(/missing receipt for research-skills-child-unit-contracts/);
  });

  it("throws when two receipts share a scenarioId", () => {
    expect(() =>
      buildCodeTaskAcceptanceContribution({
        descriptor: minimalDescriptor(),
        receipts: [
          scenarioReceipt("research-skills-child-unit-contracts"),
          {
            ...scenarioReceipt("research-skills-child-unit-contracts", ALT_DIGEST),
            outcome: "failed",
          },
        ],
        sourceCommitSha: COMMIT_SHA,
        sourceTreeSha: TREE_SHA,
        cleanupResidue: false,
      }),
    ).toThrow(/duplicate receipt for research-skills-child-unit-contracts/);
  });

  it("does not silently drop malformed receipt fields — the contract validator catches them downstream", () => {
    const descriptor = minimalDescriptor();
    const badReceipt = {
      scenarioId: "research-skills-child-unit-contracts",
      outcome: "not-a-real-outcome",
      recordedAt: "yesterday",
      digest: "0",
    };
    const contribution = buildCodeTaskAcceptanceContribution({
      descriptor,
      receipts: [badReceipt],
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      cleanupResidue: false,
    });
    expect(contribution.scenarios[0].outcome).toBe("not-a-real-outcome");
    expect(contribution.scenarios[0].recordedAt).toBe("yesterday");
    expect(contribution.scenarios[0].artifactDigests[0]).toBe("0");
    expect(contribution.scenarios[0].receiptDigest).toEqual({ outcome: "known", value: "0" });
    const validated = validateCodeTaskAcceptanceContribution(contribution);
    expect(validated.ok).toBe(false);
  });

  it("throws when a scenario has no matching receipt", () => {
    const descriptor = {
      ...minimalDescriptor(),
      scenarios: [
        ...minimalDescriptor().scenarios,
        {
          scenarioId: "research-skills-child-owned-journey",
          evidenceClass: "playwright-journey",
          platform: "linux-x64",
        },
      ],
    };
    expect(() =>
      buildCodeTaskAcceptanceContribution({
        descriptor,
        receipts: [scenarioReceipt("research-skills-child-unit-contracts")],
        sourceCommitSha: COMMIT_SHA,
        sourceTreeSha: TREE_SHA,
        cleanupResidue: false,
      }),
    ).toThrow(/missing receipt for research-skills-child-owned-journey/);
  });

  it("carries residue count when the cleanup did not complete", () => {
    const descriptor = minimalDescriptor();
    const contribution = buildCodeTaskAcceptanceContribution({
      descriptor,
      receipts: [scenarioReceipt("research-skills-child-unit-contracts", ALT_DIGEST)],
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      cleanupResidue: true,
    });
    expect(contribution.cleanup).toEqual({ state: "incomplete", residueCount: 1 });
  });

  it("emits a contract-valid payload for the checked-in #2387 descriptor", async () => {
    const descriptor = JSON.parse(await readFile(DESCRIPTOR_PATH, "utf8"));
    const receipts = descriptor.scenarios.map((scenario) => scenarioReceipt(scenario.scenarioId));
    const contribution = buildCodeTaskAcceptanceContribution({
      descriptor,
      receipts,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      cleanupResidue: false,
    });
    const validated = validateCodeTaskAcceptanceContribution(contribution);
    if (!validated.ok) {
      throw new Error(`descriptor projection failed contract: ${validated.errors.join("; ")}`);
    }
    expect(validated.ok).toBe(true);
  });
});
