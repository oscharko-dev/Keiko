import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANDIDATE_TREE_ARTIFACT_PREFIX,
  acceptMetadataOnlyEdit,
  candidateTreeArtifactName,
  resolveEvidence,
  runRecordedCandidateTree,
} from "../resolve-verified-tree-evidence.mjs";

// ADR-0178 D6. A title- or body-only `edited` event may reuse an earlier pull-request run's
// evidence, but only for the exact candidate merge tree that run measured. Every refusal below is
// a way a different merge candidate, a base retarget or an unproven run could otherwise pass.

const TOKEN = "test-token";
const REPO = "owner/repo";
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const OTHER_TREE = "d".repeat(40);
const BASE = "e".repeat(40);
const OTHER_BASE = "f".repeat(40);
const RUN_ID = 41;
const CANDIDATE = { treeSha: "c".repeat(40), baseSha: "e".repeat(40) };

const EVERY_REUSED_JOB = [
  "Semantic duplication",
  "Core quality",
  "Coverage suite (keiko-ui)",
  "Coverage and SonarCloud",
  "Build, scan, SBOM, smoke",
  "Coverage shard (packages 1/4)",
  "Coverage shard (packages 2/4)",
  "Coverage shard (packages 3/4)",
  "Coverage shard (packages 4/4)",
  "Coverage shard (scripts 1/3)",
  "Coverage shard (scripts 2/3)",
  "Coverage shard (scripts 3/3)",
  "Portable secure-read smoke (linux-x64)",
  "Portable secure-read smoke (windows-x64)",
  "Portable secure-read smoke (macos-arm64)",
  "Portable secure-read smoke (macos-x64)",
  "Firefox smoke (shard 1/2)",
  "Firefox smoke (shard 2/2)",
  "ui",
  "Cross-platform smoke (ubuntu-latest)",
].map((name) => ({ name, conclusion: "success" }));

function editEvent(overrides = {}) {
  return {
    action: "edited",
    changes: { body: { from: "old" } },
    pull_request: { number: 7, head: { sha: HEAD }, base: { sha: BASE } },
    ...overrides,
  };
}

function artifact(treeSha, runId = RUN_ID, baseSha = BASE) {
  return {
    name: `${CANDIDATE_TREE_ARTIFACT_PREFIX}${treeSha}-base-${baseSha}`,
    workflow_run: { id: runId },
  };
}

/** Answers the three lookups of the edit path and records every request. */
function stubGitHub({
  runs = [{ id: RUN_ID, conclusion: "success" }],
  jobs = EVERY_REUSED_JOB,
  artifacts = [artifact(TREE)],
} = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    const text = String(url);
    calls.push(text);
    let body = {};
    if (text.includes("/artifacts")) body = { artifacts };
    else if (text.includes("/jobs")) body = { jobs };
    else if (text.includes("/runs")) body = { workflow_runs: runs };
    return { ok: true, status: 200, json: async () => body };
  });
  return calls;
}

describe("acceptMetadataOnlyEdit", () => {
  it.each([
    ["a body edit", { body: { from: "x" } }],
    ["a title edit", { title: { from: "x" } }],
    ["a title and body edit", { title: { from: "x" }, body: { from: "y" } }],
  ])("accepts %s and binds its head", (_label, changes) => {
    expect(acceptMetadataOnlyEdit(editEvent({ changes }))).toEqual({
      headSha: HEAD,
      baseSha: BASE,
    });
  });

  it.each([
    ["a base retarget", editEvent({ changes: { base: { ref: { from: "dev" } } } })],
    ["a base retarget with a body edit", editEvent({ changes: { base: {}, body: {} } })],
    ["an unknown change key", editEvent({ changes: { draft: {} } })],
    ["an empty changes object", editEvent({ changes: {} })],
    ["a changes array", editEvent({ changes: ["body"] })],
    ["absent changes", editEvent({ changes: undefined })],
    ["a synchronize event", editEvent({ action: "synchronize" })],
    ["an opened event", editEvent({ action: "opened" })],
    [
      "a short head sha",
      editEvent({ pull_request: { head: { sha: "b".repeat(39) }, base: { sha: BASE } } }),
    ],
    [
      "an uppercase head sha",
      editEvent({ pull_request: { head: { sha: "B".repeat(40) }, base: { sha: BASE } } }),
    ],
    ["a missing base", editEvent({ pull_request: { head: { sha: HEAD } } })],
    [
      "a short base sha",
      editEvent({ pull_request: { head: { sha: HEAD }, base: { sha: "e".repeat(39) } } }),
    ],
    ["a missing pull request", editEvent({ pull_request: undefined })],
    ["a null payload", null],
  ])("refuses %s", (_label, event) => {
    expect(acceptMetadataOnlyEdit(event)).toBeNull();
  });
});

describe("candidateTreeArtifactName", () => {
  it("names the artifact after the tree", () => {
    expect(candidateTreeArtifactName(TREE, BASE)).toBe(`ci-candidate-tree-${TREE}-base-${BASE}`);
  });

  it.each(["", "c".repeat(39), "C".repeat(40), `${TREE}\n`, "../x"])(
    "refuses a malformed tree %j",
    (tree) => {
      expect(() => candidateTreeArtifactName(tree, BASE)).toThrow(TypeError);
      expect(() => candidateTreeArtifactName(TREE, tree)).toThrow(TypeError);
    },
  );
});

describe("runRecordedCandidateTree", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts the run's own artifact for exactly this tree", async () => {
    const calls = stubGitHub();
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(true);
    expect(calls).toEqual([
      `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/artifacts?name=ci-candidate-tree-${TREE}-base-${BASE}&per_page=100`,
    ]);
  });

  it("refuses another tree's artifact", async () => {
    stubGitHub({ artifacts: [artifact(OTHER_TREE)] });
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(false);
  });

  it("refuses the same tree recorded on another base", async () => {
    stubGitHub({ artifacts: [artifact(TREE, RUN_ID, OTHER_BASE)] });
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(false);
  });

  it("refuses an artifact that belongs to another run", async () => {
    stubGitHub({ artifacts: [artifact(TREE, RUN_ID + 1)] });
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(false);
  });

  it("refuses a run without the artifact and a malformed payload", async () => {
    stubGitHub({ artifacts: [] });
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(false);
    stubGitHub({ artifacts: "none" });
    await expect(runRecordedCandidateTree(REPO, RUN_ID, CANDIDATE, TOKEN)).resolves.toBe(false);
  });
});

describe("resolveEvidence for a pull-request edit", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let directory;

  function useEvent(event) {
    const path = join(directory, "event.json");
    writeFileSync(path, JSON.stringify(event));
    process.env.GITHUB_EVENT_PATH = path;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "keiko-edit-evidence-"));
    process.env.KEIKO_EVENT_NAME = "pull_request";
    process.env.KEIKO_REPOSITORY = REPO;
    process.env.KEIKO_HEAD_SHA = "a".repeat(40);
    process.env.KEIKO_TOKEN = TOKEN;
    process.env.KEIKO_CANDIDATE_TREE_SHA = TREE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(directory, { recursive: true, force: true });
  });

  it("reuses a green run of the same head that measured the same candidate tree", async () => {
    useEvent(editEvent());
    stubGitHub();
    await expect(resolveEvidence()).resolves.toEqual({
      verified: true,
      runId: RUN_ID,
      headSha: HEAD,
      treeSha: TREE,
    });
  });

  it("looks up only successful pull-request runs of the edited head", async () => {
    useEvent(editEvent());
    const calls = stubGitHub();
    await resolveEvidence();
    expect(calls[0]).toBe(
      `https://api.github.com/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request&status=success&per_page=20`,
    );
  });

  it("refuses when the green run measured another candidate tree (dev moved)", async () => {
    useEvent(editEvent());
    stubGitHub({ artifacts: [artifact(OTHER_TREE)] });
    const result = await resolveEvidence();
    expect(result.verified).toBe(false);
    expect(result.reason).toContain(
      `no complete green CI run on candidate tree ${TREE} and base ${BASE}`,
    );
  });

  it("refuses when the tree was measured on another base (dev moved, same bytes)", async () => {
    useEvent(editEvent());
    stubGitHub({ artifacts: [artifact(TREE, RUN_ID, OTHER_BASE)] });
    expect((await resolveEvidence()).verified).toBe(false);
  });

  it("refuses an earlier edit run that itself reused evidence", async () => {
    useEvent(editEvent());
    stubGitHub({
      jobs: EVERY_REUSED_JOB.map((job) => ({ ...job, conclusion: "skipped" })),
    });
    expect((await resolveEvidence()).verified).toBe(false);
  });

  it("refuses when the run with the tree skipped a reused job", async () => {
    useEvent(editEvent());
    stubGitHub({
      jobs: EVERY_REUSED_JOB.map((job) =>
        job.name === "ui" ? { ...job, conclusion: "skipped" } : job,
      ),
    });
    expect((await resolveEvidence()).verified).toBe(false);
  });

  it("refuses when the head has no green run", async () => {
    useEvent(editEvent());
    stubGitHub({ runs: [] });
    expect((await resolveEvidence()).verified).toBe(false);
  });

  it.each([
    ["a base retarget", editEvent({ changes: { base: { ref: { from: "dev" } } } })],
    ["a synchronize event", editEvent({ action: "synchronize", changes: undefined })],
    ["an opened event", editEvent({ action: "opened", changes: undefined })],
  ])("refuses %s before making any request", async (_label, event) => {
    useEvent(event);
    const calls = stubGitHub();
    const result = await resolveEvidence();
    expect(result.verified).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses without an event payload before making any request", async () => {
    delete process.env.GITHUB_EVENT_PATH;
    const calls = stubGitHub();
    expect((await resolveEvidence()).verified).toBe(false);
    expect(calls).toEqual([]);
  });

  it("fails closed on a missing or malformed candidate tree", async () => {
    useEvent(editEvent());
    stubGitHub();
    delete process.env.KEIKO_CANDIDATE_TREE_SHA;
    await expect(resolveEvidence()).rejects.toThrow("KEIKO_CANDIDATE_TREE_SHA");
    process.env.KEIKO_CANDIDATE_TREE_SHA = "not-a-tree";
    await expect(resolveEvidence()).rejects.toThrow(TypeError);
  });

  it("fails closed on an unreadable event payload", async () => {
    const path = join(directory, "event.json");
    writeFileSync(path, "{not json");
    process.env.GITHUB_EVENT_PATH = path;
    stubGitHub();
    await expect(resolveEvidence()).rejects.toThrow();
  });
});
