import { createHmac, webcrypto } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker, {
  allPages,
  appJwt,
  base64Url,
  bytesFromHex,
  constantTimeEqual,
  evidence,
  github,
  hardFailure,
  importAppKey,
  importWebhookKey,
  isValidHeadSha,
  isOwnCheckEvent,
  parseJson,
  parseStabilityMs,
  parseTrackedPull,
  privateKeyBytes,
  publishCheck,
  pullRequestNumbers,
  verifyWebhookSignature,
} from "../banking-quality-gate-worker.mjs";
import { requiredChecks } from "../banking-quality-gate-core.mjs";

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

function checkRuns(headSha) {
  return requiredChecks.map(({ appId, name }, index) => ({
    app: { id: appId },
    completed_at: "2026-07-11T09:00:00.000Z",
    conclusion: "success",
    head_sha: headSha,
    id: index + 1,
    name,
    started_at: "2026-07-11T08:59:00.000Z",
    status: "completed",
  }));
}

function reviewsResponse(url, headSha, options) {
  if (options.invalidReviews) return response({ unexpected: true });
  if (options.paginatedReviews) {
    const page = new URL(url).searchParams.get("page");
    return response(
      page === "1"
        ? Array.from({ length: 100 }, () => ({
            commit_id: headSha,
            state: "COMMENTED",
            user: { id: 2, login: "reviewer", type: "User" },
          }))
        : [],
    );
  }
  return response([
    {
      commit_id: headSha,
      state: "COMMENTED",
      user: { id: 159877585, login: "gitar-bot[bot]", type: "Bot" },
    },
  ]);
}

function commentsResponse() {
  return response([
    {
      author_association: "NONE",
      body: "0 resolved / 0 findings",
      performed_via_github_app: { id: 827041 },
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { id: 159877585, login: "gitar-bot[bot]", type: "Bot" },
    },
    {
      author_association: "NONE",
      body: "[!WARNING] https://socket.dev/npm/package/execa/overview/9.6.1",
      performed_via_github_app: { id: 156372 },
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { id: 95510084, login: "socket-security[bot]", type: "Bot" },
    },
    {
      author_association: "MEMBER",
      body: "@SocketSecurity ignore npm/execa@9.6.1",
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { id: 1, login: "oscharko", type: "User" },
    },
  ]);
}

function checksResponse(headSha, options) {
  if (options.omitCheckRuns) return response({});
  return response({ check_runs: options.checkRuns ?? checkRuns(headSha) });
}

function pullResponse(headSha, options) {
  return response(options.pull ?? { base: { ref: "dev" }, head: { sha: headSha }, state: "open" });
}

function checkWriteResponse(path, method) {
  if (path.endsWith("/check-runs") && method === "POST") return response({ id: 99 });
  if (/\/check-runs\/\d+$/u.test(path) && method === "PATCH") return response({ id: 99 });
  return undefined;
}

function githubMock(headSha, options = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const path = new URL(url).pathname;
    if (path.includes("/access_tokens")) return response({ token: "installation-token" });
    if (path.endsWith("/pulls/2329")) return pullResponse(headSha, options);
    if (path.endsWith("/reviews")) return reviewsResponse(url, headSha, options);
    if (path.endsWith("/comments")) return commentsResponse();
    if (path.includes(`/commits/${headSha}/check-runs`)) return checksResponse(headSha, options);
    const writeResponse = checkWriteResponse(path, init?.method);
    if (writeResponse !== undefined) return writeResponse;
    throw new Error(`Unexpected GitHub request: ${String(url)}`);
  });
}

function stateBinding() {
  const values = new Map();
  return {
    get: vi.fn(async (key) => values.get(key) ?? null),
    delete: vi.fn(async (key) => values.delete(key)),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
    put: vi.fn(async (key, value) => values.set(key, value)),
  };
}

function environment(state, secret = "test-secret") {
  return {
    BANKING_GATE_STATE: state,
    GITHUB_APP_ID: "999",
    GITHUB_PRIVATE_KEY_PKCS8: signingKey,
    GITHUB_WEBHOOK_SECRET: secret,
    SOCKET_RISK_ALLOWLIST_JSON: '["npm/execa@9.6.1"]',
    SOCKET_RISK_ACTORS_JSON: '["oscharko"]',
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

describe("Banking Quality Gate worker trust boundary", () => {
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
          "User-Agent": "keiko-banking-quality-gate",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
        method: "DELETE",
      }),
    );
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

  it("classifies only exact hard failures", () => {
    for (const failure of [
      "Wrong producer for ci.",
      "Gitar has an active CHANGES_REQUESTED review for the current head.",
      "Gitar has 1 unresolved finding(s).",
      "1 Socket warning(s) remain.",
      "Socket reports an error alert.",
      "Check is not successful: ci.",
    ]) {
      expect(hardFailure(["soft", failure])).toBe(true);
    }
    expect(hardFailure([])).toBe(false);
    expect(hardFailure(["Missing current-head check: ci."])).toBe(false);
  });

  it("matches only this app's exact check event", () => {
    const env = { GITHUB_APP_ID: "999" };
    const payload = { check_run: { app: { id: 999 }, name: "Banking Quality Gate" } };
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
      isOwnCheckEvent("check_run", { check_run: { app: null, name: "Banking Quality Gate" } }, env),
    ).toBe(false);
    expect(isOwnCheckEvent("check_run", { check_run: { name: "Banking Quality Gate" } }, env)).toBe(
      false,
    );
    expect(
      isOwnCheckEvent(
        "check_run",
        { check_run: { app: "999", name: "Banking Quality Gate" } },
        env,
      ),
    ).toBe(false);
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
      name: "Banking Quality Gate",
      output: {
        summary: "All current-head Banking Quality Gate evidence is valid.",
        title: "Banking Quality Gate",
      },
      status: "completed",
    });
    expect(state.put).toHaveBeenCalledWith(
      "pull:oscharko-dev/Keiko/2329",
      JSON.stringify({
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 2329,
        repository: "Keiko",
      }),
      { expirationTtl: 2_592_000 },
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
            summary: "All current-head Banking Quality Gate evidence is valid.",
            title: "Banking Quality Gate",
          },
          status: "completed",
        },
      ],
      [
        { failures: ["Wrong producer for ci.", "second failure"], passed: false },
        {
          conclusion: "failure",
          output: {
            summary: "Wrong producer for ci.\nsecond failure",
            title: "Banking Quality Gate",
          },
          status: "completed",
        },
      ],
      [
        { failures: ["Missing current-head check: ci.", "waiting"], passed: false },
        {
          output: {
            summary: "Missing current-head check: ci.\nwaiting",
            title: "Banking Quality Gate",
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
              { app: { id: 1 }, id: 1, name: "Banking Quality Gate" },
              { app: { id: 999 }, id: 2, name: "Other" },
            ],
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
        name: "Banking Quality Gate",
      });
    }
  });

  it("patches only this app's existing check without sending a head SHA", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ check_runs: [{ app: { id: 999 }, id: 7, name: "Banking Quality Gate" }] }),
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
        response({ check_runs: [{ app: "999", id: 7, name: "Banking Quality Gate" }] }),
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
            { app: null, id: 6, name: "Banking Quality Gate" },
            { id: 7, name: "Banking Quality Gate" },
          ],
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
    runs[0] = { ...runs[0], conclusion: "failure" };
    runs.push({ app: { id: 999 }, head_sha: headSha, id: 90, name: "Banking Quality Gate" });
    const fetchMock = githubMock(headSha, { checkRuns: runs });
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

  it("keeps missing evidence pending and ignores its own check event", async () => {
    const headSha = "c".repeat(40);
    const fetchMock = githubMock(headSha, { checkRuns: checkRuns(headSha).slice(1) });
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
          name: "Banking Quality Gate",
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
  });

  it("rejects replayed and unexpected-repository webhook deliveries", async () => {
    const state = stateBinding();
    const secret = "test-secret";
    const env = {
      BANKING_GATE_STATE: state,
      GITHUB_WEBHOOK_SECRET: secret,
      TARGET_REPOSITORY: "oscharko-dev/Keiko",
    };
    const payload = {
      installation: { id: 42 },
      number: 2329,
      pull_request: { number: 2329 },
      repository: { full_name: "attacker/repository" },
    };
    const unexpected = await worker.fetch(await signedRequest(payload, secret), env, {});
    expect(unexpected.status).toBe(403);
    expect(await unexpected.text()).toBe("unexpected repository");
    const replayed = await worker.fetch(await signedRequest(payload, secret), env, {});
    expect(replayed.status).toBe(409);
    expect(await replayed.text()).toBe("replayed delivery");
    expect(state.put).toHaveBeenCalledWith("delivery:delivery-1", "1", {
      expirationTtl: 86_400,
    });

    const missingRepository = await signedRequest(
      { installation: { id: 42 } },
      secret,
      "missing-repository",
    );
    const absent = await worker.fetch(missingRepository, env, {});
    expect(absent.status).toBe(403);
    expect(await absent.text()).toBe("unexpected repository");
  });

  it("rejects malformed trust-boundary inputs before evaluation", async () => {
    const state = stateBinding();
    const env = environment(state);
    const unsigned = new Request("https://gate.example", { body: "{}", method: "POST" });
    const invalidSignature = await worker.fetch(unsigned, env, {});
    expect(invalidSignature.status).toBe(401);
    expect(await invalidSignature.text()).toBe("invalid signature");
    await expect(
      worker.fetch(unsigned, { ...env, BANKING_GATE_STATE: undefined }, {}),
    ).rejects.toThrow("BANKING_GATE_STATE");

    const missingInstallation = await signedRequest(
      { pull_request: { number: 2329 }, repository: { full_name: "oscharko-dev/Keiko" } },
      "test-secret",
      "delivery-missing-installation",
    );
    const missingInstallationResponse = await worker.fetch(missingInstallation, env, {});
    expect(missingInstallationResponse.status).toBe(400);
    expect(await missingInstallationResponse.text()).toBe("missing installation");

    const missingDelivery = await signedRequest(
      { repository: { full_name: "oscharko-dev/Keiko" } },
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
    const headSha = "4".repeat(40);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          check_runs: [
            {
              app: null,
              completed_at: null,
              conclusion: null,
              head_sha: headSha,
              name: "ci",
              started_at: null,
              status: "queued",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response([{ commit_id: headSha, state: "COMMENTED", user: null }]))
      .mockResolvedValueOnce(
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
    await expect(evidence("owner", "repo", 2, headSha, "token")).resolves.toEqual({
      checks: [
        {
          appId: undefined,
          completedAt: null,
          conclusion: null,
          headSha,
          name: "ci",
          startedAt: null,
          status: "queued",
        },
      ],
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
      reviews: [
        { authorId: undefined, authorType: undefined, commitSha: headSha, state: "COMMENTED" },
      ],
    });
  });

  it("rejects null current-head evidence instead of trusting optional fields", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    await expect(evidence("owner", "repo", 2, "a".repeat(40), "token")).rejects.toThrow(
      "omitted check runs",
    );
  });

  it("uses fail-closed defaults when optional policy environment values are absent", async () => {
    const headSha = "8".repeat(40);
    const fetchMock = githubMock(headSha);
    const state = stateBinding();
    const env = environment(state);
    delete env.SOCKET_RISK_ALLOWLIST_JSON;
    delete env.SOCKET_RISK_ACTORS_JSON;
    delete env.STABILITY_WINDOW_MS;
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
    expect(JSON.parse(publish[1].body)).toMatchObject({
      conclusion: "failure",
      status: "completed",
    });
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

  it("does not evaluate closed pull requests or pull requests targeting another branch", async () => {
    const headSha = "f".repeat(40);
    const payload = {
      installation: { id: 42 },
      number: 2329,
      pull_request: { number: 2329 },
      repository: { full_name: "oscharko-dev/Keiko" },
    };
    for (const [delivery, pull] of [
      ["closed", { base: { ref: "dev" }, head: { sha: headSha }, state: "closed" }],
      ["wrong-base", { base: { ref: "main" }, head: { sha: headSha }, state: "open" }],
      ["missing-base", { head: { sha: headSha }, state: "open" }],
    ]) {
      vi.restoreAllMocks();
      const fetchMock = githubMock(headSha, { pull });
      const waits = [];
      const state = stateBinding();
      await worker.fetch(
        await signedRequest(payload, "test-secret", delivery),
        environment(state),
        { waitUntil: (promise) => waits.push(promise) },
      );
      await Promise.all(waits);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/commits/"))).toBe(false);
      expect(state.delete).toHaveBeenCalledWith(expect.stringContaining("pull:"));
    }
  });

  it("rejects malformed paginated evidence", async () => {
    const headSha = "1".repeat(40);
    githubMock(headSha, { invalidReviews: true });
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

  it("rejects a GitHub response that omits current-head checks", async () => {
    const headSha = "3".repeat(40);
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
    const fetchMock = githubMock(headSha, { paginatedReviews: true });
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
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/reviews?")).length).toBe(
      2,
    );
  });

  it("re-evaluates tracked pull requests from the scheduled stability sweep", async () => {
    const headSha = "d".repeat(40);
    githubMock(headSha);
    const state = stateBinding();
    state.get.mockResolvedValueOnce(
      JSON.stringify({
        installationId: 42,
        owner: "oscharko-dev",
        pullNumber: 2329,
        repository: "Keiko",
      }),
    );
    state.list.mockResolvedValueOnce({ keys: [{ name: "pull:tracked" }], list_complete: true });
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    expect(waits).toHaveLength(1);
    expect(state.list).toHaveBeenCalledWith({ cursor: undefined, prefix: "pull:" });
  });

  it("continues scheduled pagination with the exact pull-state prefix", async () => {
    const state = stateBinding();
    state.list
      .mockResolvedValueOnce({ cursor: "next", keys: [], list_complete: false })
      .mockResolvedValueOnce({ keys: [], list_complete: true });
    await worker.scheduled({}, environment(state), { waitUntil: vi.fn() });
    expect(state.list.mock.calls).toEqual([
      [{ cursor: undefined, prefix: "pull:" }],
      [{ cursor: "next", prefix: "pull:" }],
    ]);
  });

  it("continues a scheduled sweep past missing, malformed, and invalid state", async () => {
    const state = stateBinding();
    state.list.mockResolvedValueOnce({
      keys: [{ name: "pull:missing" }, { name: "pull:malformed" }, { name: "pull:invalid" }],
      list_complete: true,
    });
    state.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("{")
      .mockResolvedValueOnce(JSON.stringify({ owner: "oscharko-dev" }));
    const waits = [];
    await worker.scheduled({}, environment(state), { waitUntil: (promise) => waits.push(promise) });
    expect(waits).toEqual([]);
    expect(state.delete).toHaveBeenCalledTimes(2);
  });
});
