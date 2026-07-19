import { createHmac, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker, {
  allCheckRuns,
  allPages,
  appId,
  appJwt,
  base64Url,
  bytesFromHex,
  constantTimeEqual,
  dashboardComment,
  discoverOpenPullRequests,
  durationLabel,
  evidence,
  evidenceUpdatedAt,
  github,
  hardFailure,
  importAppKey,
  importWebhookKey,
  isMissingColumnError,
  isValidHeadSha,
  isOwnCheckEvent,
  isOwnCommentEvent,
  migrateTrackedPullColumns,
  parseBackstopMs,
  parseJson,
  parseStabilityMs,
  parseTrackedPull,
  privateKeyBytes,
  publishCheck,
  publishDashboardComment,
  pullNeedsReevaluation,
  pullRequestNumbers,
  reconciliationErrorKind,
  reserveDelivery,
  targetForRepository,
  targetRepositories,
  timestampLabel,
  trackedPullRequests,
  verifyWebhookSignature,
} from "../keiko-for-quality-worker.mjs";

let signingKey;

beforeAll(async () => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  signingKey = await privateKeyPem();
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
function checkRuns(headSha) {
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

// Qodo posts a summary issue comment (no check-run): h3 header, emoji/HTML
// counts line, and a full-40-hex blob permalink anchoring it to the head SHA.
function qodoReviewComment(headSha, { bugs = 0, rules = 0, gaps = 0 } = {}) {
  return {
    author_association: "NONE",
    body:
      "<h3>Code Review by Qodo</h3>\n\n" +
      `<code>🐞 Bugs (${String(bugs)})</code>  <code>📘 Rule violations (${String(rules)})</code>  ` +
      `<code>📎 Requirement gaps (${String(gaps)})</code>  <code>📜 Skill insights (0)</code>\n\n` +
      `<code>https://github.com/oscharko-dev/Keiko/blob/${headSha}/scripts/x.mjs#L1-L2</code>`,
    id: 10,
    performed_via_github_app: { id: 484649 },
    updated_at: "2026-07-11T09:00:00.000Z",
    user: { id: 151058649, login: "qodo-code-review[bot]", type: "Bot" },
  };
}

function commentsResponse(url, headSha, options = {}) {
  if (options.invalidComments) return response({ unexpected: true });
  if (options.paginatedComments) {
    const page = new URL(url).searchParams.get("page");
    return response(
      page === "1"
        ? Array.from({ length: 100 }, () => qodoReviewComment(headSha))
        : [qodoReviewComment(headSha)],
    );
  }
  const comments = [
    qodoReviewComment(options.qodoSha ?? headSha, { bugs: options.qodoBugs ?? 0 }),
    {
      author_association: "MEMBER",
      body: "An unrelated human conversation comment.",
      id: 12,
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { id: 1, login: "oscharko", type: "User" },
    },
  ];
  return response(
    options.omitQodoComment
      ? comments.filter((comment) => comment.user.id !== 151058649)
      : comments,
  );
}

function checksResponse(headSha, options) {
  if (options.omitCheckRuns) return response({});
  const runs = options.checkRuns ?? checkRuns(headSha);
  return response({ check_runs: runs, total_count: runs.length });
}

function pullResponse(headSha, options) {
  return response(
    options.pull ?? {
      auto_merge: null,
      base: { ref: "dev" },
      head: { sha: headSha },
      state: "open",
    },
  );
}

function commitResponse(headSha, options) {
  // A transient commit read must not abort the whole evaluation (fail-closed, verdict still posted).
  if (options.commitFails) return response({ message: "server error" }, 500);
  // Default: a normal single-parent commit (no merge parents surfaced). options.parents models a
  // merge-commit head (2+ parents); committer.date defaults just before the Qodo review (09:00) so a
  // parent-pinned review reads as fresh unless the test overrides commitDate to a later time.
  return response({
    commit: { committer: { date: options.commitDate ?? "2026-07-11T08:59:00.000Z" } },
    parents: options.parents ?? [{ sha: "d".repeat(40) }],
    sha: headSha,
  });
}

function checkWriteResponse(path, method) {
  if (path.endsWith("/check-runs") && method === "POST") return response({ id: 99 });
  if (/\/check-runs\/\d+$/u.test(path) && method === "PATCH") return response({ id: 99 });
  return undefined;
}

function commentWriteResponse(path, method) {
  if (/\/issues\/\d+\/comments$/u.test(path) && method === "POST") return response({ id: 100 });
  if (/\/issues\/comments\/\d+$/u.test(path) && method === "PATCH") return response({ id: 100 });
  return undefined;
}

function discoveryReadResponse(path, options) {
  if (path.endsWith("/installation")) return response({ id: 42 });
  if (path.endsWith("/pulls")) return response(options.openPulls ?? [{ number: 2329 }]);
  return undefined;
}

function githubReadResponse(url, path, method, headSha, options) {
  if (path.includes("/access_tokens")) return response({ token: "installation-token" });
  const discoveryResponse = discoveryReadResponse(path, options);
  if (discoveryResponse !== undefined) return discoveryResponse;
  if (/\/pulls\/\d+$/u.test(path)) return pullResponse(headSha, options);
  if (path.endsWith("/comments") && (method === undefined || method === "GET")) {
    return commentsResponse(url, headSha, options);
  }
  if (path.includes(`/commits/${headSha}/check-runs`)) return checksResponse(headSha, options);
  if (path.endsWith(`/commits/${headSha}`)) return commitResponse(headSha, options);
  return undefined;
}

function githubResponse(url, init, headSha, options) {
  const path = new URL(url).pathname;
  const readResponse = githubReadResponse(url, path, init?.method, headSha, options);
  if (readResponse !== undefined) return readResponse;
  const writeResponse = checkWriteResponse(path, init?.method);
  if (writeResponse !== undefined) return writeResponse;
  const commentResponse = commentWriteResponse(path, init?.method);
  if (commentResponse !== undefined) return commentResponse;
  throw new Error(`Unexpected GitHub request: ${String(url)}`);
}

function githubMock(headSha, options = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url, init) => githubResponse(url, init, headSha, options));
}

function insertDeliveryD1(state, values) {
  if (state.deliveries.has(values[0])) return { meta: { changes: 0 } };
  state.deliveries.set(values[0], values[1]);
  return { meta: { changes: 1 } };
}

function insertTrackedD1(state, values) {
  const key = `${values[0]}/${values[1]}#${String(values[2])}`;
  // Models the upsert that always refreshes installation and reconcile metadata (last_head_sha,
  // settled, last_evaluated_at) so a later sweep reads the newest evaluation of every tracked pull.
  state.tracked.set(key, {
    installation_id: values[3],
    last_evaluated_at: values[6],
    last_head_sha: values[4],
    owner: values[0],
    pull_number: values[2],
    repository: values[1],
    settled: values[5],
  });
  return { meta: { changes: 1 } };
}

function runD1(query, state, values) {
  if (query.startsWith("INSERT OR IGNORE INTO webhook_deliveries"))
    return insertDeliveryD1(state, values);
  if (query.startsWith("INSERT INTO tracked_pulls")) return insertTrackedD1(state, values);
  if (query.startsWith("DELETE FROM tracked_pulls")) {
    const key = `${values[0]}/${values[1]}#${String(values[2])}`;
    return { meta: { changes: state.tracked.delete(key) ? 1 : 0 } };
  }
  if (query.startsWith("DELETE FROM webhook_deliveries")) {
    let changes = 0;
    for (const [delivery, expiry] of state.deliveries) {
      if (expiry > values[0]) continue;
      state.deliveries.delete(delivery);
      changes += 1;
    }
    return { meta: { changes } };
  }
  throw new Error(`Unexpected D1 run: ${query}`);
}

function allD1(query, state, values) {
  if (!query.startsWith("SELECT installation_id")) throw new Error(`Unexpected D1 read: ${query}`);
  const rows = [...state.tracked.values()].sort((left, right) =>
    `${left.owner}/${left.repository}#${String(left.pull_number)}`.localeCompare(
      `${right.owner}/${right.repository}#${String(right.pull_number)}`,
    ),
  );
  return { results: rows.slice(values[1], values[1] + values[0]) };
}

function d1Statement(query, state) {
  let values = [];
  const statement = {
    all: vi.fn(async () => allD1(query, state, values)),
    bind: vi.fn((...bound) => {
      values = bound;
      return statement;
    }),
    run: vi.fn(async () => runD1(query, state, values)),
  };
  return statement;
}

function stateBinding() {
  const state = { deliveries: new Map(), tracked: new Map() };
  return { ...state, prepare: vi.fn((query) => d1Statement(query, state)) };
}

function databaseWithResult(result) {
  const statement = {
    bind: vi.fn(() => statement),
    run: vi.fn().mockResolvedValue(result),
  };
  return { prepare: vi.fn(() => statement) };
}

function settledColumn(settled) {
  if (settled === undefined) return undefined;
  return settled ? 1 : 0;
}

function trackPull(state, pullNumber, installationId = 42, metadata = {}) {
  state.tracked.set(`oscharko-dev/Keiko#${String(pullNumber)}`, {
    installation_id: installationId,
    last_evaluated_at: metadata.lastEvaluatedAt,
    last_head_sha: metadata.lastHeadSha,
    owner: "oscharko-dev",
    pull_number: pullNumber,
    repository: "Keiko",
    settled: settledColumn(metadata.settled),
  });
}

function environment(state, secret = "test-secret") {
  return {
    KEIKO_FOR_QUALITY_DB: state,
    GITHUB_APP_ID: "999",
    GITHUB_PRIVATE_KEY_PKCS8: signingKey,
    GITHUB_WEBHOOK_SECRET: secret,
    STABILITY_WINDOW_MS: "0",
    TARGET_REPOSITORY: "oscharko-dev/Keiko",
  };
}

async function signedRequest(payload, secret, delivery = "delivery-1") {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://gate.example/webhook", {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": delivery,
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    method: "POST",
  });
}

describe("Keiko for Quality worker trust boundary", () => {
  it("pins the branded least-privilege App manifest and square Keiko logo", () => {
    const root = resolve(import.meta.dirname, "../..");
    const manifest = JSON.parse(
      readFileSync(
        resolve(root, "infrastructure/keiko-for-quality/github-app-manifest.json.example"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      default_events: [
        "check_run",
        "check_suite",
        "issue_comment",
        "pull_request",
        "pull_request_review",
      ],
      default_permissions: {
        checks: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
      },
      name: "Keiko for Quality",
      public: false,
    });
    expect(Object.keys(manifest.default_permissions).toSorted()).toEqual([
      "checks",
      "issues",
      "metadata",
      "pull_requests",
    ]);

    const logo = readFileSync(resolve(root, "packages/keiko-ui/public/icon-512.png"));
    expect(logo.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(logo.readUInt32BE(16)).toBe(512);
    expect(logo.readUInt32BE(20)).toBe(512);
  });

  it("pins the atomic D1 replay schema and excludes the exhausted KV binding", () => {
    const root = resolve(import.meta.dirname, "../..");
    const schema = readFileSync(
      resolve(root, "infrastructure/keiko-for-quality/schema.sql"),
      "utf8",
    );
    const wrangler = readFileSync(
      resolve(root, "infrastructure/keiko-for-quality/wrangler.toml.example"),
      "utf8",
    );
    expect(schema).toContain("delivery_id TEXT PRIMARY KEY NOT NULL");
    expect(schema).toContain("PRIMARY KEY (owner, repository, pull_number)");
    expect(schema).toContain("settled INTEGER NOT NULL DEFAULT 0");
    expect(schema).toContain("last_evaluated_at INTEGER NOT NULL DEFAULT 0");
    expect(wrangler).toContain('binding = "KEIKO_FOR_QUALITY_DB"');
    expect(wrangler).not.toContain("kv_namespaces");
    expect(wrangler).not.toContain("KEIKO_FOR_QUALITY_STATE");
    // Reduced, targeted cron cadence (Issue #2507): a two-minute liveness backstop, not per-minute.
    expect(wrangler).toContain('crons = ["*/2 * * * *"]');
    expect(wrangler).toContain('RECONCILE_BACKSTOP_MS = "900000"');
  });

  it("encodes JWT material and compares signature bytes exactly", async () => {
    expect(base64Url("test?")).toBe("dGVzdD8");
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect([...bytesFromHex("00ff10")]).toEqual([0, 255, 16]);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    const jwt = await appJwt({ GITHUB_APP_ID: "999", GITHUB_PRIVATE_KEY_PKCS8: signingKey }, 1_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      exp: 1_540,
      iat: 940,
      iss: "999",
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const defaultTimeJwt = await appJwt({
      GITHUB_APP_ID: "999",
      GITHUB_PRIVATE_KEY_PKCS8: signingKey,
    });
    const defaultPayload = defaultTimeJwt.split(".")[1];
    expect(JSON.parse(Buffer.from(defaultPayload, "base64url").toString("utf8"))).toMatchObject({
      exp: 1_540,
      iat: 940,
    });
  });

  it("extracts only PKCS8 key bodies", () => {
    expect(privateKeyBytes(signingKey).byteLength).toBeGreaterThan(100);
    expect(() => privateKeyBytes("-----BEGIN PUBLIC KEY-----bad-----END PUBLIC KEY-----")).toThrow(
      "PKCS#8",
    );
  });

  it("imports non-extractable least-privilege signing keys", async () => {
    const webhookKey = await importWebhookKey("secret");
    const appKey = await importAppKey(signingKey);
    expect(webhookKey.extractable).toBe(false);
    expect(webhookKey.usages).toEqual(["sign"]);
    expect(appKey.extractable).toBe(false);
    expect(appKey.usages).toEqual(["sign"]);
  });

  it("uses the exact GitHub API contract and handles body-free responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(undefined, 204));
    await expect(github("/test", "token", { method: "DELETE" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/test",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer token",
          "Content-Type": "application/json",
          "User-Agent": "keiko-keiko-for-quality",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
        method: "DELETE",
      }),
    );
  });

  it("refuses to build a request from an unexpected path and never calls fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const badPath of [
      "",
      "items",
      "/path with space",
      "/path\ninjection",
      "/repos/o/r?q=<script>",
      "https://evil.example/x",
    ]) {
      await expect(github(badPath, "token")).rejects.toThrow("unexpected path");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(() => Promise.resolve(response({ ok: true })));
    await expect(github("/repos/oscharko-dev/Keiko/pulls/2329", "token")).resolves.toEqual({
      ok: true,
    });
    await expect(
      github(`/repos/o/r/commits/${"a".repeat(40)}/check-runs?per_page=100&page=1`, "token"),
    ).resolves.toEqual({ ok: true });
  });

  it("paginates bounded GitHub arrays with and without an existing query", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Promise.resolve(
        response(page === 1 ? Array.from({ length: 100 }, (_, i) => i) : [100]),
      );
    });
    await expect(allPages("/items?state=open", "token")).resolves.toHaveLength(101);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/items?state=open&per_page=100&page=1",
      "https://api.github.com/items?state=open&per_page=100&page=2",
    ]);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(response(Array.from({ length: 100 }))),
    );
    await expect(allPages("/items", "token")).rejects.toThrow("Pagination limit exceeded");

    vi.restoreAllMocks();
    const tenPageFetch = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Promise.resolve(response(Array.from({ length: page === 10 ? 1 : 100 })));
    });
    await expect(allPages("/ten-pages", "token")).resolves.toHaveLength(901);
    expect(tenPageFetch).toHaveBeenCalledTimes(10);
  });

  it("paginates every current-head check run and fails closed on incomplete metadata", async () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const secondPage = [{ id: 100 }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return Promise.resolve(
        response({ check_runs: page === 1 ? firstPage : secondPage, total_count: 101 }),
      );
    });
    await expect(allCheckRuns("/checks?filter=latest", "token")).resolves.toHaveLength(101);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/checks?filter=latest&per_page=100&page=1",
      "https://api.github.com/checks?filter=latest&per_page=100&page=2",
    ]);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ check_runs: [] }));
    await expect(allCheckRuns("/checks", "token")).rejects.toThrow(
      "GitHub omitted check run count",
    );

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ check_runs: [{ id: 1 }], total_count: 2 }),
    );
    await expect(allCheckRuns("/checks", "token")).rejects.toThrow(
      "Incomplete paginated check runs",
    );

    vi.restoreAllMocks();
    const tenPageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(response({ check_runs: Array.from({ length: 100 }), total_count: 1_000 })),
      );
    await expect(allCheckRuns("/checks", "token")).resolves.toHaveLength(1_000);
    expect(tenPageFetch).toHaveBeenCalledTimes(10);
    expect(tenPageFetch.mock.calls[0][0]).toBe("https://api.github.com/checks?per_page=100&page=1");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(response({ check_runs: Array.from({ length: 100 }), total_count: 1_001 })),
    );
    await expect(allCheckRuns("/checks", "token")).rejects.toThrow(
      "Pagination limit exceeded for /checks.",
    );
  });

  it("classifies only an unresolved Qodo finding as a hard failure", () => {
    expect(hardFailure(["soft", "Qodo has 1 unresolved finding(s)."])).toBe(true);
    expect(hardFailure([])).toBe(false);
    expect(hardFailure(["Current Qodo finding evidence is missing or unparseable."])).toBe(false);
    expect(hardFailure(["Review-product stability evidence is incomplete."])).toBe(false);
    expect(hardFailure(["Review-product evidence is inside the stability window."])).toBe(false);
  });

  it("matches only this app's exact check event", () => {
    const env = { GITHUB_APP_ID: "999" };
    const payload = { check_run: { app: { id: 999 }, name: "Keiko for Quality" } };
    expect(isOwnCheckEvent("check_run", payload, env)).toBe(true);
    expect(isOwnCheckEvent("check_suite", payload, env)).toBe(false);
    expect(
      isOwnCheckEvent("check_run", { check_run: { ...payload.check_run, name: "Other" } }, env),
    ).toBe(false);
    expect(
      isOwnCheckEvent("check_run", { check_run: { ...payload.check_run, app: { id: 1 } } }, env),
    ).toBe(false);
    expect(isOwnCheckEvent("check_run", {}, env)).toBe(false);
    expect(
      isOwnCheckEvent("check_run", { check_run: { app: null, name: "Keiko for Quality" } }, env),
    ).toBe(false);
    expect(isOwnCheckEvent("check_run", { check_run: { name: "Keiko for Quality" } }, env)).toBe(
      false,
    );
    expect(
      isOwnCheckEvent("check_run", { check_run: { app: "999", name: "Keiko for Quality" } }, env),
    ).toBe(false);
  });

  it("ignores only comments created through this exact app", () => {
    const env = { GITHUB_APP_ID: "999" };
    const payload = { comment: { performed_via_github_app: { id: 999 } } };
    expect(isOwnCommentEvent("issue_comment", payload, env)).toBe(true);
    expect(
      isOwnCommentEvent(
        "issue_comment",
        { comment: { performed_via_github_app: { id: 998 } } },
        env,
      ),
    ).toBe(false);
    expect(isOwnCommentEvent("pull_request", {}, env)).toBe(false);
    expect(isOwnCommentEvent("pull_request", payload, env)).toBe(false);
    expect(isOwnCommentEvent("issue_comment", { comment: null }, env)).toBe(false);
  });

  it("renders a redacted in-place dashboard for ready, waiting, and blocked states", () => {
    const headSha = "a".repeat(40);
    const ready = dashboardComment({
      headSha,
      pull: { auto_merge: { enabled_at: "2026-07-13T18:00:00.000Z" } },
      result: {
        evaluatedAt: Date.parse("2026-07-13T18:00:00.000Z"),
        evidenceUpdatedAt: Date.parse("2026-07-13T17:00:00.000Z"),
        failures: [],
        passed: true,
      },
    });
    expect(ready).toBe(
      [
        "<!-- keiko-for-quality-dashboard:v1 -->",
        "## Keiko for Quality",
        "",
        "✅ **Ready for auto-merge**",
        "",
        "| Evaluation | Value |",
        "| --- | --- |",
        "| Last evaluated head | `head aaaaaaaaaaaa` |",
        "| Last evaluated | `2026-07-13T18:00:00.000Z` |",
        "| Current-head evidence age | `1h` |",
        "",
        "| Gate group | Evidence |",
        "| --- | --- |",
        "| Qodo review | ✅ zero unresolved findings |",
        "| Stability window | ✅ settled |",
        "",
        "| Automation | State |",
        "| --- | --- |",
        "| GitHub Auto-Merge | armed |",
        "",
        "<details>",
        "<summary>Validated evidence</summary>",
        "",
        "All exact-current-head evidence is valid.",
        "",
        "</details>",
        "",
        "<sub>Exact-head, app-bound, fail-closed aggregate. This redacted status comment updates in place.</sub>",
      ].join("\n"),
    );
    expect(ready).not.toContain(headSha);

    const waiting = dashboardComment({
      headSha,
      pull: { auto_merge: null },
      result: {
        failures: [
          "Current Qodo finding evidence is missing or unparseable.",
          "Review-product stability evidence is incomplete.",
        ],
        passed: false,
      },
    });
    expect(waiting).toContain("⏳ **Waiting for evidence**");
    expect(waiting).toContain("<details>");
    expect(waiting).not.toContain("<details open>");
    expect(waiting).toContain(
      "| Qodo review | ⏳ Current Qodo finding evidence is missing or unparseable. |",
    );
    expect(waiting).toContain(
      "| Stability window | ⏳ Review-product stability evidence is incomplete. |",
    );
    expect(waiting).toContain("| GitHub Auto-Merge | not armed |");
    expect(waiting).toContain(
      "- Current Qodo finding evidence is missing or unparseable.\n" +
        "- Review-product stability evidence is incomplete.",
    );

    const blocked = dashboardComment({
      headSha,
      pull: { auto_merge: null },
      result: { failures: ["Qodo has 1 unresolved finding(s)."], passed: false },
    });
    expect(blocked).toContain("❌ **Blocked**");
    expect(blocked).toContain("<details open>");
    expect(blocked).toContain("<summary>Blocking evidence (1)</summary>");
    expect(blocked).toContain("| Qodo review | ❌ Qodo has 1 unresolved finding(s). |");
    expect(blocked).toContain("| Stability window | ✅ settled |");
    expect(blocked).not.toContain("secret-value");

    const missingAutoMerge = dashboardComment({
      headSha,
      pull: {},
      result: { failures: [], passed: false },
    });
    expect(missingAutoMerge).toContain("| GitHub Auto-Merge | not armed |");
  });

  it("renders bounded timing labels without making malformed evidence look current", () => {
    expect(durationLabel(0)).toBe("0s");
    expect(durationLabel(59_999)).toBe("59s");
    expect(durationLabel(60_000)).toBe("1m");
    expect(durationLabel(3_600_000)).toBe("1h");
    expect(durationLabel(86_400_000)).toBe("1d");
    expect(durationLabel(-1)).toBeUndefined();
    expect(durationLabel(Number.NaN)).toBeUndefined();
    expect(timestampLabel(Number.MAX_VALUE)).toBe("unavailable");
    expect(timestampLabel(undefined)).toBe("unavailable");

    const invalidAge = dashboardComment({
      headSha: "a".repeat(40),
      pull: { auto_merge: null },
      result: {
        evaluatedAt: Date.parse("2026-07-13T18:00:00.000Z"),
        evidenceUpdatedAt: Date.parse("2026-07-13T18:00:01.000Z"),
        failures: [],
        passed: true,
      },
    });
    expect(invalidAge).toContain("| Current-head evidence age | unavailable (invalid) |");
  });

  it("derives age only from app-verified evidence bound to the evaluated head", () => {
    const headSha = "a".repeat(40);
    const updatedAt = "2026-07-13T17:00:00.000Z";
    const current = {
      appId: 484649,
      authorId: 151058649,
      authorType: "Bot",
      body: qodoReviewComment(headSha).body,
      updatedAt,
    };
    expect(evidenceUpdatedAt([current], headSha)).toBe(Date.parse(updatedAt));
    expect(evidenceUpdatedAt([current], "b".repeat(40))).toBeUndefined();
    expect(evidenceUpdatedAt([{ ...current, appId: 1 }], headSha)).toBeUndefined();
  });

  it("creates one dashboard comment and subsequently updates the app-owned marker", async () => {
    const headSha = "a".repeat(40);
    const baseEvidence = { comments: [] };
    const pull = { auto_merge: null, head: { sha: headSha } };
    const result = {
      failures: ["Current Qodo finding evidence is missing or unparseable."],
      passed: false,
    };
    const createFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ id: 100 }));
    await publishDashboardComment({
      owner: "owner",
      repository: "repo",
      pullNumber: 42,
      currentEvidence: baseEvidence,
      pull,
      result,
      token: "token",
      env: { GITHUB_APP_ID: "999" },
    });
    expect(createFetch.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/issues/42/comments",
    );
    expect(createFetch.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(createFetch.mock.calls[0][1].body).body).toContain(
      "<!-- keiko-for-quality-dashboard:v1 -->",
    );

    vi.restoreAllMocks();
    const updateFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ id: 77 }));
    await publishDashboardComment({
      owner: "owner",
      repository: "repo",
      pullNumber: 42,
      currentEvidence: {
        ...baseEvidence,
        comments: [
          {
            appId: 998,
            body: "<!-- keiko-for-quality-dashboard:v1 -->wrong app",
            id: 74,
          },
          {
            appId: 999,
            body: "<!-- keiko-for-quality-dashboard:v1 -->invalid id",
            id: "75",
          },
          { appId: 999, body: "no ownership marker", id: 76 },
          {
            appId: 999,
            body: "<!-- keiko-for-quality-dashboard:v1 -->old",
            id: 77,
          },
        ],
      },
      pull,
      result,
      token: "token",
      env: { GITHUB_APP_ID: "999" },
    });
    expect(updateFetch.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/issues/comments/77",
    );
    expect(updateFetch.mock.calls[0][1].method).toBe("PATCH");

    vi.restoreAllMocks();
    const stableBody = dashboardComment({
      headSha,
      pull,
      result,
    });
    const unchangedFetch = vi.spyOn(globalThis, "fetch");
    await publishDashboardComment({
      owner: "owner",
      repository: "repo",
      pullNumber: 42,
      currentEvidence: {
        ...baseEvidence,
        comments: [{ appId: 999, body: stableBody, id: 77 }],
      },
      pull,
      result,
      token: "token",
      env: { GITHUB_APP_ID: "999" },
    });
    expect(unchangedFetch).not.toHaveBeenCalled();
  });

  it("extracts app identity only when present", () => {
    expect(appId({ id: 999 })).toBe(999);
    expect(appId(null)).toBeUndefined();
    expect(appId(undefined)).toBeUndefined();
  });

  it("does not trust absent event collection shapes", () => {
    expect(pullRequestNumbers("check_run", { check_run: { pull_requests: null } })).toEqual([]);
    expect(pullRequestNumbers("check_suite", { check_suite: { pull_requests: null } })).toEqual([]);
    expect(pullRequestNumbers("issue_comment", { issue: null })).toEqual([]);
  });

  it("validates every persisted scheduled-pull field", () => {
    expect(parseTrackedPull(null)).toEqual({ kind: "missing" });
    expect(parseTrackedPull("{")).toEqual({ kind: "invalid" });
    expect(parseTrackedPull("null")).toEqual({ kind: "invalid" });
    for (const tracked of [
      { installationId: 1, owner: 1, pullNumber: 2, repository: "repo" },
      { installationId: 1, owner: "owner", pullNumber: 2, repository: 1 },
      { installationId: 1, owner: "owner", pullNumber: "2", repository: "repo" },
      { installationId: "1", owner: "owner", pullNumber: 2, repository: "repo" },
    ]) {
      expect(parseTrackedPull(JSON.stringify(tracked))).toEqual({ kind: "invalid" });
    }
    const tracked = { installationId: 1, owner: "owner", pullNumber: 2, repository: "repo" };
    expect(parseTrackedPull(JSON.stringify(tracked))).toEqual({ kind: "valid", tracked });
  });

  it("parses JSON and stability configuration without ambiguous fallbacks", () => {
    expect(parseJson('{"value":1}')).toEqual({ value: 1 });
    expect(parseJson("{")).toBeUndefined();
    expect(parseStabilityMs(undefined)).toBe(60_000);
    expect(parseStabilityMs("")).toBe(60_000);
    expect(parseStabilityMs("   ")).toBe(60_000);
    expect(parseStabilityMs("0")).toBe(0);
    expect(parseStabilityMs("1234")).toBe(1_234);
    expect(parseStabilityMs("invalid")).toBe(60_000);
    expect(parseStabilityMs("-1")).toBe(60_000);
    expect(parseStabilityMs("Infinity")).toBe(60_000);
    expect(isValidHeadSha("a".repeat(40))).toBe(true);
    expect(isValidHeadSha(`a${"b".repeat(40)}`)).toBe(false);
    expect(isValidHeadSha({ toString: () => "a".repeat(40) })).toBe(false);
  });

  it("parses the reconcile backstop interval with a safe fifteen-minute default", () => {
    expect(parseBackstopMs(undefined)).toBe(900_000);
    expect(parseBackstopMs("")).toBe(900_000);
    expect(parseBackstopMs("   ")).toBe(900_000);
    expect(parseBackstopMs("0")).toBe(0);
    expect(parseBackstopMs("120000")).toBe(120_000);
    expect(parseBackstopMs("invalid")).toBe(900_000);
    expect(parseBackstopMs("-1")).toBe(900_000);
    expect(parseBackstopMs("Infinity")).toBe(900_000);
  });

  it("re-evaluates only pending, head-changed, or backstop-due pull requests", () => {
    const now = 10_000_000;
    const backstopMs = 900_000;
    const head = "a".repeat(40);
    const base = { backstopMs, currentHeadSha: head, now };
    const settled = (over) => ({ lastEvaluatedAt: now - over, lastHeadSha: head, settled: true });
    // Never evaluated, or a verdict still waiting on evidence, must always re-evaluate (the stability
    // window is a timer, not a webhook, so only a re-run flips it).
    expect(pullNeedsReevaluation({ ...base, persisted: undefined })).toBe(true);
    expect(
      pullNeedsReevaluation({
        ...base,
        persisted: { lastEvaluatedAt: now, lastHeadSha: head, settled: false },
      }),
    ).toBe(true);
    // A settled verdict whose head moved re-evaluates; unchanged and recent is skipped, even when the
    // current head is only known from D1 tracking (undefined discovery head).
    expect(
      pullNeedsReevaluation({
        ...base,
        persisted: { lastEvaluatedAt: now, lastHeadSha: "b".repeat(40), settled: true },
      }),
    ).toBe(true);
    expect(pullNeedsReevaluation({ ...base, persisted: settled(0) })).toBe(false);
    expect(
      pullNeedsReevaluation({ ...base, currentHeadSha: undefined, persisted: settled(0) }),
    ).toBe(false);
    // The liveness backstop re-evaluates a settled pull request once its last evaluation ages out, or
    // when the persisted timestamp is unusable.
    expect(pullNeedsReevaluation({ ...base, persisted: settled(backstopMs) })).toBe(true);
    expect(
      pullNeedsReevaluation({
        ...base,
        persisted: { lastEvaluatedAt: undefined, lastHeadSha: head, settled: true },
      }),
    ).toBe(true);
  });

  it("accepts only an exact SHA-256 webhook signature", async () => {
    const body = '{"repository":{"full_name":"oscharko-dev/Keiko"}}';
    const secret = "test-secret";
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    await expect(verifyWebhookSignature(body, `sha256=${digest}`, secret)).resolves.toBe(true);
    await expect(verifyWebhookSignature(`${body}x`, `sha256=${digest}`, secret)).resolves.toBe(
      false,
    );
    await expect(verifyWebhookSignature(body, "sha1=invalid", secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, `xsha256=${digest}`, secret)).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, `sha256=${digest}x`, secret)).resolves.toBe(false);
  });

  it("validates, evaluates, and publishes a successful app-bound check", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha);
    const state = stateBinding();
    const waits = [];
    const secret = "test-secret";
    const request = await signedRequest(
      {
        installation: { id: 42 },
        number: 2329,
        pull_request: { number: 2329 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      secret,
    );
    const result = await worker.fetch(request, environment(state, secret), {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(result.status).toBe(202);
    expect(await result.text()).toBe("accepted");
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    expect(JSON.parse(publish[1].body)).toMatchObject({
      conclusion: "success",
      head_sha: headSha,
      name: "Keiko for Quality",
      output: {
        summary: "All current-head Keiko for Quality evidence is valid.",
        title: "Keiko for Quality",
      },
      status: "completed",
    });
    expect([...state.tracked.values()]).toContainEqual(
      expect.objectContaining({
        installation_id: 42,
        owner: "oscharko-dev",
        pull_number: 2329,
        repository: "Keiko",
      }),
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("publishes exact success, failure, and pending check contracts", async () => {
    const headSha = "9".repeat(40);
    for (const [result, expected] of [
      [
        { failures: [], passed: true },
        {
          conclusion: "success",
          output: {
            summary: "All current-head Keiko for Quality evidence is valid.",
            title: "Keiko for Quality",
          },
          status: "completed",
        },
      ],
      [
        { failures: ["Qodo has 2 unresolved finding(s).", "second failure"], passed: false },
        {
          conclusion: "failure",
          output: {
            summary: "Qodo has 2 unresolved finding(s).\nsecond failure",
            title: "Keiko for Quality",
          },
          status: "completed",
        },
      ],
      [
        {
          failures: ["Current Qodo finding evidence is missing or unparseable.", "waiting"],
          passed: false,
        },
        {
          output: {
            summary: "Current Qodo finding evidence is missing or unparseable.\nwaiting",
            title: "Keiko for Quality",
          },
          status: "in_progress",
        },
      ],
    ]) {
      vi.restoreAllMocks();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          response({
            check_runs: [
              { app: { id: 1 }, id: 1, name: "Keiko for Quality" },
              { app: { id: 999 }, id: 2, name: "Other" },
            ],
            total_count: 2,
          }),
        )
        .mockResolvedValueOnce(response({ id: 3 }));
      await publishCheck("owner", "repo", headSha, result, "token", { GITHUB_APP_ID: "999" });
      const [, init] = fetchMock.mock.calls[1];
      expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/repos/owner/repo/check-runs");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        ...expected,
        head_sha: headSha,
        name: "Keiko for Quality",
      });
    }
  });

  it("patches only this app's existing check without sending a head SHA", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          check_runs: [{ app: { id: 999 }, id: 7, name: "Keiko for Quality" }],
          total_count: 1,
        }),
      )
      .mockResolvedValueOnce(response({ id: 7 }));
    await publishCheck("owner", "repo", "a".repeat(40), { failures: [], passed: true }, "token", {
      GITHUB_APP_ID: "999",
    });
    const [, init] = fetchMock.mock.calls[1];
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/repos/owner/repo/check-runs/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).not.toHaveProperty("head_sha");
  });

  it("does not treat a non-object app field as trusted check identity", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          check_runs: [{ app: "999", id: 7, name: "Keiko for Quality" }],
          total_count: 1,
        }),
      )
      .mockResolvedValueOnce(response({ id: 8 }));
    await publishCheck("owner", "repo", "a".repeat(40), { failures: [], passed: true }, "token", {
      GITHUB_APP_ID: "999",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/repos/owner/repo/check-runs");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("does not treat an absent app field as trusted check identity", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          check_runs: [
            { app: null, id: 6, name: "Keiko for Quality" },
            { id: 7, name: "Keiko for Quality" },
          ],
          total_count: 2,
        }),
      )
      .mockResolvedValueOnce(response({ id: 8 }));
    await publishCheck("owner", "repo", "a".repeat(40), { failures: [], passed: true }, "token", {
      GITHUB_APP_ID: "999",
    });
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("publishes failures and updates an existing app check", async () => {
    const headSha = "b".repeat(40);
    const runs = checkRuns(headSha);
    runs.push({ app: { id: 999 }, head_sha: headSha, id: 90, name: "Keiko for Quality" });
    const fetchMock = githubMock(headSha, { checkRuns: runs, qodoBugs: 2 });
    const waits = [];
    const state = stateBinding();
    const request = await signedRequest(
      {
        installation: { id: 42 },
        number: 2329,
        pull_request: { number: 2329 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      "test-secret",
    );
    await worker.fetch(request, environment(state), {
      waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs/90") && init?.method === "PATCH",
    );
    expect(JSON.parse(publish[1].body)).toMatchObject({
      conclusion: "failure",
      status: "completed",
    });
  });

  it("reads Qodo evidence on a merge-commit head via its parent SHA", async () => {
    const headSha = "a".repeat(40);
    const parent = "f".repeat(40);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T10:00:00.000Z"));
    // Merge-commit head (2 parents); Qodo pinned its review to the feature parent with 2 findings.
    const fetchMock = githubMock(headSha, {
      parents: [{ sha: parent }, { sha: "e".repeat(40) }],
      qodoSha: parent,
      qodoBugs: 2,
    });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "merge-head",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    const body = JSON.parse(publish[1].body);
    expect(body.conclusion).toBe("failure");
    expect(body.output.summary).toContain("Qodo has 2 unresolved finding(s).");
    const dashboardPublish = fetchMock.mock.calls.find(
      ([url, init]) =>
        /\/issues\/\d+\/comments$/u.test(new URL(String(url)).pathname) && init?.method === "POST",
    );
    const dashboard = JSON.parse(dashboardPublish[1].body).body;
    expect(dashboard).toContain("| Last evaluated head | `head aaaaaaaaaaaa` |");
    expect(dashboard).toContain("| Last evaluated | `2026-07-11T10:00:00.000Z` |");
    expect(dashboard).toContain("| Current-head evidence age | `1h` |");
    // The head commit was fetched precisely because no Qodo review bound the exact head.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /\/commits\/[0-9a-f]{40}$/u.test(new URL(String(url)).pathname),
      ),
    ).toBe(true);
  });

  it("degrades to missing Qodo evidence when the merge-parent commit read fails", async () => {
    const headSha = "a".repeat(40);
    // Head not directly bound (Qodo pinned to a parent), so the worker attempts the head-commit read
    // — which fails here. The evaluation must still publish a fail-closed verdict, not abort.
    const fetchMock = githubMock(headSha, {
      commitFails: true,
      qodoBugs: 2,
      qodoSha: "f".repeat(40),
    });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "merge-head-fetch-fails",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    expect(publish).toBeDefined();
    const body = JSON.parse(publish[1].body);
    // Missing Qodo evidence blocks as a pending check (in_progress, no conclusion) — never success.
    expect(body.conclusion).not.toBe("success");
    expect(body.output.summary).toContain("Qodo finding evidence is missing");
  });

  it("blocks a merge-commit head whose only Qodo review predates the merge", async () => {
    const headSha = "a".repeat(40);
    const parent = "f".repeat(40);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T10:00:00.000Z"));
    // The merge commit (09:30) was created AFTER Qodo's parent-pinned review (09:00), so that review
    // is stale for the merged result and must not satisfy currency.
    const fetchMock = githubMock(headSha, {
      commitDate: "2026-07-11T09:30:00.000Z",
      parents: [{ sha: parent }, { sha: "e".repeat(40) }],
      qodoBugs: 2,
      qodoSha: parent,
    });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "merge-head-stale",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    const body = JSON.parse(publish[1].body);
    // A pre-merge review is not accepted, so currency reads as missing → blocks (never success).
    expect(body.conclusion).not.toBe("success");
    expect(body.output.summary).toContain("Qodo finding evidence is missing");
    const dashboardPublish = fetchMock.mock.calls.find(
      ([url, init]) =>
        /\/issues\/\d+\/comments$/u.test(new URL(String(url)).pathname) && init?.method === "POST",
    );
    const dashboard = JSON.parse(dashboardPublish[1].body).body;
    expect(dashboard).toContain("| Current-head evidence age | unavailable (missing) |");
  });

  it("skips the head-commit fetch when a Qodo review binds the exact head", async () => {
    const headSha = "a".repeat(40);
    const fetchMock = githubMock(headSha); // default Qodo review references the head directly
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "no-parent-fetch",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    const commitFetches = fetchMock.mock.calls.filter(([url]) =>
      /\/commits\/[0-9a-f]{40}$/u.test(new URL(String(url)).pathname),
    );
    expect(commitFetches).toHaveLength(0);
  });

  it("keeps missing evidence pending and ignores its own check event", async () => {
    const headSha = "c".repeat(40);
    // No current Qodo review at all: the aggregate must stay pending, never fail terminally.
    const fetchMock = githubMock(headSha, { omitQodoComment: true });
    const waits = [];
    const state = stateBinding();
    const request = await signedRequest(
      {
        installation: { id: 42 },
        number: 2329,
        pull_request: { number: 2329 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      "test-secret",
    );
    await worker.fetch(request, environment(state), {
      waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    expect(JSON.parse(publish[1].body)).toMatchObject({ status: "in_progress" });

    const own = await signedRequest(
      {
        check_run: {
          app: { id: 999 },
          name: "Keiko for Quality",
          pull_requests: [{ number: 2329 }],
        },
        installation: { id: 42 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      "test-secret",
      "delivery-own",
    );
    own.headers.set("X-GitHub-Event", "check_run");
    const ignored = await worker.fetch(own, environment(state), {});
    expect(ignored.status).toBe(202);
    expect(await ignored.text()).toBe("ignored");
    expect(state.deliveries.has("delivery-own")).toBe(false);
  });

  it("reserves only actionable deliveries and rejects their replays", async () => {
    const state = stateBinding();
    const secret = "test-secret";
    const env = environment(state, secret);
    const payload = {
      installation: { id: 42 },
      number: 2329,
      pull_request: { number: 2329 },
      repository: { full_name: "attacker/repository" },
    };
    const unexpected = await worker.fetch(await signedRequest(payload, secret), env, {});
    expect(unexpected.status).toBe(403);
    expect(await unexpected.text()).toBe("unexpected repository");
    const repeatedUnexpected = await worker.fetch(await signedRequest(payload, secret), env, {});
    expect(repeatedUnexpected.status).toBe(403);
    expect(state.deliveries.size).toBe(0);

    const missingRepository = await signedRequest(
      { installation: { id: 42 } },
      secret,
      "missing-repository",
    );
    const absent = await worker.fetch(missingRepository, env, {});
    expect(absent.status).toBe(403);
    expect(await absent.text()).toBe("unexpected repository");

    const noPull = await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        secret,
        "delivery-no-pull",
      ),
      env,
      {},
    );
    expect(noPull.status).toBe(202);
    expect(await noPull.text()).toBe("accepted");
    expect(state.deliveries.has("delivery-no-pull")).toBe(false);

    githubMock("e".repeat(40), {
      pull: { base: { ref: "dev" }, head: { sha: "e".repeat(40) }, state: "closed" },
    });
    const actionable = { ...payload, repository: { full_name: "oscharko-dev/Keiko" } };
    const waits = [];
    const accepted = await worker.fetch(await signedRequest(actionable, secret), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(accepted.status).toBe(202);
    await Promise.all(waits);
    const replayed = await worker.fetch(await signedRequest(actionable, secret), env, {});
    expect(replayed.status).toBe(409);
    expect(await replayed.text()).toBe("replayed delivery");
    expect(state.deliveries.get("delivery-1")).toEqual(expect.any(Number));
  });

  it("atomically reserves one concurrent delivery and rejects every duplicate", async () => {
    const database = stateBinding();
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => reserveDelivery(database, "same-delivery", 1_000)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(database.deliveries.get("same-delivery")).toBe(86_401_000);
  });

  it("accepts only exact D1 reservation change counts", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [result, expected] of [
      [{ meta: { changes: 0 } }, false],
      [{ meta: { changes: 1 } }, true],
      [{ meta: { changes: -1 } }, false],
      [{ meta: { changes: 2 } }, false],
      [{}, false],
      [undefined, false],
    ]) {
      await expect(reserveDelivery(databaseWithResult(result), "delivery-result")).resolves.toBe(
        expected,
      );
    }
    expect(errorLog).toHaveBeenCalledTimes(4);
    expect(errorLog).toHaveBeenNthCalledWith(
      1,
      "reserveDelivery failed errorKind=UnexpectedChangeCount",
    );
    expect(errorLog).toHaveBeenNthCalledWith(
      2,
      "reserveDelivery failed errorKind=UnexpectedChangeCount",
    );
  });

  it("fails closed and redacts D1 delivery reservation failures", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database = stateBinding();
    database.prepare.mockImplementationOnce(() => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn().mockRejectedValue(new Error("sensitive endpoint write conflict")),
      };
      return statement;
    });
    database.prepare.mockImplementationOnce(() => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn().mockRejectedValue("opaque sensitive failure"),
      };
      return statement;
    });
    database.prepare.mockImplementationOnce(() => {
      const statement = {
        bind: vi.fn(() => statement),
        run: vi.fn().mockResolvedValue({ meta: {} }),
      };
      return statement;
    });

    await expect(reserveDelivery(database, "failed-1")).resolves.toBe(false);
    await expect(reserveDelivery(database, "failed-2")).resolves.toBe(false);
    await expect(reserveDelivery(database, "failed-3")).resolves.toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(3);
    expect(errorLog).toHaveBeenCalledWith("reserveDelivery failed errorKind=Error");
    expect(errorLog).toHaveBeenCalledWith("reserveDelivery failed errorKind=UnknownError");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive endpoint");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("opaque sensitive");
  });

  it("accepts only a signed GitHub webhook verification ping without repository data", async () => {
    const state = stateBinding();
    const secret = "test-secret";
    const ping = await signedRequest({ hook: { type: "App" } }, secret, "delivery-ping");
    ping.headers.set("X-GitHub-Event", "ping");

    const response = await worker.fetch(ping, environment(state, secret), {});

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("pong");
    expect(state.deliveries.size).toBe(0);
  });

  it("rejects malformed trust-boundary inputs before evaluation", async () => {
    const state = stateBinding();
    const env = environment(state);
    const unsigned = new Request("https://gate.example", { body: "{}", method: "POST" });
    const invalidSignature = await worker.fetch(unsigned, env, {});
    expect(invalidSignature.status).toBe(401);
    expect(await invalidSignature.text()).toBe("invalid signature");
    await expect(
      worker.fetch(unsigned, { ...env, KEIKO_FOR_QUALITY_DB: undefined }, {}),
    ).rejects.toThrow("KEIKO_FOR_QUALITY_DB");

    const invalidDelivery = await signedRequest(
      {
        installation: { id: 42 },
        pull_request: { number: 2329 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      "test-secret",
      "invalid/delivery",
    );
    const invalidDeliveryResponse = await worker.fetch(invalidDelivery, env, {});
    expect(invalidDeliveryResponse.status).toBe(409);
    expect(await invalidDeliveryResponse.text()).toBe("invalid delivery");
    expect(state.deliveries.size).toBe(0);

    const missingInstallation = await signedRequest(
      { pull_request: { number: 2329 }, repository: { full_name: "oscharko-dev/Keiko" } },
      "test-secret",
      "delivery-missing-installation",
    );
    const missingInstallationResponse = await worker.fetch(missingInstallation, env, {});
    expect(missingInstallationResponse.status).toBe(400);
    expect(await missingInstallationResponse.text()).toBe("missing installation");

    const missingDelivery = await signedRequest(
      {
        installation: { id: 42 },
        pull_request: { number: 2329 },
        repository: { full_name: "oscharko-dev/Keiko" },
      },
      "test-secret",
      "delivery-to-remove",
    );
    missingDelivery.headers.delete("X-GitHub-Delivery");
    const missingDeliveryResponse = await worker.fetch(missingDelivery, env, {});
    expect(missingDeliveryResponse.status).toBe(409);
    expect(await missingDeliveryResponse.text()).toBe("missing delivery");
  });

  it("extracts pull request numbers only from supported event shapes", () => {
    expect(pullRequestNumbers("pull_request_review", { pull_request: { number: 2 } })).toEqual([2]);
    expect(pullRequestNumbers("issue_comment", { issue: { number: 3, pull_request: {} } })).toEqual(
      [3],
    );
    expect(pullRequestNumbers("issue_comment", { issue: { number: 3 } })).toEqual([]);
    expect(
      pullRequestNumbers("check_run", { check_run: { pull_requests: [{ number: 4 }] } }),
    ).toEqual([4]);
    expect(
      pullRequestNumbers("check_suite", { check_suite: { pull_requests: [{ number: 5 }] } }),
    ).toEqual([5]);
    expect(pullRequestNumbers("unknown", {})).toEqual([]);
    expect(pullRequestNumbers("pull_request", { number: 6 })).toEqual([6]);
    expect(pullRequestNumbers("pull_request", {})).toEqual([]);
    expect(pullRequestNumbers("check_run", {})).toEqual([]);
    expect(pullRequestNumbers("check_suite", {})).toEqual([]);
    expect(pullRequestNumbers("issue_comment", {})).toEqual([]);
    expect(pullRequestNumbers("pull_request_review", { number: 7 })).toEqual([7]);
  });

  it("maps absent GitHub evidence fields without trusting implicit identities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response([
        {
          author_association: "NONE",
          body: null,
          performed_via_github_app: null,
          updated_at: "2026-07-11T09:00:00.000Z",
          user: null,
        },
      ]),
    );
    await expect(evidence("owner", "repo", 2, "token")).resolves.toEqual({
      comments: [
        {
          appId: undefined,
          author: "",
          authorAssociation: "NONE",
          authorId: undefined,
          authorType: undefined,
          body: "",
          updatedAt: "2026-07-11T09:00:00.000Z",
        },
      ],
    });
  });

  it("uses the fail-closed default stability window when the variable is absent", async () => {
    const headSha = "8".repeat(40);
    const fetchMock = githubMock(headSha);
    const state = stateBinding();
    const env = environment(state);
    delete env.STABILITY_WINDOW_MS;
    // Qodo (re)posted its review at 09:00:00; thirty seconds later the default 60-second window is
    // still open, so the aggregate must stay pending rather than turning green early.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-11T09:00:30.000Z"));
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "default-policy",
      ),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    const body = JSON.parse(publish[1].body);
    expect(body.status).toBe("in_progress");
    expect(body).not.toHaveProperty("conclusion");
    expect(body.output.summary).toContain("inside the stability window");
  });

  it("rejects a signed delivery without an event name", async () => {
    const state = stateBinding();
    const request = await signedRequest(
      { installation: { id: 42 }, repository: { full_name: "oscharko-dev/Keiko" } },
      "test-secret",
      "no-event-name",
    );
    request.headers.delete("X-GitHub-Event");
    const result = await worker.fetch(request, environment(state), { waitUntil: vi.fn() });
    expect(result.status).toBe(400);
    expect(await result.text()).toBe("missing event");
  });

  it("fails closed for invalid keys, tokens, API responses, and pull heads", async () => {
    const headSha = "e".repeat(40);
    const state = stateBinding();
    const payload = {
      installation: { id: 42 },
      number: 2329,
      pull_request: { number: 2329 },
      repository: { full_name: "oscharko-dev/Keiko" },
    };
    const waits = [];

    githubMock(headSha);
    await worker.fetch(
      await signedRequest(payload, "test-secret", "invalid-key"),
      { ...environment(state), GITHUB_PRIVATE_KEY_PKCS8: "invalid" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("PKCS#8");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, 500));
    await worker.fetch(
      await signedRequest(payload, "test-secret", "api-error"),
      environment(state),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("GitHub API 500");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}));
    await worker.fetch(
      await signedRequest(payload, "test-secret", "missing-token"),
      environment(state),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("omitted installation token");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null));
    await worker.fetch(
      await signedRequest(payload, "test-secret", "null-token"),
      environment(state),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("omitted installation token");

    vi.restoreAllMocks();
    githubMock(headSha, {
      pull: { base: { ref: "dev" }, head: { sha: "invalid" }, state: "open" },
    });
    await worker.fetch(
      await signedRequest(payload, "test-secret", "invalid-head"),
      environment(state),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("head SHA is invalid");

    for (const [delivery, pull] of [
      ["missing-head", { base: { ref: "dev" }, state: "open" }],
      [
        "object-head",
        { base: { ref: "dev" }, head: { sha: { toString: () => headSha } }, state: "open" },
      ],
      ["prefixed-head", { base: { ref: "dev" }, head: { sha: `x${headSha}` }, state: "open" }],
      ["suffixed-head", { base: { ref: "dev" }, head: { sha: `${headSha}x` }, state: "open" }],
    ]) {
      vi.restoreAllMocks();
      githubMock(headSha, { pull });
      await worker.fetch(
        await signedRequest(payload, "test-secret", delivery),
        environment(state),
        { waitUntil: (promise) => waits.push(promise) },
      );
      await expect(waits.pop()).rejects.toThrow("head SHA is invalid");
    }
  });

  it("does not evaluate ineligible, unmerged, or expired pull requests", async () => {
    const headSha = "f".repeat(40);
    const payload = {
      installation: { id: 42 },
      number: 2329,
      pull_request: { number: 2329 },
      repository: { full_name: "oscharko-dev/Keiko" },
    };
    for (const [delivery, pull] of [
      ["closed", { base: { ref: "dev" }, head: { sha: headSha }, state: "closed" }],
      [
        "expired-merged",
        {
          base: { ref: "dev" },
          head: { sha: headSha },
          merged: true,
          merged_at: "2026-07-11T09:00:00.000Z",
          state: "closed",
        },
      ],
      ["wrong-base", { base: { ref: "main" }, head: { sha: headSha }, state: "open" }],
      ["missing-base", { head: { sha: headSha }, state: "open" }],
    ]) {
      vi.restoreAllMocks();
      const fetchMock = githubMock(headSha, { pull });
      const waits = [];
      const state = stateBinding();
      trackPull(state, 2329);
      await worker.fetch(
        await signedRequest(payload, "test-secret", delivery),
        environment(state),
        { waitUntil: (promise) => waits.push(promise) },
      );
      await Promise.all(waits);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/commits/"))).toBe(false);
      expect(
        state.prepare.mock.calls.some(([query]) => query.startsWith("DELETE FROM tracked_pulls")),
      ).toBe(true);
      expect(state.tracked.has("oscharko-dev/Keiko#2329")).toBe(false);
    }
  });

  it("reconciles a merged pull through the stability window before deleting tracking", async () => {
    const headSha = "a".repeat(40);
    const mergedAt = "2026-07-11T09:00:20.000Z";
    const pull = {
      base: { ref: "dev" },
      head: { sha: headSha },
      merged: true,
      merged_at: mergedAt,
      state: "closed",
    };
    const fetchMock = githubMock(headSha, { openPulls: [], pull });
    const state = stateBinding();
    trackPull(state, 2329);
    const env = { ...environment(state), STABILITY_WINDOW_MS: "60000" };
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(mergedAt) + 10_000);
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "merged-stability",
      ),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    expect(state.tracked.has("oscharko-dev/Keiko#2329")).toBe(true);
    expect(
      fetchMock.mock.calls
        .filter(([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST")
        .map(([, init]) => JSON.parse(init.body)),
    ).toContainEqual(expect.objectContaining({ status: "in_progress" }));

    now.mockReturnValue(Date.parse(mergedAt) + 120_000);
    const scheduled = [];
    await worker.scheduled({}, env, { waitUntil: (promise) => scheduled.push(promise) });
    await Promise.all(scheduled);
    expect(state.tracked.has("oscharko-dev/Keiko#2329")).toBe(false);
    expect(
      fetchMock.mock.calls
        .filter(([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST")
        .map(([, init]) => JSON.parse(init.body)),
    ).toContainEqual(expect.objectContaining({ conclusion: "success", status: "completed" }));
  });

  it("rejects malformed paginated evidence", async () => {
    const headSha = "1".repeat(40);
    githubMock(headSha, { invalidComments: true });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "invalid-reviews",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits[0]).rejects.toThrow("Expected paginated array");
  });

  it("rejects a check-runs listing that omits runs on the publish path", async () => {
    const headSha = "3".repeat(40);
    // Evaluation no longer reads check runs; the publish path still lists them to locate an
    // existing aggregate run, and a malformed listing must surface, not be silently trusted.
    githubMock(headSha, { omitCheckRuns: true });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "omitted-checks",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits[0]).rejects.toThrow("omitted check runs");
  });

  it("loads subsequent evidence pages before evaluating", async () => {
    const headSha = "2".repeat(40);
    const fetchMock = githubMock(headSha, { paginatedComments: true });
    const waits = [];
    await worker.fetch(
      await signedRequest(
        {
          installation: { id: 42 },
          number: 2329,
          pull_request: { number: 2329 },
          repository: { full_name: "oscharko-dev/Keiko" },
        },
        "test-secret",
        "paginated-reviews",
      ),
      environment(stateBinding()),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/comments?"))).toHaveLength(
      2,
    );
  });

  it("re-evaluates tracked pull requests from the scheduled stability sweep", async () => {
    const headSha = "d".repeat(40);
    githubMock(headSha, { openPulls: [] });
    const state = stateBinding();
    trackPull(state, 2329);
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    expect(waits).toHaveLength(1);
    expect(state.prepare).toHaveBeenCalledWith(expect.stringContaining("FROM tracked_pulls"));
  });

  it("discovers open dev pull requests with their current head without relying on webhooks", async () => {
    githubMock("f".repeat(40), {
      openPulls: [
        { head: { sha: "f".repeat(40) }, number: 2397 },
        { head: { sha: "short" }, number: 2398 },
        { number: "invalid" },
      ],
    });
    await expect(discoverOpenPullRequests(environment(stateBinding()))).resolves.toEqual([
      {
        headSha: "f".repeat(40),
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 2397,
        repository: "Keiko",
      },
      {
        headSha: undefined,
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 2398,
        repository: "Keiko",
      },
    ]);
  });

  it("validates repository-specific base branches and quality profiles", () => {
    const env = {
      TARGET_REPOSITORIES_JSON: JSON.stringify([
        { baseBranch: "dev", profile: "keiko", repository: "oscharko-dev/Keiko" },
        {
          baseBranch: "main",
          profile: "keiko-native",
          repository: "oscharko-dev/Keiko-Native",
        },
      ]),
    };
    expect(targetRepositories(env)).toEqual([
      { baseBranch: "dev", profile: "keiko", repository: "oscharko-dev/Keiko" },
      {
        baseBranch: "main",
        profile: "keiko-native",
        repository: "oscharko-dev/Keiko-Native",
      },
    ]);
    expect(targetForRepository("oscharko-dev/Keiko-Native", env)).toEqual({
      baseBranch: "main",
      profile: "keiko-native",
      repository: "oscharko-dev/Keiko-Native",
    });
    expect(() => targetForRepository("outside/repository", env)).toThrow(
      "Repository is outside the quality target set.",
    );
  });

  it("discovers each configured repository on its own protected base branch", async () => {
    const fetchMock = githubMock("f".repeat(40), {
      openPulls: [{ head: { sha: "f".repeat(40) }, number: 7 }],
    });
    const env = {
      ...environment(stateBinding()),
      TARGET_REPOSITORIES_JSON: JSON.stringify([
        { baseBranch: "dev", profile: "keiko", repository: "oscharko-dev/Keiko" },
        {
          baseBranch: "main",
          profile: "keiko-native",
          repository: "oscharko-dev/Keiko-Native",
        },
      ]),
    };
    delete env.TARGET_REPOSITORY;
    await expect(discoverOpenPullRequests(env)).resolves.toEqual([
      {
        headSha: "f".repeat(40),
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 7,
        repository: "Keiko",
      },
      {
        headSha: "f".repeat(40),
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 7,
        repository: "Keiko-Native",
      },
    ]);
    const pullUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/pulls?"));
    expect(pullUrls).toEqual([
      expect.stringContaining("/repos/oscharko-dev/Keiko/pulls?state=open&base=dev"),
      expect.stringContaining("/repos/oscharko-dev/Keiko-Native/pulls?state=open&base=main"),
    ]);
  });

  it("fails closed for malformed, duplicate, or unsupported target profiles", () => {
    for (const value of ["invalid", "[]", '[{"repository":"owner/repo"}]']) {
      expect(() => targetRepositories({ TARGET_REPOSITORIES_JSON: value })).toThrow();
    }
    const duplicate = JSON.stringify([
      { baseBranch: "dev", profile: "keiko", repository: "owner/repo" },
      { baseBranch: "main", profile: "keiko-native", repository: "owner/repo" },
    ]);
    expect(() => targetRepositories({ TARGET_REPOSITORIES_JSON: duplicate })).toThrow(
      "Target repositories must be unique.",
    );
    const unsupported = JSON.stringify([
      { baseBranch: "main", profile: "unknown", repository: "owner/repo" },
    ]);
    expect(() => targetRepositories({ TARGET_REPOSITORIES_JSON: unsupported })).toThrow(
      "Unsupported quality-gate profile.",
    );
  });

  it("rejects malformed reconciliation targets and missing installation identity", async () => {
    for (const target of ["", "owner", "/repo", "owner/", "owner/repo/extra"]) {
      await expect(
        discoverOpenPullRequests({
          ...environment(stateBinding()),
          TARGET_REPOSITORY: target,
        }),
      ).rejects.toThrow("TARGET_REPOSITORY must be owner/repository.");
    }

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(null));
    await expect(discoverOpenPullRequests(environment(stateBinding()))).rejects.toThrow(
      "GitHub omitted installation ID.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules every discovered PR and deduplicates tracked discovery", async () => {
    const headSha = "9".repeat(40);
    githubMock(headSha, { openPulls: [{ number: 2329 }] });
    const state = stateBinding();
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    expect(waits).toHaveLength(1);
    await Promise.all(waits);

    vi.restoreAllMocks();
    githubMock(headSha, { openPulls: [{ number: 2329 }, { number: 2330 }] });
    trackPull(state, 2329);
    const deduplicatedWaits = [];
    await worker.scheduled({}, environment(state), {
      waitUntil: (promise) => deduplicatedWaits.push(promise),
    });
    expect(deduplicatedWaits).toHaveLength(2);
    await Promise.all(deduplicatedWaits);
  });

  it("skips settled pull requests and re-evaluates pending, changed, or backstop-due ones", async () => {
    const settledSha = "a".repeat(40);
    const movedNewSha = "c".repeat(40);
    const now = Date.parse("2026-07-11T10:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = githubMock(settledSha, {
      openPulls: [
        { head: { sha: settledSha }, number: 100 },
        { head: { sha: movedNewSha }, number: 101 },
        { head: { sha: settledSha }, number: 102 },
        { head: { sha: settledSha }, number: 103 },
      ],
    });
    const state = stateBinding();
    // 100: settled, head unchanged, evaluated within the backstop -> skipped.
    trackPull(state, 100, 42, {
      lastEvaluatedAt: now - 60_000,
      lastHeadSha: settledSha,
      settled: true,
    });
    // 101: settled, but its head moved since the last evaluation -> re-evaluated.
    trackPull(state, 101, 42, {
      lastEvaluatedAt: now - 60_000,
      lastHeadSha: "b".repeat(40),
      settled: true,
    });
    // 102: last verdict still waiting on evidence -> re-evaluated so the stability window can converge.
    trackPull(state, 102, 42, {
      lastEvaluatedAt: now - 60_000,
      lastHeadSha: settledSha,
      settled: false,
    });
    // 103: settled and unchanged, but its last evaluation is older than the backstop -> re-evaluated.
    trackPull(state, 103, 42, {
      lastEvaluatedAt: now - 2_000_000,
      lastHeadSha: settledSha,
      settled: true,
    });
    const logMock = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    expect(waits).toHaveLength(3);
    expect(logMock).toHaveBeenCalledWith("reconcile settled-skip evaluated=3 skipped=1");
    await Promise.all(waits);
    // The skipped pull request is never fetched, so no evidence, check, or comment call is spent on it.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pulls/100"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pulls/101"))).toBe(true);
  });

  it("continues tracked reconciliation and emits redacted diagnostics when discovery fails", async () => {
    const headSha = "7".repeat(40);
    const options = { openPulls: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/installation")) return Promise.reject(new Error("network-failure"));
      return Promise.resolve(githubResponse(url, init, headSha, options));
    });
    const state = stateBinding();
    trackPull(state, 2329);
    const errorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    expect(errorMock).toHaveBeenCalledWith("pull reconciliation failed errorKind=Error");
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  it("reduces reconciliation failures to a redacted error kind", () => {
    expect(reconciliationErrorKind(new TypeError("sensitive detail"))).toBe("TypeError");
    expect(reconciliationErrorKind("sensitive detail")).toBe("UnknownError");
  });

  it("continues bounded D1 pagination for persisted pull state", async () => {
    const partial = stateBinding();
    for (let pullNumber = 1; pullNumber <= 101; pullNumber += 1) trackPull(partial, pullNumber);
    expect((await trackedPullRequests(partial)).size).toBe(101);
    expect(partial.prepare).toHaveBeenCalledTimes(2);

    const state = stateBinding();
    for (let pullNumber = 1; pullNumber <= 1_000; pullNumber += 1) trackPull(state, pullNumber);
    const pulls = await trackedPullRequests(state);
    expect(pulls.size).toBe(1_000);
    expect(state.prepare).toHaveBeenCalledTimes(10);

    const overLimit = stateBinding();
    for (let pullNumber = 1; pullNumber <= 1_001; pullNumber += 1) trackPull(overLimit, pullNumber);
    await expect(trackedPullRequests(overLimit)).rejects.toThrow(
      "Tracked pull pagination limit exceeded.",
    );
  });

  it("cleans expired replay rows only on the bounded hourly sweep", async () => {
    githubMock("e".repeat(40), { openPulls: [] });
    const state = stateBinding();
    state.deliveries.set("expired", 10);
    state.deliveries.set("current", 20_000);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const waits = [];
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 6, 14, 6, 0) }, environment(state), {
      waitUntil: (promise) => waits.push(promise),
    });
    await Promise.all(waits);
    expect(state.deliveries.has("expired")).toBe(false);
    expect(state.deliveries.has("current")).toBe(true);

    state.deliveries.set("not-hourly", 10);
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 6, 14, 6, 1) }, environment(state), {
      waitUntil: vi.fn(),
    });
    expect(state.deliveries.has("not-hourly")).toBe(true);

    await expect(
      worker.scheduled(
        {},
        { ...environment(state), KEIKO_FOR_QUALITY_DB: undefined },
        {
          waitUntil: vi.fn(),
        },
      ),
    ).rejects.toThrow("KEIKO_FOR_QUALITY_DB binding is required.");
  });

  it("fails closed on absent and invalid D1 tracked-pull rows", async () => {
    const absent = stateBinding();
    absent.prepare.mockImplementationOnce(() => {
      const statement = {
        all: vi.fn().mockResolvedValue(undefined),
        bind: vi.fn(() => statement),
      };
      return statement;
    });
    await expect(trackedPullRequests(absent)).rejects.toThrow("D1 omitted tracked pull rows.");

    const invalid = stateBinding();
    invalid.prepare.mockImplementationOnce(() => {
      const statement = {
        all: vi.fn().mockResolvedValue({ results: [null] }),
        bind: vi.fn(() => statement),
      };
      return statement;
    });
    await expect(trackedPullRequests(invalid)).rejects.toThrow(
      "D1 returned an invalid tracked pull row.",
    );

    const malformed = stateBinding();
    malformed.prepare.mockImplementationOnce(() => {
      const statement = {
        all: vi.fn().mockResolvedValue({ results: [{ owner: "oscharko-dev" }] }),
        bind: vi.fn(() => statement),
      };
      return statement;
    });
    await expect(trackedPullRequests(malformed)).rejects.toThrow(
      "D1 returned an invalid tracked pull row.",
    );
  });

  it("recognizes only a missing reconcile-metadata column error", () => {
    expect(isMissingColumnError(new Error("no such column: settled"))).toBe(true);
    expect(
      isMissingColumnError(new Error("table tracked_pulls has no column named last_head_sha")),
    ).toBe(true);
    expect(isMissingColumnError(new Error("database is locked"))).toBe(false);
    expect(isMissingColumnError("no such column: settled")).toBe(false);
  });

  it("adds each reconcile-metadata column and tolerates one already present", async () => {
    const runs = [];
    const database = {
      prepare: (sql) => ({
        run: async () => {
          runs.push(sql);
          // A concurrent evaluation already added `settled`; that must not abort the migration.
          if (sql.includes("ADD COLUMN settled")) throw new Error("duplicate column name: settled");
          return { meta: {} };
        },
      }),
    };
    await expect(migrateTrackedPullColumns(database)).resolves.toBeUndefined();
    expect(runs).toEqual([
      "ALTER TABLE tracked_pulls ADD COLUMN last_head_sha TEXT",
      "ALTER TABLE tracked_pulls ADD COLUMN settled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tracked_pulls ADD COLUMN last_evaluated_at INTEGER NOT NULL DEFAULT 0",
    ]);
  });

  it("surfaces a non-duplicate schema migration failure", async () => {
    const database = {
      prepare: () => ({
        run: async () => {
          throw new Error("disk I/O error");
        },
      }),
    };
    await expect(migrateTrackedPullColumns(database)).rejects.toThrow("disk I/O error");
  });

  it("self-heals a legacy tracked_pulls schema and retries the read once", async () => {
    const altered = [];
    let migrated = false;
    const rows = [
      {
        installation_id: 42,
        last_evaluated_at: 5,
        last_head_sha: "a".repeat(40),
        owner: "oscharko-dev",
        pull_number: 2329,
        repository: "Keiko",
        settled: 1,
      },
    ];
    const database = {
      prepare: (query) => ({
        bind: () => ({
          all: async () => {
            if (!migrated) throw new Error("no such column: settled");
            return { results: rows };
          },
        }),
        run: async () => {
          altered.push(query);
          if (query.includes("last_evaluated_at")) migrated = true;
          return { meta: {} };
        },
      }),
    };
    const pulls = await trackedPullRequests(database);
    expect(altered).toEqual([
      "ALTER TABLE tracked_pulls ADD COLUMN last_head_sha TEXT",
      "ALTER TABLE tracked_pulls ADD COLUMN settled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tracked_pulls ADD COLUMN last_evaluated_at INTEGER NOT NULL DEFAULT 0",
    ]);
    expect(pulls.size).toBe(1);
    expect([...pulls.values()][0]).toMatchObject({
      lastEvaluatedAt: 5,
      lastHeadSha: "a".repeat(40),
      settled: true,
    });
  });

  it("does not migrate on a non-schema tracked-pull read error", async () => {
    const altered = [];
    const database = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("database is locked");
          },
        }),
        run: async () => {
          altered.push("altered");
          return { meta: {} };
        },
      }),
    };
    await expect(trackedPullRequests(database)).rejects.toThrow("database is locked");
    expect(altered).toEqual([]);
  });

  it("continues discovery when persisted D1 pull state is malformed", async () => {
    githubMock("e".repeat(40), { openPulls: [] });
    const state = stateBinding();
    state.prepare.mockImplementationOnce(() => {
      const statement = {
        all: vi.fn().mockResolvedValue({ results: [{ owner: "oscharko-dev" }] }),
        bind: vi.fn(() => statement),
      };
      return statement;
    });
    const errorMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    expect(waits).toEqual([]);
    expect(errorMock).toHaveBeenCalledWith("tracked pull read failed errorKind=Error");
  });
});
