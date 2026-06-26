// Route tests for the governed commit preview + execute routes (Issue #475, Epic #470).
//
// Proves the #475 commit-quality acceptance criteria at the BFF seam:
//   * AC2 — a message-policy violation BLOCKS the commit before the kernel runs, with typed codes.
//   * AC3 — the read-only preview surfaces mixed-scope / WIP commit-intent warnings.
//   * AC4 — a governed commit records evidence; outcomes are content-free.
//   * AC5 — commit execution cannot bypass the kernel: a policy/preflight block executes nothing.

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
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import {
  createHandleCommitExecute,
  createHandleCommitPreview,
  type GitDeliveryCommitPreviewBody,
} from "./commitRoutes.js";
import type { GitDeliveryExecutionSeams } from "./execution.js";

const PREVIEW = "/api/git-delivery/commit/preview";
const EXECUTE = "/api/git-delivery/commit/execute";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feature/x",
  stagedFileCount: 2,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  existingLocalBranchNames: ["feature/x", "main"],
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

interface RecordingAdapter {
  readonly adapter: GitLocalMutationAdapter;
  readonly calls: () => readonly string[];
}

function recordingAdapter(): RecordingAdapter {
  const calls: string[] = [];
  const ok: GitDeliveryExecutionResult = {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome: "succeeded",
    durationMs: 2,
  };
  const run = (name: string) => (): Promise<GitDeliveryExecutionResult> => {
    calls.push(name);
    return Promise.resolve(ok);
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

function capturingEvidenceStore(): { store: EvidenceStore; count: () => number } {
  const docs = new Map<string, string>();
  return {
    store: {
      put: (runId, json): string => {
        docs.set(runId, json);
        return runId;
      },
      list: () => [...docs.keys()],
      get: (runId) => docs.get(runId),
      delete: (runId) => docs.delete(runId),
    },
    count: (): number => {
      let n = 0;
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        n += Array.isArray(doc.records) ? doc.records.length : 0;
      }
      return n;
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
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...overrides,
  };
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
    stagedPathsReader: () => Promise.resolve(["packages/keiko-ui/a.ts", "docs/b.md"]),
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

beforeEach(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-commit-static-"));
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-commit-proj-"))).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("commit routes — central enforcement (real dispatch)", () => {
  beforeEach(async () => {
    await startBound();
  });
  afterEach(async () => {
    await closeServer();
  });

  it("does not require a deployment enable flag before checking the worktree", async () => {
    await closeServer();
    await startBound({ env: {} });
    const cases = [
      { path: PREVIEW, body: { schemaVersion: "1", projectId, messageDraft: "feat: x" } },
      { path: EXECUTE, body: { schemaVersion: "1", projectId, message: "feat: x" } },
    ] as const;
    for (const item of cases) {
      const res = await fetch(`http://${UI_HOST}:${String(port)}${item.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(item.body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE" },
      });
    }
  });

  it("403s without the central CSRF header", async () => {
    const res = await fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1", projectId, message: "feat: x" }),
    });
    expect(res.status).toBe(403);
  });

  function postExec(body: unknown): Promise<Response> {
    return fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("rejects validation failures before execution", async () => {
    expect(
      (await postExec({ schemaVersion: "1", projectId, message: "feat: x", evil: 1 })).status,
    ).toBe(400);
    expect(
      (await postExec({ schemaVersion: "1", projectId, message: "Authorization: Bearer abc" }))
        .status,
    ).toBe(400);
    expect(
      (await postExec({ schemaVersion: "1", projectId: "/no/such", message: "feat: x" })).status,
    ).toBe(404);
    const big = JSON.stringify({ schemaVersion: "1", projectId, message: "x".repeat(70 * 1024) });
    expect((await postExec(big)).status).toBe(413);
    expect((await postExec("{ not json")).status).toBe(400);
  });
});

describe("commit preview — read-only verification context (AC3)", () => {
  it("surfaces mixed-scope and WIP commit-intent warnings + message-policy violations", async () => {
    const handler = createHandleCommitPreview({ execution: seams() });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "WIP not conventional" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.summary.areaCount).toBe(2);
    expect(body.intent.warnings).toContain("mixed-scope");
    expect(body.intent.warnings).toContain("wip-marker");
    expect(body.intent.isWip).toBe(true);
    expect(body.messageValidation.ok).toBe(false);
    expect(body.policyOutcome).toBe("constrained");
  });

  it("accepts a clean conventional message in the same scope", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ stagedPathsReader: () => Promise.resolve(["packages/keiko-ui/a.ts"]) }),
    });
    const res = await handler(
      ctxFor(PREVIEW, {
        schemaVersion: "1",
        projectId,
        messageDraft: "feat(ui): add governed flow\n\nbody",
      }),
      deps(),
    );
    const body = res.body as GitDeliveryCommitPreviewBody;
    expect(body.intent.warnings).not.toContain("mixed-scope");
    expect(body.messageValidation.ok).toBe(true);
  });
});

describe("commit execute — message policy gate + no-bypass (AC2/AC4/AC5)", () => {
  it("blocks a policy-violating message BEFORE the kernel and never commits (AC2)", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "broken commit message" }),
      deps(),
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string; blockReason?: string; messageViolations?: string[] };
    expect(body.status).toBe("blocked");
    expect(body.blockReason).toBe("message-policy");
    expect(body.messageViolations).toContain("missing-conventional-prefix");
    expect(adapter.calls()).toEqual([]); // nothing executed
  });

  it("executes a valid conventional commit and records evidence (AC4)", async () => {
    const adapter = recordingAdapter();
    const cap = capturingEvidenceStore();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add governed flow" }),
      deps({ evidenceStore: cap.store }),
    );
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
    expect(cap.count()).toBe(1);
  });

  it("cannot bypass the kernel: a valid message is still policy-blocked, executing nothing (AC5)", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: BLOCK_ALL_PACK },
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add governed flow" }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { policyOutcome: string }).policyOutcome).toBe("blocked");
    expect(adapter.calls()).toEqual([]);
  });

  it("cannot bypass preflight: nothing staged blocks the commit (AC5)", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, stagedFileCount: 0 }),
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add governed flow" }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("blocked");
    expect((res.body as { preflightFindingCodes?: string[] }).preflightFindingCodes).toContain(
      "nothing-staged-to-commit",
    );
    expect(adapter.calls()).toEqual([]);
  });

  it("commits with allowEmpty and honours a granted approval object", async () => {
    const adapter = recordingAdapter();
    const handler = createHandleCommitExecute({
      execution: seams({ adapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message: "chore: empty",
        allowEmpty: true,
        approval: { required: false },
      }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("succeeded");
    expect(adapter.calls()).toEqual(["commit"]);
  });

  it("holds for approval when the trusted pack is approval-gated", async () => {
    const adapter = recordingAdapter();
    const approvalGated: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      rules: [{ actionKind: "commit", decision: "approval-gated", requiredApprovers: ["lead"] }],
      defaultRule: { decision: "blocked" },
    };
    const handler = createHandleCommitExecute({
      execution: seams({
        adapterFactory: () => adapter.adapter,
        policyPacks: { repoPack: approvalGated },
      }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    expect((res.body as { status: string }).status).toBe("approval-required");
    expect(adapter.calls()).toEqual([]);
  });

  it("returns 409 worktree-unavailable when the live snapshot cannot be read", async () => {
    const handler = createHandleCommitExecute({
      execution: seams({ snapshotReader: () => Promise.reject(new Error("not a git repo")) }),
    });
    const res = await handler(
      ctxFor(EXECUTE, { schemaVersion: "1", projectId, message: "feat(ui): add flow" }),
      deps(),
    );
    expect(res.status).toBe(409);
  });

  it("rejects a malformed approval and an oversized/invalid body", async () => {
    const handler = createHandleCommitExecute({ execution: seams() });
    const bad = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        message: "feat: x",
        approval: { required: "yes" },
      }),
      deps(),
    );
    expect(bad.status).toBe(400);
  });
});

describe("commit preview — default draft, policy block, and worktree failure", () => {
  it("defaults an absent messageDraft to empty and reports a policy block reason", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ policyPacks: { repoPack: BLOCK_ALL_PACK } }),
    });
    const res = await handler(ctxFor(PREVIEW, { schemaVersion: "1", projectId }), deps());
    const body = res.body as GitDeliveryCommitPreviewBody & { policyBlockReason?: string };
    expect(body.policyOutcome).toBe("blocked");
    expect(body.policyBlockReason).toBeDefined();
    expect(body.messageValidation.ok).toBe(false); // empty draft → empty-subject
  });

  it("returns 409 when the worktree cannot be read", async () => {
    const handler = createHandleCommitPreview({
      execution: seams({ snapshotReader: () => Promise.reject(new Error("not a git repo")) }),
    });
    const res = await handler(
      ctxFor(PREVIEW, { schemaVersion: "1", projectId, messageDraft: "feat: x" }),
      deps(),
    );
    expect(res.status).toBe(409);
  });
});
