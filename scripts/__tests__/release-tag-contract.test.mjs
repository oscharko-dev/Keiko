import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BETA_INDEX,
  GOVERNED_BETA_TAG_RE,
  isAcceptedReleaseTag,
  isExactReleaseTag,
  isGovernedBetaTag,
  rootPackageVersion,
  runReleaseTagContractCli,
} from "../release-tag-contract.mjs";

const REPO_VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
).version;

/** Captures the CLI's operator-facing surface: both streams and the resulting exit code. */
function runCli(argv, env = {}) {
  const out = [];
  const err = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const previousTag = process.env.RELEASE_TAG;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  if (env.RELEASE_TAG === undefined) delete process.env.RELEASE_TAG;
  else process.env.RELEASE_TAG = env.RELEASE_TAG;
  try {
    runReleaseTagContractCli(argv);
    return { exitCode: process.exitCode, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.exitCode = previousExitCode;
    if (previousTag === undefined) delete process.env.RELEASE_TAG;
    else process.env.RELEASE_TAG = previousTag;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("release tag contract", () => {
  it("accepts the exact tag for a stable version", () => {
    expect(isExactReleaseTag("v0.3.0", "0.3.0")).toBe(true);
    expect(isAcceptedReleaseTag("v0.3.0", "0.3.0")).toBe(true);
  });

  it("accepts the exact tag for an npm PRERELEASE version", () => {
    // The npm beta/RC flow sets package.json to a prerelease version and pushes the exact tag;
    // it must receive the full verification, not the portable-beta treatment (#3043).
    expect(isExactReleaseTag("v0.3.1-rc.1", "0.3.1-rc.1")).toBe(true);
    expect(isGovernedBetaTag("v0.3.1-rc.1", "0.3.1-rc.1")).toBe(false);
  });

  it("accepts the governed portable beta layered over the package version", () => {
    expect(isGovernedBetaTag("v0.3.0-beta.0", "0.3.0")).toBe(true);
    expect(isGovernedBetaTag("v0.3.0-beta.10", "0.3.0")).toBe(true);
  });

  it("refuses a leading-zero beta index", () => {
    // One tag, one spelling: the producer may not mint v0.3.0-beta.00 either — both sides read
    // this module, so the shapes cannot drift apart (#3043).
    expect(isGovernedBetaTag("v0.3.0-beta.00", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.00", "0.3.0")).toBe(false);
    expect(GOVERNED_BETA_TAG_RE.test("v0.3.0-beta.00")).toBe(false);
  });

  it("refuses a foreign version, an RC suffix, and a malformed index", () => {
    expect(isAcceptedReleaseTag("v0.9.9-beta.1", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-rc.1", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.x", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.", "0.3.0")).toBe(false);
  });

  it("treats the version as a literal, not a pattern", () => {
    // An unescaped '.' would make 'v0Q3P0' pass as 'v0.3.0'.
    expect(isAcceptedReleaseTag("v0Q3P0", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0Q3P0-beta.1", "0.3.0")).toBe(false);
  });

  it("exposes the index shape the producer reuses", () => {
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("0")).toBe(true);
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("00")).toBe(false);
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("12")).toBe(true);
  });
});

describe("release tag contract CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the repository's own exact tag and reports it", () => {
    const result = runCli([`v${REPO_VERSION}`]);
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("PASS");
    expect(result.stderr).toBe("");
  });

  it("accepts a governed beta tag passed through RELEASE_TAG", () => {
    // The workflow step sets the env; the argument form is the operator's.
    const result = runCli([], { RELEASE_TAG: `v${REPO_VERSION}-beta.2` });
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("PASS");
  });

  it("refuses a leading-zero beta index with a non-zero exit", () => {
    const result = runCli([`v${REPO_VERSION}-beta.00`]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match package version");
    expect(result.stderr).toContain("without a leading-zero index");
  });

  it("refuses a foreign version", () => {
    const result = runCli(["v99.99.99"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("FAIL");
  });

  it("refuses a missing tag with usage guidance", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pass the tag as an argument or RELEASE_TAG");
  });

  it("reads the version from the repository manifest", () => {
    expect(rootPackageVersion(resolve(import.meta.dirname, "..", ".."))).toBe(REPO_VERSION);
  });
});
