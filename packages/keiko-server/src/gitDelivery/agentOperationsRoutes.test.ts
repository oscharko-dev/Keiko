import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { GitProcessRunner } from "../gitRoutes.js";
import { matchRoute, type RouteContext } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { handleGitAgentOperation } from "./agentOperationsRoutes.js";

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
    expect(
      await handleGitAgentOperation(ctx(request({ extra: true })), deps()),
    ).toMatchObject({
      status: 400,
      body: { status: "denied", denialReason: "bad-request" },
    });
    expect(
      await handleGitAgentOperation(
        ctx(request({ payload: { remote: "api_keyleak" } })),
        deps(),
      ),
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
});
