// Regression coverage for the release-alignment gate (issue #3252): version, tag, GitHub Latest
// release, npm `latest`, and the `npm-publish` deployment record must never diverge silently.
// This gate is BRAND NEW — nothing before it read all five sources together, which is exactly how
// the 0.3.12-0.3.15 governed-container publishes went unnoticed (they promoted npm `latest`
// without ever touching the Deployments panel). There is no meaningful "before" state to pin
// against; every scenario below proves the new checker classifies its case correctly.

import { describe, expect, it } from "vitest";

import { checkReleaseAlignment } from "../check-release-alignment.mjs";

const REPOSITORY = "oscharko-dev/Keiko";
const PACKAGE_NAME = "@oscharko-dev/keiko";
const REGISTRY = "https://registry.npmjs.org/";

function ok(stdout) {
  return { status: 0, stdout };
}

function failed(stderr = "boom") {
  return { status: 1, stderr, stdout: "" };
}

// Captures the argv each call was made with, on the returned function itself, so a test can
// assert the exact command shape rather than only the canned response — a fixture that ignores
// its own `args` parameter cannot notice a regression that drops `--registry` (silently falling
// back to the public registry) or corrupts the `git tag --list` invocation (AGENTS.md section 7's
// fixture rule: a fixture must be able to fail when the production call it stands in for breaks).
function npmDistTags(latest) {
  const runNpm = (args) => {
    runNpm.calls.push(args);
    return ok(JSON.stringify({ beta: "0.0.0-beta.1", latest }));
  };
  runNpm.calls = [];
  return runNpm;
}

function gitTags(tags) {
  const runGit = (args) => {
    runGit.calls.push(args);
    return ok(tags.map((tag) => `${tag}\n`).join(""));
  };
  runGit.calls = [];
  return runGit;
}

function ghFor({ deploymentRef, latestReleaseTag }) {
  return (args) => {
    const path = args[1];
    if (path.includes("/releases/latest")) {
      return latestReleaseTag === undefined
        ? failed()
        : ok(JSON.stringify({ tag_name: latestReleaseTag }));
    }
    if (path.includes("/deployments")) {
      return deploymentRef === undefined ? ok("[]") : ok(JSON.stringify([{ ref: deploymentRef }]));
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
}

function alignedSeams(overrides = {}) {
  return {
    checkoutVersion: "0.3.15",
    packageName: PACKAGE_NAME,
    registry: REGISTRY,
    repository: REPOSITORY,
    runGh: ghFor({ deploymentRef: "v0.3.15", latestReleaseTag: "v0.3.15" }),
    runGit: gitTags(["v0.3.14", "v0.3.15"]),
    runNpm: npmDistTags("0.3.15"),
    ...overrides,
  };
}

describe("checkReleaseAlignment", () => {
  it("passes when version, tag, GitHub Latest, npm latest, and the deployment record all agree", () => {
    const result = checkReleaseAlignment(alignedSeams());
    expect(result.aligned).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.rows).toEqual([
      { source: "checkout version", value: "0.3.15" },
      { source: "npm latest dist-tag", value: "0.3.15" },
      { source: "newest tag", value: "v0.3.15" },
      { source: "GitHub Latest release", value: "v0.3.15" },
      { source: "newest npm-publish deployment", value: "v0.3.15" },
    ]);
  });

  it("reads npm dist-tags scoped to the configured registry and lists tags by the v* pattern", () => {
    // Pins the exact command shape, not only the canned response: a regression that drops
    // `--registry` (silently falling back to the public registry instead of the configured
    // KEIKO_REGISTRY_URL) or corrupts `git tag --list` must fail here, not just return whatever
    // the fixture was told to return regardless of what was asked.
    const runNpm = npmDistTags("0.3.15");
    const runGit = gitTags(["v0.3.14", "v0.3.15"]);
    checkReleaseAlignment(alignedSeams({ runNpm, runGit }));
    expect(runNpm.calls).toEqual([
      ["view", PACKAGE_NAME, "dist-tags", "--json", "--registry", REGISTRY],
    ]);
    expect(runGit.calls).toEqual([["tag", "--list", "v*"]]);
  });

  it("passes when the checkout is exactly one patch ahead of npm latest (release cut pending)", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ checkoutVersion: "0.3.16", runGit: gitTags(["v0.3.14", "v0.3.15"]) }),
    );
    expect(result.aligned).toBe(true);
  });

  it("passes when the checkout is exactly one minor ahead of npm latest (release cut pending)", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ checkoutVersion: "0.4.0", runGit: gitTags(["v0.3.15"]) }),
    );
    expect(result.aligned).toBe(true);
  });

  it("fails when the tag matching npm latest does not exist", () => {
    const result = checkReleaseAlignment(alignedSeams({ runGit: gitTags(["v0.3.14"]) }));
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("tag v0.3.15 does not exist (npm latest is 0.3.15).");
  });

  it("fails when the GitHub Latest release names a different tag", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ runGh: ghFor({ deploymentRef: "v0.3.15", latestReleaseTag: "v0.3.14" }) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("GitHub Latest release is v0.3.14, expected v0.3.15.");
  });

  it("fails on a stale deployment record — the real 0.3.12-0.3.15 incident shape", () => {
    // The Deployments panel kept showing v0.3.11 while npm latest was already 0.3.15: the
    // governed-container publish path promoted npm without ever touching GitHub deployments.
    const result = checkReleaseAlignment(
      alignedSeams({
        checkoutVersion: "0.3.15",
        runGh: ghFor({ deploymentRef: "v0.3.11", latestReleaseTag: "v0.3.15" }),
        runGit: gitTags(["v0.3.11", "v0.3.12", "v0.3.13", "v0.3.14", "v0.3.15"]),
      }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain(
      "newest npm-publish deployment ref is v0.3.11, expected v0.3.15 (stale deployment record).",
    );
  });

  it("fails when the checkout is more than one step ahead of npm latest", () => {
    const result = checkReleaseAlignment(alignedSeams({ checkoutVersion: "0.3.17" }));
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain(
      "checkout version 0.3.17 diverges from npm latest 0.3.15 " +
        "(must equal it or be exactly one patch/minor release ahead).",
    );
  });

  it("fails when the checkout is a major version ahead of npm latest", () => {
    const result = checkReleaseAlignment(alignedSeams({ checkoutVersion: "1.0.0" }));
    expect(result.aligned).toBe(false);
    expect(result.failures.some((failure) => failure.includes("diverges from npm latest"))).toBe(
      true,
    );
  });

  it("fails when the checkout is behind npm latest", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ checkoutVersion: "0.3.14", runGit: gitTags(["v0.3.14", "v0.3.15"]) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures.some((failure) => failure.includes("diverges from npm latest"))).toBe(
      true,
    );
  });

  it("treats an unreadable npm latest dist-tag as a divergence, not a pass", () => {
    const result = checkReleaseAlignment(alignedSeams({ runNpm: () => failed() }));
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("npm latest dist-tag could not be read.");
    expect(result.rows).toContainEqual({ source: "npm latest dist-tag", value: "UNREADABLE" });
  });

  it("treats an unreadable git tag list as a divergence", () => {
    const result = checkReleaseAlignment(alignedSeams({ runGit: () => failed() }));
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("tag list could not be read.");
    expect(result.rows).toContainEqual({ source: "newest tag", value: "UNREADABLE" });
  });

  it("treats an unreadable GitHub Latest release as a divergence", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ runGh: ghFor({ deploymentRef: "v0.3.15", latestReleaseTag: undefined }) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("GitHub Latest release could not be read.");
  });

  it("treats a missing npm-publish deployment as a divergence", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ runGh: ghFor({ deploymentRef: undefined, latestReleaseTag: "v0.3.15" }) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("no npm-publish deployment could be read.");
  });

  it("fails when a newer tag already exists even though every other source still agrees on npm latest", () => {
    // Every source (checkout, npm latest, GitHub Latest, deployment record) agrees on 0.3.15,
    // but a stray/premature v0.4.0 tag already exists. `tags.includes(expectedTag)` alone would
    // pass this — the gate must compare the NEWEST tag against npm latest, not merely check that
    // the expected tag exists somewhere in the list.
    const result = checkReleaseAlignment(
      alignedSeams({ runGit: gitTags(["v0.3.14", "v0.3.15", "v0.4.0"]) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain(
      "newest tag is v0.4.0, expected v0.3.15 (a newer tag already exists).",
    );
  });

  it("names every simultaneously-unreadable source, not only npm latest", () => {
    // Before this fix, evaluateAgainstLatest only ran when npm latest itself was readable, so an
    // npm outage masked a concurrently-broken GitHub Latest release read from `failures` even
    // though `rows` already showed both as UNREADABLE.
    const result = checkReleaseAlignment(
      alignedSeams({
        runGh: ghFor({ deploymentRef: "v0.3.15", latestReleaseTag: undefined }),
        runNpm: () => failed(),
      }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("npm latest dist-tag could not be read.");
    expect(result.failures).toContain("GitHub Latest release could not be read.");
  });

  it("network/tool errors on a seam are treated the same as a non-zero status", () => {
    const result = checkReleaseAlignment(
      alignedSeams({ runNpm: () => ({ error: new Error("spawn npm ENOENT") }) }),
    );
    expect(result.aligned).toBe(false);
    expect(result.failures).toContain("npm latest dist-tag could not be read.");
  });
});
