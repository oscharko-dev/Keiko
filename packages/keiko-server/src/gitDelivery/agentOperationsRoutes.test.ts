import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitRepositoryAgentOperationRequest,
  GitRepositoryAgentOperationResponse,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { GitProcessRunner } from "../gitRoutes.js";
import { matchRoute, type RouteContext } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import {
  handleGitAgentOperation,
  handleGitAgentOperationWithDelegate,
  IdempotencyCache,
} from "./agentOperationsRoutes.js";

let store: UiStore;
let root: string;

function ok(stdout: string): Awaited<ReturnType<GitProcessRunner>> {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function deps(runner: GitProcessRunner = vi.fn(() => Promise.resolve(ok("")))): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    gitRouteOptions: { runner, maxDiffBytes: 64, maxStatusBytes: 4096, maxChanges: 10 },
  };
}

function ctx(body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/git/agent/operations"),
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    operation: "status",
    mode: "read",
    projectId: root,
    ...overrides,
  };
}

async function waitUntil(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  }
  throw lastError;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-agent-git-"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/git/agent/operations", () => {
  it("is registered as an exact POST route only", () => {
    const match = matchRoute("POST", "/api/git/agent/operations");
    expect(match).not.toBe("method-not-allowed");
    expect(match).toBeDefined();
    if (match === undefined || match === "method-not-allowed") {
      throw new Error("route did not resolve");
    }
    expect(match.definition.pattern).toBe("/api/git/agent/operations");
    expect(matchRoute("GET", "/api/git/agent/operations")).toBe("method-not-allowed");
    expect(matchRoute("POST", "/api/git/agent/operations/foo")).toBeUndefined();
  });

  it("denies direct shell payloads before any Git runner is called", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const result = await handleGitAgentOperation(
      ctx(request({ payload: { command: "git status", argv: ["git", "status"] } })),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "denied",
      denialReason: "unsupported-direct-shell",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects extra top-level fields and credential-shaped strings", async () => {
    expect(await handleGitAgentOperation(ctx(request({ extra: true })), deps())).toMatchObject({
      status: 400,
      body: { status: "denied", denialReason: "bad-request" },
    });
    expect(
      await handleGitAgentOperation(ctx(request({ payload: { remote: "api_keyleak" } })), deps()),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "GIT_AGENT_OPERATION_FORBIDDEN_PAYLOAD" } },
    });
  });

  it("delegates read operations to the existing Git read route", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0"));
    const result = await handleGitAgentOperation(ctx(request()), deps(runner));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "delegated",
      operation: "status",
      routeStatus: 200,
      response: { state: "available", branch: "main" },
    });
  });

  it("passes through unknown project results from delegated routes", async () => {
    const result = await handleGitAgentOperation(
      ctx(
        request({
          operation: "branch-switch",
          mode: "execute",
          idempotencyKey: "unknown-1",
          projectId: join(tmpdir(), "keiko-missing-project"),
          payload: { branchName: "main" },
        }),
      ),
      deps(),
    );

    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      status: "delegated",
      operation: "branch-switch",
      routeStatus: 404,
    });
  });

  it("requires execute idempotency and conflicts reused keys with different bodies", async () => {
    const firstBody = request({
      operation: "branch-switch",
      mode: "execute",
      idempotencyKey: "switch-1",
      payload: { branchName: "main" },
    });
    const first = await handleGitAgentOperation(ctx(firstBody), deps());
    const replay = await handleGitAgentOperation(ctx(firstBody), deps());
    const conflict = await handleGitAgentOperation(
      ctx({
        ...firstBody,
        payload: { branchName: "other" },
      }),
      deps(),
    );

    expect(first.body).toMatchObject({ status: "delegated", operation: "branch-switch" });
    expect(replay.body).toMatchObject({ status: "delegated", replay: true });
    expect(conflict).toMatchObject({
      status: 409,
      body: { status: "denied", denialReason: "idempotency-conflict" },
    });
  });

  it("reserves execute idempotency before the delegated mutation settles", async () => {
    let releaseDelegate!: () => void;
    const delegateGate = new Promise<void>((resolve) => {
      releaseDelegate = resolve;
    });
    const delegated = vi.fn(async () => {
      await delegateGate;
      return { status: 200, body: { ok: true } };
    });
    const body = request({
      operation: "branch-switch",
      mode: "execute",
      idempotencyKey: "switch-concurrent",
      payload: { branchName: "main" },
    }) as unknown as GitRepositoryAgentOperationRequest;
    const first = handleGitAgentOperationWithDelegate(body, "same-fingerprint", delegated);

    await waitUntil(() => {
      expect(delegated).toHaveBeenCalledTimes(1);
    });
    const second = handleGitAgentOperationWithDelegate(body, "same-fingerprint", delegated);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(delegated).toHaveBeenCalledTimes(1);
    releaseDelegate();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.body).toMatchObject({ status: "delegated", operation: "branch-switch" });
    expect(secondResult.body).toMatchObject({
      status: "delegated",
      operation: "branch-switch",
      replay: true,
    });
  });
});

type CacheEntry = Parameters<IdempotencyCache["set"]>[1];

describe("IdempotencyCache eviction", () => {
  const response = { schemaVersion: "1" } as unknown as GitRepositoryAgentOperationResponse;
  const settledEntry = (fingerprint: string): CacheEntry => ({ fingerprint, result: response });
  const pendingEntry = (fingerprint: string): CacheEntry => ({
    fingerprint,
    pending: Promise.resolve(response),
  });

  it("evicts the least-recently-used settled entry once over the size cap", () => {
    const cache = new IdempotencyCache({ maxEntries: 2, ttlMs: 1_000_000, now: (): number => 0 });
    cache.set("a", settledEntry("fa"));
    cache.set("b", settledEntry("fb"));
    // Touch "a" so "b" becomes the least-recently-used entry.
    expect(cache.get("a")?.fingerprint).toBe("fa");

    cache.set("c", settledEntry("fc"));

    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.fingerprint).toBe("fa");
    expect(cache.get("c")?.fingerprint).toBe("fc");
  });

  it("expires a settled entry once its TTL has elapsed", () => {
    let clockMs = 0;
    const cache = new IdempotencyCache({ maxEntries: 16, ttlMs: 1000, now: (): number => clockMs });
    cache.set("k", settledEntry("fk"));

    clockMs = 999;
    expect(cache.get("k")?.fingerprint).toBe("fk");

    clockMs = 1000;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("prunes expired settled entries when a new key is inserted", () => {
    let clockMs = 0;
    const cache = new IdempotencyCache({ maxEntries: 16, ttlMs: 1000, now: (): number => clockMs });
    cache.set("old", settledEntry("fold"));

    clockMs = 5000; // well past the TTL
    cache.set("new", settledEntry("fnew")); // insertion triggers a prune sweep

    expect(cache.size).toBe(1);
    expect(cache.get("new")?.fingerprint).toBe("fnew");
  });

  it("never evicts an in-flight reservation to make room for a settled entry", () => {
    const cache = new IdempotencyCache({ maxEntries: 1, ttlMs: 1_000_000, now: (): number => 0 });
    cache.set("pending", pendingEntry("fp"));
    cache.set("settled", settledEntry("fs"));

    expect(cache.size).toBe(1);
    expect(cache.get("pending")?.fingerprint).toBe("fp");
    expect(cache.get("settled")).toBeUndefined();
  });

  it("retains concurrent in-flight reservations even beyond the cap", () => {
    const cache = new IdempotencyCache({ maxEntries: 1, ttlMs: 1_000_000, now: (): number => 0 });
    cache.set("p1", pendingEntry("f1"));
    cache.set("p2", pendingEntry("f2"));

    expect(cache.size).toBe(2);
    expect(cache.get("p1")?.fingerprint).toBe("f1");
    expect(cache.get("p2")?.fingerprint).toBe("f2");
  });
});

describe("agent idempotency cache lifecycle through the handler", () => {
  const execute = (idempotencyKey: string): GitRepositoryAgentOperationRequest =>
    request({
      operation: "branch-switch",
      mode: "execute",
      idempotencyKey,
      payload: { branchName: "main" },
    }) as unknown as GitRepositoryAgentOperationRequest;

  it("replays a completed operation for a repeated key without re-delegating", async () => {
    const cache = new IdempotencyCache({ maxEntries: 8, ttlMs: 1_000_000 });
    const delegated = vi.fn(() => Promise.resolve({ status: 200, body: { ok: true } }));
    const body = execute("replay-1");

    const first = await handleGitAgentOperationWithDelegate(body, "fp", delegated, cache);
    const second = await handleGitAgentOperationWithDelegate(body, "fp", delegated, cache);

    expect(delegated).toHaveBeenCalledTimes(1);
    expect(first.body).toMatchObject({ status: "delegated" });
    expect(first.body).not.toMatchObject({ replay: true });
    expect(second.body).toMatchObject({ status: "delegated", replay: true });
  });

  it("bounds the cache when many distinct keys are delegated", async () => {
    const cache = new IdempotencyCache({ maxEntries: 3, ttlMs: 1_000_000 });
    const delegated = vi.fn(() => Promise.resolve({ status: 200, body: { ok: true } }));

    for (let i = 0; i < 10; i += 1) {
      await handleGitAgentOperationWithDelegate(
        execute(`bound-${String(i)}`),
        `fp-${String(i)}`,
        delegated,
        cache,
      );
    }

    expect(delegated).toHaveBeenCalledTimes(10);
    expect(cache.size).toBe(3);
  });

  it("re-delegates once the replay entry has expired from the cache", async () => {
    let clockMs = 0;
    const cache = new IdempotencyCache({ maxEntries: 8, ttlMs: 1000, now: (): number => clockMs });
    const delegated = vi.fn(() => Promise.resolve({ status: 200, body: { ok: true } }));
    const body = execute("ttl-1");

    await handleGitAgentOperationWithDelegate(body, "fp", delegated, cache);
    clockMs = 5000; // past the replay window
    const after = await handleGitAgentOperationWithDelegate(body, "fp", delegated, cache);

    expect(delegated).toHaveBeenCalledTimes(2);
    expect(after.body).toMatchObject({ status: "delegated" });
    expect(after.body).not.toMatchObject({ replay: true });
  });
});
