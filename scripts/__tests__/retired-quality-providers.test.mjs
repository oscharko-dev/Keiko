import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PERFORMANCE_PROVIDER = ["cod", "speed"].join("");
const REVIEW_PROVIDER = ["grep", "tile"].join("");
const RETIRED_PROVIDER_NAME_PATTERN = new RegExp(
  `${PERFORMANCE_PROVIDER}|${REVIEW_PROVIDER}`,
  "iu",
);
const RETIRED_PATHS = [
  `.${PERFORMANCE_PROVIDER}-policy.json`,
  `.github/workflows/${PERFORMANCE_PROVIDER}-policy.yml`,
  `.github/workflows/${PERFORMANCE_PROVIDER}.yml`,
  `.${REVIEW_PROVIDER}/config.json`,
  `.${REVIEW_PROVIDER}/files.json`,
  `benchmarks/${PERFORMANCE_PROVIDER}.mjs`,
  `${PERFORMANCE_PROVIDER}.yml`,
  `scripts/__tests__/check-${PERFORMANCE_PROVIDER}-policy.test.mjs`,
  "scripts/__tests__/check-reviewer-policy.test.mjs",
  `scripts/check-${PERFORMANCE_PROVIDER}-policy.mjs`,
  "scripts/check-reviewer-policy.mjs",
  `scripts/lib/${PERFORMANCE_PROVIDER}-policy-contract.mjs`,
  "scripts/lib/run-cli-check.mjs",
];
const HISTORICAL_PATH_PREFIXES = ["docs/adr/", "docs/qa/"];
const fixtureRoots = [];

function repositoryFile(repoRoot, path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function trackedRepositoryPaths() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function repositoryEntry(repoRoot, path) {
  try {
    return lstatSync(resolve(repoRoot, path));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function providerFindingsForPaths(repoRoot, paths) {
  return paths
    .filter((path) => !HISTORICAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .flatMap((path) => {
      const findings = [];
      if (RETIRED_PROVIDER_NAME_PATTERN.test(path)) findings.push(`provider-named path: ${path}`);
      const entry = repositoryEntry(repoRoot, path);
      if (entry === undefined) return findings;
      const content = entry.isSymbolicLink()
        ? readlinkSync(resolve(repoRoot, path), "utf8")
        : repositoryFile(repoRoot, path);
      if (RETIRED_PROVIDER_NAME_PATTERN.test(content)) {
        findings.push(`active provider token: ${path}`);
      }
      return findings;
    });
}

function activeProviderFindings() {
  return providerFindingsForPaths(REPO_ROOT, trackedRepositoryPaths());
}

function createFixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "keiko-retired-provider-"));
  fixtureRoots.push(root);
  return root;
}

describe("retired hosted quality providers", () => {
  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it.each(RETIRED_PATHS)("does not retain executable provider surface at %s", (path) => {
    expect(existsSync(resolve(REPO_ROOT, path))).toBe(false);
  });

  it("does not retain the retired provider configuration directory", () => {
    expect(existsSync(resolve(REPO_ROOT, `.${REVIEW_PROVIDER}`))).toBe(false);
  });

  it("does not retain provider scripts in the package command surface", () => {
    const scripts = JSON.parse(repositoryFile(REPO_ROOT, "package.json")).scripts;
    expect(scripts).not.toHaveProperty(`bench:${PERFORMANCE_PROVIDER}`);
    expect(scripts).not.toHaveProperty(`check:${PERFORMANCE_PROVIDER}-policy`);
    expect(scripts).not.toHaveProperty("check:reviewer-policy");
  });

  it("rejects a bare retired-provider reference in workflow content", () => {
    const root = createFixtureRoot();
    const path = ".github/workflows/ci.yml";
    mkdirSync(resolve(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      resolve(root, path),
      `uses: ${REVIEW_PROVIDER}-apps/${REVIEW_PROVIDER}@0123456789abcdef\n`,
    );

    expect(providerFindingsForPaths(root, [path])).toEqual([`active provider token: ${path}`]);
  });

  it("rejects a tracked provider-named dangling symlink", () => {
    const root = createFixtureRoot();
    const path = `scripts/${PERFORMANCE_PROVIDER}.mjs`;
    mkdirSync(resolve(root, "scripts"), { recursive: true });
    symlinkSync("missing-provider-target", resolve(root, path));

    expect(providerFindingsForPaths(root, [path])).toEqual([`provider-named path: ${path}`]);
  });

  it("does not retain provider-named paths or active provider tokens in tracked files", () => {
    expect(activeProviderFindings()).toEqual([]);
  });
});
