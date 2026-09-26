import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  candidateProvedEveryReusedJob,
  publish,
  requireEnv,
  resolveEvidence,
  resolveGreenPullRequestRun,
  resolveMergedPullRequest,
  resolveTreeSha,
} from "../resolve-verified-tree-evidence.mjs";

// ADR-0178. This resolver decides whether a required matrix runs at all, so every path that can
// answer "reuse" must be exercised directly rather than through a subprocess: a subprocess proves
// the happy path but leaves the refusals — the half that keeps the gate closed — unmeasured.
//
// Each test below drives one refusal. Together they are the claim the ADR makes: exactly one
// success path, and everything else runs the full matrix.

const TOKEN = "test-token";
const REPO = "owner/repo";
const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);

/** A fetch stub that answers by URL substring, and records what it was asked. */
function stubFetch(routes) {
  const calls = [];
  const fetch = vi.fn(async (url) => {
    calls.push(String(url));
    for (const [needle, response] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        if (response instanceof Error) throw response;
        const { status = 200, body } = response;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  globalThis.fetch = fetch;
  return calls;
}

describe("requireEnv", () => {
  it("returns a set value and refuses an absent or blank one", () => {
    process.env.KEIKO_TEST_VALUE = " present ";
    expect(requireEnv("KEIKO_TEST_VALUE")).toBe("present");
    delete process.env.KEIKO_TEST_VALUE;
    expect(() => requireEnv("KEIKO_TEST_VALUE")).toThrow(/missing required/u);
    process.env.KEIKO_TEST_VALUE = "   ";
    expect(() => requireEnv("KEIKO_TEST_VALUE")).toThrow(/missing required/u);
    delete process.env.KEIKO_TEST_VALUE;
  });
});

describe("api", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a successful body and sends the bearer token", async () => {
    const calls = stubFetch({ "/repos/": { body: { ok: true } } });
    await expect(api("/repos/x", TOKEN)).resolves.toEqual({ ok: true });
    expect(calls[0]).toContain("/repos/x");
  });

  it("throws on any non-2xx status, so the caller cannot mistake it for evidence", async () => {
    stubFetch({ "/repos/": { status: 401, body: {} } });
    await expect(api("/repos/x", TOKEN)).rejects.toThrow(/401/u);
  });
});

describe("resolveTreeSha", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads a well-formed tree sha", async () => {
    stubFetch({ "/commits/": { body: { commit: { tree: { sha: TREE } } } } });
    await expect(resolveTreeSha(REPO, SHA, TOKEN)).resolves.toBe(TREE);
  });

  it.each([
    ["a missing tree", { commit: {} }],
    ["a non-string sha", { commit: { tree: { sha: 7 } } }],
    ["a malformed sha", { commit: { tree: { sha: "not-a-sha" } } }],
  ])("throws on %s rather than returning something unusable", async (_label, body) => {
    stubFetch({ "/commits/": { body } });
    await expect(resolveTreeSha(REPO, SHA, TOKEN)).rejects.toThrow(/tree sha/u);
  });
});

describe("resolveMergedPullRequest", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const merged = {
    number: 1,
    merged_at: "2026-09-20T00:00:00Z",
    merge_commit_sha: SHA,
    head: { sha: HEAD },
  };

  it("accepts the pull request whose merge commit is exactly this commit", async () => {
    stubFetch({ "/pulls": { body: [merged] } });
    await expect(resolveMergedPullRequest(REPO, SHA, TOKEN)).resolves.toEqual({
      number: 1,
      headSha: HEAD,
    });
  });

  it.each([
    ["the payload is not a list", {}],
    ["no candidate matches", []],
    [
      "the pull request merely CONTAINS the commit",
      [{ ...merged, merge_commit_sha: "d".repeat(40) }],
    ],
    ["the pull request is not merged", [{ ...merged, merged_at: null }]],
  ])("returns null when %s", async (_label, body) => {
    stubFetch({ "/pulls": { body } });
    await expect(resolveMergedPullRequest(REPO, SHA, TOKEN)).resolves.toBeNull();
  });
});

describe("candidateProvedEveryReusedJob", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const everyJob = [
    "Semantic duplication",
    "Core quality",
    "Coverage suite (keiko-ui)",
    "Coverage suite (scripts)",
    "Coverage and SonarCloud",
    "Build, scan, SBOM, smoke",
    "Node 26 compatibility",
    "ui",
    "Cross-platform smoke (ubuntu-latest)",
    "Coverage shard (packages 1/3)",
  ].map((name) => ({ name, conclusion: "success" }));

  it("accepts a candidate that executed every reused job", async () => {
    stubFetch({ "/jobs": { body: { jobs: everyJob } } });
    await expect(candidateProvedEveryReusedJob(REPO, 1, TOKEN)).resolves.toBe(true);
  });

  it("refuses a candidate that SKIPPED one of them", async () => {
    const skipped = everyJob.map((job) =>
      job.name === "ui" ? { ...job, conclusion: "skipped" } : job,
    );
    stubFetch({ "/jobs": { body: { jobs: skipped } } });
    await expect(candidateProvedEveryReusedJob(REPO, 1, TOKEN)).resolves.toBe(false);
  });

  it("refuses a candidate missing a matrix-suffixed job entirely", async () => {
    const withoutMatrix = everyJob.filter((job) => !job.name.startsWith("Cross-platform smoke"));
    stubFetch({ "/jobs": { body: { jobs: withoutMatrix } } });
    await expect(candidateProvedEveryReusedJob(REPO, 1, TOKEN)).resolves.toBe(false);
  });

  it("refuses a malformed payload", async () => {
    stubFetch({ "/jobs": { body: {} } });
    await expect(candidateProvedEveryReusedJob(REPO, 1, TOKEN)).resolves.toBe(false);
  });
});

describe("resolveGreenPullRequestRun", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when no run matches", async () => {
    stubFetch({ "/runs": { body: { workflow_runs: [] } } });
    await expect(resolveGreenPullRequestRun(REPO, HEAD, "ci.yml", TOKEN)).resolves.toBeNull();
  });

  it("returns null for a malformed payload", async () => {
    stubFetch({ "/runs": { body: {} } });
    await expect(resolveGreenPullRequestRun(REPO, HEAD, "ci.yml", TOKEN)).resolves.toBeNull();
  });

  it("skips a run whose conclusion is not success", async () => {
    stubFetch({ "/runs": { body: { workflow_runs: [{ id: 1, conclusion: "failure" }] } } });
    await expect(resolveGreenPullRequestRun(REPO, HEAD, "ci.yml", TOKEN)).resolves.toBeNull();
  });
});

describe("resolveEvidence", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KEIKO_EVENT_NAME = "push";
    process.env.KEIKO_REPOSITORY = REPO;
    process.env.KEIKO_HEAD_SHA = SHA;
    process.env.KEIKO_TOKEN = TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it.each(["pull_request", "workflow_dispatch", "schedule", "merge_queue"])(
    "refuses reuse for the %s event before making any request",
    async (event) => {
      process.env.KEIKO_EVENT_NAME = event;
      const calls = stubFetch({});
      const result = await resolveEvidence();
      expect(result.verified).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it("refuses when no merged pull request resolves to this commit", async () => {
    stubFetch({ "/pulls": { body: [] } });
    const result = await resolveEvidence();
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("no merged pull request");
  });

  it("refuses when the trees differ by one byte", async () => {
    let commitCall = 0;
    globalThis.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes("/pulls")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { number: 1, merged_at: "x", merge_commit_sha: SHA, head: { sha: HEAD } },
          ],
        };
      }
      commitCall += 1;
      const sha = commitCall === 1 ? TREE : "d".repeat(40);
      return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha } } }) };
    });
    const result = await resolveEvidence();
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("tree differs");
  });

  it("refuses when the head has no complete green run", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes("/pulls")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { number: 1, merged_at: "x", merge_commit_sha: SHA, head: { sha: HEAD } },
          ],
        };
      }
      if (text.includes("/runs")) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha: TREE } } }) };
    });
    const result = await resolveEvidence();
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("no complete green CI run");
  });
});

describe("publish", () => {
  let dir;
  let logs;
  let restore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-publish-"));
    process.env.GITHUB_OUTPUT = join(dir, "out");
    writeFileSync(process.env.GITHUB_OUTPUT, "");
    const log = console.log;
    logs = [];
    console.log = (message) => logs.push(String(message));
    restore = () => {
      console.log = log;
      rmSync(dir, { force: true, recursive: true });
      delete process.env.GITHUB_OUTPUT;
    };
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("writes the complete identity when a tree is verified", async () => {
    await publish({ verified: true, runId: 7, headSha: HEAD, treeSha: TREE });
    const written = readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    expect(written).toContain("tree-verified=true");
    expect(written).toContain("evidence-run-id=7");
    expect(written).toContain(`evidence-head-sha=${HEAD}`);
    expect(written).toContain(`evidence-tree-sha=${TREE}`);
    expect(logs.join("\n")).toContain("already proven green");
  });

  it("writes an empty identity and the reason when it is not", async () => {
    await publish({ verified: false, reason: "no merged pull request" });
    const written = readFileSync(process.env.GITHUB_OUTPUT, "utf8");
    expect(written).toContain("tree-verified=false");
    expect(written).toContain("evidence-run-id=\n");
    expect(logs.join("\n")).toContain("full matrix required");
  });
});
