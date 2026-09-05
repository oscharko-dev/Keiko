import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  GitRepositoryAgentOperationKind,
  GitRepositoryAgentOperationRequest,
  GitRepositoryAgentOperationResponse,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { gitRepositoryAgentMinimumMode } from "@oscharko-dev/keiko-contracts/runtime/git-repository-agent";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { GitProcessRunner } from "../gitRoutes.js";
import { matchRoute, type RouteContext } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import {
  handleGitAgentOperation,
  handleGitAgentOperationWithDelegate,
  IdempotencyCache,
} from "./agentOperationsRoutes.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

let store: UiStore;
let root: string;

function ok(stdout: string): Awaited<ReturnType<GitProcessRunner>> {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

// An explicit "the operator configured nothing" marker. A bare `undefined` cannot express it here:
// a default parameter value is applied when `undefined` is passed, so the unconfigured case needs a
// distinct token to reach the deps object.
const NO_CEILING = "unconfigured" as const;

// The facade's autonomy gate resolves the product-wide deployment ceiling from deps and fails closed
// to `governed-assist`. These cases exercise delegation, idempotency and payload hardening rather
// than the gate itself, so they run at the ceiling that admits every operation; the gate has its own
// describe block below, which pins each rung of the ladder explicitly.
function deps(
  runner: GitProcessRunner = vi.fn(() => Promise.resolve(ok(""))),
  ceiling: CodingWorkbenchMode | typeof NO_CEILING = "autonomous-delivery",
  branch?: CodingWorkbenchAuthorityEnvelope["branch"],
): UiHandlerDeps {
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
    ...(ceiling === NO_CEILING ? {} : { codingRuntimeDeploymentCeiling: ceiling }),
    ...(ceiling === NO_CEILING
      ? {}
      : {
          gitDeliveryAuthority: permittedGitDeliveryAuthority(
            () => root,
            () => root,
            ceiling,
            branch,
          ),
        }),
  };
}

function ctx(body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    correlationId: undefined,
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
  resetServerLogger();
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

  it("denies an execute request for an unknown project before delegation", async () => {
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

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      status: "denied",
      operation: "branch-switch",
      denialReason: "autonomy-mode-denied",
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

  // F2: the facade continues the SAME request into a downstream gitDelivery route handler (it AWAITS
  // and wraps the delegate's result before this request's own response is produced — never a spawned
  // background job), so the delegated handler must see the ORIGINATING request's own correlationId,
  // not an unknown one. Drives a real execute delegation (branch-switch against the default fixture,
  // whose branch envelope does not admit "main"): the delegated local-mutation route runs its OWN
  // `gitDeliveryAuthorityDenial` check independently of the facade's outer admission and logs
  // `git.delivery.authority.denied` (reason branch-out-of-envelope) through the shared activity log —
  // a line only the DELEGATED handler emits. Asserting it carries the top-level ctx's correlationId
  // proves postContext threads the id across the internal delegation boundary (AGENTS.md §8).
  it("threads the originating request's correlationId across internal delegation to a downstream route", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const body = executeRequest("branch-switch", "delegation-correlation-1");
    const result = await handleGitAgentOperation(
      { ...ctx(body), correlationId: "9c6c8d1e-2222-4444-8888-abcdef012345" },
      deps(),
    );

    expect(result.body).toMatchObject({ status: "delegated", operation: "branch-switch" });
    const delegatedDenial = sink.events.find(
      (event) =>
        event.op === "git.delivery.authority.denied" &&
        (event.extra as { readonly reason?: string } | undefined)?.reason ===
          "branch-out-of-envelope",
    );
    expect(delegatedDenial).toBeDefined();
    expect(delegatedDenial?.correlationId).toBe("9c6c8d1e-2222-4444-8888-abcdef012345");
    // Never the sanctioned "no id available" marker: a real one was in scope the whole time.
    expect(delegatedDenial?.correlationId).not.toBe("unknown-correlation-id");
  });

  it("keeps idempotency fingerprints independent of runtime locale collation", async () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale collation must not participate in idempotency fingerprints");
    });
    try {
      const body = request({
        operation: "branch-switch",
        mode: "execute",
        idempotencyKey: "locale-independent",
        payload: { branchName: "main" },
      });

      await expect(handleGitAgentOperation(ctx(body), deps())).resolves.toMatchObject({
        body: { status: "delegated" },
      });
    } finally {
      localeCompare.mockRestore();
    }
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

// Every write the facade admits, with a payload its allowed-key set accepts. Keyed by operation so a
// new agent write kind is a compile error here rather than an untested one.
const EXECUTE_PAYLOADS: Readonly<
  Record<
    Exclude<GitRepositoryAgentOperationKind, "status" | "diff" | "branch-list">,
    Record<string, unknown>
  >
> = {
  "branch-create": { branchName: "feat/x", baseBranchName: "main", startPointRefHash: "abcdef1" },
  "branch-switch": { branchName: "main" },
  stage: { pathspecs: ["a.ts"], includeUntracked: false },
  unstage: { pathspecs: ["a.ts"] },
  commit: { message: "feat: add a thing" },
  fetch: { remote: "origin" },
  pull: { remote: "origin" },
  push: { remoteAlias: "origin", remoteBranchName: "feat/x", sourceBranchName: "feat/x" },
  "pull-request": {
    kind: "pr-create",
    ownerAndRepo: "owner/repo",
    headBranchName: "feat/x",
    baseBranchName: "main",
    title: "A title",
    description: "",
  },
  merge: {
    kind: "merge",
    ownerAndRepo: "owner/repo",
    prExternalId: "1",
    baseBranchName: "main",
    headBranchName: "feat/x",
    mergeStrategy: "squash",
  },
};

const WRITE_OPERATIONS = Object.keys(
  EXECUTE_PAYLOADS,
) as readonly (keyof typeof EXECUTE_PAYLOADS)[];

function executeRequest(
  operation: keyof typeof EXECUTE_PAYLOADS,
  idempotencyKey = `${operation}-1`,
): Record<string, unknown> {
  return request({
    operation,
    mode: "execute",
    idempotencyKey,
    payload: EXECUTE_PAYLOADS[operation],
  });
}

// The facade is the door an AGENT walks through to write to the user's repository. Before this gate
// the only server-level admission for a state-changing POST was the loopback CSRF header: no autonomy
// mode and no Authority Envelope was consulted anywhere on the git-delivery routes or on this facade,
// so an agent could stage, commit, push, open a pull request and merge with no accepted authority at
// all. The gate resolves the SERVER-OWNED product-wide ceiling and fails closed when none is
// configured (ADR-0129 modes, ADR-0138 monotonic semantics).
describe("agent facade — autonomy admission (fail-closed)", () => {
  it.each(CODING_WORKBENCH_MODES)(
    "requires the verified runtime commit service instead of delegating to manual commit in %s",
    async (mode) => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
      const result = await handleGitAgentOperation(
        {
          ...ctx(executeRequest("commit", `unverified-${mode}`)),
          correlationId: "commit-boundary",
        },
        deps(runner, mode),
      );
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ status: "denied", operation: "commit" });
      expect(runner).not.toHaveBeenCalled();
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          op: "git.delivery.authority.denied",
          correlationId: "commit-boundary",
          extra: { operation: "commit", phase: "admission", reason: "verified-commit-required" },
        }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("add a thing");
      expect(JSON.stringify(sink.events)).not.toContain(root);
    },
  );

  it.each(WRITE_OPERATIONS)(
    "denies %s execute when no deployment ceiling is configured, without delegating",
    async (operation) => {
      const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
      const result = await handleGitAgentOperation(
        ctx(executeRequest(operation)),
        deps(runner, NO_CEILING),
      );

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({
        status: "denied",
        denialReason: "autonomy-mode-denied",
        operation,
      });
      expect(runner).not.toHaveBeenCalled();
    },
  );

  // The expectation is DERIVED from the production rule table: whichever operations that table puts
  // above supervised-coding (or, since KEIKO-0227, never admit through this boolean facade at all —
  // gitRepositoryAgentMinimumMode returns undefined for repository-delivery operations) must be
  // denied there, and whichever it puts at or below must be admitted.
  it.each(WRITE_OPERATIONS)("honours the ladder for %s at supervised-coding", async (operation) => {
    const minimum = gitRepositoryAgentMinimumMode(operation);
    const admitted =
      minimum !== undefined &&
      CODING_WORKBENCH_MODES.indexOf(minimum) <=
        CODING_WORKBENCH_MODES.indexOf("supervised-coding");
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const result = await handleGitAgentOperation(
      ctx(executeRequest(operation, `${operation}-supervised`)),
      deps(runner, "supervised-coding"),
    );

    expect(result.body).toMatchObject({ status: admitted ? "delegated" : "denied" });
    if (!admitted) {
      expect(result.status).toBe(403);
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it("routes an accepted autonomous push to its downstream policy and approval gate", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const body = executeRequest("push", "push-autonomous");
    body.payload = {
      remoteAlias: "origin",
      sourceBranchName: "feat/x",
      remoteBranchName: "feat/x",
    };
    const result = await handleGitAgentOperation(
      ctx(body),
      deps(runner, "autonomous-delivery", {
        headRef: "feat/x",
        baseRef: "dev",
        allowDetachedHead: false,
        allowedPrefixes: ["feat/"],
      }),
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      status: "delegated",
      operation: "push",
    });
  });

  it("routes an accepted autonomous merge to its downstream approval gate", async () => {
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const result = await handleGitAgentOperation(
      ctx(executeRequest("merge", "merge-facade-approval-required")),
      deps(runner, "autonomous-delivery", {
        headRef: "feat/x",
        baseRef: "main",
        allowDetachedHead: false,
        allowedPrefixes: ["feat/"],
      }),
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      status: "delegated",
      operation: "merge",
    });
  });

  it.each(["read", "preview"] as const)(
    "always admits %s mode at the fail-closed default ceiling",
    async (mode) => {
      const runner = vi
        .fn<GitProcessRunner>()
        .mockResolvedValueOnce(ok(`${root}\n`))
        .mockResolvedValueOnce(ok("## main\0"));
      const body =
        mode === "read"
          ? request()
          : request({ operation: "commit", mode: "preview", payload: { messageDraft: "feat: x" } });
      const result = await handleGitAgentOperation(ctx(body), deps(runner, NO_CEILING));

      expect(result.body).toMatchObject({ status: "delegated" });
    },
  );

  it("does not consume the idempotency slot when the gate denies", async () => {
    const body = executeRequest("branch-switch", "gate-then-admit");
    const blocked = await handleGitAgentOperation(ctx(body), deps(undefined, NO_CEILING));
    const admitted = await handleGitAgentOperation(ctx(body), deps(undefined, "supervised-coding"));

    expect(blocked.body).toMatchObject({ status: "denied", denialReason: "autonomy-mode-denied" });
    expect(admitted.body).toMatchObject({ status: "delegated" });
    expect(admitted.body).not.toMatchObject({ replay: true });
  });

  it("denies an execute request for an unresolved workspace before idempotency or delegation", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const runner = vi.fn<GitProcessRunner>(() => Promise.resolve(ok("")));
    const body = executeRequest("branch-switch", "unknown-workspace-idempotency");
    body.projectId = "/not-a-registered-workspace";
    const result = await handleGitAgentOperation(
      { ...ctx(body), correlationId: "717cfe41-510a-4f53-aa43-a48c6829452d" },
      deps(runner, "autonomous-delivery"),
    );

    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ status: "denied", denialReason: "autonomy-mode-denied" });
    expect(runner).not.toHaveBeenCalled();
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        category: "security",
        op: "git.delivery.authority.denied",
        correlationId: "717cfe41-510a-4f53-aa43-a48c6829452d",
        status: 403,
        extra: {
          operation: "branch-switch",
          phase: "admission",
          reason: "workspace-unresolvable",
        },
      }),
    );
  });

  it("keeps the denial content-free", async () => {
    const result = await handleGitAgentOperation(
      ctx(executeRequest("commit", "content-free")),
      deps(undefined, NO_CEILING),
    );
    const body = result.body as { readonly message: string };

    expect(body.message).not.toContain("add a thing");
    expect(body.message).not.toContain(root);
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
