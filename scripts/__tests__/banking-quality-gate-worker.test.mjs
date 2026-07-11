import { createHmac, webcrypto } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker, {
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
            user: { login: "reviewer" },
          }))
        : [],
    );
  }
  return response([{ commit_id: headSha, state: "COMMENTED", user: { login: "gitar-bot[bot]" } }]);
}

function commentsResponse() {
  return response([
    {
      author_association: "NONE",
      body: "0 resolved / 0 findings",
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { login: "gitar-bot[bot]" },
    },
    {
      author_association: "NONE",
      body: "[!WARNING] https://socket.dev/npm/package/execa/overview/9.6.1",
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { login: "socket-security[bot]" },
    },
    {
      author_association: "MEMBER",
      body: "@SocketSecurity ignore npm/execa@9.6.1",
      updated_at: "2026-07-11T09:00:00.000Z",
      user: { login: "oscharko" },
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
  it("accepts only an exact SHA-256 webhook signature", async () => {
    const body = '{"repository":{"full_name":"oscharko-dev/Keiko"}}';
    const secret = "test-secret";
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    await expect(verifyWebhookSignature(body, `sha256=${digest}`, secret)).resolves.toBe(true);
    await expect(verifyWebhookSignature(`${body}x`, `sha256=${digest}`, secret)).resolves.toBe(
      false,
    );
    await expect(verifyWebhookSignature(body, "sha1=invalid", secret)).resolves.toBe(false);
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
    await Promise.all(waits);
    const publish = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs") && init?.method === "POST",
    );
    expect(JSON.parse(publish[1].body)).toMatchObject({
      conclusion: "success",
      head_sha: headSha,
      name: "Banking Quality Gate",
      status: "completed",
    });
    expect(state.put).toHaveBeenCalledWith(expect.stringContaining("pull:"), expect.any(String));
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
    expect((await worker.fetch(own, environment(state), {})).status).toBe(202);
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
    expect((await worker.fetch(await signedRequest(payload, secret), env, {})).status).toBe(403);
    expect((await worker.fetch(await signedRequest(payload, secret), env, {})).status).toBe(409);
  });

  it("rejects malformed trust-boundary inputs before evaluation", async () => {
    const state = stateBinding();
    const env = environment(state);
    const unsigned = new Request("https://gate.example", { body: "{}", method: "POST" });
    expect((await worker.fetch(unsigned, env, {})).status).toBe(401);
    await expect(
      worker.fetch(unsigned, { ...env, BANKING_GATE_STATE: undefined }, {}),
    ).rejects.toThrow("BANKING_GATE_STATE");

    const missingInstallation = await signedRequest(
      { pull_request: { number: 2329 }, repository: { full_name: "oscharko-dev/Keiko" } },
      "test-secret",
      "delivery-missing-installation",
    );
    expect((await worker.fetch(missingInstallation, env, {})).status).toBe(400);

    const missingDelivery = await signedRequest(
      { repository: { full_name: "oscharko-dev/Keiko" } },
      "test-secret",
      "delivery-to-remove",
    );
    missingDelivery.headers.delete("X-GitHub-Delivery");
    expect((await worker.fetch(missingDelivery, env, {})).status).toBe(409);
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
    githubMock(headSha, {
      pull: { base: { ref: "dev" }, head: { sha: "invalid" }, state: "open" },
    });
    await worker.fetch(
      await signedRequest(payload, "test-secret", "invalid-head"),
      environment(state),
      { waitUntil: (promise) => waits.push(promise) },
    );
    await expect(waits.pop()).rejects.toThrow("head SHA is invalid");
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
    ]) {
      vi.restoreAllMocks();
      const fetchMock = githubMock(headSha, { pull });
      const waits = [];
      await worker.fetch(
        await signedRequest(payload, "test-secret", delivery),
        environment(stateBinding()),
        { waitUntil: (promise) => waits.push(promise) },
      );
      await Promise.all(waits);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/commits/"))).toBe(false);
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
  });
});
