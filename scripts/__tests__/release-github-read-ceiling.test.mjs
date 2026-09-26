// 1.1.9 release, 2026-09-26: the release-dispatch history grew to its 61st run, and its one-page
// answer (1,057,318 bytes) crossed spawnSync's default 1 MiB output buffer. From then on the release
// request and every advance run failed with a bare "the release workflow runs could not be read":
// the child was killed with ENOBUFS and the reason was dropped. These tests pin the ceiling on every
// gh spawn of the release chain and the reason on a failed read.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readFound, readGithub } from "../lib/github-api.mjs";
import { HOST_COMMAND_MAX_BUFFER_BYTES, spawnHostExecutable } from "../lib/host-executable.mjs";
import { readReleaseDispatchRuns } from "../lib/release-candidate.mjs";

const scriptsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;

// The release.yml dispatch listing GitHub answers with: `count` runs, each carrying a commit message
// of `messageLength` characters, as squash commits do.
function dispatchListing(count, messageLength) {
  const runs = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    event: "workflow_dispatch",
    head_branch: "dev",
    head_commit: { message: "x".repeat(messageLength) },
  }));
  return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
}

// A child that prints the listing to stdout, exactly as `gh api` prints an answer. It builds the
// listing itself: an environment string of that size is refused on Linux (E2BIG).
function childPrintingListing(count, messageLength) {
  const script = `process.stdout.write((${dispatchListing.toString()})(${String(count)}, ${String(messageLength)}))`;
  return () => spawnHostExecutable("node", ["-e", script]);
}

describe("gh output ceiling of the release chain", () => {
  it("returns a child's whole output past the 1 MiB spawnSync default", () => {
    const result = spawnHostExecutable("node", [
      "-e",
      `process.stdout.write("x".repeat(${String(2 * MIB)}))`,
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(2 * MIB);
    expect(HOST_COMMAND_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(32 * MIB);
  });

  it("reads a release-dispatch history whose one page is larger than 1 MiB", () => {
    expect(dispatchListing(61, 17_400).length).toBeGreaterThan(MIB);

    const read = readReleaseDispatchRuns(childPrintingListing(61, 17_400), "oscharko-dev/Keiko");

    expect(read.map((run) => run.id)).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
  });

  // Every script the release workflows run that spawns gh or npm. A new one belongs in this list.
  const RELEASE_CHAIN_SCRIPTS = [
    "release-candidate.mjs",
    "release-advance.mjs",
    "release-authorize.mjs",
    "resolve-release-portable-assets.mjs",
    "verify-release-required-checks.mjs",
    "release-publish.mjs",
    "check-release-alignment.mjs",
    "release-portable-prerelease.mjs",
  ];

  function spawnSyncCalls(source) {
    const calls = [];
    for (let start = source.indexOf("spawnSync("); start !== -1;) {
      let depth = 0;
      let end = start + "spawnSync".length;
      for (; end < source.length; end += 1) {
        if (source[end] === "(") depth += 1;
        if (source[end] === ")") depth -= 1;
        if (depth === 0) break;
      }
      calls.push(source.slice(start, end + 1));
      start = source.indexOf("spawnSync(", end);
    }
    return calls;
  }

  it.each(RELEASE_CHAIN_SCRIPTS)("%s spawns every child with the output ceiling", (name) => {
    const source = readFileSync(join(scriptsRoot, name), "utf8");
    const calls = spawnSyncCalls(source);

    expect(calls.length + source.split("spawnHostExecutable(").length - 1).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("maxBuffer: HOST_COMMAND_MAX_BUFFER_BYTES");
    }
  });
});

describe("a failed GitHub read names its cause", () => {
  const PATH = "repos/oscharko-dev/Keiko/actions/workflows/release.yml/runs";
  const enobufs = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS" });

  it.each([
    [{ error: enobufs, status: null, stdout: "{", stderr: "" }, "ENOBUFS"],
    [{ status: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 403)" }, "HTTP 403"],
    [{ status: 1, stdout: "", stderr: "gh: connection reset" }, "exit 1"],
    [{ status: 0, stdout: "not json", stderr: "" }, "unparseable answer"],
  ])("reports %j as %s", (result, reason) => {
    expect(readGithub(() => result, PATH)).toEqual({ kind: "error", reason });
    expect(() => readFound(() => result, PATH, "the release workflow runs")).toThrow(
      `github-api: the release workflow runs could not be read (${reason}).`,
    );
  });

  it("keeps a missing resource apart from a failed read", () => {
    const missing = { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };

    expect(readGithub(() => missing, PATH)).toEqual({ kind: "missing" });
    expect(() => readFound(() => missing, PATH, "the v1.1.9 tag")).toThrow(
      "github-api: the v1.1.9 tag could not be read (HTTP 404).",
    );
  });

  it("returns the parsed answer of a successful read", () => {
    const found = { status: 0, stdout: '{"workflow_runs":[]}', stderr: "" };

    expect(readFound(() => found, PATH, "the release workflow runs")).toEqual({
      workflow_runs: [],
    });
  });
});
