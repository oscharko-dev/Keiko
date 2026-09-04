import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchAuthorityEnvelope,
  EditorAgentAction,
  EditorAgentRootBinding,
  EditorAgentSessionSnapshot,
  WorkspaceManifest,
  WorkspaceRootDispatch,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { validateCodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { WorkspaceManifestService } from "../workspace-manifests.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";
import { listEditorAgentActionAudit } from "./agentActionAudit.js";
import {
  _resetEditorAgentStateForTests,
  handleEditorAgentActions,
  handleEditorAgentScopedSessions,
  handleEditorAgentSnapshot,
} from "./agentRoutes.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { handleEditorAgentProducerTurn } from "./agentProducerRoute.js";
import { handleEditorAgentVerificationRun } from "./agentVerificationRoute.js";
import type { VerificationRunnerManager } from "./verificationRunner.js";
import {
  editorAgentPathBoundaryReason,
  editorAgentRootContainmentReason,
  resolveEditorAgentActionRoot,
  resolveEditorAgentContainmentPort,
  resolveEditorAgentSessionRoot,
} from "./agentRootBoundary.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import {
  grantedWorkspaceRootAccess,
  type WorkspaceRootAccessOutcome,
} from "../task-workspace/workspace-root-access.js";
import { forwardWorkspaceFs, nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

const HASH = "a".repeat(64);
let temporaryRoot: string;
let rootA: string;
let rootB: string;
let store: UiStore;
let manifest: WorkspaceManifest;
let authoritySequence = 0;
const disconnects: (() => void)[] = [];

function requestContext(body: unknown, path: string): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  return {
    correlationId: undefined,
    req,
    // `removeListener` is required by routes that install a request-lifecycle abort handler
    // (the verification route disposes one on every exit path).
    res: {
      writableEnded: false,
      on: (): void => undefined,
      removeListener: (): void => undefined,
    } as unknown as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function dispatch(current: WorkspaceManifest): WorkspaceRootDispatch {
  const root = current.roots[0];
  if (root === undefined) throw new Error("missing manifest root");
  return {
    kind: "workspace-root-dispatch",
    schemaVersion: current.schemaVersion,
    workspaceId: current.workspaceId,
    manifestRef: current.manifestRef,
    manifestRevision: current.revision,
    manifestDigest: current.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
    operationClass: "mutating",
  };
}

function binding(rootIndex: number): EditorAgentRootBinding {
  const root = manifest.roots[rootIndex];
  if (root === undefined) throw new Error("missing bound root");
  return {
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
  };
}

function snapshot(
  root: string,
  rootBinding: EditorAgentRootBinding | undefined,
  sessionId: string,
  file = "src/file.ts",
): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId,
    windowId: `window-${sessionId}`,
    workspaceRoot: root,
    ...(rootBinding === undefined ? {} : { rootBinding }),
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: file, openFiles: [file] }],
    dirtyFiles: [],
    activeFile: file,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    activeFileContentHash: HASH,
    textMode: "none",
    updatedAt: 1,
  };
}

function authority(root: string, runId: string): CodingWorkbenchAuthorityEnvelope {
  const requestedMode = "autonomous-delivery" as const;
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId,
    localUser: "local-operator",
    taskRefs: ["issue-2532"],
    workspace: {
      workspaceId: "workspace-2532",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(root),
    },
    branch: {
      baseRef: "dev",
      headRef: "issue-2532",
      allowDetachedHead: false,
      allowedPrefixes: ["issue-"],
    },
    requestedMode,
    deploymentCeiling: requestedMode,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, requestedMode),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-2532",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 20,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: createHash("sha256").update(runId).digest("hex"),
  };
}

function authorityRef(root: string): NonNullable<EditorAgentAction["authorityRef"]> {
  authoritySequence += 1;
  const runId = `run-${String(authoritySequence)}`;
  const envelope = authority(root, runId);
  const validation = validateCodingWorkbenchAuthorityEnvelope(envelope);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const registered = editorAgentAuthorityRegistry.register(
    envelope,
    "autonomous-delivery",
    new Date().toISOString(),
  );
  if (!registered.ok) throw new Error("authority registration failed");
  return registered.authorityRef;
}

function routeDeps(): NonNullable<Parameters<typeof handleEditorAgentActions>[1]> {
  return {
    store,
    env: {},
    redactor: (value: unknown): unknown => value,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    workspaceScriptTrust: {
      trustLevelForRoot: (root: string): "trusted" | "restricted" =>
        root === rootA ? "trusted" : "restricted",
    },
  } as unknown as NonNullable<Parameters<typeof handleEditorAgentActions>[1]>;
}

async function registerLive(session: EditorAgentSessionSnapshot): Promise<void> {
  const response = await handleEditorAgentSnapshot(
    requestContext(
      { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, kind: "snapshot", snapshot: session },
      "/api/editor/agent/snapshot",
    ),
    routeDeps(),
  );
  expect(response.status).toBe(200);
  disconnects.push(editorAgentRegistry.connect(session.sessionId, () => undefined));
}

function action(
  session: EditorAgentSessionSnapshot,
  type: EditorAgentAction["type"],
  actionId: string,
): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId,
    idempotencyKey: `key-${actionId}`,
    sessionId: session.sessionId,
    ...(session.rootBinding === undefined ? {} : { rootBinding: session.rootBinding }),
    type,
    authorityRef: authorityRef(session.workspaceRoot),
    ...(type === "save" ? { expectedContentHash: HASH } : {}),
    ...(type === "searchWorkspace"
      ? { searchWorkspace: { mode: "text", query: "alpha", maxResults: 5 } }
      : {}),
  };
}

// Issue #2624 — THE assertion for "a root-boundary denial produced content-free, server-attributed
// evidence". The actions route and the verification route reach the same ledger through different
// admission paths, and they drifted: one suppressed the target path and read attribution from the
// server-held session, the other recorded the path and let the caller's supplied root stand in.
// Routing both through one assertion is what keeps them from drifting apart again — a route that
// starts trusting caller input, or starts recording a path it never authorized, fails here.
function expectRootBoundaryDenialEvidence(
  record: unknown,
  expected: {
    readonly reason: string;
    readonly rootBinding?: EditorAgentRootBinding | undefined;
  },
): void {
  expect(record).toMatchObject({ disposition: "denied", denyReason: expected.reason });
  expect(record).not.toHaveProperty("targetPath");
  expect(record).not.toHaveProperty("targetBasename");
  expect(record).not.toHaveProperty("targetPathHash");
  if (expected.rootBinding === undefined) {
    expect(record).not.toHaveProperty("rootAttribution");
    return;
  }
  expect(record).toMatchObject({
    rootAttribution: {
      rootRef: expected.rootBinding.rootRef,
      rootIdentityDigest: expected.rootBinding.rootIdentityDigest,
    },
  });
}

// A complete VerificationRunnerManager whose every entry point throws. Typed rather than cast, so
// the "a denial never reaches the runner" claim binds to the real interface: a method added to the
// manager becomes a compile error here instead of an undefined the route would call at runtime.
const deniedVerificationRunner: VerificationRunnerManager = {
  discover: (): never => {
    throw new Error("discover not exercised");
  },
  execute: (): never => {
    throw new Error("execute not exercised");
  },
  abort: (): never => {
    throw new Error("abort not exercised");
  },
  inFlightCount: (): number => 0,
  subscribe: (): (() => void) => (): void => undefined,
  runToReport: (): never => {
    throw new Error("a denied verification must never reach the runner");
  },
};

// One widening assertion, not `as unknown as`: UiHandlerDeps is the app-wide dependency bag and a
// unit test cannot construct all of it, but every field this route reads is supplied with its real
// type, so a wrong-shaped stub still fails to compile.
function verificationDeps(): UiHandlerDeps {
  return { ...routeDeps(), verificationRunner: deniedVerificationRunner } as UiHandlerDeps;
}

beforeEach(() => {
  authoritySequence = 0;
  temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-root-boundary-")));
  rootA = join(temporaryRoot, "alpha");
  rootB = join(temporaryRoot, "beta");
  mkdirSync(join(rootA, "src"), { recursive: true });
  mkdirSync(join(rootB, "src"), { recursive: true });
  writeFileSync(join(rootA, "src/file.ts"), "export const alpha = true;\n");
  writeFileSync(join(rootB, "src/file.ts"), "export const beta = true;\n");
  symlinkSync(rootB, join(rootA, "linked-beta"), "dir");
  store = createInMemoryUiStore();
  store.createProject(rootA, "Alpha");
  store.createProject(rootB, "Beta");
  const service = new WorkspaceManifestService(store);
  const initial = service.list().find((entry) => entry.roots[0]?.canonicalRoot === rootA);
  if (initial === undefined) throw new Error("missing alpha manifest");
  manifest = service.addRoot(dispatch(initial), rootB).manifest;
  _resetEditorAgentStateForTests();
});

afterEach(() => {
  for (const disconnect of disconnects.splice(0)) disconnect();
  _resetEditorAgentStateForTests();
  store.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("editor agent root boundary", () => {
  it("executes a trusted action and attributes its evidence to root A", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-a");
    await registerLive(sessionA);

    const accepted = await handleEditorAgentActions(
      requestContext(
        action(sessionA, "searchWorkspace", "trusted-search"),
        "/api/editor/agent/actions",
      ),
      routeDeps(),
    );
    expect(accepted).toMatchObject({ status: 200, body: { result: { status: "succeeded" } } });
    expect(listEditorAgentActionAudit("session-a")[0]).toMatchObject({
      disposition: "allowed",
      rootAttribution: {
        rootRef: binding(0).rootRef,
        rootIdentityDigest: binding(0).rootIdentityDigest,
      },
    });
  });

  it("scopes agent session discovery to its authorized root", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-a");
    const sessionB = snapshot(rootB, binding(1), "session-b");
    await registerLive(sessionA);
    await registerLive(sessionB);
    const reference = authorityRef(rootA);
    const response = await handleEditorAgentScopedSessions(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          rootBinding: binding(0),
          authorityRef: reference,
        },
        "/api/editor/agent/sessions",
      ),
      routeDeps(),
    );
    expect(response).toMatchObject({
      status: 200,
      body: { sessions: [{ sessionId: "session-a" }] },
    });
    expect(JSON.stringify(response.body)).not.toContain(rootB);
    const hostile = await handleEditorAgentScopedSessions(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          rootBinding: binding(0),
          authorityRef: reference,
          activeRoot: rootB,
        },
        "/api/editor/agent/sessions",
      ),
      routeDeps(),
    );
    expect(hostile.status).toBe(400);
  });

  it("keeps authority-only legacy discovery on its authorized single root", async () => {
    const sessionB = snapshot(rootB, binding(1), "session-multi-b");
    await registerLive(sessionB);
    const singleStore = createInMemoryUiStore();
    singleStore.createProject(rootA, "Alpha");
    const legacy = snapshot(rootA, undefined, "session-legacy-a");
    try {
      const registration = await handleEditorAgentSnapshot(
        requestContext(
          { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, kind: "snapshot", snapshot: legacy },
          "/api/editor/agent/snapshot",
        ),
        { ...routeDeps(), store: singleStore },
      );
      expect(registration.status).toBe(200);
      disconnects.push(editorAgentRegistry.connect(legacy.sessionId, () => undefined));
      const response = await handleEditorAgentScopedSessions(
        requestContext(
          {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            authorityRef: authorityRef(rootA),
          },
          "/api/editor/agent/sessions",
        ),
        { ...routeDeps(), store: singleStore },
      );
      expect(response).toMatchObject({
        status: 200,
        body: { sessions: [{ sessionId: "session-legacy-a" }] },
      });
      expect(JSON.stringify(response.body)).not.toContain("session-multi-b");
    } finally {
      singleStore.close();
    }
  });

  it("denies a snapshot read for a bindingless session once the workspace has more than one root", async () => {
    // Fail-open regression: authorizeSnapshotRead returned early for any snapshot without a
    // rootBinding, skipping both the root boundary and the authority reservation. A session
    // registered while the workspace still had a single root keeps rootBinding === undefined, so a
    // caller holding only root B's authority could read root A's snapshot — absolute workspaceRoot,
    // open files, cursor and, at textMode "activeFile", file content.
    const singleStore = createInMemoryUiStore();
    try {
      singleStore.createProject(rootA, "Alpha");
      const legacy = snapshot(rootA, undefined, "session-legacy-read");
      const registration = await handleEditorAgentSnapshot(
        requestContext(
          { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, kind: "snapshot", snapshot: legacy },
          "/api/editor/agent/snapshot",
        ),
        { ...routeDeps(), store: singleStore },
      );
      expect(registration.status).toBe(200);
      disconnects.push(editorAgentRegistry.connect(legacy.sessionId, () => undefined));

      // The workspace grows a second root; the already-registered session keeps no binding.
      const multiRoot = await handleEditorAgentSnapshot(
        requestContext(
          {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            sessionId: legacy.sessionId,
            textMode: "activeFile",
          },
          "/api/editor/agent/snapshot",
        ),
        routeDeps(),
      );

      expect(multiRoot.status).toBe(403);
      // Issue #2619: strengthened from status-only. Any 403 satisfied this pin, so a regression that
      // reported the unrooted dispatch as `root-binding-invalid` — erasing the distinction the
      // invariant rests on — stayed green.
      expect((multiRoot.body as { error?: { code?: unknown } }).error?.code).toBe(
        "EDITOR_AGENT_ROOT_BINDING_REQUIRED",
      );
      expect(JSON.stringify(multiRoot.body)).not.toContain(rootA);
    } finally {
      singleStore.close();
    }
  });

  it("rejects an A-to-B target without leaking either root path", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-a");
    await registerLive(sessionA);
    const crossRoot = {
      ...action(sessionA, "openFile", "cross-root"),
      authorityRef: undefined,
      target: { file: join(rootB, "src/file.ts") },
    };
    const rejected = await handleEditorAgentActions(
      requestContext(crossRoot, "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(rejected).toMatchObject({
      status: 403,
      body: { result: { status: "conflict", conflict: { code: "DECOMPOSE_PER_ROOT" } } },
    });
    expect(JSON.stringify(rejected.body)).not.toContain(rootA);
    expect(JSON.stringify(rejected.body)).not.toContain(rootB);
    expectRootBoundaryDenialEvidence(listEditorAgentActionAudit("session-a").at(-1), {
      reason: "decompose-per-root",
      rootBinding: binding(0),
    });
  });

  // Issue #2624 — the same dispatch on the verification route. This is the branch the Wave-2 audit
  // found untested: a cross-root `targetPath` reaches `editorAgentPathBoundaryReason` only once a
  // real manifest is resolved, which the route's own store-less suite cannot set up. The target is
  // the symlink alias rather than a `..` traversal — the request parser rejects a lexical escape
  // before admission, so only a path that is contained ON PAPER exercises the real-path guard.
  it("rejects an A-to-B verification target with the same content-free evidence", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-verify-a");
    await registerLive(sessionA);
    const rejected = await handleEditorAgentVerificationRun(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          sessionId: sessionA.sessionId,
          rootBinding: binding(0),
          kind: "targeted-test",
          targetPath: "linked-beta/src/file.ts",
          authorityRef: authorityRef(rootA),
        },
        "/api/editor/verification/agent-runs",
      ),
      verificationDeps(),
    );
    expect(rejected).toMatchObject({
      status: 200,
      body: { result: { outcome: "not-run", disposition: "denied", reason: "decompose-per-root" } },
    });
    expect(JSON.stringify(rejected.body)).not.toContain(rootA);
    expect(JSON.stringify(rejected.body)).not.toContain(rootB);
    expectRootBoundaryDenialEvidence(listEditorAgentActionAudit(sessionA.sessionId).at(-1), {
      reason: "decompose-per-root",
      rootBinding: binding(0),
    });
  });

  it("classifies a cross-root patch path before patch preflight", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-patch");
    await registerLive(sessionA);
    const crossRootPatch = {
      ...action(sessionA, "applyPatch", "cross-root-patch"),
      patch: [
        "--- a/../beta/src/file.ts",
        "+++ b/../beta/src/file.ts",
        "@@ -1 +1 @@",
        "-export const beta = true;",
        "+export const beta = false;",
        "",
      ].join("\n"),
    };
    const response = await handleEditorAgentActions(
      requestContext(crossRootPatch, "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(response).toMatchObject({
      status: 403,
      body: { result: { conflict: { code: "DECOMPOSE_PER_ROOT" } } },
    });
    expect(listEditorAgentActionAudit("session-patch")[0]).toMatchObject({
      denyReason: "decompose-per-root",
      rootAttribution: { rootRef: binding(0).rootRef },
    });
  });

  it("revalidates the current manifest before returning cached context", async () => {
    const sessionA = snapshot(rootA, binding(0), "session-replay");
    await registerLive(sessionA);
    const search = action(sessionA, "searchWorkspace", "stale-replay");
    const first = await handleEditorAgentActions(
      requestContext(search, "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(first).toMatchObject({ status: 200, body: { result: { status: "succeeded" } } });
    const removedRoot = manifest.roots[1];
    if (removedRoot === undefined) throw new Error("missing beta root");
    new WorkspaceManifestService(store).removeRoot(dispatch(manifest), removedRoot.rootRef);
    const replay = await handleEditorAgentActions(
      requestContext(search, "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(replay).toMatchObject({
      status: 403,
      body: { result: { conflict: { code: "POLICY_DENIED" } } },
    });
  });

  it("denies execution on restricted root B and attributes the denial", async () => {
    const sessionB = snapshot(rootB, binding(1), "session-b");
    await registerLive(sessionB);
    const execution = await handleEditorAgentActions(
      requestContext(
        action(sessionB, "requestVerification", "restricted-execution"),
        "/api/editor/agent/actions",
      ),
      routeDeps(),
    );
    expect(execution).toMatchObject({ status: 403, body: { result: { status: "conflict" } } });
    expect(listEditorAgentActionAudit("session-b")[0]).toMatchObject({
      disposition: "denied",
      denyReason: "workspace-restricted",
      rootAttribution: { rootRef: binding(1).rootRef },
    });
  });

  it("denies a restricted-root producer turn before model creation", async () => {
    const sessionB = snapshot(rootB, binding(1), "session-producer-b");
    await registerLive(sessionB);
    let modelFactoryCalls = 0;
    const deps = {
      ...routeDeps(),
      modelPortFactory: (): undefined => {
        modelFactoryCalls += 1;
        return undefined;
      },
    } as unknown as UiHandlerDeps;
    const response = await handleEditorAgentProducerTurn(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          sessionId: sessionB.sessionId,
          modelId: "model-b",
          goal: "Run root B checks",
          authorityRef: authorityRef(rootB),
        },
        "/api/editor/agent/producer/turn",
      ),
      deps,
    );
    expect(response).toMatchObject({
      status: 403,
      body: { error: { code: "WORKSPACE_RESTRICTED" } },
    });
    expect(modelFactoryCalls).toBe(0);
  });

  it("rejects crafted lexical, absolute, and symlink paths that reach another root", () => {
    const session = snapshot(rootA, binding(0), "session-paths");
    const resolved = resolveEditorAgentSessionRoot(session, store);
    if (!resolved.ok) throw new Error("root resolution failed");
    const crafted = [
      join("..", "beta", "src/file.ts"),
      join(rootB, "src/file.ts"),
      "linked-beta/src/file.ts",
    ];
    for (const path of crafted) {
      expect(editorAgentPathBoundaryReason(resolved.root, [path])).toBe("decompose-per-root");
    }
    expect(editorAgentPathBoundaryReason(resolved.root, ["src/file.ts"])).toBeNull();
  });

  it("stores a canonical root instead of a retargetable symlink alias", async () => {
    const alias = join(temporaryRoot, "alias-alpha");
    symlinkSync(rootA, alias, "dir");
    const session = snapshot(alias, binding(0), "session-alias");
    await registerLive(session);
    expect(editorAgentRegistry.snapshotFor(session.sessionId)?.workspaceRoot).toBe(rootA);
    unlinkSync(alias);
    symlinkSync(rootB, alias, "dir");
    expect(editorAgentRegistry.snapshotFor(session.sessionId)?.workspaceRoot).toBe(rootA);
  });

  it("rejects forged, replayed, and cross-root action bindings with typed reasons", () => {
    const current = binding(0);
    const session = snapshot(rootA, current, "session-bindings");
    const stale = { ...current, manifestRevision: current.manifestRevision + 1 };
    const forgedIdentity = { ...current, rootIdentityDigest: binding(1).rootIdentityDigest };
    const crossRoot = binding(1);
    expect(resolveEditorAgentActionRoot(session, stale, store)).toEqual({
      ok: false,
      reason: "root-binding-invalid",
    });
    expect(resolveEditorAgentActionRoot(session, forgedIdentity, store)).toEqual({
      ok: false,
      reason: "root-binding-invalid",
    });
    expect(resolveEditorAgentActionRoot(session, crossRoot, store)).toEqual({
      ok: false,
      reason: "decompose-per-root",
    });
  });

  it("rejects a session when the private filesystem object binding changed", () => {
    const guardedStore: UiStore = {
      ...store,
      findWorkspaceManifestRecordByProject: (projectPath) => {
        const row = store.findWorkspaceManifestRecordByProject(projectPath);
        if (row === undefined) return undefined;
        return {
          ...row,
          rootProjects: row.rootProjects.map((root) => ({
            ...root,
            objectIdentityDigest: "f".repeat(64),
          })),
        };
      },
    };

    expect(
      resolveEditorAgentSessionRoot(
        snapshot(rootA, binding(0), "session-object-replaced"),
        guardedStore,
      ),
    ).toEqual({ ok: false, reason: "root-binding-invalid" });
  });

  it("fails closed on a missing manifest row when a store is available", () => {
    const legacy = snapshot(rootA, undefined, "session-missing-manifest");
    const noManifestStore: UiStore = {
      ...store,
      findWorkspaceManifestRecordByProject: () => undefined,
    };

    expect(resolveEditorAgentSessionRoot(legacy, noManifestStore)).toEqual({
      ok: false,
      reason: "root-binding-invalid",
    });
    expect(resolveEditorAgentSessionRoot(legacy)).toEqual({
      ok: true,
      root: {
        workspaceRoot: rootA,
        binding: undefined,
        explicitBindingRequired: false,
      },
    });
  });

  it("omits caller-supplied root attribution for an unknown session", async () => {
    const unknown = snapshot(rootA, binding(0), "session-unknown");
    const response = await handleEditorAgentActions(
      requestContext(action(unknown, "save", "unknown-save"), "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(response).toMatchObject({
      status: 409,
      body: { result: { conflict: { code: "NO_ACTIVE_SESSION" } } },
    });
    expect(response.body).not.toHaveProperty("result.rootAttribution");
    expect(listEditorAgentActionAudit("session-unknown")[0]).not.toHaveProperty("rootAttribution");
  });

  it("preserves a legacy single-root snapshot byte-for-byte", async () => {
    const singleStore = createInMemoryUiStore();
    singleStore.createProject(rootA, "Alpha");
    const legacy = snapshot(rootA, undefined, "single-root");
    try {
      const resolved = resolveEditorAgentSessionRoot(legacy, singleStore);
      if (!resolved.ok) throw new Error("single root resolution failed");
      expect(editorAgentPathBoundaryReason(resolved.root, [join(rootA, "src/file.ts")])).toBe(
        "workspace-boundary-escape",
      );
      const response = await handleEditorAgentSnapshot(
        requestContext(
          { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, kind: "snapshot", snapshot: legacy },
          "/api/editor/agent/snapshot",
        ),
        { ...routeDeps(), store: singleStore },
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ snapshot: legacy });
      const responseBody = response.body as Readonly<Record<string, unknown>>;
      expect(typeof responseBody.bridgeDecisionCapability).toBe("string");
    } finally {
      singleStore.close();
    }
  });
});

// Issue #2619 (ADR-0147 D1/D4) — `root-binding-required` is the contract expression of "the focused
// root is never a fallback": it fires exactly when a mutating or executing dispatch names no root in
// a workspace that has more than one. Before this block the reason had three by-value assertions in
// the whole repository, all against the pure contracts function; every server consumer and the wire
// code `EDITOR_AGENT_ROOT_BINDING_REQUIRED` were unasserted, so a regression that collapsed it into
// the neighbouring `root-binding-invalid` stayed green. Each test below pins one consumer.
describe("root-binding-required across every server consumer (#2619)", () => {
  // A session registered while the workspace still had one root keeps `rootBinding === undefined`.
  // Growing the workspace is what turns that session into an unrooted dispatch.
  function bindinglessSession(sessionId: string): EditorAgentSessionSnapshot {
    const session = snapshot(rootA, undefined, sessionId);
    expect(editorAgentRegistry.registerSnapshot(session)).toBe(true);
    disconnects.push(editorAgentRegistry.connect(sessionId, () => undefined));
    return session;
  }

  function errorCode(body: unknown): unknown {
    return (body as { error?: { code?: unknown } }).error?.code;
  }

  it("resolves the reason at the producing boundary for a bindingless multi-root session", () => {
    const session = snapshot(rootA, undefined, "session-required-unit");
    expect(resolveEditorAgentSessionRoot(session, store)).toEqual({
      ok: false,
      reason: "root-binding-required",
    });
    // The focused root is a current member and would resolve cleanly — the boundary must still
    // refuse rather than supply it. Focus is presentation state (ADR-0147 D1).
    expect(manifest.roots.some((root) => root.rootRef === manifest.focusedRootRef)).toBe(true);
  });

  it("reports the required reason distinctly from invalid on the snapshot route", async () => {
    bindinglessSession("session-required-snapshot");
    const response = await handleEditorAgentSnapshot(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          sessionId: "session-required-snapshot",
          textMode: "activeFile",
        },
        "/api/editor/agent/snapshot",
      ),
      routeDeps(),
    );
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("EDITOR_AGENT_ROOT_BINDING_REQUIRED");
    expect(JSON.stringify(response.body)).not.toContain(rootA);
  });

  it("reports the required reason on the producer turn route", async () => {
    bindinglessSession("session-required-producer");
    const response = await handleEditorAgentProducerTurn(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          sessionId: "session-required-producer",
          modelId: "model-2619",
          goal: "summarise the workspace",
          authorityRef: authorityRef(rootA),
        },
        "/api/editor/agent/producer/turn",
      ),
      routeDeps() as unknown as Parameters<typeof handleEditorAgentProducerTurn>[1],
    );
    expect(response.status).toBe(403);
    // Regression: this route collapsed every non-decompose reason into ROOT_BINDING_INVALID, so a
    // dispatch that named no root was reported as one that named a bad root.
    expect(errorCode(response.body)).toBe("EDITOR_AGENT_ROOT_BINDING_REQUIRED");
    expect(JSON.stringify(response.body)).not.toContain(rootA);
  });

  it("denies a mutating action and keeps its audit record target-free", async () => {
    const session = bindinglessSession("session-required-action");
    const response = await handleEditorAgentActions(
      requestContext(action(session, "save", "required-save"), "/api/editor/agent/actions"),
      routeDeps(),
    );
    expect(response).toMatchObject({
      status: 403,
      body: { result: { conflict: { code: "POLICY_DENIED" } } },
    });
    // A root-boundary denial never resolved a root, so it must not report a target it could not
    // have authorized, and the unrooted session leaves nothing to attribute it to.
    expectRootBoundaryDenialEvidence(listEditorAgentActionAudit("session-required-action")[0], {
      reason: "root-binding-required",
    });
  });

  it("hides the unrooted session from scoped discovery", async () => {
    bindinglessSession("session-required-discovery");
    const rooted = snapshot(rootA, binding(0), "session-required-visible");
    await registerLive(rooted);
    const response = await handleEditorAgentScopedSessions(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          rootBinding: binding(0),
          authorityRef: authorityRef(rootA),
        },
        "/api/editor/agent/sessions",
      ),
      routeDeps(),
    );
    // Positive control first: without it, a regression that returned NO sessions at all would
    // satisfy the absence assertion below and look like correct filtering.
    expect(response).toMatchObject({
      status: 200,
      body: { sessions: [{ sessionId: "session-required-visible" }] },
    });
    expect(JSON.stringify(response.body)).not.toContain("session-required-discovery");
  });

  it("returns the required reason as a not-run verification disposition", async () => {
    bindinglessSession("session-required-verification");
    const response = await handleEditorAgentVerificationRun(
      requestContext(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          sessionId: "session-required-verification",
          kind: "typecheck",
          authorityRef: authorityRef(rootA),
        },
        "/api/editor/verification/agent-runs",
      ),
      verificationDeps(),
    );
    expect(response).toMatchObject({
      status: 200,
      body: {
        result: { outcome: "not-run", disposition: "denied", reason: "root-binding-required" },
      },
    });
    // Issue #2624 strengthened this pin from response-only. The route audited the denial the whole
    // time; nothing asserted that the record it wrote was content-free and server-attributed.
    expectRootBoundaryDenialEvidence(
      listEditorAgentActionAudit("session-required-verification")[0],
      { reason: "root-binding-required" },
    );
  });
});

// PR #3381 review — the containment port both editor route families resolve. It used to be a
// near-verbatim private copy in agentRoutes.ts and agentVerificationRoute.ts (cursor, low), and
// its `catch { return nodeWorkspaceFs; }` plus `?.fs ?? nodeWorkspaceFs` collapsed a REFUSED
// managed root into a boundary escape: the operator was told the target left the workspace when
// the truth was that the workspace's own authority no longer held, and nothing was logged (P3).
describe("editor agent containment port (PR #3381)", () => {
  it("returns the node port when no resolver is wired or the root is merely unresolved", () => {
    expect(resolveEditorAgentContainmentPort(undefined, rootA)).toEqual({
      ok: true,
      fs: nodeWorkspaceFs,
    });
    expect(
      resolveEditorAgentContainmentPort(
        {
          workspaceRootAccessResolver: (): WorkspaceRootAccessOutcome => ({
            decision: "unresolved",
          }),
        },
        rootA,
      ),
    ).toEqual({ ok: true, fs: nodeWorkspaceFs });
  });

  it("returns the port a granted managed access minted", () => {
    const accessFs = forwardWorkspaceFs(nodeWorkspaceFs);
    expect(
      resolveEditorAgentContainmentPort(
        {
          workspaceRootAccessResolver: (requestedRoot): WorkspaceRootAccessOutcome =>
            grantedWorkspaceRootAccess({
              kind: "managed-task",
              canonicalRoot: requestedRoot,
              fs: accessFs,
              repositoryRoot: requestedRoot,
            }),
        },
        rootA,
      ),
    ).toEqual({ ok: true, fs: accessFs });
  });

  it("threads the caller's correlation id into the resolver so its denial line is joinable", () => {
    const seen: (string | undefined)[] = [];
    resolveEditorAgentContainmentPort(
      {
        workspaceRootAccessResolver: (_root, correlationId): WorkspaceRootAccessOutcome => {
          seen.push(correlationId);
          return { decision: "denied" };
        },
      },
      rootA,
      "run-boundary-1",
    );
    expect(seen).toEqual(["run-boundary-1"]);
  });

  it("reports a denied managed root as its own refusal, never as a path escape", () => {
    const session = snapshot(rootA, binding(0), "session-denied-port");
    const resolved = resolveEditorAgentSessionRoot(session, store);
    if (!resolved.ok) throw new Error("root resolution failed");
    const deps = {
      workspaceRootAccessResolver: (): WorkspaceRootAccessOutcome => ({ decision: "denied" }),
    };

    // The path is genuinely contained, so the node-port fallback would have answered `null` here
    // and admitted the action against a root whose authority was refused.
    expect(editorAgentPathBoundaryReason(resolved.root, ["src/file.ts"])).toBeNull();
    expect(editorAgentRootContainmentReason(resolved.root, ["src/file.ts"], deps)).toBe(
      "root-binding-invalid",
    );
    // Positive control: a real escape still reports as an escape, so the denial mapping above did
    // not simply swallow every reason.
    expect(
      editorAgentRootContainmentReason(resolved.root, ["../escape.ts"], {
        workspaceRootAccessResolver: (requestedRoot): WorkspaceRootAccessOutcome =>
          grantedWorkspaceRootAccess({
            kind: "ordinary",
            canonicalRoot: requestedRoot,
            fs: nodeWorkspaceFs,
          }),
      }),
    ).toBe("workspace-boundary-escape");
  });

  it("refuses and records a resolver that cannot complete its authority proof at all", () => {
    const session = snapshot(rootA, binding(0), "session-throwing-port");
    const resolved = resolveEditorAgentSessionRoot(session, store);
    if (!resolved.ok) throw new Error("root resolution failed");
    const record = vi
      .spyOn(defaultServerDiagnosticSink, "record")
      .mockImplementation(() => undefined);
    try {
      expect(
        editorAgentRootContainmentReason(
          resolved.root,
          ["src/file.ts"],
          {
            workspaceRootAccessResolver: (): never => {
              throw new Error("SENTINEL_RESOLVER_FAULT");
            },
          },
          "run-boundary-2",
        ),
      ).toBe("root-binding-invalid");
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          operation: "editor.agent.root-containment",
          source: "editor.agent-root-boundary",
          message: "editor-agent-root-authority-unresolvable",
          correlationId: "run-boundary-2",
        }),
      );
      expect(JSON.stringify(record.mock.calls)).not.toContain("SENTINEL_RESOLVER_FAULT");
    } finally {
      record.mockRestore();
    }
  });
});
