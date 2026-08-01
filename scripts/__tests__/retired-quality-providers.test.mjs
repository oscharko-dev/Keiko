import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CODSPEED = ["cod", "speed"].join("");
const GREPTILE = ["grep", "tile"].join("");
const RETIRED_PROVIDER_NAME_PATTERN = new RegExp(`${CODSPEED}|${GREPTILE}`, "iu");
const ACTIVE_PROVIDER_PATTERN = new RegExp(
  [
    `${CODSPEED}HQ`,
    `gql\\.${CODSPEED}`,
    `${CODSPEED}-policy`,
    `\\.${GREPTILE}`,
    `@${GREPTILE}ai`,
    `check-${CODSPEED}-policy`,
    `bench:${CODSPEED}`,
  ].join("|"),
  "iu",
);
const RETIRED_PATHS = [
  `.${CODSPEED}-policy.json`,
  `.github/workflows/${CODSPEED}-policy.yml`,
  `.github/workflows/${CODSPEED}.yml`,
  `.${GREPTILE}/config.json`,
  `.${GREPTILE}/files.json`,
  `benchmarks/${CODSPEED}.mjs`,
  `${CODSPEED}.yml`,
  `scripts/__tests__/check-${CODSPEED}-policy.test.mjs`,
  "scripts/__tests__/check-reviewer-policy.test.mjs",
  `scripts/check-${CODSPEED}-policy.mjs`,
  "scripts/check-reviewer-policy.mjs",
  `scripts/lib/${CODSPEED}-policy-contract.mjs`,
  "scripts/lib/run-cli-check.mjs",
];
const HISTORICAL_PATH_PREFIXES = ["docs/adr/", "docs/qa/"];

function repositoryFile(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function trackedRepositoryPaths() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function activeProviderFindings() {
  return trackedRepositoryPaths()
    .filter((path) => !HISTORICAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .filter((path) => existsSync(resolve(REPO_ROOT, path)))
    .flatMap((path) => {
      const findings = [];
      if (RETIRED_PROVIDER_NAME_PATTERN.test(path)) findings.push(`provider-named path: ${path}`);
      if (ACTIVE_PROVIDER_PATTERN.test(repositoryFile(path))) {
        findings.push(`active provider token: ${path}`);
      }
      return findings;
    });
}

describe("retired hosted quality providers", () => {
  it.each(RETIRED_PATHS)("does not retain executable provider surface at %s", (path) => {
    expect(existsSync(resolve(REPO_ROOT, path))).toBe(false);
  });

  it("does not retain the retired provider configuration directory", () => {
    expect(existsSync(resolve(REPO_ROOT, `.${GREPTILE}`))).toBe(false);
  });

  it("does not retain provider scripts in the package command surface", () => {
    const scripts = JSON.parse(repositoryFile("package.json")).scripts;
    expect(scripts).not.toHaveProperty(`bench:${CODSPEED}`);
    expect(scripts).not.toHaveProperty(`check:${CODSPEED}-policy`);
    expect(scripts).not.toHaveProperty("check:reviewer-policy");
  });

  it("does not retain provider-named paths or active provider tokens in tracked files", () => {
    expect(activeProviderFindings()).toEqual([]);
  });
});
