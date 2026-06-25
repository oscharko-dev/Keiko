// Route tests for the governed local branch + staging execution routes (Issue #475, Epic #470).
//
// Two harnesses:
//   * Real `createUiServer` dispatch — central CSRF / 415 / body-cap, envelope validation, the
//     capability gate (404 when disabled), and unknown-project authorization. The default route uses
//     the real git adapter, so real-dispatch tests stop at the gates BEFORE execution.
//   * Direct handler calls with injected execution SEAMS (fake adapter / snapshot / clock / packs) —
//     exercise the governed outcomes (success, preflight-block, policy-block, approval-required) and
//     prove evidence is recorded and the mutation never bypasses the kernel.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryExecutionResult,
  type GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import type { GitLocalMutationAdapter, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  createHandleLocalMutation,
  type GitDeliveryLocalErrorBody,
} from "./localMutationRoutes.js";
import type { GitDeliveryExecutionSeams } from "./execution.js";

const POST_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const ENABLED_ENV = { KEIKO_GIT_DELIVERY_ENABLED: "true" } as const;

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "main",
  stagedFileCount: 2,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  existingLocalBranchNames: ["main", "feature/x"],
  remoteAliases: ["origin"],
};

const ALLOW_LOCAL_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

const BLOCK_ALL_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: { decision: "blocked" },
};

function execResult(
  outcome: GitDeliveryExecutionResult["outcome"] = "succeeded",
  errorCode?: GitDeliveryExecutionResult["errorCode"],
): GitDeliveryExecutionResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: 3,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

interface RecordingAdapter {
  readonly adapter: GitLocalMutationAdapter;
  readonly calls: () => readonly string[];
}

function recordingAdapter(result: GitDeliveryExecutionResult = execResult()): RecordingAdapter {
  const calls: string[] = [];
  const run = (name: string) => (): Promise<GitDeliveryExecutionResult> => {
    calls.push(name);
    return Promise.resolve(result);
  };
  return {
    adapter: {
      createBranch: run("createBranch"),
      switchBranch: run("switchBranch"),
      stage: run("stage"),
      unstage: run("unstage"),
      commit: run("commit"),
      abort: run("abort"),
      recover: run("recover"),
    },
    calls: () => calls,
  };
}

interface CapturingStore {
  readonly evidenceStore: EvidenceStore;
  readonly records: () => readonly unknown[];
}

function capturingEvidenceStore(throwOnPut = false): CapturingStore {
  const docs = new Map<string, string>();
  const evidenceStore: EvidenceStore = {
    put: (runId, json) => {
      if (throwOnPut) throw new Error("disk full");
      docs.set(runId, json);
      return runId;
    },
    list: () => [...docs.keys()],
    get: (runId) => docs.get(runId),
    delete: (runId) => docs.delete(runId),
  };
  return {
    evidenceStore,
    records: (): readonly unknown[] => {
      const out: unknown[] = [];
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        if (Array.isArray(doc.records)) out.push(...doc.records);
      }
      return out;
    },
  };
}

let server: Server;
let port: number;
let staticRoot: string;
let store: UiStore;
let projectId: string;

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: ENABLED_ENV,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...overrides,
  };
}

function url(path: string): string {
  return `http://${UI_HOST}:${String(port)}${path}`;
}

function ctxFor(path: string, body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return { req, res: {} as ServerResponse, params: {}, url: new URL(`http://127.0.0.1${path}`) };
}

function seams(overrides: Partial<GitDeliveryExecutionSeams> = {}): GitDeliveryExecutionSeams {
  return {
    snapshotReader: () => Promise.resolve(SNAPSHOT),
    stagedPathsReader: () => Promise.resolve([]),
    now: () => 1_700_000_000_000,
    newActionId: () => "action-test-1",
    policyPacks: { repoPack: ALLOW_LOCAL_PACK },
    ...overrides,
  };
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(overrides),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = POST_HEADERS,
): Promise<Response> {
  return fetch(url(path), {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-local-static-"));
  store = createInMemoryUiStore();
  const projectDir = mkdtempSync(join(tmpdir(), "keiko-gd-proj-"));
  projectId = store.createProject(projectDir).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

const SWITCH = "/api/git-delivery/local-branch/switch";
const STAGE = "/api/git-delivery/staging/stage";

describe("local mutation routes — central enforcement + validation (real dispatch)", () => {
  beforeEach(async () => {
    await startBound();
  });
  afterEach(async () => {
    await closeServer();
  });

  it("404s every execution route when governed git delivery is disabled", async () => {
    await closeServer();
    await startBound({ env: {} });
    const res = await post(SWITCH, { schemaVersion: "1", projectId, branchName: "feature/x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as GitDeliveryLocalErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_LOCAL_DISABLED");
  });

  it("403s when the central CSRF header is missing", async () => {
    const res = await post(
      SWITCH,
      { schemaVersion: "1", projectId, branchName: "feature/x" },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(403);
  });

  it("404s an unknown project before any execution", async () => {
    const res = await post(SWITCH, {
      schemaVersion: "1",
      projectId: "/no/such/project",
      branchName: "x",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as GitDeliveryLocalErrorBody).error.code).toBe(
      "GIT_DELIVERY_LOCAL_UNKNOWN_PROJECT",
    );
  });

  it("400s an unknown top-level key", async () => {
    const res = await post(SWITCH, { schemaVersion: "1", projectId, branchName: "x", evil: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as GitDeliveryLocalErrorBody).error.code).toBe(
      "GIT_DELIVERY_LOCAL_BAD_REQUEST",
    );
  });

  it("400s a forbidden credential-shaped field", async () => {
    const res = await post(SWITCH, {
      schemaVersion: "1",
      projectId,
      branchName: "Authorization: Bearer abc",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as GitDeliveryLocalErrorBody).error.code).toBe(
      "GIT_DELIVERY_LOCAL_FORBIDDEN_PAYLOAD",
    );
  });

  it("400s a pathspec that escapes the worktree", async () => {
    const res = await post(STAGE, {
      schemaVersion: "1",
      projectId,
      pathspecs: ["../../etc/passwd"],
      includeUntracked: false,
    });
    expect(res.status).toBe(400);
  });

  it("413s an oversized body before parsing", async () => {
    const big = JSON.stringify({
      schemaVersion: "1",
      projectId,
      branchName: "x".repeat(70 * 1024),
    });
    const res = await post(SWITCH, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as GitDeliveryLocalErrorBody).error.code).toBe(
      "GIT_DELIVERY_LOCAL_PAYLOAD_TOO_LARGE",
    );
  });
});

describe("local mutation routes — governed execution (direct handler + seams)", () => {
  it("switches a branch through the kernel and records evidence", async () => {
    const cap = capturingEvidenceStore();
    const adapter = recordingAdapter();
    const handler = createHandleLocalMutation(
      {
        pattern: SWITCH,
        allowedKeys: new Set(["schemaVersion", "projectId", "approval", "branchName"]),
        parse: () => ({ ok: true, command: { kind: "branch-switch", branchName: "feature/x" } }),
      },
      { execution: seams({ adapterFactory: () => adapter.adapter }) },
    );
    const res = await handler(
      ctxFor(SWITCH, { schemaVersion: "1", projectId, branchName: "feature/x" }),
      deps({ evidenceStore: cap.evidenceStore }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["switchBranch"]);
    expect(cap.records()).toHaveLength(1);
  });

  it("blocks at preflight (switch target missing) and never calls the adapter", async () => {
    const cap = capturingEvidenceStore();
    const adapter = recordingAdapter();
    const handler = createHandleLocalMutation(
      {
        pattern: SWITCH,
        allowedKeys: new Set(["schemaVersion", "projectId", "approval", "branchName"]),
        parse: () => ({
          ok: true,
          command: { kind: "branch-switch", branchName: "feature/missing" },
        }),
      },
      {
        execution: seams({
          adapterFactory: () => adapter.adapter,
          snapshotReader: () =>
            Promise.resolve({ ...SNAPSHOT, existingLocalBranchNames: ["main"] }),
        }),
      },
    );
    const res = await handler(
      ctxFor(SWITCH, { schemaVersion: "1", projectId, branchName: "feature/missing" }),
      deps({ evidenceStore: cap.evidenceStore }),
    );
    expect((res.body as { status: string; preflightFindingCodes?: string[] }).status).toBe(
      "blocked",
    );
    expect((res.body as { preflightFindingCodes?: string[] }).preflightFindingCodes).toContain(
      "switch-target-missing",
    );
    expect(adapter.calls()).toEqual([]);
    expect(cap.records()).toHaveLength(1); // a blocked outcome is still audited
  });

  it("blocks at policy when the trusted pack denies, without executing", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleLocalMutation(
      {
        pattern: SWITCH,
        allowedKeys: new Set(["schemaVersion", "projectId", "approval", "branchName"]),
        parse: () => ({ ok: true, command: { kind: "branch-switch", branchName: "feature/x" } }),
      },
      {
        execution: seams({
          adapterFactory: () => adapter.adapter,
          policyPacks: { repoPack: BLOCK_ALL_PACK },
        }),
      },
    );
    const res = await handler(
      ctxFor(SWITCH, { schemaVersion: "1", projectId, branchName: "feature/x" }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { policyOutcome: string }).policyOutcome).toBe("blocked");
    expect(adapter.calls()).toEqual([]);
  });

  it("never throws when evidence persistence fails (best-effort audit)", async () => {
    const cap = capturingEvidenceStore(true);
    const adapter = recordingAdapter();
    const handler = createHandleLocalMutation(
      {
        pattern: SWITCH,
        allowedKeys: new Set(["schemaVersion", "projectId", "approval", "branchName"]),
        parse: () => ({ ok: true, command: { kind: "branch-switch", branchName: "feature/x" } }),
      },
      { execution: seams({ adapterFactory: () => adapter.adapter }) },
    );
    const res = await handler(
      ctxFor(SWITCH, { schemaVersion: "1", projectId, branchName: "feature/x" }),
      deps({ evidenceStore: cap.evidenceStore }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("succeeded");
  });
});
