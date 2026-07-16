import { describe, expect, it } from "vitest";

import {
  CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
  CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
  CODE_TASK_EVIDENCE_CLASSES,
  CODE_TASK_EVIDENCE_PLATFORMS,
  codeTaskAcceptanceQualificationFailures,
  isCodeTaskContentFreeNote,
  isCodeTaskIsoInstant,
  isCodeTaskRepoRelativePath,
  validateCodeTaskAcceptanceContribution,
  type CodeTaskAcceptanceBinding,
  type CodeTaskAcceptanceContributionV1,
} from "./code-task-acceptance.js";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

function validContribution(): CodeTaskAcceptanceContributionV1 {
  const parsed: unknown = JSON.parse(
    JSON.stringify({
      kind: CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND,
      schemaVersion: CODE_TASK_ACCEPTANCE_SCHEMA_VERSION,
      epicIssue: 2384,
      childIssue: 2385,
      sourceCommitSha: COMMIT_SHA,
      sourceTreeSha: TREE_SHA,
      scenarios: [
        {
          scenarioId: "opencode-tracer-edit-verify",
          evidenceClass: "playwright-journey",
          platform: "linux-x64",
          outcome: "passed",
          recordedAt: "2026-07-16T12:00:00Z",
          artifactDigests: [DIGEST],
          receiptDigest: { outcome: "known", value: DIGEST },
        },
      ],
      salvage: [
        {
          sourceBranch: "codex/archive-1982-2376-production-runtime-host",
          sourceSha: COMMIT_SHA,
          path: "packages/keiko-server/src/coding-runtime/productionCodingRuntimeHost.ts",
          disposition: "reshaped",
          reshaping: { outcome: "known", value: "rebound onto the extracted host ports" },
          verifiedAtSha: COMMIT_SHA,
        },
      ],
      knownLimitations: ["packaged-platform activation stays fail-closed"],
      cleanup: { state: "complete" },
    }),
  );
  const result = validateCodeTaskAcceptanceContribution(parsed);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function mutated(patch: Record<string, unknown>): unknown {
  return { ...validContribution(), ...patch };
}

describe("validateCodeTaskAcceptanceContribution", () => {
  it("accepts a complete JSON-round-tripped contribution", () => {
    const result = validateCodeTaskAcceptanceContribution(validContribution());
    expect(result.ok).toBe(true);
  });

  it("rejects non-object payloads", () => {
    for (const value of [undefined, null, "contribution", 7, []]) {
      expect(validateCodeTaskAcceptanceContribution(value).ok).toBe(false);
    }
  });

  it("rejects a wrong kind and a non-literal schema version", () => {
    expect(validateCodeTaskAcceptanceContribution(mutated({ kind: "other" })).ok).toBe(false);
    expect(validateCodeTaskAcceptanceContribution(mutated({ schemaVersion: "1" })).ok).toBe(false);
    expect(validateCodeTaskAcceptanceContribution(mutated({ schemaVersion: 2 })).ok).toBe(false);
  });

  it("rejects malformed issue numbers and git identities", () => {
    for (const patch of [
      { epicIssue: 0 },
      { childIssue: -5 },
      { childIssue: 1.5 },
      { sourceCommitSha: COMMIT_SHA.slice(1) },
      { sourceCommitSha: COMMIT_SHA.toUpperCase() },
      { sourceTreeSha: "not-a-sha" },
    ]) {
      expect(validateCodeTaskAcceptanceContribution(mutated(patch)).ok).toBe(false);
    }
  });

  it("rejects malformed scenarios across the input space", () => {
    const base = validContribution().scenarios[0] as unknown as Record<string, unknown>;
    for (const patch of [
      { scenarioId: "Bad_Upper" },
      { scenarioId: "x" },
      { evidenceClass: "manual-only" },
      { platform: "linux-arm64" },
      { outcome: "skipped" },
      { recordedAt: "2026-07-16 12:00:00" },
      { recordedAt: "2026-13-40T12:00:00Z" },
      { artifactDigests: [DIGEST.slice(2)] },
      { artifactDigests: "none" },
      { receiptDigest: { outcome: "known", value: "short" } },
      { receiptDigest: { outcome: "unknown", value: DIGEST } },
      { receiptDigest: { outcome: "guessed" } },
    ]) {
      const result = validateCodeTaskAcceptanceContribution(
        mutated({ scenarios: [{ ...base, ...patch }] }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects malformed salvage rows", () => {
    const base = validContribution().salvage[0] as unknown as Record<string, unknown>;
    for (const patch of [
      { sourceBranch: "" },
      { sourceBranch: `token ${"x".repeat(10)}` },
      { sourceSha: "zz" },
      { path: "/etc/passwd" },
      { path: "../outside.ts" },
      { path: "a/../../b" },
      { path: "C:\\repo\\file.ts" },
      { disposition: "copied" },
      { reshaping: { outcome: "known", value: "" } },
      { verifiedAtSha: "1234" },
    ]) {
      const result = validateCodeTaskAcceptanceContribution(
        mutated({ salvage: [{ ...base, ...patch }] }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects content-bearing limitation notes and invalid cleanup states", () => {
    for (const patch of [
      { knownLimitations: ["x".repeat(201)] },
      { knownLimitations: ["api_key=abc123"] },
      { knownLimitations: "none" },
      { cleanup: { state: "complete", residueCount: 1 } },
      { cleanup: { state: "incomplete" } },
      { cleanup: { state: "incomplete", residueCount: 0 } },
      { cleanup: { state: "done" } },
    ]) {
      expect(validateCodeTaskAcceptanceContribution(mutated(patch)).ok).toBe(false);
    }
  });

  it("reports every field error instead of stopping at the first", () => {
    const result = validateCodeTaskAcceptanceContribution(
      mutated({ epicIssue: 0, sourceTreeSha: "bad", cleanup: { state: "done" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("codeTaskAcceptanceQualificationFailures", () => {
  const binding: CodeTaskAcceptanceBinding = {
    epicIssue: 2384,
    childIssue: 2385,
    sourceCommitSha: COMMIT_SHA,
    registeredScenarioIds: ["opencode-tracer-edit-verify"],
  };

  it("passes a bound, registered, cleaned contribution", () => {
    expect(codeTaskAcceptanceQualificationFailures(validContribution(), binding)).toEqual([]);
  });

  it("fails an empty contribution", () => {
    const empty = { ...validContribution(), scenarios: [] };
    expect(codeTaskAcceptanceQualificationFailures(empty, binding)).toContain(
      "empty contribution: at least one scenario is required",
    );
  });

  it("fails foreign issue bindings and stale SHA bindings", () => {
    const contribution = validContribution();
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, { ...binding, epicIssue: 1982 }),
    ).toContain("foreign epic issue binding");
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, { ...binding, childIssue: 2386 }),
    ).toContain("foreign child issue binding");
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, {
        ...binding,
        sourceCommitSha: TREE_SHA,
      }),
    ).toContain("stale or foreign source SHA binding");
  });

  it("fails unregistered scenarios and incomplete cleanup", () => {
    const contribution = validContribution();
    expect(
      codeTaskAcceptanceQualificationFailures(contribution, {
        ...binding,
        registeredScenarioIds: [],
      }),
    ).toContain("unregistered scenario: opencode-tracer-edit-verify");
    const incomplete: CodeTaskAcceptanceContributionV1 = {
      ...contribution,
      cleanup: { state: "incomplete", residueCount: 2 },
    };
    expect(codeTaskAcceptanceQualificationFailures(incomplete, binding)).toContain(
      "incomplete cleanup: 2 residues",
    );
  });
});

describe("code task acceptance primitives", () => {
  it("keeps the closed evidence-class and platform registers stable", () => {
    expect(CODE_TASK_EVIDENCE_CLASSES).toContain("production-functional");
    expect(CODE_TASK_EVIDENCE_CLASSES).toContain("packaged-computer-use");
    expect(CODE_TASK_EVIDENCE_PLATFORMS).toEqual([
      "windows-x64",
      "macos-arm64",
      "macos-x64",
      "linux-x64",
    ]);
  });

  it("validates ISO instants strictly", () => {
    expect(isCodeTaskIsoInstant("2026-07-16T12:00:00.123Z")).toBe(true);
    expect(isCodeTaskIsoInstant("2026-07-16T12:00:00+02:00")).toBe(false);
    expect(isCodeTaskIsoInstant("2026-02-30T12:00:00Z")).toBe(false);
  });

  it("rejects hostile paths and content-bearing notes", () => {
    expect(isCodeTaskRepoRelativePath("packages/keiko-contracts/src/index.ts")).toBe(true);
    expect(isCodeTaskRepoRelativePath("/absolute")).toBe(false);
    expect(isCodeTaskRepoRelativePath("nested/..")).toBe(false);
    expect(isCodeTaskContentFreeNote("bounded qualification note")).toBe(true);
    expect(isCodeTaskContentFreeNote("-----BEGIN PRIVATE KEY-----")).toBe(false);
    expect(isCodeTaskContentFreeNote("Bearer abcdef")).toBe(false);
  });
});
