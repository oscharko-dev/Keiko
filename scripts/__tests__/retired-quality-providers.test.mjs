import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ACTIVE_PROVIDER_PATTERN =
  /CodSpeedHQ|gql\.codspeed|\.codspeed-policy|\.greptile|@greptileai|check-codspeed-policy|bench:codspeed/iu;
const RETIRED_PATHS = [
  ".codspeed-policy.json",
  ".github/workflows/codspeed-policy.yml",
  ".github/workflows/codspeed.yml",
  ".greptile/config.json",
  ".greptile/files.json",
  "benchmarks/codspeed.mjs",
  "codspeed.yml",
  "scripts/__tests__/check-codspeed-policy.test.mjs",
  "scripts/__tests__/check-reviewer-policy.test.mjs",
  "scripts/check-codspeed-policy.mjs",
  "scripts/check-reviewer-policy.mjs",
  "scripts/lib/codspeed-policy-contract.mjs",
];

function repositoryFile(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("retired hosted quality providers", () => {
  it.each(RETIRED_PATHS)("does not retain executable provider surface at %s", (path) => {
    expect(existsSync(resolve(REPO_ROOT, path))).toBe(false);
  });

  it("does not retain CodSpeed scripts in the package command surface", () => {
    const scripts = JSON.parse(repositoryFile("package.json")).scripts;
    expect(scripts).not.toHaveProperty("bench:codspeed");
    expect(scripts).not.toHaveProperty("check:codspeed-policy");
    expect(scripts).not.toHaveProperty("check:reviewer-policy");
  });

  it.each([
    "scripts/check-external-quality-config.mjs",
    "scripts/check-review-bot-suppression.mjs",
  ])("does not retain active CodSpeed or Greptile logic in %s", (path) => {
    expect(repositoryFile(path)).not.toMatch(ACTIVE_PROVIDER_PATTERN);
  });
});
