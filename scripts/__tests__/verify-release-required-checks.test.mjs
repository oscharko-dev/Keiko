import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyTreeEvidence,
  checkRunsForIdenticalTree,
  evaluateRequiredChecks,
  fetchTreeIdenticalCheckRuns,
  fetchTreeSha,
  latestCheckRunsByName,
  parseRequiredChecks,
  requiredChecksFromBranchProtection,
  resolveSkippedWithTreeEvidence,
} from "../verify-release-required-checks.mjs";

describe("parseRequiredChecks", () => {
  it("accepts JSON, comma, and newline lists", () => {
    expect(parseRequiredChecks('["ci","ui"]')).toEqual(["ci", "ui"]);
    expect(parseRequiredChecks("ci, ui\nBuild")).toEqual(["ci", "ui", "Build"]);
  });

  it("deduplicates checks while preserving order", () => {
    expect(parseRequiredChecks('["ci","ui","ci"]')).toEqual(["ci", "ui"]);
  });
});

describe("requiredChecksFromBranchProtection", () => {
  it("reads legacy contexts and modern required check entries", () => {
    expect(
      requiredChecksFromBranchProtection({
        required_status_checks: {
          checks: [{ context: "ci" }, { context: "ui" }],
          contexts: ["actionlint", "ci"],
        },
      }),
    ).toEqual(["actionlint", "ci", "ui"]);
  });
});

describe("latestCheckRunsByName", () => {
  it("keeps the newest run for duplicate check names", () => {
    const latest = latestCheckRunsByName([
      { completed_at: "2026-06-22T08:00:00Z", id: 1, name: "ci" },
      { completed_at: "2026-06-22T08:01:00Z", id: 2, name: "ci" },
    ]);

    expect(latest.get("ci")?.id).toBe(2);
  });
});

describe("evaluateRequiredChecks", () => {
  it("passes when every required check succeeded as a check run or commit status", () => {
    const result = evaluateRequiredChecks(
      ["ci", "external/status"],
      [{ conclusion: "success", name: "ci", status: "completed" }],
      [{ context: "external/status", state: "success" }],
    );

    expect(result).toMatchObject({
      failed: [],
      missing: [],
      ok: true,
      passed: ["ci", "external/status"],
      pending: [],
    });
  });

  it("separates pending, failed, and missing checks", () => {
    const result = evaluateRequiredChecks(
      ["ci", "ui", "actionlint", "dependency-review"],
      [
        { conclusion: "success", name: "ci", status: "completed" },
        { conclusion: "failure", name: "ui", status: "completed" },
        { conclusion: null, name: "actionlint", status: "in_progress" },
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.passed).toEqual(["ci"]);
    expect(result.failed).toEqual([{ name: "ui", source: "check-run", state: "failure" }]);
    expect(result.pending).toEqual([
      { name: "actionlint", source: "check-run", state: "in_progress" },
    ]);
    expect(result.missing).toEqual(["dependency-review"]);
  });
});

// ADR-0178: an integration run may reuse the required matrix's verdict when this commit's tree is
// byte-identical to a pull-request head that matrix already proved. The reused gate then reports
// `skipped` on the release commit while its evidence binds the tree-identical head. The release
// binds a tree, not a sha, so that evidence counts — but ONLY for `skipped`, and only after the
// trees were confirmed equal. A gate that ran and FAILED here must never be rescued by it.
describe("resolveSkippedWithTreeEvidence", () => {
  const skippedResult = () => ({
    failed: [{ name: "ui", source: "check-run", state: "skipped" }],
    missing: [],
    ok: false,
    passed: ["ci"],
    pending: [],
  });
  const green = (name) => ({ name, status: "completed", conclusion: "success" });

  it("accepts a skipped check an identical tree already proved green", () => {
    const resolved = resolveSkippedWithTreeEvidence(skippedResult(), [green("ui")]);
    expect(resolved.ok).toBe(true);
    expect(resolved.failed).toEqual([]);
    expect(resolved.passed).toContain("ui");
  });

  it("never rescues a check that ran and failed on this commit", () => {
    const failed = {
      failed: [{ name: "ui", source: "check-run", state: "failure" }],
      missing: [],
      ok: false,
      passed: [],
      pending: [],
    };
    const resolved = resolveSkippedWithTreeEvidence(failed, [green("ui")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.failed).toEqual(failed.failed);
  });

  it("never rescues a check the identical tree did not prove", () => {
    const resolved = resolveSkippedWithTreeEvidence(skippedResult(), [green("Core quality")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.failed).toHaveLength(1);
  });

  it("ignores tree evidence that did not itself conclude success", () => {
    for (const run of [
      { name: "ui", status: "completed", conclusion: "skipped" },
      { name: "ui", status: "completed", conclusion: "failure" },
      { name: "ui", status: "in_progress", conclusion: null },
    ]) {
      expect(resolveSkippedWithTreeEvidence(skippedResult(), [run]).ok).toBe(false);
    }
  });

  it("leaves the verdict untouched when there is no tree evidence at all", () => {
    for (const evidence of [[], undefined, null]) {
      expect(resolveSkippedWithTreeEvidence(skippedResult(), evidence)).toEqual(skippedResult());
    }
  });

  it("keeps the run red while something else is still missing or pending", () => {
    const mixed = { ...skippedResult(), missing: ["workflow hygiene"] };
    const resolved = resolveSkippedWithTreeEvidence(mixed, [green("ui")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.missing).toEqual(["workflow hygiene"]);
  });
});

// `githubJson` prefers the `gh` CLI and only falls back to fetch. These tests drive the HTTP
// layer, so the CLI resolution is made to fail: that is the documented fallback path, not a
// behaviour change, and it keeps the suite hermetic (no `gh`, no network, no credentials).
vi.mock("../lib/host-executable.mjs", () => ({
  resolveHostExecutable: () => {
    throw new Error("gh unavailable in tests");
  },
}));

// ADR-0178 added the tree-identity path to this verifier: a required check that is `skipped` on the
// release commit counts when a commit carrying the IDENTICAL tree proved it green. Every step of
// that path is exercised here, because each one can only ever widen what the release accepts.
describe("tree-identity evidence lookup", () => {
  const OWNER = "owner";
  const REPO = "repo";
  const TOKEN = "t";
  const SHA = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const TREE = "c".repeat(40);
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Route fetch by URL substring, MOST SPECIFIC FIRST. The check-runs URL also contains
   * "/commits/", so a plain first-match would answer it with the commit payload and the test would
   * fail for a reason that has nothing to do with the code under test.
   */
  function routeFetch(routes) {
    globalThis.fetch = async (url) => {
      const ordered = Object.entries(routes).toSorted(
        ([left], [right]) => right.length - left.length,
      );
      for (const [needle, value] of ordered) {
        if (String(url).includes(needle)) {
          if (value === "throw") throw new Error("network");
          return { ok: true, status: 200, json: async () => value };
        }
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }

  describe("fetchTreeSha", () => {
    it("reads a well-formed tree sha", async () => {
      routeFetch({ "/commits/": { commit: { tree: { sha: TREE } } } });
      await expect(
        fetchTreeSha({ owner: OWNER, repo: REPO, sha: SHA, token: TOKEN }),
      ).resolves.toBe(TREE);
    });

    it.each([
      ["a malformed sha", { commit: { tree: { sha: "nope" } } }],
      ["a missing tree", { commit: {} }],
      ["a request failure", "throw"],
    ])("returns undefined for %s, so no evidence is inferred", async (_label, body) => {
      routeFetch({ "/commits/": body });
      await expect(
        fetchTreeSha({ owner: OWNER, repo: REPO, sha: SHA, token: TOKEN }),
      ).resolves.toBeUndefined();
    });
  });

  describe("checkRunsForIdenticalTree", () => {
    it("returns the head's check runs when its tree matches", async () => {
      routeFetch({
        "/commits/": { commit: { tree: { sha: TREE } } },
        "/check-runs": { check_runs: [{ name: "ui", status: "completed", conclusion: "success" }] },
      });
      const runs = await checkRunsForIdenticalTree({
        headSha: HEAD,
        owner: OWNER,
        repo: REPO,
        token: TOKEN,
        treeSha: TREE,
      });
      expect(runs).toHaveLength(1);
    });

    it("returns nothing when the candidate's tree differs by one byte", async () => {
      routeFetch({ "/commits/": { commit: { tree: { sha: "d".repeat(40) } } } });
      await expect(
        checkRunsForIdenticalTree({
          headSha: HEAD,
          owner: OWNER,
          repo: REPO,
          token: TOKEN,
          treeSha: TREE,
        }),
      ).resolves.toEqual([]);
    });

    it("returns nothing when the check-run request fails", async () => {
      routeFetch({ "/commits/": { commit: { tree: { sha: TREE } } }, "/check-runs": "throw" });
      await expect(
        checkRunsForIdenticalTree({
          headSha: HEAD,
          owner: OWNER,
          repo: REPO,
          token: TOKEN,
          treeSha: TREE,
        }),
      ).resolves.toEqual([]);
    });
  });

  describe("fetchTreeIdenticalCheckRuns", () => {
    it("collects evidence from a pull-request head that carries the same tree", async () => {
      globalThis.fetch = async (url) => {
        const text = String(url);
        if (text.includes("/pulls")) {
          return { ok: true, status: 200, json: async () => [{ head: { sha: HEAD } }] };
        }
        if (text.includes("/check-runs")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              check_runs: [{ name: "ui", status: "completed", conclusion: "success" }],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha: TREE } } }) };
      };
      const runs = await fetchTreeIdenticalCheckRuns({
        owner: OWNER,
        repo: REPO,
        sha: SHA,
        token: TOKEN,
      });
      expect(runs.map((run) => run.name)).toEqual(["ui"]);
    });

    it("returns nothing when this commit's own tree cannot be read", async () => {
      routeFetch({ "/commits/": "throw" });
      await expect(
        fetchTreeIdenticalCheckRuns({ owner: OWNER, repo: REPO, sha: SHA, token: TOKEN }),
      ).resolves.toEqual([]);
    });

    it("returns nothing when the pull-request lookup fails or is malformed", async () => {
      routeFetch({ "/commits/": { commit: { tree: { sha: TREE } } }, "/pulls": "throw" });
      await expect(
        fetchTreeIdenticalCheckRuns({ owner: OWNER, repo: REPO, sha: SHA, token: TOKEN }),
      ).resolves.toEqual([]);
    });

    it("skips a candidate whose head IS this commit, which is not independent evidence", async () => {
      globalThis.fetch = async (url) => {
        const text = String(url);
        if (text.includes("/pulls")) {
          return { ok: true, status: 200, json: async () => [{ head: { sha: SHA } }] };
        }
        return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha: TREE } } }) };
      };
      await expect(
        fetchTreeIdenticalCheckRuns({ owner: OWNER, repo: REPO, sha: SHA, token: TOKEN }),
      ).resolves.toEqual([]);
    });
  });

  describe("applyTreeEvidence", () => {
    const config = { owner: OWNER, repo: REPO, sha: SHA, token: TOKEN };

    it("returns the verdict untouched when nothing is skipped, without any request", async () => {
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return { ok: false, status: 404, json: async () => ({}) };
      };
      const verdict = { failed: [], missing: [], ok: true, passed: ["ci"], pending: [] };
      await expect(applyTreeEvidence(config, verdict)).resolves.toBe(verdict);
      expect(called).toBe(false);
    });

    it("accepts a skipped check that an identical tree proved green", async () => {
      globalThis.fetch = async (url) => {
        const text = String(url);
        if (text.includes("/pulls")) {
          return { ok: true, status: 200, json: async () => [{ head: { sha: HEAD } }] };
        }
        if (text.includes("/check-runs")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              check_runs: [{ name: "ui", status: "completed", conclusion: "success" }],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha: TREE } } }) };
      };
      const verdict = {
        failed: [{ name: "ui", source: "check-run", state: "skipped" }],
        missing: [],
        ok: false,
        passed: [],
        pending: [],
      };
      const resolved = await applyTreeEvidence(config, verdict);
      expect(resolved.ok).toBe(true);
      expect(resolved.passed).toContain("ui");
    });

    it("leaves a skipped check failing when no identical tree proves it", async () => {
      routeFetch({ "/commits/": "throw" });
      const verdict = {
        failed: [{ name: "ui", source: "check-run", state: "skipped" }],
        missing: [],
        ok: false,
        passed: [],
        pending: [],
      };
      const resolved = await applyTreeEvidence(config, verdict);
      expect(resolved.ok).toBe(false);
      expect(resolved.failed).toHaveLength(1);
    });
  });
});

// Reuse must come from ONE candidate and ONE producing app. Both of these widen what the release
// accepts if they are wrong, so each is pinned by the case that would exploit it.
describe("reuse evidence is bound, not aggregated", () => {
  const skipped = (appId) => ({
    failed: [{ name: "ui", source: "check-run", state: "skipped", appId }],
    missing: [],
    ok: false,
    passed: [],
    pending: [],
  });
  const success = (name, appId) => ({
    name,
    status: "completed",
    conclusion: "success",
    app: { id: appId },
  });

  it("accepts a success from the SAME app", () => {
    const resolved = resolveSkippedWithTreeEvidence(skipped(42), [success("ui", 42)]);
    expect(resolved.ok).toBe(true);
    expect(resolved.passed).toContain("ui");
  });

  it("refuses a same-named success from a DIFFERENT app", () => {
    const resolved = resolveSkippedWithTreeEvidence(skipped(42), [success("ui", 99)]);
    expect(resolved.ok).toBe(false);
    expect(resolved.failed).toHaveLength(1);
  });

  it("refuses when the evidence carries no app and the skipped check does", () => {
    const resolved = resolveSkippedWithTreeEvidence(skipped(42), [success("ui", undefined)]);
    expect(resolved.ok).toBe(false);
  });

  it("refuses when the skipped check carries no app and the evidence does", () => {
    const resolved = resolveSkippedWithTreeEvidence(skipped(undefined), [success("ui", 42)]);
    expect(resolved.ok).toBe(false);
  });

  it("takes evidence from ONE candidate, never a union across commits", async () => {
    // Two tree-identical candidates: the first proves only `ui`, the second only `Core quality`.
    // A union would satisfy both; binding to one candidate must not.
    const HEAD_A = "1".repeat(40);
    const HEAD_B = "2".repeat(40);
    const TREE = "c".repeat(40);
    const SHA = "a".repeat(40);
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const text = String(url);
      if (text.includes("/pulls")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ head: { sha: HEAD_A } }, { head: { sha: HEAD_B } }],
        };
      }
      if (text.includes("/check-runs")) {
        const name = text.includes(HEAD_A) ? "ui" : "Core quality";
        return {
          ok: true,
          status: 200,
          json: async () => ({ check_runs: [success(name, 7)] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ commit: { tree: { sha: TREE } } }) };
    };
    try {
      const runs = await fetchTreeIdenticalCheckRuns({
        owner: "owner",
        repo: "repo",
        sha: SHA,
        token: "t",
      });
      // Only the first candidate's evidence, so `Core quality` is not in it.
      expect(runs.map((run) => run.name)).toEqual(["ui"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
