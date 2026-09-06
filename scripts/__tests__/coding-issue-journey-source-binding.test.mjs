import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH,
  CODING_ISSUE_JOURNEY_MANIFEST_PATH,
  CODING_ISSUE_JOURNEY_RECEIPTS_PATH,
  inspectCodingIssueJourneySourceBinding,
} from "../lib/coding-issue-journey-source-binding.mjs";
import { evidenceGateFailures } from "../lib/coding-issue-journey-evidence.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const roots = [];
const gitExecutable = resolveHostExecutable("git");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync(gitExecutable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function descriptor(
  scenarioId = "egress-confinement-macos-arm64",
  flows = [{ flowId: "issue-to-pr-flow-01", ordinal: 1, mode: "governed-assist" }],
) {
  return {
    scenarios: [{ scenarioId, evidenceClass: "production-functional" }],
    flows,
  };
}

function fixture(trustedDescriptor = descriptor()) {
  const root = mkdtempSync(join(tmpdir(), "keiko-3390-source-binding-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=dev");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Qualification Fixture");
  git(root, "config", "commit.gpgsign", "false");
  write(root, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, JSON.stringify(trustedDescriptor));
  write(root, "docs/qa/evidence/coding-issue-journey/3390/rubric.md", "# Frozen rubric\n");
  write(root, "docs/release/1209-perf-evidence.json", '{"measurement":"source"}\n');
  write(root, "docs/release/1209-bundle-evidence.json", '{"bundle":"source"}\n');
  write(root, "packages/keiko-server/src/runtime.ts", "export const runtime = true;\n");
  const sourceCommitSha = commit(root, "freeze qualification source");
  const sourceTreeSha = git(root, "rev-parse", `${sourceCommitSha}^{tree}`);
  return { root, trustedDescriptor, sourceCommitSha, sourceTreeSha };
}

function commitEvidence(input, ids = ["egress-confinement-macos-arm64", "issue-to-pr-flow-01"]) {
  write(input.root, CODING_ISSUE_JOURNEY_MANIFEST_PATH, "{}\n");
  for (const id of ids) {
    write(input.root, `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/${id}.artifact`, "{}\n");
    write(input.root, `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/${id}.receipt.json`, "{}\n");
  }
  return commit(input.root, "land qualification evidence");
}

function replaceWithGitSymlink(root, path, target) {
  git(root, "config", "core.symlinks", "false");
  const oid = execFileSync(gitExecutable, ["hash-object", "-w", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: target,
  }).trim();
  git(root, "update-index", "--add", "--cacheinfo", "120000", oid, path);
  git(root, "commit", "--quiet", "-m", "replace evidence with a git symlink");
  git(root, "reset", "--hard", "--quiet", "HEAD");
}

function inspect(input, overrides = {}) {
  return inspectCodingIssueJourneySourceBinding({
    root: input.root,
    sourceCommitSha: input.sourceCommitSha,
    sourceTreeSha: input.sourceTreeSha,
    landingCommitSha: git(input.root, "rev-parse", "HEAD"),
    manifestPath: join(input.root, CODING_ISSUE_JOURNEY_MANIFEST_PATH),
    receiptsDir: join(input.root, CODING_ISSUE_JOURNEY_RECEIPTS_PATH),
    descriptorPath: join(input.root, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH),
    descriptor: input.trustedDescriptor,
    ...overrides,
  });
}

describe("coding issue journey evidence-only source binding", () => {
  it("accepts an evidence-only descendant that the old exact-HEAD rule rejected", () => {
    const input = fixture();
    const landingCommitSha = commitEvidence(input);
    const landingTreeSha = git(input.root, "rev-parse", `${landingCommitSha}^{tree}`);
    expect(landingCommitSha).not.toBe(input.sourceCommitSha);
    expect(
      evidenceGateFailures({
        manifestValidation: {
          ok: true,
          value: {
            sourceTreeSha: input.sourceTreeSha,
            requiredTools: [],
            scenarios: [],
            flows: [],
          },
        },
        manifestFailures: [],
        headCommitSha: landingCommitSha,
        headTreeSha: landingTreeSha,
        receiptsByScenarioId: new Map(),
        flowReceiptsById: new Map(),
        modelVisibleToolNames: new Set(),
      }),
    ).toContain(
      `manifest is not bound to the qualified head: expected tree ${landingTreeSha}, got ` +
        input.sourceTreeSha,
    );
    expect(inspect(input)).toMatchObject({
      failures: [],
      sourceCommitSha: input.sourceCommitSha,
      sourceTreeSha: input.sourceTreeSha,
      landingCommitSha,
    });
  });

  it("accepts only the two owning-generated D12 evidence documents after source freeze", () => {
    const input = fixture();
    commitEvidence(input);
    write(input.root, "docs/release/1209-perf-evidence.json", '{"measurement":"landing"}\n');
    write(input.root, "docs/release/1209-bundle-evidence.json", '{"bundle":"landing"}\n');
    const landingCommitSha = commit(input.root, "land generated D12 evidence");

    expect(inspect(input)).toMatchObject({ failures: [], landingCommitSha });
  });

  it("allows the registered CI-repair stage for every flow and rejects an unregistered flow", () => {
    const flows = [
      { flowId: "issue-to-pr-flow-01", ordinal: 1, mode: "governed-assist" },
      { flowId: "issue-to-pr-flow-02", ordinal: 2, mode: "supervised-coding" },
      { flowId: "issue-to-pr-flow-03", ordinal: 3, mode: "autonomous-delivery" },
      { flowId: "issue-to-pr-flow-04", ordinal: 4, mode: "governed-assist" },
      { flowId: "issue-to-pr-flow-05", ordinal: 5, mode: "supervised-coding" },
    ];
    const input = fixture(descriptor("ci-repair-loop", flows));
    commitEvidence(input, [
      "ci-repair-loop",
      "issue-to-pr-flow-01",
      "issue-to-pr-flow-02",
      "issue-to-pr-flow-03",
      "issue-to-pr-flow-04",
      "issue-to-pr-flow-05",
      "issue-to-pr-flow-01.ci-repair-loop",
      "issue-to-pr-flow-02.ci-repair-loop",
      "issue-to-pr-flow-03.ci-repair-loop",
      "issue-to-pr-flow-04.ci-repair-loop",
      "issue-to-pr-flow-05.ci-repair-loop",
    ]);
    const registeredPath = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-05.ci-repair-loop.artifact`;
    write(input.root, registeredPath, '{"repaired":true}\n');
    commit(input.root, "land fifth flow CI repair evidence");
    expect(inspect(input).failures).toEqual([]);

    const unregisteredPath = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-06.ci-repair-loop.artifact`;
    write(input.root, unregisteredPath, "{}\n");
    commit(input.root, "forge unregistered flow CI repair evidence");
    expect(inspect(input).failures).toContain(
      `qualification source changed outside evidence outputs: ${unregisteredPath}`,
    );
  });

  it.each([
    ["packages/keiko-server/src/runtime.ts", "export const runtime = false;\n"],
    [CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, JSON.stringify(descriptor("forged-scenario"))],
    ["docs/qa/evidence/coding-issue-journey/3390/rubric.md", "# Changed rubric\n"],
    ["docs/qa/epic-3384-acceptance-evidence-map.md", "forged acceptance\n"],
    ["docs/release/1209-adjacent-evidence.json", "{}\n"],
  ])("rejects a committed source/input/report change at %s", (path, content) => {
    const input = fixture();
    commitEvidence(input);
    write(input.root, path, content);
    commit(input.root, "change frozen input");
    expect(inspect(input).failures).toContain(
      `qualification source changed outside evidence outputs: ${path}`,
    );
  });

  it("rejects a source deletion hidden by a rename into an allowed evidence path", () => {
    const input = fixture();
    commitEvidence(input);
    const sourcePath = "packages/keiko-server/src/runtime.ts";
    const allowedArtifact = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-01.artifact`;
    rmSync(join(input.root, allowedArtifact));
    git(input.root, "mv", sourcePath, allowedArtifact);
    git(input.root, "commit", "--quiet", "-m", "hide source deletion as evidence output");

    expect(git(input.root, "diff", "--name-status", `${input.sourceCommitSha}...HEAD`)).toMatch(
      /^R\d+\s+packages\/keiko-server\/src\/runtime\.ts\s+/mu,
    );
    expect(inspect(input).failures).toContain(
      `qualification source changed outside evidence outputs: ${sourcePath}`,
    );
  });

  it("rejects a source deletion hidden by a rename into a generated D12 evidence path", () => {
    const input = fixture();
    commitEvidence(input);
    const sourcePath = "packages/keiko-server/src/runtime.ts";
    const generatedEvidencePath = "docs/release/1209-perf-evidence.json";
    rmSync(join(input.root, generatedEvidencePath));
    git(input.root, "mv", sourcePath, generatedEvidencePath);
    git(input.root, "commit", "--quiet", "-m", "hide source deletion as D12 evidence");

    expect(inspect(input).failures).toContain(
      `qualification source changed outside evidence outputs: ${sourcePath}`,
    );
  });

  it("rejects uncommitted changes instead of blessing the working tree", () => {
    const input = fixture();
    commitEvidence(input);
    write(input.root, "packages/keiko-server/src/runtime.ts", "export const runtime = false;\n");
    expect(inspect(input).failures).toContain("qualification landing worktree is not clean");
  });

  it("rejects when HEAD moves after the landing identity was captured", () => {
    const input = fixture();
    const capturedLandingCommitSha = commitEvidence(input);
    write(input.root, CODING_ISSUE_JOURNEY_MANIFEST_PATH, '{"new":true}\n');
    commit(input.root, "move landing head after capture");

    expect(inspect(input, { landingCommitSha: capturedLandingCommitSha }).failures).toContain(
      "qualification landing commit is stale",
    );
  });

  it("rejects a clean landing whose allowlisted evidence is a Git symlink", () => {
    const input = fixture();
    commitEvidence(input);
    const path = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-01.artifact`;
    replaceWithGitSymlink(input.root, path, "../../../../../../outside-artifact.json");

    expect(git(input.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(inspect(input).failures).toContain(
      "qualification evidence inputs must be tracked regular Git blobs",
    );
  });

  it("rejects a generated D12 evidence path replaced by a Git symlink", () => {
    const input = fixture();
    commitEvidence(input);
    replaceWithGitSymlink(
      input.root,
      "docs/release/1209-bundle-evidence.json",
      "../../outside-bundle-evidence.json",
    );

    expect(inspect(input).failures).toContain(
      "qualification evidence inputs must be tracked regular Git blobs",
    );
  });

  it("rejects an ignored untracked evidence output even when Git reports a clean landing", () => {
    const input = fixture();
    const ignoredPath = `${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/issue-to-pr-flow-01.artifact`;
    write(input.root, ".gitignore", `${ignoredPath}\n`);
    commit(input.root, "declare ignored evidence output");
    input.sourceCommitSha = git(input.root, "rev-parse", "HEAD");
    input.sourceTreeSha = git(input.root, "rev-parse", "HEAD^{tree}");
    commitEvidence(input);

    expect(git(input.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(inspect(input).failures).toContain(
      "qualification evidence inputs must be tracked regular Git blobs",
    );
  });

  it("rejects a worktree symlink at an evidence file or parent directory", () => {
    const input = fixture();
    commitEvidence(input);
    const artifactPath = join(
      input.root,
      CODING_ISSUE_JOURNEY_RECEIPTS_PATH,
      "issue-to-pr-flow-01.artifact",
    );
    const outsideArtifact = join(input.root, "outside-artifact.json");
    writeFileSync(outsideArtifact, "{}\n");
    rmSync(artifactPath);
    symlinkSync(outsideArtifact, artifactPath);
    expect(inspect(input).failures).toContain(
      "qualification evidence inputs must be canonical regular worktree entries",
    );

    git(input.root, "reset", "--hard", "--quiet", "HEAD");
    rmSync(outsideArtifact);
    const receiptsPath = join(input.root, CODING_ISSUE_JOURNEY_RECEIPTS_PATH);
    const outsideReceipts = join(input.root, "outside-receipts");
    renameSync(receiptsPath, outsideReceipts);
    symlinkSync(outsideReceipts, receiptsPath, "dir");
    expect(inspect(input).failures).toContain(
      "qualification receipts directory must be a canonical worktree directory",
    );
  });

  it("rejects a missing or non-ancestor source without falling back to landing HEAD", () => {
    const input = fixture();
    commitEvidence(input);
    const missingSource = "f".repeat(40);
    expect(
      inspect(input, { sourceCommitSha: missingSource, sourceTreeSha: "e".repeat(40) }).failures,
    ).toContain("qualification source commit is missing, foreign, or not an ancestor");
  });

  it("rejects an existing source commit from a non-ancestor history", () => {
    const input = fixture();
    git(input.root, "checkout", "--quiet", "--orphan", "unrelated");
    git(input.root, "rm", "--quiet", "-rf", ".");
    write(input.root, "unrelated.txt", "unrelated history\n");
    commit(input.root, "unrelated landing");
    expect(inspect(input).failures).toContain(
      "qualification source commit is missing, foreign, or not an ancestor",
    );
  });

  it("rejects a source tree claim that does not match the frozen source commit", () => {
    const input = fixture();
    commitEvidence(input);
    expect(inspect(input, { sourceTreeSha: "e".repeat(40) }).failures).toContain(
      "qualification source tree does not match the frozen source commit",
    );
  });

  it("rejects unsafe descriptor ids and noncanonical output paths", () => {
    const input = fixture();
    commitEvidence(input);
    const result = inspect(input, {
      descriptor: descriptor("../forged"),
      manifestPath: join(input.root, "forged-manifest.json"),
    });
    expect(result.failures).toContain("qualification descriptor contains an unsafe evidence id");
    expect(result.failures).toContain("qualification manifest path is not canonical");
  });
});
