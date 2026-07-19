import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actionIdentity,
  affectedPullNumbers,
  parseEvent,
  pullIsOptedIn,
  resolveAuth,
  run,
} from "../keiko-for-quality-action.mjs";

const evaluatedAt = Date.parse("2026-07-12T00:00:00.000Z");
let signingKey;

beforeAll(async () => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  signingKey = await privateKeyPem();
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

function base64(value) {
  return Buffer.from(value)
    .toString("base64")
    .match(/.{1,64}/gu)
    .join("\n");
}

async function privateKeyPem() {
  const pair = await webcrypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const key = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
  return `-----BEGIN PRIVATE KEY-----\n${base64(key)}\n-----END PRIVATE KEY-----`;
}

function response(payload, status = 200) {
  return new Response(payload === undefined ? undefined : JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

// Only the publish path lists check runs (to locate an existing aggregate run to PATCH); the
// narrowed evaluation itself reads no check-run evidence (Issue #2508).
function checkRunsFor(headSha) {
  return [
    {
      app: { id: 15368 },
      completed_at: "2026-07-11T09:00:00.000Z",
      conclusion: "success",
      head_sha: headSha,
      id: 1,
      name: "ci",
      started_at: "2026-07-11T08:59:00.000Z",
      status: "completed",
    },
  ];
}

// Qodo posts a comment (no check-run): the header, a counts line, and the footer commit marker that
// binds it to the head SHA even for a clean review.
function qodoComment(headSha, bugs = 0) {
  return {
    author_association: "NONE",
    body:
      `<h3>Code Review by Qodo</h3>\n<code>🐞 Bugs (${String(bugs)})</code> ` +
      `<code>📘 Rule violations (0)</code>\n` +
      `<!-- https://github.com/oscharko-dev/Keiko/commit/${headSha} -->`,
    id: 10,
    performed_via_github_app: { id: 484649 },
    updated_at: "2026-07-11T09:00:00.000Z",
    user: { id: 151058649, login: "qodo-code-review[bot]", type: "Bot" },
  };
}

function pullFor(headSha, options = {}) {
  return {
    auto_merge: null,
    base: { ref: options.baseRef ?? "dev" },
    head: { sha: headSha },
    labels: options.labels ?? [{ name: "kfq-action-poc" }],
    number: 2329,
    state: options.state ?? "open",
  };
}

function readAuthRouter(path) {
  if (path.includes("/access_tokens")) return response({ token: "installation-token" });
  if (path.endsWith("/installation")) return response({ id: 42 });
  return undefined;
}

function readEvidenceRouter(path, method, headSha, options) {
  if (/\/pulls\/\d+$/u.test(path)) return response(options.pull ?? pullFor(headSha, options));
  if (path.endsWith("/comments") && (method === undefined || method === "GET")) {
    return response(options.comments ?? [qodoComment(headSha)]);
  }
  if (path.includes(`/commits/${headSha}/check-runs`)) {
    const runs = options.checkRuns ?? checkRunsFor(headSha);
    return response({ check_runs: runs, total_count: runs.length });
  }
  if (path.endsWith(`/commits/${headSha}`)) {
    return response({
      commit: { committer: { date: "2026-07-11T08:59:00.000Z" } },
      parents: [{ sha: "d".repeat(40) }],
      sha: headSha,
    });
  }
  return undefined;
}

function readRouter(path, method, headSha, options) {
  return readAuthRouter(path) ?? readEvidenceRouter(path, method, headSha, options);
}

function writeRouter(path, method) {
  if (path.endsWith("/check-runs") && method === "POST") return response({ id: 99 });
  if (/\/check-runs\/\d+$/u.test(path) && method === "PATCH") return response({ id: 99 });
  if (/\/issues\/\d+\/comments$/u.test(path) && method === "POST") return response({ id: 100 });
  if (/\/issues\/comments\/\d+$/u.test(path) && method === "PATCH") return response({ id: 100 });
  return undefined;
}

function githubMock(headSha, options = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const path = new URL(String(url)).pathname;
    const read = readRouter(path, init?.method, headSha, options);
    if (read !== undefined) return Promise.resolve(read);
    const write = writeRouter(path, init?.method);
    if (write !== undefined) return Promise.resolve(write);
    throw new Error(`Unexpected request: ${String(url)}`);
  });
}

function baseEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "oscharko-dev/Keiko",
    GITHUB_TOKEN: "token",
    STABILITY_WINDOW_MS: "0",
    TARGET_REPOSITORIES_JSON:
      '[{"repository":"oscharko-dev/Keiko","baseBranch":"dev","profile":"keiko"}]',
    ...overrides,
  };
}

function checkPost(fetchMock) {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
  );
  return call === undefined ? undefined : JSON.parse(call[1].body);
}

function dashboardPost(fetchMock) {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      /\/issues\/\d+\/comments$/u.test(new URL(String(url)).pathname) && init?.method === "POST",
  );
  return call === undefined ? undefined : JSON.parse(call[1].body).body;
}

function requestPaths(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

function hasWrite(fetchMock) {
  return fetchMock.mock.calls.some(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH",
  );
}

describe("Keiko for Quality Action execution shell", () => {
  it("publishes a passing aggregate under the distinct Action identity", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha);
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    expect(checkPost(fetchMock)).toMatchObject({
      conclusion: "success",
      head_sha: headSha,
      name: "Keiko for Quality (Action)",
      output: {
        summary: "All current-head Keiko for Quality evidence is valid.",
        title: "Keiko for Quality (Action)",
      },
      status: "completed",
    });
    const commentCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        /\/issues\/\d+\/comments$/u.test(new URL(String(url)).pathname) && init?.method === "POST",
    );
    const commentBody = JSON.parse(commentCall[1].body).body;
    expect(commentBody).toContain("<!-- keiko-for-quality-action-dashboard:v1 -->");
    expect(commentBody).toContain("## Keiko for Quality (Action)");
    // The distinct marker keeps this comment independent from the live Worker's dashboard comment.
    expect(commentBody).not.toContain("<!-- keiko-for-quality-dashboard:v1 -->");
  });

  it("keeps missing evidence pending without a failure conclusion (fail-closed)", async () => {
    const headSha = "b".repeat(40);
    // No Qodo review comment at all: the aggregate stays pending, never a terminal failure.
    const fetchMock = githubMock(headSha, { comments: [] });
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    const body = checkPost(fetchMock);
    expect(body.status).toBe("in_progress");
    expect(body).not.toHaveProperty("conclusion");
    expect(body.output.summary).toContain("Qodo finding evidence is missing");
  });

  it("makes current-head evidence age and evaluation currency diagnosable in the dashboard", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha);
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    const commentBody = dashboardPost(fetchMock);

    expect(commentBody).toContain(`| Last evaluated head | \`head ${headSha.slice(0, 12)}\` |`);
    expect(commentBody).toContain("| Last evaluated | `2026-07-12T00:00:00.000Z` |");
    expect(commentBody).toContain("| Current-head evidence age | `15h` |");
  });

  it("marks absent current-head evidence as unavailable while retaining the evaluated head", async () => {
    const headSha = "b".repeat(40);
    const fetchMock = githubMock(headSha, { comments: [] });
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    const commentBody = dashboardPost(fetchMock);

    expect(commentBody).toContain(`| Last evaluated head | \`head ${headSha.slice(0, 12)}\` |`);
    expect(commentBody).toContain("| Last evaluated | `2026-07-12T00:00:00.000Z` |");
    expect(commentBody).toContain("| Current-head evidence age | unavailable (missing) |");
  });

  it("blocks with a failure conclusion on an unresolved Qodo finding", async () => {
    const headSha = "c".repeat(40);
    const fetchMock = githubMock(headSha, { comments: [qodoComment(headSha, 2)] });
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    expect(checkPost(fetchMock)).toMatchObject({ conclusion: "failure", status: "completed" });
    expect(checkPost(fetchMock).output.summary).toContain("Qodo has 2 unresolved finding(s).");
  });

  it("evaluates only exact-current-head review evidence", async () => {
    const headSha = "d".repeat(40);
    // The Qodo review is bound to a different head, so the aggregate stays pending rather than
    // reusing stale review evidence.
    const fetchMock = githubMock(headSha, { comments: [qodoComment("e".repeat(40))] });
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    const body = checkPost(fetchMock);
    expect(body.status).toBe("in_progress");
    expect(body.output.summary).toContain("Qodo finding evidence is missing");
  });

  it("performs no writes in dry-run mode", async () => {
    const fetchMock = githubMock("a".repeat(40));
    await run(baseEnv({ KFQ_DRY_RUN: "1", KFQ_PR: "2329" }), { now: evaluatedAt });
    expect(hasWrite(fetchMock)).toBe(false);
    expect(requestPaths(fetchMock).some((path) => /\/pulls\/\d+$/u.test(path))).toBe(true);
  });

  it("settles a stability-window-only verdict within the same run", async () => {
    const headSha = "a".repeat(40);
    // The Qodo review is bound to the head and clean, but was (re)posted thirty seconds ago: the
    // only failure is the open stability window. The triggering event may have been that very
    // comment, so the run itself must wait out the bounded remainder and re-evaluate.
    const fetchMock = githubMock(headSha);
    const delays = [];
    await run(baseEnv({ KFQ_PR: "2329", STABILITY_WINDOW_MS: "60000" }), {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      now: Date.parse("2026-07-11T09:00:30.000Z"),
    });
    expect(delays).toEqual([30_000]);
    expect(checkPost(fetchMock)).toMatchObject({ conclusion: "success", status: "completed" });
    // Evidence is refreshed for the post-wait evaluation (two comment listings, one run).
    const commentReads = fetchMock.mock.calls.filter(
      ([url, init]) =>
        new URL(String(url)).pathname.endsWith("/comments") && init?.method === undefined,
    );
    expect(commentReads).toHaveLength(2);
  });

  it("publishes pending when the stability wait exceeds the bounded settle window", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha);
    const delays = [];
    await run(baseEnv({ KFQ_PR: "2329", STABILITY_WINDOW_MS: "600000" }), {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      now: Date.parse("2026-07-11T09:00:30.000Z"),
    });
    expect(delays).toEqual([]);
    const body = checkPost(fetchMock);
    expect(body.status).toBe("in_progress");
    expect(body).not.toHaveProperty("conclusion");
    expect(body.output.summary).toContain("inside the stability window");
  });

  it("does not hold a dry run for the stability window", async () => {
    const fetchMock = githubMock("a".repeat(40));
    const delays = [];
    await run(baseEnv({ KFQ_DRY_RUN: "1", KFQ_PR: "2329", STABILITY_WINDOW_MS: "60000" }), {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      now: Date.parse("2026-07-11T09:00:30.000Z"),
    });
    expect(delays).toEqual([]);
    expect(hasWrite(fetchMock)).toBe(false);
  });

  it("skips a pull request that has not opted into the proof-of-concept", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha, { pull: pullFor(headSha, { labels: [] }) });
    await run(baseEnv(), {
      event: { eventName: "pull_request", payload: { pull_request: { number: 2329 } } },
      now: evaluatedAt,
    });
    expect(requestPaths(fetchMock).some((path) => path.includes("/check-runs"))).toBe(false);
    expect(hasWrite(fetchMock)).toBe(false);
  });

  it("evaluates an opted-in pull request delivered by a pull_request event", async () => {
    const fetchMock = githubMock("a".repeat(40));
    await run(baseEnv(), {
      event: { eventName: "pull_request", payload: { pull_request: { number: 2329 } } },
      now: evaluatedAt,
    });
    expect(checkPost(fetchMock)).toMatchObject({ conclusion: "success" });
  });

  it("skips a pull request that does not target the protected base branch", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha, { pull: pullFor(headSha, { baseRef: "main" }) });
    await run(baseEnv({ KFQ_PR: "2329" }), { now: evaluatedAt });
    expect(requestPaths(fetchMock).some((path) => path.includes("/check-runs"))).toBe(false);
  });

  it("does nothing when the repository is outside the quality target set", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(baseEnv({ GITHUB_REPOSITORY: "someone/other", KFQ_PR: "2329" }), {
      now: evaluatedAt,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns early when the event affects no pull request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await run(baseEnv(), {
      event: {
        eventName: "check_run",
        payload: {
          check_run: { name: "Keiko for Quality (Action)", pull_requests: [{ number: 2329 }] },
        },
      },
      now: evaluatedAt,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores an empty KFQ_PR and uses the event pull instead of phantom pull #0", async () => {
    const fetchMock = githubMock("a".repeat(40));
    await run(baseEnv({ KFQ_PR: "" }), {
      event: { eventName: "pull_request", payload: { pull_request: { number: 2329 } } },
      now: evaluatedAt,
    });
    expect(requestPaths(fetchMock)).toContain("/repos/oscharko-dev/Keiko/pulls/2329");
    expect(requestPaths(fetchMock)).not.toContain("/repos/oscharko-dev/Keiko/pulls/0");
  });

  it("mints an installation token and publishes under the App id in App auth", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha);
    await run(
      baseEnv({
        GITHUB_TOKEN: undefined,
        KFQ_APP_ID: "4290143",
        KFQ_PR: "2329",
        KFQ_PRIVATE_KEY_PKCS8: signingKey,
      }),
      { now: evaluatedAt },
    );
    const paths = requestPaths(fetchMock);
    expect(paths).toContain("/repos/oscharko-dev/Keiko/installation");
    expect(paths.some((path) => path.includes("/access_tokens"))).toBe(true);
    expect(checkPost(fetchMock).name).toBe("Keiko for Quality (Action)");
  });

  it("resolves App auth, token auth, and fails closed without credentials", () => {
    expect(resolveAuth({ KFQ_APP_ID: "4290143", KFQ_PRIVATE_KEY_PKCS8: "key" })).toMatchObject({
      mode: "app",
      producerAppId: 4290143,
    });
    expect(resolveAuth({ GITHUB_TOKEN: "t" })).toMatchObject({
      mode: "token",
      producerAppId: 15368,
    });
    expect(() => resolveAuth({})).toThrow("Missing credentials");
    expect(() => resolveAuth({ KFQ_APP_ID: "abc", KFQ_PRIVATE_KEY_PKCS8: "key" })).toThrow(
      "integer App id",
    );
  });

  it("uses the default Action identity and honours the canonical cutover override", () => {
    expect(actionIdentity({})).toEqual({
      label: "kfq-action-poc",
      marker: "<!-- keiko-for-quality-action-dashboard:v1 -->",
      name: "Keiko for Quality (Action)",
    });
    // The migration is a config flip: point the Action at the canonical name and marker.
    expect(
      actionIdentity({
        KFQ_ACTION_LABEL: "kfq",
        KFQ_CHECK_NAME: "Keiko for Quality",
        KFQ_DASHBOARD_MARKER: "<!-- keiko-for-quality-dashboard:v1 -->",
      }),
    ).toEqual({
      label: "kfq",
      marker: "<!-- keiko-for-quality-dashboard:v1 -->",
      name: "Keiko for Quality",
    });
  });

  it("treats an explicitly empty label as gate-off, and only an absent variable as the PoC default", () => {
    // ADR-0142 cutover: the workflow sets KFQ_ACTION_LABEL to "" so every pull is evaluated.
    expect(actionIdentity({ KFQ_ACTION_LABEL: "" }).label).toBe("");
    expect(actionIdentity({ KFQ_ACTION_LABEL: "  " }).label).toBe("");
    expect(actionIdentity({}).label).toBe("kfq-action-poc");
  });

  it("targets only aggregated check completions and non-own comments", () => {
    expect(
      affectedPullNumbers(
        "check_run",
        { check_run: { name: "ci", pull_requests: [{ number: 7 }] } },
        15368,
      ),
    ).toEqual([7]);
    expect(
      affectedPullNumbers(
        "check_run",
        { check_run: { name: "Keiko for Quality (Action)", pull_requests: [{ number: 7 }] } },
        15368,
      ),
    ).toEqual([]);
    expect(
      affectedPullNumbers(
        "issue_comment",
        {
          comment: { performed_via_github_app: { id: 484649 } },
          issue: { number: 9, pull_request: {} },
        },
        15368,
      ),
    ).toEqual([9]);
    expect(
      affectedPullNumbers(
        "issue_comment",
        {
          comment: { performed_via_github_app: { id: 15368 } },
          issue: { number: 9, pull_request: {} },
        },
        15368,
      ),
    ).toEqual([]);
    expect(affectedPullNumbers("pull_request", { pull_request: { number: 3 } }, 15368)).toEqual([
      3,
    ]);
  });

  it("opts in via label, manual dispatch, or dry run only", () => {
    expect(
      pullIsOptedIn(
        { labels: [{ name: "kfq-action-poc" }] },
        "kfq-action-poc",
        "pull_request",
        false,
      ),
    ).toBe(true);
    expect(pullIsOptedIn({ labels: [] }, "kfq-action-poc", "pull_request", false)).toBe(false);
    expect(pullIsOptedIn({}, "kfq-action-poc", "workflow_dispatch", false)).toBe(true);
    expect(pullIsOptedIn({ labels: [] }, "kfq-action-poc", "pull_request", true)).toBe(true);
  });

  it("evaluates every pull when the label gate is disabled (ADR-0142 cutover)", () => {
    expect(pullIsOptedIn({ labels: [] }, "", "pull_request", false)).toBe(true);
    expect(pullIsOptedIn({ labels: [] }, "", "check_run", false)).toBe(true);
    expect(pullIsOptedIn(undefined, "", "issue_comment", false)).toBe(true);
  });

  it("reads the event name and payload from the runner event file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kfq-action-"));
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify({ pull_request: { number: 5 } }));
    try {
      expect(parseEvent({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path })).toEqual({
        eventName: "pull_request",
        payload: { pull_request: { number: 5 } },
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
    expect(() => parseEvent({})).toThrow("GITHUB_EVENT_NAME");
    expect(() => parseEvent({ GITHUB_EVENT_NAME: "pull_request" })).toThrow("GITHUB_EVENT_PATH");
  });
});
