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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  EDITOR_AGENT_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentAction,
  type EditorAgentRootBinding,
  type EditorAgentSessionSnapshot,
  type WorkspaceManifest,
  type WorkspaceRootDispatch,
} from "@oscharko-dev/keiko-contracts";
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
import {
  editorAgentPathBoundaryReason,
  resolveEditorAgentActionRoot,
  resolveEditorAgentSessionRoot,
} from "./agentRootBoundary.js";

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
    req,
    res: { writableEnded: false, on: (): void => undefined } as unknown as ServerResponse,
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
    const evidence = listEditorAgentActionAudit("session-a").at(-1);
    expect(evidence).toMatchObject({
      disposition: "denied",
      denyReason: "decompose-per-root",
      rootAttribution: { rootRef: binding(0).rootRef },
    });
    expect(evidence).not.toHaveProperty("targetPath");
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
