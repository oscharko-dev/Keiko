import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  loadBaseTrustAnchors,
  loadReviewerPolicySources,
  loadReviewerPreflightSources,
  main,
  MAX_CONFIG_BYTES,
  MAX_EVENT_BYTES,
  preflightMain,
  REQUIRED_CONTROL_PATHS,
  TRUST_ANCHOR_PATHS,
  validateReviewerPolicy,
  validateReviewerPreflight,
} from "../check-reviewer-policy.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const TREE_SHA = "d".repeat(40);

function readRepositoryFile(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function trustedSources() {
  const trustedCodeRabbit = readRepositoryFile(".coderabbit.yaml");
  const trustedGreptileConfig = readRepositoryFile(".greptile/config.json");
  const trustedGreptileFiles = readRepositoryFile(".greptile/files.json");
  return { trustedCodeRabbit, trustedGreptileConfig, trustedGreptileFiles };
}

function regularBlob(path, overrides = {}) {
  return { mode: "100644", path, sha: "c".repeat(40), size: 128, type: "blob", ...overrides };
}

function trustedAnchors() {
  return new Map(
    TRUST_ANCHOR_PATHS.map((path) => [
      path,
      path === ".github/workflows"
        ? { mode: "040000", sha: "e".repeat(40), type: "tree" }
        : { mode: "100644", sha: "f".repeat(40), type: "blob" },
    ]),
  );
}

function candidateTree(trustedGreptileFiles, anchors, overrides = {}) {
  const governancePaths = JSON.parse(trustedGreptileFiles).files.map((entry) => entry.path);
  const entries = new Map();
  for (const path of [...REQUIRED_CONTROL_PATHS, ...governancePaths]) {
    entries.set(path, regularBlob(path));
  }
  for (const [path, anchor] of anchors) {
    entries.set(path, regularBlob(path, anchor));
  }
  return JSON.stringify({
    sha: TREE_SHA,
    tree: [
      { mode: "040000", path: ".greptile", sha: "e".repeat(40), type: "tree" },
      ...entries.values(),
    ],
    truncated: false,
    ...overrides,
  });
}

function githubEvent(overrides = {}) {
  return JSON.stringify({
    pull_request: {
      base: { ref: "dev", sha: BASE_SHA },
      body: "Normal quality-gate change",
      head: { sha: HEAD_SHA },
      title: "Harden reviewer policy",
      ...overrides,
    },
  });
}

function validSources(overrides = {}) {
  const trusted = trustedSources();
  const anchors = trustedAnchors();
  return {
    baseSha: BASE_SHA,
    candidateCommit: JSON.stringify({ sha: HEAD_SHA, tree: { sha: TREE_SHA } }),
    candidateHead: HEAD_SHA,
    candidateTree: candidateTree(trusted.trustedGreptileFiles, anchors),
    codeRabbit: trusted.trustedCodeRabbit,
    githubEvent: githubEvent(),
    greptileConfig: trusted.trustedGreptileConfig,
    greptileFiles: trusted.trustedGreptileFiles,
    trustedAnchors: anchors,
    ...trusted,
    ...overrides,
  };
}

function writeCandidateFile(directory, name, source) {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function exactOverLimitEvent() {
  const marker = "__BODY__";
  const template = githubEvent({ body: marker });
  const fixedBytes = Buffer.byteLength(template, "utf8") - marker.length;
  return template.replace(marker, "n".repeat(MAX_EVENT_BYTES + 1 - fixedBytes));
}

function createBaseAnchorRepository() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-base-trust-anchors-"));
  onTestFinished(() => rmSync(directory, { force: true, recursive: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  for (const path of TRUST_ANCHOR_PATHS) {
    const filePath = path === ".github/workflows" ? `${path}/codspeed-policy.yml` : path;
    writeCandidateFile(directory, filePath, `${filePath}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Keiko Test",
      "-c",
      "user.email=keiko-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "test: create base anchors",
    ],
    { cwd: directory },
  );
  return directory;
}

describe("base-trusted reviewer policy", () => {
  it("loads every execution anchor from the protected base commit", () => {
    const anchors = loadBaseTrustAnchors(createBaseAnchorRepository());
    expect([...anchors.keys()].sort()).toEqual([...TRUST_ANCHOR_PATHS].sort());
    expect(anchors.get(".github/workflows")).toMatchObject({ mode: "040000", type: "tree" });
    expect(anchors.get("scripts/check-reviewer-policy.mjs")).toMatchObject({
      mode: "100644",
      type: "blob",
    });
  });

  it("fails closed with a static error when protected-base anchors are incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-incomplete-base-trust-anchors-"));
    onTestFinished(() => rmSync(directory, { force: true, recursive: true }));
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    expect(() => loadBaseTrustAnchors(directory)).toThrow(
      "protected-base trust anchors are unavailable",
    );
  });

  it("accepts exact-head policy data that matches protected-base approvals", () => {
    expect(validateReviewerPolicy(validSources())).toEqual([]);
  });

  it("accepts the same bounded inputs in the pre-download preflight", async () => {
    const source = validSources();
    expect(validateReviewerPreflight(source)).toEqual([]);
    const log = vi.fn();
    const error = vi.fn();
    await expect(preflightMain(source, log, error)).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a PR that changes both reviewer config and its candidate validator", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-candidate-reviewer-policy-"));
    onTestFinished(() => rmSync(directory, { force: true, recursive: true }));
    const sources = validSources();
    const marker = join(directory, "candidate-validator-executed");
    writeCandidateFile(
      directory,
      "scripts/check-reviewer-policy.mjs",
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`,
    );
    const tree = JSON.parse(sources.candidateTree);
    tree.tree.find((entry) => entry.path === "scripts/check-reviewer-policy.mjs").sha = "1".repeat(
      40,
    );
    const env = {
      GITHUB_EVENT_PATH: writeCandidateFile(directory, "event.json", sources.githubEvent),
      QUALITY_BASE_SHA: BASE_SHA,
      QUALITY_CODERABBIT_PATH: writeCandidateFile(
        directory,
        "coderabbit.yaml",
        sources.codeRabbit.replace("enabled: true", "enabled: false"),
      ),
      QUALITY_GREPTILE_CONFIG_PATH: writeCandidateFile(
        directory,
        "greptile-config.json",
        sources.greptileConfig,
      ),
      QUALITY_GREPTILE_FILES_PATH: writeCandidateFile(
        directory,
        "greptile-files.json",
        sources.greptileFiles,
      ),
      QUALITY_HEAD_SHA: HEAD_SHA,
      QUALITY_REVIEWER_COMMIT_PATH: writeCandidateFile(
        directory,
        "commit.json",
        sources.candidateCommit,
      ),
      QUALITY_REVIEWER_TREE_PATH: writeCandidateFile(directory, "tree.json", JSON.stringify(tree)),
    };
    const loaded = loadReviewerPolicySources(env, () => sources.trustedAnchors);
    const log = vi.fn();
    const error = vi.fn();

    await expect(main(loaded, log, error)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "reviewer-policy: FAIL — candidate codeRabbit policy differs from the protected-base approval",
    );
    expect(existsSync(marker)).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    { body: "@coderabbitai ignore", title: "Normal title" },
    { body: "@greptileai pause", title: "Normal title" },
    { body: "Normal body", title: "@CodeRabbitAI resolve" },
  ])("rejects suppressive exact-head metadata without reflecting it", (metadata) => {
    const source = validSources({ githubEvent: githubEvent(metadata) });
    const problems = validateReviewerPolicy(source);
    expect(problems).toContain("pull-request metadata must not suppress an automatic review bot");
    expect(problems.join("\n")).not.toContain(metadata.body);
    expect(problems.join("\n")).not.toContain(metadata.title);
  });

  it("fails closed when event, base, or head binding is invalid", () => {
    const source = validSources({
      baseSha: "not-a-sha",
      candidateHead: "d".repeat(40),
      githubEvent: githubEvent({ body: [], title: 42 }),
    });
    expect(validateReviewerPolicy(source)).toEqual(
      expect.arrayContaining([
        "pull-request title must be text when present",
        "pull-request body must be text when present",
        "candidate policy data is not bound to the exact pull-request head",
        "reviewer policy execution is not bound to the protected base",
        "candidate tree is not bound to the exact pull-request head",
      ]),
    );
  });

  it("rejects pull requests that do not target dev", () => {
    const source = validSources({
      githubEvent: githubEvent({ base: { ref: "main", sha: BASE_SHA } }),
    });
    expect(validateReviewerPreflight(source)).toContain(
      "reviewer policy applies only to pull requests targeting dev",
    );
  });

  it("rejects a tree that is not the tree named by the exact-head commit", () => {
    const source = validSources({
      candidateCommit: JSON.stringify({ sha: HEAD_SHA, tree: { sha: "f".repeat(40) } }),
    });
    expect(validateReviewerPolicy(source)).toContain(
      "candidate tree is not bound to the exact pull-request head",
    );
  });

  it("rejects truncated, malformed, nested, or non-regular candidate-tree controls", () => {
    const source = validSources();
    const parsedTree = JSON.parse(source.candidateTree);
    const governancePath = JSON.parse(source.trustedGreptileFiles).files[0].path;
    parsedTree.tree.find((entry) => entry.path === governancePath).mode = "120000";
    parsedTree.tree.find((entry) => entry.path === ".greptile").mode = "100644";
    parsedTree.tree.push(regularBlob("packages/example/.greptile/rules.md"));
    parsedTree.tree.push(null);
    const problems = validateReviewerPolicy({
      ...source,
      candidateTree: JSON.stringify(parsedTree),
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "candidate tree contains an invalid entry",
        "candidate tree contains an unapproved reviewer control",
        "candidate reviewer policy or governance inventory is not a regular blob",
      ]),
    );

    expect(
      validateReviewerPolicy({
        ...source,
        candidateTree: candidateTree(source.trustedGreptileFiles, source.trustedAnchors, {
          truncated: true,
        }),
      }),
    ).toContain("candidate tree inventory is incomplete");
  });

  it("rejects duplicate or missing exact-head governance paths", () => {
    const source = validSources();
    const parsedTree = JSON.parse(source.candidateTree);
    const missing = JSON.parse(source.trustedGreptileFiles).files[0].path;
    parsedTree.tree = parsedTree.tree.filter((entry) => entry.path !== missing);
    parsedTree.tree.push(parsedTree.tree[0]);
    expect(
      validateReviewerPolicy({ ...source, candidateTree: JSON.stringify(parsedTree) }),
    ).toEqual(
      expect.arrayContaining([
        "candidate tree contains an invalid or duplicate path",
        "candidate reviewer policy or governance inventory is not a regular blob",
      ]),
    );
  });

  it.each([...REQUIRED_CONTROL_PATHS])(
    "rejects oversized or non-regular preflight data at %s",
    (path) => {
      const source = validSources();
      const parsedTree = JSON.parse(source.candidateTree);
      const entry = parsedTree.tree.find((candidate) => candidate.path === path);
      entry.mode = "120000";
      entry.size = MAX_CONFIG_BYTES + 1;
      expect(
        validateReviewerPreflight({ ...source, candidateTree: JSON.stringify(parsedTree) }),
      ).toEqual(
        expect.arrayContaining([
          "candidate reviewer policy or governance inventory is not a regular blob",
          "candidate quality-control data exceeds its size limit",
        ]),
      );
    },
  );

  it("rejects a non-integer control size before raw policy download", () => {
    const source = validSources();
    const parsedTree = JSON.parse(source.candidateTree);
    parsedTree.tree.find((entry) => entry.path === ".codspeed-policy.json").size = 1.5;
    expect(
      validateReviewerPreflight({ ...source, candidateTree: JSON.stringify(parsedTree) }),
    ).toContain("candidate quality-control data exceeds its size limit");
  });

  it.each(TRUST_ANCHOR_PATHS)("rejects self-amendment of execution anchor %s", (path) => {
    const source = validSources();
    const parsedTree = JSON.parse(source.candidateTree);
    parsedTree.tree.find((entry) => entry.path === path).sha = "1".repeat(40);
    expect(
      validateReviewerPreflight({ ...source, candidateTree: JSON.stringify(parsedTree) }),
    ).toContain("candidate tree changes a protected-base execution anchor");
  });

  it("rejects a changed workflow tree before a duplicate required-context producer can run", () => {
    const source = validSources();
    const parsedTree = JSON.parse(source.candidateTree);
    parsedTree.tree.find((entry) => entry.path === ".github/workflows").sha = "2".repeat(40);
    expect(
      validateReviewerPreflight({ ...source, candidateTree: JSON.stringify(parsedTree) }),
    ).toContain("candidate tree changes a protected-base execution anchor");
  });

  it("redacts sensitive loader paths and rejects valid JSON at MAX_EVENT_BYTES plus one", () => {
    const secretPath = "/private/customer/acme-super-secret-event.json";
    expect(() =>
      loadReviewerPreflightSources({ QUALITY_REVIEWER_COMMIT_PATH: secretPath }, trustedAnchors),
    ).toThrow("candidate commit is unavailable or exceeds its size limit");
    try {
      loadReviewerPreflightSources({ QUALITY_REVIEWER_COMMIT_PATH: secretPath }, trustedAnchors);
    } catch (error) {
      expect(String(error)).not.toContain(secretPath);
    }

    const directory = mkdtempSync(join(tmpdir(), "keiko-reviewer-event-bound-"));
    onTestFinished(() => rmSync(directory, { force: true, recursive: true }));
    const source = validSources();
    const oversizedEvent = exactOverLimitEvent();
    expect(Buffer.byteLength(oversizedEvent, "utf8")).toBe(MAX_EVENT_BYTES + 1);
    expect(() => JSON.parse(oversizedEvent)).not.toThrow();
    const env = {
      GITHUB_EVENT_PATH: writeCandidateFile(directory, "event.json", oversizedEvent),
      QUALITY_BASE_SHA: BASE_SHA,
      QUALITY_HEAD_SHA: HEAD_SHA,
      QUALITY_REVIEWER_COMMIT_PATH: writeCandidateFile(
        directory,
        "commit.json",
        source.candidateCommit,
      ),
      QUALITY_REVIEWER_TREE_PATH: writeCandidateFile(directory, "tree.json", source.candidateTree),
    };
    expect(() => loadReviewerPreflightSources(env, trustedAnchors)).toThrow(
      "GitHub event is unavailable or exceeds its size limit",
    );
  });

  it("rejects malformed base inventory and unapproved Greptile policy data", () => {
    const source = validSources({
      greptileConfig: "{}",
      trustedGreptileFiles: "{}",
    });
    expect(validateReviewerPolicy(source)).toEqual(
      expect.arrayContaining([
        "candidate greptileConfig policy differs from the protected-base approval",
        "protected-base greptileFiles policy is not approved",
        "protected-base Greptile inventory is invalid",
      ]),
    );
  });

  it("returns only redacted CLI diagnostics", async () => {
    const secret = "untrusted-private-metadata";
    const source = validSources({ githubEvent: `{${secret}` });
    const log = vi.fn();
    const error = vi.fn();
    await expect(main(source, log, error)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "reviewer-policy: FAIL — GitHub event must contain a JSON object",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});
