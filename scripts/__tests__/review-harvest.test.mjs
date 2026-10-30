// Review harvest (Issue #4132). Hermetic: the GitHub transport, the Git region probe, the
// checkpoint store, the clock and the sleep are fixtures. AC1: the same GitHub state yields the
// same dataset digest, the dataset carries no body, login, email or token, and pagination and
// rate-limit handling are covered here.

import { describe, expect, it } from "vitest";

import { ReviewEval } from "@oscharko-dev/keiko-evaluations";

import {
  executeReviewHarvestCli,
  encodeDataset,
  parseHarvestArguments,
  readDataset,
} from "../review-harvest.mjs";
import {
  changeFromDiffResult,
  createGitRegionProbe,
  parseDiffTreeOutput,
  parseFirstParentChain,
} from "../lib/review-harvest-git.mjs";
import {
  CONNECTION_QUERIES,
  HarvestTransportError,
  MAX_ATTEMPTS,
  PULL_REQUEST_PAGE_QUERY,
  RATE_LIMIT_RESERVE_POINTS,
  SECONDARY_RATE_LIMIT_WAIT_MS,
  TRANSIENT_BACKOFF_MS,
  classifyTransportFailure,
  createGhTransport,
  harvestReviewThreads,
  requestGraphql,
} from "../lib/review-harvest-graphql.mjs";
import {
  REGION_CHANGES,
  REPLY_CLASSIFICATIONS,
  REVIEW_PRODUCERS,
  anchorOf,
  buildReviewHarvestDataset,
  classifyProducer,
  classifyReply,
  isReviewNotice,
  normalizePullRequest,
  normalizeThread,
  carryAnchor,
  parseUnifiedHunks,
  regionChangedInHistory,
  regionChangeOf,
  regionTouched,
  reviewHarvestDatasetDigest,
  tallyRecordKeys,
  verifyReviewHarvestDataset,
} from "../lib/review-harvest-records.mjs";

const REVIEWED = "1".repeat(40);
const HEAD = "2".repeat(40);
const BASE = "3".repeat(40);
const SECRET_BODY = "ghp_FAKE_TOKEN_123 alice@example.com Fixed by moving the guard";

const bot = (login) => ({ login, __typename: "Bot" });
const user = (login) => ({ login, __typename: "User" });
const page = (nodes, next = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

function comment(author, body, oid = REVIEWED) {
  return { author, body, originalCommit: oid === null ? null : { oid } };
}

function rawThread(id, comments, overrides = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    diffSide: "RIGHT",
    subjectType: "LINE",
    originalLine: 12,
    originalStartLine: 10,
    comments: page(comments),
    ...overrides,
  };
}

function rawPullRequest(number, threads, overrides = {}) {
  return {
    id: `PR_${String(number)}`,
    number,
    state: "MERGED",
    headRefOid: HEAD,
    baseRefOid: BASE,
    reviews: page([{ author: bot("qodo-code-review") }]),
    reviewThreads: page(threads),
    ...overrides,
  };
}

const hunk = (oldStart, oldCount, newStart, newCount) => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
});
const own = (...hunks) => ({ merge: false, change: { kind: "hunks", hunks } });
const merge = (...hunks) => ({ merge: true, change: { kind: "hunks", hunks } });
const changedProbe = () => ({ kind: "steps", steps: [own(hunk(11, 1, 11, 1))] });

describe("producer and reply classification", () => {
  it.each([
    [bot("keiko-for-quality"), "keiko-for-quality"],
    [bot("coderabbitai[bot]"), "coderabbit"],
    [bot("chatgpt-codex-connector"), "codex"],
    [bot("qodo-code-review"), "qodo"],
    [user("someone"), "human"],
    [user("coderabbitai"), "human"],
    [bot("github-advanced-security"), "other"],
    [null, "other"],
  ])("attributes %j to %s", (author, producer) => {
    expect(classifyProducer(author)).toBe(producer);
  });

  it.each([
    ["Fixed in abc123 — the guard was missing.", "fixed"],
    ["Refuted: applying this would reintroduce the race.", "refuted"],
    ["This is already handled by the caller.", "refuted"],
    ["False positive, the value is validated upstream.", "refuted"],
    ["Addressed.", "fixed"],
    ["Thanks for the review!", "unclassified"],
    ["   ", "unclassified"],
    [undefined, "unclassified"],
  ])("classifies the reply %j as %s", (body, classification) => {
    expect(classifyReply(body)).toBe(classification);
  });

  it("recognizes only the retired reviewer's own coverage notice", () => {
    expect(isReviewNotice("keiko-for-quality", "This change was not fully reviewed.")).toBe(true);
    expect(isReviewNotice("coderabbit", "This change was not fully reviewed.")).toBe(false);
    expect(isReviewNotice("keiko-for-quality", "A real finding.")).toBe(false);
  });
});

describe("region change rule", () => {
  const anchor = { startLine: 10, endLine: 12, fileLevel: false };

  it("parses hunks, one line when a count is omitted", () => {
    expect(
      parseUnifiedHunks("diff --git\n@@ -10,3 +10,4 @@ fn\n@@ -20 +21 @@\n@@ -30,0 +31,2 @@\n"),
    ).toEqual([hunk(10, 3, 10, 4), hunk(20, 1, 21, 1), hunk(30, 0, 31, 2)]);
  });

  it("touches a line anchor within the tolerance and a file-level anchor on any hunk", () => {
    const touched = (...hunks) => regionTouched({ kind: "hunks", hunks }, anchor);
    expect(touched(hunk(15, 1, 15, 1))).toBe(true);
    expect(touched(hunk(16, 5, 16, 5))).toBe(false);
    expect(touched(hunk(1, 6, 1, 6))).toBe(false);
    expect(touched(hunk(1, 7, 1, 7))).toBe(true);
    expect(touched(hunk(15, 0, 16, 2))).toBe(true);
    expect(regionTouched({ kind: "hunks", hunks: [] }, { fileLevel: true })).toBe(false);
    expect(
      regionTouched({ kind: "hunks", hunks: [hunk(900, 1, 900, 1)] }, { fileLevel: true }),
    ).toBe(true);
    expect(regionTouched({ kind: "whole-file" }, anchor)).toBe(true);
  });

  it("carries an anchor past hunks above it, stretches it over hunks inside it", () => {
    const carry = (...hunks) => carryAnchor(anchor, { kind: "hunks", hunks });
    expect(carry(hunk(2, 0, 3, 5))).toEqual({ startLine: 15, endLine: 17, fileLevel: false });
    expect(carry(hunk(2, 4, 2, 1))).toEqual({ startLine: 7, endLine: 9, fileLevel: false });
    expect(carry(hunk(40, 2, 40, 9))).toEqual(anchor);
    expect(carry(hunk(12, 0, 13, 4))).toEqual(anchor);
    expect(carry(hunk(11, 1, 11, 3))).toEqual({ startLine: 10, endLine: 14, fileLevel: false });
    expect(carryAnchor({ fileLevel: true }, { kind: "hunks", hunks: [hunk(1, 1, 1, 1)] })).toEqual({
      fileLevel: true,
    });
    expect(carryAnchor(anchor, { kind: "whole-file" })).toEqual(anchor);
  });

  it("counts the pull request's own commits and never a merge from the base", () => {
    const history = (...steps) => regionChangedInHistory({ kind: "steps", steps }, anchor);
    expect(history(own(hunk(11, 1, 11, 1)))).toBe(true);
    expect(history(merge(hunk(11, 1, 11, 1)))).toBe(false);
    expect(history(own(hunk(40, 1, 40, 1)))).toBe(false);
    expect(history()).toBe(false);
    // A merge inserts 20 lines above the region; the own commit then edits the region where it now is.
    expect(history(merge(hunk(1, 0, 2, 20)), own(hunk(31, 1, 31, 1)))).toBe(true);
    // Without carrying, that own edit at line 31 would be read as far below the original anchor.
    expect(history(own(hunk(31, 1, 31, 1)))).toBe(false);
    expect(
      regionChangedInHistory(
        { kind: "cumulative", change: { kind: "hunks", hunks: [hunk(12, 1, 12, 1)] } },
        anchor,
      ),
    ).toBe(true);
  });

  it("anchors on the original position and treats a file subject as file-level", () => {
    expect(anchorOf({ originalLine: 12, originalStartLine: 10 })).toEqual({
      startLine: 10,
      endLine: 12,
      fileLevel: false,
    });
    expect(anchorOf({ originalLine: 12, originalStartLine: null })).toEqual({
      startLine: 12,
      endLine: 12,
      fileLevel: false,
    });
    expect(anchorOf({ originalLine: null })).toEqual({
      startLine: null,
      endLine: null,
      fileLevel: true,
    });
    expect(anchorOf({ subjectType: "FILE", originalLine: 3 }).fileLevel).toBe(true);
  });

  it("distinguishes changed, unchanged, no later commit and unavailable", () => {
    const base = {
      anchor: { startLine: 10, endLine: 12, fileLevel: false },
      side: "right",
      path: "src/a.ts",
      reviewedCommit: REVIEWED,
      headCommit: HEAD,
    };
    expect(regionChangeOf({ ...base, probe: changedProbe })).toBe("changed");
    expect(regionChangeOf({ ...base, probe: () => ({ kind: "steps", steps: [] }) })).toBe(
      "unchanged",
    );
    expect(regionChangeOf({ ...base, headCommit: REVIEWED, probe: changedProbe })).toBe(
      "no-later-commit",
    );
    expect(regionChangeOf({ ...base, probe: () => ({ kind: "unavailable" }) })).toBe("unavailable");
    expect(regionChangeOf({ ...base, side: "left", probe: changedProbe })).toBe("unavailable");
    expect(regionChangeOf({ ...base, reviewedCommit: null, probe: changedProbe })).toBe(
      "unavailable",
    );
  });
});

describe("thread and pull request normalization", () => {
  const context = { headCommit: HEAD, probe: changedProbe };

  it("keeps the facts and a digest, never the body or a login", () => {
    const normalized = normalizeThread(
      rawThread("T1", [
        comment(bot("coderabbitai"), SECRET_BODY),
        comment(bot("coderabbitai"), "self"),
        comment(user("alice"), SECRET_BODY),
      ]),
      context,
    );
    expect(normalized.kind).toBe("thread");
    expect(normalized.record).toMatchObject({
      id: "T1",
      producer: "coderabbit",
      startLine: 10,
      endLine: 12,
      reply: { classification: "fixed", producer: "human" },
      regionChange: "changed",
    });
    expect(normalized.record.bodyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(normalized);
    for (const forbidden of ["ghp_FAKE", "alice", "example.com", "Fixed by", "coderabbitai"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("separates notices and skips empty threads", () => {
    expect(
      normalizeThread(
        rawThread("N", [comment(bot("keiko-for-quality"), "This change was not fully reviewed.")]),
        context,
      ),
    ).toEqual({ kind: "notice", producer: "keiko-for-quality" });
    expect(normalizeThread(rawThread("E", []), context)).toEqual({ kind: "empty" });
  });

  it("fails loud on a malformed commit oid or a missing path", () => {
    expect(() =>
      normalizeThread(rawThread("X", [comment(user("a"), "b", "abc")]), context),
    ).toThrow(TypeError);
    expect(() =>
      normalizeThread(rawThread("X", [comment(user("a"), "b")], { path: "" }), context),
    ).toThrow(TypeError);
  });

  it("orders threads, records every reviewing producer in report order and counts notices", () => {
    const { record, notices } = normalizePullRequest(
      rawPullRequest(7, [
        rawThread("T2", [comment(user("bob"), "x")]),
        rawThread("T1", [comment(bot("chatgpt-codex-connector"), "y")]),
        rawThread("N", [comment(bot("keiko-for-quality"), "was not fully reviewed")]),
      ]),
      changedProbe,
    );
    expect(record.threads.map((entry) => entry.id)).toEqual(["T1", "T2"]);
    expect(record.reviewedBy).toEqual(["codex", "qodo", "human"]);
    expect(record).toMatchObject({
      number: 7,
      state: "merged",
      headCommit: HEAD,
      baseCommit: BASE,
    });
    expect(notices).toEqual({ "keiko-for-quality": 1 });
  });
});

describe("dataset", () => {
  const prs = [
    normalizePullRequest(
      rawPullRequest(9, [
        rawThread("A", [comment(user("x"), SECRET_BODY), comment(bot("coderabbitai"), "Fixed")]),
      ]),
      changedProbe,
    ).record,
    normalizePullRequest(rawPullRequest(3, []), changedProbe).record,
  ];

  it("is ordered, carries no wall clock, and its digest ignores input order", () => {
    const one = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: prs,
      excludedNoticeThreads: { qodo: 2 },
    });
    const two = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: [...prs].reverse(),
      excludedNoticeThreads: { qodo: 2 },
    });
    expect(one.digest).toBe(two.digest);
    expect(one.pullRequests.map((entry) => entry.number)).toEqual([3, 9]);
    expect(one.population).toEqual({
      states: ["merged", "closed"],
      pullRequestCount: 2,
      firstPullRequest: 3,
      lastPullRequest: 9,
    });
    expect(one.excludedNoticeThreads).toEqual({
      "keiko-for-quality": 0,
      coderabbit: 0,
      codex: 0,
      qodo: 2,
      human: 0,
      other: 0,
    });
    expect(JSON.stringify(one)).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it("verifies its own digest and detects any change", () => {
    const built = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: prs,
      excludedNoticeThreads: {},
    });
    expect(verifyReviewHarvestDataset(built)).toBe(true);
    const { digest: _digest, ...content } = built;
    expect(reviewHarvestDatasetDigest(content)).toBe(built.digest);
    const tampered = structuredClone(built);
    tampered.pullRequests[1].threads[0].resolved = true;
    expect(verifyReviewHarvestDataset(tampered)).toBe(false);
    expect(verifyReviewHarvestDataset({ ...content })).toBe(false);
  });

  it("uses a closed, body-free key set", () => {
    const built = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: prs,
      excludedNoticeThreads: {},
    });
    const leaves = new Set(tallyRecordKeys(built).map((path) => path.split(".").at(-1)));
    for (const forbidden of ["body", "login", "author", "email", "token", "url", "createdAt"]) {
      expect(leaves.has(forbidden)).toBe(false);
    }
    expect(
      tallyRecordKeys(built).filter((path) => path.startsWith("$.pullRequests[].threads[].")),
    ).toEqual(
      [
        "bodyDigest",
        "endLine",
        "fileLevel",
        "id",
        "outdated",
        "path",
        "producer",
        "regionChange",
        "reply",
        "reply.classification",
        "reply.producer",
        "resolved",
        "reviewedCommit",
        "side",
        "startLine",
      ].map((key) => `$.pullRequests[].threads[].${key}`),
    );
  });

  it("is accepted by the evaluation family's fail-closed loader, which shares the producer enum", () => {
    const built = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: prs,
      excludedNoticeThreads: {},
    });
    expect(ReviewEval.parseReviewHarvestDataset(structuredClone(built))).toEqual(built);
    expect([...ReviewEval.REVIEW_PRODUCERS]).toEqual([...REVIEW_PRODUCERS]);
    expect([...ReviewEval.REVIEW_REPLY_CLASSIFICATIONS]).toEqual([...REPLY_CLASSIFICATIONS]);
    expect([...ReviewEval.REVIEW_REGION_CHANGES]).toEqual([...REGION_CHANGES]);
  });
});

/** A fixture GitHub: `pages` of pull requests, node continuations, and a scripted rate limit. */
function fixtureGithub({ pages, connections = {}, remaining = () => 4000, failures = [] }) {
  const requests = [];
  const pending = [...failures];
  const transport = async (query, variables) => {
    requests.push({ query, variables });
    const failure = pending.shift();
    if (failure !== undefined) throw failure;
    const rateLimit = {
      cost: 1,
      remaining: remaining(requests.length),
      resetAt: "2026-10-30T02:00:00Z",
    };
    if (query === PULL_REQUEST_PAGE_QUERY) {
      const index = variables.after === null ? 0 : Number(variables.after);
      const nodes = pages[index] ?? [];
      const next = index + 1 < pages.length ? String(index + 1) : null;
      return { data: { rateLimit, repository: { pullRequests: page(nodes, next) } } };
    }
    const kind = Object.keys(CONNECTION_QUERIES).find((key) => CONNECTION_QUERIES[key] === query);
    return { data: { rateLimit, node: { [kind]: connections[`${variables.id}:${kind}`] } } };
  };
  return { transport, requests };
}

function memoryStore(initial) {
  let saved = initial;
  const saves = [];
  return {
    load: () => (saved === undefined ? undefined : structuredClone(saved)),
    save: (checkpoint) => {
      saved = structuredClone(checkpoint);
      saves.push(saved);
    },
    saves,
  };
}

function fixtureIo() {
  const sleeps = [];
  const logs = [];
  return {
    io: {
      now: () => Date.parse("2026-10-30T01:00:00Z"),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (line) => logs.push(line),
    },
    sleeps,
    logs,
  };
}

const PAGES = [
  [
    rawPullRequest(1, [
      rawThread("A", [comment(bot("coderabbitai"), "x"), comment(user("u"), "Fixed")]),
    ]),
  ],
  [
    rawPullRequest(2, [rawThread("B", [comment(user("u"), "y")])], {
      reviewThreads: page(
        [
          rawThread("B", [comment(user("u"), "y")], {
            comments: page([comment(user("u"), "y")], "c1"),
          }),
        ],
        "t1",
      ),
      reviews: page([], "r1"),
    }),
  ],
];
const CONNECTIONS = {
  "PR_2:reviewThreads": page([rawThread("C", [comment(bot("chatgpt-codex-connector"), "z")])]),
  "PR_2:reviews": page([{ author: bot("qodo-code-review") }]),
  "B:comments": page([comment(bot("coderabbitai"), "Refuted: not applicable")]),
  "C:comments": page([]),
};

async function harvest(overrides = {}) {
  const github = fixtureGithub({ pages: PAGES, connections: CONNECTIONS, ...overrides.github });
  const store = overrides.store ?? memoryStore();
  const fixture = fixtureIo();
  const result = await harvestReviewThreads({
    owner: "o",
    name: "r",
    transport: github.transport,
    probe: changedProbe,
    store,
    io: fixture.io,
    pageSize: overrides.pageSize ?? 10,
  });
  const dataset = buildReviewHarvestDataset({
    repository: result.checkpoint.repository,
    pullRequests: result.checkpoint.pullRequests,
    excludedNoticeThreads: result.checkpoint.excludedNoticeThreads,
  });
  return { ...result, dataset, github, store, fixture };
}

describe("harvestReviewThreads", () => {
  it("AC1: two runs against the same GitHub state produce the same digest", async () => {
    const first = await harvest();
    const second = await harvest();
    expect(second.dataset.digest).toBe(first.dataset.digest);
    expect(verifyReviewHarvestDataset(first.dataset)).toBe(true);
  });

  it("follows the pull request cursor and completes overflowing connections", async () => {
    const { dataset, github } = await harvest();
    expect(dataset.pullRequests.map((entry) => entry.number)).toEqual([1, 2]);
    const second = dataset.pullRequests[1];
    expect(second.threads.map((entry) => entry.id)).toEqual(["B", "C"]);
    // B's second comment page holds the first foreign reply; reading only page one would miss it.
    expect(second.threads[0].reply).toEqual({ classification: "refuted", producer: "coderabbit" });
    expect(second.reviewedBy).toEqual(["codex", "qodo", "human"]);
    expect(
      github.requests
        .filter((entry) => entry.query === PULL_REQUEST_PAGE_QUERY)
        .map((entry) => entry.variables.after),
    ).toEqual([null, "1"]);
  });

  it("pauses until the reset when the remaining budget drops below the reserve", async () => {
    const { fixture } = await harvest({
      github: { remaining: (n) => (n === 1 ? RATE_LIMIT_RESERVE_POINTS - 1 : 4000) },
    });
    expect(fixture.sleeps).toEqual([3_600_000 + 1_000]);
    expect(fixture.logs.some((line) => line.startsWith("rate limit:"))).toBe(true);
  });

  it("waits out a rate-limited answer and backs off a transient one, then succeeds", async () => {
    const { fixture, dataset } = await harvest({
      github: {
        failures: [
          new HarvestTransportError("rate-limited", "You have exceeded a secondary rate limit"),
          new HarvestTransportError("transient", "HTTP 502"),
        ],
      },
    });
    expect(fixture.sleeps.slice(0, 2)).toEqual([
      SECONDARY_RATE_LIMIT_WAIT_MS,
      TRANSIENT_BACKOFF_MS * 2,
    ]);
    expect(dataset.pullRequests).toHaveLength(2);
  });

  it("gives up after the retry budget and on a fatal answer", async () => {
    const exhausted = Array.from(
      { length: MAX_ATTEMPTS },
      () => new HarvestTransportError("transient", "HTTP 503"),
    );
    await expect(harvest({ github: { failures: exhausted } })).rejects.toThrow("HTTP 503");
    await expect(
      harvest({ github: { failures: [new HarvestTransportError("fatal", "Bad credentials")] } }),
    ).rejects.toThrow("Bad credentials");
  });

  it("saves a checkpoint per page and resumes from it without re-reading earlier pages", async () => {
    const full = await harvest();
    const afterFirstPage = full.store.saves[0];
    expect(afterFirstPage).toMatchObject({ cursor: "1", complete: false });
    const resumed = await harvest({ store: memoryStore(afterFirstPage) });
    expect(resumed.dataset.digest).toBe(full.dataset.digest);
    expect(
      resumed.github.requests.filter((entry) => entry.query === PULL_REQUEST_PAGE_QUERY),
    ).toHaveLength(1);
    const done = await harvest({ store: memoryStore(full.store.saves.at(-1)) });
    expect(done.github.requests).toEqual([]);
  });

  it("lets the probe prepare every commit of a page before it is asked about them", async () => {
    const prepared = [];
    const probe = Object.assign(changedProbe.bind(null), {
      prepare: (oids) => prepared.push(oids),
    });
    const github = fixtureGithub({ pages: PAGES, connections: CONNECTIONS });
    await harvestReviewThreads({
      owner: "o",
      name: "r",
      transport: github.transport,
      probe,
      store: memoryStore(),
      io: fixtureIo().io,
    });
    expect(prepared).toEqual([
      [HEAD, REVIEWED],
      [HEAD, REVIEWED],
    ]);
  });

  it("refuses a checkpoint from another repository", async () => {
    await expect(
      harvest({ store: memoryStore({ schemaVersion: 1, repository: "x/y" }) }),
    ).rejects.toThrow(/another run/u);
  });

  it("stores no body text in its checkpoints", async () => {
    const { store } = await harvest({
      github: {
        pages: [[rawPullRequest(5, [rawThread("S", [comment(user("alice"), SECRET_BODY)])])]],
      },
    });
    const serialized = JSON.stringify(store.saves);
    expect(serialized).not.toContain("ghp_FAKE");
    expect(serialized).not.toContain("alice");
  });
});

describe("GraphQL transport", () => {
  it.each([
    ["GraphQL: API rate limit exceeded for user ID 1", "rate-limited"],
    ["HTTP 403: You have exceeded a secondary rate limit", "rate-limited"],
    ["HTTP 502: Bad Gateway", "transient"],
    ["read: connection reset (ECONNRESET)", "transient"],
    ["HTTP 401: Bad credentials", "fatal"],
  ])("classifies %j as %s", (text, kind) => {
    expect(classifyTransportFailure(text)).toBe(kind);
  });

  it("passes the query and typed variables to gh and parses its answer", async () => {
    const calls = [];
    const transport = createGhTransport((args) => {
      calls.push(args);
      return { status: 0, stdout: '{"data":{"ok":true}}', stderr: "" };
    });
    await expect(transport("query{}", { count: 5, after: null, owner: "o" })).resolves.toEqual({
      data: { ok: true },
    });
    expect(calls[0]).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query{}",
      "-F",
      "count=5",
      "-f",
      "owner=o",
    ]);
  });

  it("rejects a failed or unlaunchable gh with a classified error", async () => {
    const failed = createGhTransport(() => ({ status: 1, stdout: "", stderr: "HTTP 502" }));
    await expect(failed("q", {})).rejects.toMatchObject({ kind: "transient" });
    const missing = createGhTransport(() => ({
      status: null,
      error: new Error("spawn gh ENOENT"),
    }));
    await expect(missing("q", {})).rejects.toMatchObject({ kind: "fatal" });
  });

  it("treats GraphQL errors in a 200 answer as failures", async () => {
    const context = {
      transport: async () => ({
        errors: [{ message: "Something went wrong while executing your query" }],
        data: null,
      }),
      io: fixtureIo().io,
      state: { pointsUsed: 0 },
    };
    await expect(requestGraphql(context, "q", {})).rejects.toThrow(/Something went wrong/u);
  });
});

describe("Git region probe", () => {
  const CHAIN_A = "a".repeat(40);
  const CHAIN_M = "c".repeat(40);

  function fakeGit(answers) {
    const calls = [];
    const run = (args, input) => {
      const command = args[2];
      calls.push({ command, args, input });
      return answers[command]?.(args, input) ?? { status: 0, stdout: "" };
    };
    return { run, calls };
  }

  it("reads hunks, a binary change and a failure", () => {
    expect(changeFromDiffResult({ status: 0, stdout: "@@ -4,2 +4,3 @@\n" })).toEqual({
      kind: "hunks",
      hunks: [hunk(4, 2, 4, 3)],
    });
    expect(
      changeFromDiffResult({ status: 0, stdout: "Binary files a/x.png and b/x.png differ\n" }),
    ).toEqual({ kind: "whole-file" });
    expect(changeFromDiffResult({ status: 128, stdout: "" })).toEqual({ kind: "unavailable" });
    expect(changeFromDiffResult({ status: null, error: new Error("ENOENT") })).toEqual({
      kind: "unavailable",
    });
  });

  it("parses the first-parent chain and the per-commit diff-tree output", () => {
    expect(
      parseFirstParentChain(`${CHAIN_A} ${REVIEWED}\n${CHAIN_M} ${CHAIN_A} ${BASE}\n`),
    ).toEqual([
      { sha: CHAIN_A, firstParent: REVIEWED, merge: false },
      { sha: CHAIN_M, firstParent: CHAIN_A, merge: true },
    ]);
    const parsed = parseDiffTreeOutput(
      `${CHAIN_A}\ndiff --git a/x b/x\n@@ -3 +3 @@\n-a\n+b\n${CHAIN_M} (from ${CHAIN_A})\nBinary files a/x and b/x differ\n`,
    );
    expect(parsed.get(CHAIN_A)).toEqual({ kind: "hunks", hunks: [hunk(3, 1, 3, 1)] });
    expect(parsed.get(CHAIN_M)).toEqual({ kind: "whole-file" });
  });

  it("walks a linear first-parent chain with pinned diffs, once per question", () => {
    const git = fakeGit({
      "rev-list": () => ({
        status: 0,
        stdout: `${CHAIN_A} ${REVIEWED}\n${HEAD} ${CHAIN_A} ${BASE}\n`,
      }),
      "diff-tree": () => ({ status: 0, stdout: `${CHAIN_A}\n${HEAD}\n@@ -1 +1 @@\n` }),
    });
    const probe = createGitRegionProbe("/repo.git", git.run);
    const answer = probe({ from: REVIEWED, to: HEAD, path: "src/a.ts" });
    expect(answer).toEqual({
      kind: "steps",
      steps: [
        { merge: false, change: { kind: "hunks", hunks: [] } },
        { merge: true, change: { kind: "hunks", hunks: [hunk(1, 1, 1, 1)] } },
      ],
    });
    probe({ from: REVIEWED, to: HEAD, path: "src/a.ts" });
    probe({ from: REVIEWED, to: HEAD, path: "src/b.ts" });
    expect(git.calls.map((call) => call.command)).toEqual(["rev-list", "diff-tree", "diff-tree"]);
    const diffTree = git.calls[1];
    expect(diffTree.args).toEqual(
      expect.arrayContaining([
        "--stdin",
        "--diff-merges=first-parent",
        "--no-renames",
        "--diff-algorithm=myers",
        "-U0",
        "--",
        "src/a.ts",
      ]),
    );
    expect(diffTree.input).toBe(`${CHAIN_A}\n${HEAD}\n`);
  });

  it("falls back to one cumulative diff when a force-push took the reviewed commit off the chain", () => {
    const git = fakeGit({
      "rev-list": () => ({ status: 0, stdout: `${HEAD} ${CHAIN_A}\n` }),
      diff: () => ({ status: 0, stdout: "@@ -7 +7 @@\n" }),
    });
    const probe = createGitRegionProbe("/repo.git", git.run);
    expect(probe({ from: REVIEWED, to: HEAD, path: "a" })).toEqual({
      kind: "cumulative",
      change: { kind: "hunks", hunks: [hunk(7, 1, 7, 1)] },
    });
    expect(git.calls.at(-1).args).toEqual(
      expect.arrayContaining(["diff", REVIEWED, HEAD, "--", "a"]),
    );
  });

  it("is unavailable when an object is missing", () => {
    const missingChain = createGitRegionProbe(
      "/repo.git",
      fakeGit({ "rev-list": () => ({ status: 128 }) }).run,
    );
    expect(missingChain({ from: REVIEWED, to: HEAD, path: "a" })).toEqual({ kind: "unavailable" });
    const failedTree = createGitRegionProbe(
      "/repo.git",
      fakeGit({
        "rev-list": () => ({ status: 0, stdout: `${HEAD} ${REVIEWED}\n` }),
        "diff-tree": () => ({ status: 128 }),
      }).run,
    );
    expect(failedTree({ from: REVIEWED, to: HEAD, path: "a" })).toEqual({ kind: "unavailable" });
    const failedDiff = createGitRegionProbe(
      "/repo.git",
      fakeGit({ "rev-list": () => ({ status: 0, stdout: "" }), diff: () => ({ status: 128 }) }).run,
    );
    expect(failedDiff({ from: REVIEWED, to: HEAD, path: "a" })).toEqual({ kind: "unavailable" });
  });

  it("prepares a page by fetching every missing commit in one read, only when asked to", () => {
    const answers = {
      "cat-file": (_args, input) => ({
        status: 0,
        stdout: input
          .trim()
          .split("\n")
          .map((oid) => (oid === REVIEWED ? `${oid} missing` : `${oid} commit 200`))
          .join("\n"),
      }),
    };
    const fetching = fakeGit(answers);
    createGitRegionProbe("/repo.git", fetching.run, { fetchMissing: true }).prepare([
      REVIEWED,
      HEAD,
    ]);
    expect(fetching.calls.map((call) => call.command)).toEqual(["cat-file", "fetch"]);
    expect(fetching.calls[1].args).toEqual([
      "--git-dir",
      "/repo.git",
      "fetch",
      "--no-tags",
      "--quiet",
      "origin",
      REVIEWED,
    ]);
    const complete = fakeGit({ "cat-file": () => ({ status: 0, stdout: `${HEAD} commit 200\n` }) });
    createGitRegionProbe("/repo.git", complete.run, { fetchMissing: true }).prepare([HEAD]);
    expect(complete.calls.map((call) => call.command)).toEqual(["cat-file"]);
    const idle = fakeGit(answers);
    createGitRegionProbe("/repo.git", idle.run).prepare([REVIEWED]);
    createGitRegionProbe("/repo.git", idle.run, { fetchMissing: true }).prepare([]);
    expect(idle.calls).toEqual([]);
  });
});

describe("review-harvest CLI", () => {
  it("parses a harvest and a verify request and refuses incomplete arguments", () => {
    expect(
      parseHarvestArguments([
        "--repo",
        "o/r",
        "--git-dir",
        "g",
        "--checkpoint",
        "c",
        "--out",
        "d.json.gz",
        "--fetch-missing-commits",
      ]),
    ).toEqual({
      mode: "harvest",
      owner: "o",
      name: "r",
      gitDir: "g",
      checkpoint: "c",
      out: "d.json.gz",
      pageSize: 10,
      fetchMissing: true,
    });
    expect(parseHarvestArguments(["--verify", "d.json"])).toEqual({
      mode: "verify",
      path: "d.json",
    });
    expect(() => parseHarvestArguments(["--repo", "nope"])).toThrow(/usage/u);
    expect(() =>
      parseHarvestArguments([
        "--repo",
        "o/r",
        "--git-dir",
        "g",
        "--checkpoint",
        "c",
        "--out",
        "d",
        "--page-size",
        "0",
      ]),
    ).toThrow(/page-size/u);
  });

  it("round-trips a dataset through gzip and plain JSON", () => {
    const dataset = buildReviewHarvestDataset({
      repository: "o/r",
      pullRequests: [],
      excludedNoticeThreads: {},
    });
    for (const path of ["d.json.gz", "d.json"]) {
      const bytes = encodeDataset(path, dataset);
      expect(readDataset(path, () => bytes)).toEqual(dataset);
    }
  });

  it("harvests, writes the dataset and prints a deterministic PASS line; verify re-checks it", async () => {
    const github = fixtureGithub({ pages: PAGES, connections: CONNECTIONS });
    const written = new Map();
    const lines = [];
    const io = {
      ...fixtureIo().io,
      out: (line) => lines.push(line),
      transport: github.transport,
      probe: changedProbe,
      store: memoryStore(),
      write: (path, bytes) => written.set(path, bytes),
    };
    const code = await executeReviewHarvestCli(
      ["--repo", "o/r", "--git-dir", "g", "--checkpoint", "c", "--out", "d.json.gz"],
      io,
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(
      /^review-harvest PASS: 2 pull requests \(#1-#2\), 3 threads, 0 with region change unavailable, digest sha256:[0-9a-f]{64}$/u,
    );
    const bytes = written.get("d.json.gz");
    const verifyLines = [];
    expect(
      await executeReviewHarvestCli(["--verify", "d.json.gz"], {
        out: (line) => verifyLines.push(line),
        read: () => bytes,
      }),
    ).toBe(0);
    expect(verifyLines[0]).toBe(lines[0]);
    const tampered = readDataset("d.json.gz", () => bytes);
    tampered.repository = "x/y";
    expect(
      await executeReviewHarvestCli(["--verify", "d.json"], {
        out: (line) => verifyLines.push(line),
        read: () => encodeDataset("d.json", tampered),
      }),
    ).toBe(1);
    expect(verifyLines[1]).toMatch(/^review-harvest FAIL: /u);
  });

  it("reports a usage error as FAIL with exit code 1", async () => {
    const lines = [];
    expect(await executeReviewHarvestCli([], { out: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toMatch(/^review-harvest FAIL: usage:/u);
  });
});
