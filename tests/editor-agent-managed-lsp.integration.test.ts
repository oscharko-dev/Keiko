import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  DEFAULT_LSP_PROCESS_CONFIG,
  EDITOR_AGENT_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentGovernedAuthorityReference,
  type EditorAgentNavigateSymbolOperation,
  type EditorAgentSessionSnapshot,
  type ToolCallResult,
} from "@oscharko-dev/keiko-contracts";
import {
  createFetchEditorAgentHttpTransport,
  EditorAgentHttpClient,
  EditorAgentToolHost,
  type EditorAgentHttpTransport,
  type EditorAgentHttpTransportRequest,
  type EditorAgentHttpTransportResponse,
  type EditorAgentToolOutput,
} from "@oscharko-dev/keiko-tools";
import { afterEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "../packages/keiko-server/src/csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  type UiHandlerDeps,
} from "../packages/keiko-server/src/index.js";
import { createRunRegistry } from "../packages/keiko-server/src/runs.js";
import { createUiServer, UI_HOST } from "../packages/keiko-server/src/server.js";
import { _resetEditorAgentStateForTests } from "../packages/keiko-server/src/editor/agentRoutes.js";
import { listEditorAgentActionAudit } from "../packages/keiko-server/src/editor/agentActionAudit.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../packages/keiko-server/src/editor/agentAuthorityRegistry.js";
import { createManagedLspActivationStore } from "../packages/keiko-server/src/editor/lsp/managedLspActivationStore.js";
import { createManagedLspControlService } from "../packages/keiko-server/src/editor/lsp/managedLspControl.js";
import { shutdownHostLspPool } from "../packages/keiko-server/src/editor/lsp/hostLanguageOperation.js";
import type { LspSpawnFn } from "../packages/keiko-server/src/editor/lsp/lspNodeAdapter.js";
import {
  createFakeLspProcess,
  type FakeLspBehavior,
} from "../packages/keiko-server/src/editor/lsp/testing/fakeLspProcess.js";
import { createWorkspaceMutexRegistry } from "../packages/keiko-server/src/task-workspace/mutex.js";

const SESSION_ID = "session-2281";
const HASH = "a".repeat(64);
const RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
} as const;

interface Fixture {
  readonly root: string;
  readonly stateDir: string;
  readonly staticRoot: string;
  readonly binDir: string;
  readonly server: Server;
  readonly deps: UiHandlerDeps;
  readonly client: EditorAgentHttpClient;
  readonly toolHost: EditorAgentToolHost;
  readonly spawnedMethods: readonly (readonly string[])[];
  readonly extraRoots: string[];
  readonly queuedRequests: readonly EditorAgentHttpTransportRequest[];
}

const activeFixtures: Fixture[] = [];

function executable(directory: string, name: string): void {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  chmodSync(path, 0o755);
}

function callHierarchyItem(root: string): Record<string, unknown> {
  return {
    name: "value",
    kind: 12,
    uri: pathToFileURL(join(root, "main.py")).href,
    range: RANGE,
    selectionRange: RANGE,
  };
}

function navigationResults(root: string): Record<string, unknown> {
  const pythonUri = pathToFileURL(join(root, "main.py")).href;
  const item = callHierarchyItem(root);
  return {
    "textDocument/typeDefinition": [{ uri: pythonUri, range: RANGE }],
    "textDocument/implementation": [{ uri: pythonUri, range: RANGE }],
    "textDocument/references": [{ uri: pythonUri, range: RANGE }],
    "textDocument/prepareCallHierarchy": [item],
    "callHierarchy/incomingCalls": [{ from: item, fromRanges: [RANGE] }],
    "callHierarchy/outgoingCalls": [{ to: item, fromRanges: [RANGE] }],
    "textDocument/inlayHint": [{ position: RANGE.end, label: ": str", kind: 1 }],
    "textDocument/signatureHelp": { signatures: [{ label: "value()" }] },
  };
}

const DEFAULT_MANAGED_CAPABILITIES: Record<string, unknown> = {
  textDocumentSync: 2,
  diagnosticProvider: true,
  definitionProvider: true,
  typeDefinitionProvider: true,
  implementationProvider: true,
  referencesProvider: true,
  callHierarchyProvider: true,
  inlayHintProvider: true,
  signatureHelpProvider: {},
  codeActionProvider: true,
  renameProvider: { prepareProvider: true },
};

interface ManagedSpawnOverrides {
  readonly capabilities?: Record<string, unknown>;
  readonly results?: Readonly<Record<string, unknown>>;
  readonly behavior?: FakeLspBehavior;
}

function managedSpawn(
  methods: (readonly string[])[],
  root: string,
  onMessage?: (method: string) => void,
  overrides?: ManagedSpawnOverrides,
): LspSpawnFn {
  return () => {
    const controller = createFakeLspProcess({
      ...(overrides?.behavior === undefined ? {} : { behavior: overrides.behavior }),
      initializeResult: {
        capabilities: overrides?.capabilities ?? DEFAULT_MANAGED_CAPABILITIES,
      },
      results: {
        "textDocument/diagnostic": {
          kind: "full",
          items: [{ range: RANGE, severity: 1, message: "bounded diagnostic", code: "P2281" }],
        },
        "textDocument/definition": [
          { uri: pathToFileURL(join(root, "main.go")).href, range: RANGE },
        ],
        "textDocument/prepareRename": { range: RANGE, placeholder: "value" },
        "textDocument/codeAction": [
          {
            title: "Review change",
            kind: "quickfix",
            edit: {
              changes: {
                [pathToFileURL(join(root, "main.py")).href]: [
                  { range: RANGE, newText: "reviewed" },
                ],
              },
            },
          },
        ],
        ...navigationResults(root),
        ...overrides?.results,
      },
      ...(onMessage === undefined
        ? {}
        : {
            onMessage: (method: string): void => {
              onMessage(method);
            },
          }),
    });
    methods.push(controller.receivedMethods());
    return controller.handle;
  };
}

// Spawns a process that crashes immediately, over and over, driving the manager's own restart
// throttle to exhaustion (RESTART_THROTTLED) -- the docked-agent-visible shape of a crash-looping,
// unhealthy provider (docs/qa: "Unhealthy ... including crash-loop exhaustion"). The crash is
// deferred to a macrotask so the manager's `onExit` listener is registered first; there is no real
// backoff delay anywhere in the throttle, so the whole loop resolves in milliseconds, never the real
// restart window.
function crashLoopSpawn(methods: (readonly string[])[]): LspSpawnFn {
  return () => {
    const controller = createFakeLspProcess();
    methods.push(controller.receivedMethods());
    setTimeout(() => {
      controller.crash(1);
    }, 0);
    return controller.handle;
  };
}

function manyReferenceLocations(root: string, count: number): readonly Record<string, unknown>[] {
  const uri = pathToFileURL(join(root, "main.py")).href;
  return Array.from({ length: count }, (_, line) => ({
    uri,
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
  }));
}

function authority(root: string): EditorAgentGovernedAuthorityReference {
  const envelope: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2281",
    localUser: "local-operator",
    taskRefs: ["issue-2281"],
    workspace: {
      workspaceId: "workspace-2281",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(root),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "governed-assist",
    effectiveMode: resolveEffectiveCodingWorkbenchMode("supervised-coding", "governed-assist"),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-2281",
      source: "keiko-model-gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "deny",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 1,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 300_000,
      maxToolCalls: 8,
      maxPromptTokens: 1,
      maxPatchBytes: 65_536,
    },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    approvalProofDigest: HASH,
  };
  const registered = editorAgentAuthorityRegistry.register(
    envelope,
    "governed-assist",
    new Date().toISOString(),
  );
  if (!registered.ok) throw new Error("expected authority registration");
  return registered.authorityRef;
}

function snapshot(root: string): EditorAgentSessionSnapshot {
  const path = join(root, "main.py");
  const text = "value = missing\n";
  const stats = statSync(path);
  const contentHash = createHash("sha256").update(text).digest("hex");
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    windowId: "window-2281",
    workspaceRoot: root,
    activePaneId: "pane-2281",
    panes: [{ paneId: "pane-2281", activeFile: "main.py", openFiles: ["main.py", "main.go"] }],
    dirtyFiles: [],
    activeFile: "main.py",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: stats.size, modifiedAt: stats.mtimeMs, contentHash },
    activeFileContentHash: contentHash,
    textMode: "none",
    updatedAt: Date.now(),
  };
}

function recordingTransport(
  inner: EditorAgentHttpTransport,
  sink: EditorAgentHttpTransportRequest[],
): EditorAgentHttpTransport {
  return {
    request: (request): Promise<EditorAgentHttpTransportResponse> => {
      sink.push(request);
      return inner.request(request);
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function createFixture(
  onLspMessage?: (method: string) => void,
  controlEnv: Readonly<Record<string, string>> = {},
  spawnFactory?: (methods: string[][], root: string) => LspSpawnFn,
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-lsp-ws-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-lsp-state-")));
  const staticRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-lsp-static-")));
  const binDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-lsp-bin-")));
  executable(binDir, "pyright-langserver");
  executable(binDir, "gopls");
  writeFileSync(join(root, "main.py"), "value = missing\n", "utf8");
  writeFileSync(join(root, "main.go"), "package main\nfunc main() {}\n", "utf8");
  writeFileSync(join(staticRoot, "index.html"), "<html></html>", "utf8");
  const spawnedMethods: string[][] = [];
  const managedLspControl = createManagedLspControlService({
    store: createManagedLspActivationStore({ stateDir }),
    processEnv: controlEnv,
    provisioning: (): boolean => true,
    disposePoolEntry: (): Promise<void> => Promise.resolve(),
    runtimeApproved: (): boolean => true,
    configurationSafe: (): boolean => true,
    projectEvidence: (): "projected" => "projected",
    mutex: createWorkspaceMutexRegistry(),
  });
  const deps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: { PATH: binDir },
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    managedLspControl,
    editorLanguageRouteOptions: {
      hostLanguageCommandRules: [{ executable: "pyright-langserver" }, { executable: "gopls" }],
      hostLanguageProcessConfig: {
        requestTimeoutMs: 200,
        shutdownTimeoutMs: 200,
      },
      hostLanguageSpawn: (spawnFactory ?? ((m, r): LspSpawnFn => managedSpawn(m, r, onLspMessage)))(
        spawnedMethods,
        root,
      ),
    },
  } satisfies UiHandlerDeps;
  let server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  const port = await listen(server);
  await closeServer(server);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  const queuedRequests: EditorAgentHttpTransportRequest[] = [];
  const client = new EditorAgentHttpClient({
    baseUrl: `http://${UI_HOST}:${String(port)}`,
    transport: recordingTransport(createFetchEditorAgentHttpTransport(), queuedRequests),
    // The default 2 000 ms client budget matches the LSP request deadline exactly, so a
    // server-resolved operation that legitimately takes the full deadline (the "unresponsive
    // request" fail-closed test below, ~2 000 ms) or that then disposes a terminally unhealthy
    // pooled process (the crash-loop test below: `finalizePooledEntry` awaits a graceful-shutdown
    // handshake against a dead transport, which itself waits the full `shutdownTimeoutMs`,
    // ~5 000 ms) would race the client's own abort. A longer client-side budget lets the server's
    // own typed TIMED_OUT response win that race.
    timeoutMs: 8_000,
  });
  const toolHost = new EditorAgentToolHost({
    client,
    authorityRef: authority(root),
    nextActionId: ((): (() => string) => {
      let id = 0;
      return (): string => `action-2281-${String((id += 1))}`;
    })(),
  });
  const fixture = {
    root,
    stateDir,
    staticRoot,
    binDir,
    server,
    deps,
    client,
    toolHost,
    spawnedMethods,
    extraRoots: [],
    queuedRequests,
  };
  activeFixtures.push(fixture);
  return fixture;
}

async function activate(
  fixture: Fixture,
  language: "python" | "go",
  revision: number,
): Promise<void> {
  const result = await fixture.deps.managedLspControl?.mutate({
    action: "activate",
    actorClass: "localHuman",
    expectedRevision: revision,
    idempotencyKey: `activate-${language}-2281`,
    language,
    root: fixture.root,
  });
  expect(result?.kind).toBe("ok");
}

type ReadOnlyNavigateSymbolOperation = Exclude<
  EditorAgentNavigateSymbolOperation,
  "renamePrepare" | "codeActions"
>;

function call(
  fixture: Fixture,
  operation: ReadOnlyNavigateSymbolOperation,
  file: "main.py" | "main.go",
  languageId: "python" | "go",
  idempotencySuffix = "initial",
): Promise<ToolCallResult> {
  return fixture.toolHost.execute({
    toolCallId: `call-${operation}-${languageId}`,
    toolName: "editor_navigate_symbol",
    arguments: {
      sessionId: SESSION_ID,
      idempotencyKey: `idempotency-${operation}-${languageId}-${idempotencySuffix}`,
      file,
      operation,
      position: { line: 0, character: 0 },
      languageId,
      ...(operation === "inlayHints" ? { range: RANGE } : {}),
    },
    signal: new AbortController().signal,
  });
}

function output(result: ToolCallResult): EditorAgentToolOutput {
  return JSON.parse(result.output) as EditorAgentToolOutput;
}

async function registerSnapshot(fixture: Fixture, root: string): Promise<void> {
  const port = (fixture.server.address() as AddressInfo).port;
  const response = await fetch(`http://${UI_HOST}:${String(port)}/api/editor/agent/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot: snapshot(root),
    }),
  });
  expect(response.status).toBe(200);
}

function reviewCall(
  fixture: Fixture,
  operation: "renamePrepare" | "codeActions",
): Promise<ToolCallResult> {
  return fixture.toolHost.execute({
    toolCallId: `call-${operation}-python`,
    toolName: "editor_navigate_symbol",
    arguments: {
      sessionId: SESSION_ID,
      idempotencyKey: `idempotency-${operation}-python`,
      file: "main.py",
      operation,
      position: { line: 0, character: 0 },
      languageId: "python",
      ...(operation === "codeActions" ? { range: RANGE, diagnostics: [] } : {}),
    },
    signal: new AbortController().signal,
  });
}

afterEach(async () => {
  for (const fixture of activeFixtures.splice(0)) {
    await closeServer(fixture.server);
    fixture.deps.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.stateDir, { recursive: true, force: true });
    rmSync(fixture.staticRoot, { recursive: true, force: true });
    rmSync(fixture.binDir, { recursive: true, force: true });
    for (const root of fixture.extraRoots) rmSync(root, { recursive: true, force: true });
  }
  await shutdownHostLspPool();
  _resetEditorAgentStateForTests();
});

describe("docked-agent managed-LSP integration (#2281)", () => {
  it("resolves Python diagnostics and Go navigation through the real BFF and tool host", async () => {
    const fixture = await createFixture();
    await activate(fixture, "python", 0);
    await activate(fixture, "go", 1);
    await registerSnapshot(fixture, fixture.root);

    const pythonResult = output(await call(fixture, "diagnostics", "main.py", "python"));
    if (!pythonResult.ok) throw new Error(JSON.stringify(pythonResult));
    expect(pythonResult).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "diagnostics", result: { diagnostics: [{ code: "P2281" }] } },
      },
    });
    expect(output(await call(fixture, "definition", "main.go", "go"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "definition", result: { locations: [{ path: "main.go" }] } },
      },
    });
    const beforeReview = readFileSync(join(fixture.root, "main.py"), "utf8");
    expect(output(await reviewCall(fixture, "renamePrepare"))).toMatchObject({
      ok: true,
      result: { status: "succeeded", data: { operation: "renamePrepare" } },
    });
    expect(output(await reviewCall(fixture, "codeActions"))).toMatchObject({
      ok: true,
      result: { status: "succeeded", data: { operation: "codeActions" } },
    });
    expect(readFileSync(join(fixture.root, "main.py"), "utf8")).toBe(beforeReview);
    expect(fixture.spawnedMethods).toHaveLength(2);
    expect(listEditorAgentActionAudit(SESSION_ID)).toMatchObject([
      { actionType: "navigateSymbol", outcome: "succeeded", targetPath: "main.py" },
      { actionType: "navigateSymbol", outcome: "succeeded", targetPath: "main.go" },
      { actionType: "navigateSymbol", outcome: "succeeded", targetPath: "main.py" },
      { actionType: "navigateSymbol", outcome: "succeeded", targetPath: "main.py" },
    ]);
    const serialized = JSON.stringify(listEditorAgentActionAudit(SESSION_ID));
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("bounded diagnostic");
  });

  it("resolves references, hierarchy, inlay, and signature operations through the real BFF and tool host", async () => {
    const fixture = await createFixture();
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);

    expect(output(await call(fixture, "typeDefinition", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "typeDefinition", result: { locations: [{ path: "main.py" }] } },
      },
    });
    expect(output(await call(fixture, "implementation", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "implementation", result: { locations: [{ path: "main.py" }] } },
      },
    });
    expect(output(await call(fixture, "references", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "references", result: { locations: [{ path: "main.py" }] } },
      },
    });
    expect(output(await call(fixture, "callHierarchy", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "callHierarchy", result: { roots: [{ item: { path: "main.py" } }] } },
      },
    });
    expect(output(await call(fixture, "inlayHints", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "inlayHints", result: { hints: [{ label: ": str" }] } },
      },
    });
    expect(output(await call(fixture, "signatureHelp", "main.py", "python"))).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "signatureHelp", result: { signatures: [{ label: "value()" }] } },
      },
    });

    const serialized = JSON.stringify(listEditorAgentActionAudit(SESSION_ID));
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(": str");
  });

  it("rejects a stale advertised capability after workspace deactivation without fallback", async () => {
    const fixture = await createFixture();
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);
    const port = (fixture.server.address() as AddressInfo).port;
    const capabilityResponse = await fetch(
      `http://${UI_HOST}:${String(port)}/api/editor/language/capabilities?root=${encodeURIComponent(fixture.root)}`,
    );
    const capabilityBody = (await capabilityResponse.json()) as {
      readonly providers: readonly { readonly id: string; readonly availability: string }[];
    };
    expect(capabilityBody.providers.find(({ id }) => id === "python-lsp")).toMatchObject({
      id: "python-lsp",
      availability: "available",
    });
    const deactivated = await fixture.deps.managedLspControl?.mutate({
      action: "deactivate",
      actorClass: "localHuman",
      expectedRevision: 1,
      idempotencyKey: "deactivate-python-2281",
      language: "python",
      root: fixture.root,
    });
    expect(deactivated?.kind).toBe("ok");

    expect(output(await call(fixture, "diagnostics", "main.py", "python", "stale"))).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE" } },
    });
    expect(fixture.spawnedMethods).toHaveLength(0);
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "PROVIDER_UNAVAILABLE",
      targetPath: "main.py",
    });
  });

  it("fails closed on a policy-blocked provider without dispatching to the fake process", async () => {
    const fixture = await createFixture(undefined, { KEIKO_EDITOR_LSP_POLICY_PYTHON: "denied" });
    await registerSnapshot(fixture, fixture.root);
    const denied = await fixture.deps.managedLspControl?.mutate({
      action: "activate",
      actorClass: "localHuman",
      expectedRevision: 0,
      idempotencyKey: "activate-python-policy-2281",
      language: "python",
      root: fixture.root,
    });
    expect(denied?.kind).toBe("denied");

    expect(output(await call(fixture, "diagnostics", "main.py", "python", "policy"))).toMatchObject(
      { ok: true, result: { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE" } } },
    );
    expect(fixture.spawnedMethods).toHaveLength(0);
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "PROVIDER_UNAVAILABLE",
      targetPath: "main.py",
    });
  });

  it("propagates in-flight caller cancellation to the managed provider request", async () => {
    const controller = new AbortController();
    const fixture = await createFixture((method) => {
      if (method === "textDocument/diagnostic") controller.abort();
    });
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);
    const result = await fixture.toolHost.execute({
      toolCallId: "call-cancel-python",
      toolName: "editor_navigate_symbol",
      arguments: {
        sessionId: SESSION_ID,
        idempotencyKey: "idempotency-cancel-python",
        file: "main.py",
        operation: "diagnostics",
        position: { line: 0, character: 0 },
        languageId: "python",
      },
      signal: controller.signal,
    });
    expect(output(result)).toMatchObject({
      ok: false,
      error: { kind: "cancelled", code: "CANCELLED" },
    });
    expect(fixture.spawnedMethods.flat()).toContain("textDocument/diagnostic");
  });

  it("rechecks managed activation after a workspace switch before provider dispatch", async () => {
    const fixture = await createFixture();
    await activate(fixture, "python", 0);
    const switchedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-agent-lsp-switched-")));
    fixture.extraRoots.push(switchedRoot);
    writeFileSync(join(switchedRoot, "main.py"), "value = switched\n", "utf8");
    await registerSnapshot(fixture, switchedRoot);

    const switched = output(await call(fixture, "diagnostics", "main.py", "python", "switched"));
    expect(switched).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE" } },
    });
    expect(fixture.spawnedMethods).toHaveLength(0);
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      disposition: "allowed",
      outcome: "failed",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("fails closed with PROVIDER_UNAVAILABLE when the activated tool is no longer resolvable, without spawning it", async () => {
    const fixture = await createFixture();
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);
    rmSync(join(fixture.binDir, "pyright-langserver"));

    expect(
      output(await call(fixture, "diagnostics", "main.py", "python", "missing")),
    ).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE" } },
    });
    expect(fixture.spawnedMethods).toHaveLength(0);
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "PROVIDER_UNAVAILABLE",
      targetPath: "main.py",
    });
  });

  it("fails closed with UNSUPPORTED_OPERATION when the negotiated capability set excludes the operation, without dispatching it", async () => {
    const fixture = await createFixture(undefined, {}, (methods, root) =>
      managedSpawn(methods, root, undefined, {
        capabilities: { ...DEFAULT_MANAGED_CAPABILITIES, referencesProvider: false },
      }),
    );
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);

    expect(output(await call(fixture, "references", "main.py", "python"))).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "UNSUPPORTED_OPERATION" } },
    });
    expect(fixture.spawnedMethods.flat()).toContain("initialize");
    expect(fixture.spawnedMethods.flat()).not.toContain("textDocument/references");
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "UNSUPPORTED_OPERATION",
      targetPath: "main.py",
    });
  });

  it("fails closed with TIMED_OUT when the provider is unhealthy from crash-loop exhaustion, never negotiating", async () => {
    const fixture = await createFixture(undefined, {}, (methods) => crashLoopSpawn(methods));
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);

    expect(output(await call(fixture, "references", "main.py", "python"))).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "TIMED_OUT" } },
    });
    expect(fixture.spawnedMethods).toHaveLength(DEFAULT_LSP_PROCESS_CONFIG.maxRestartsInWindow + 1);
    expect(fixture.spawnedMethods.flat()).not.toContain("textDocument/references");
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "TIMED_OUT",
      targetPath: "main.py",
    });
  });

  it("fails closed with TIMED_OUT when the provider accepts the request but never answers it", async () => {
    const fixture = await createFixture(undefined, {}, (methods, root) =>
      managedSpawn(methods, root, undefined, { behavior: "unresponsive-request" }),
    );
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);

    expect(output(await call(fixture, "references", "main.py", "python"))).toMatchObject({
      ok: true,
      result: { status: "failed", failure: { code: "TIMED_OUT" } },
    });
    expect(fixture.spawnedMethods.flat()).toContain("textDocument/references");
    expect(listEditorAgentActionAudit(SESSION_ID).at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "TIMED_OUT",
      targetPath: "main.py",
    });
  });

  it("caps an over-limit references result at the docked-agent boundary without leaking the dropped tail", async () => {
    const overLimit = DEFAULT_LANGUAGE_SERVICE_LIMITS.maxReferenceLocations + 1;
    const fixture = await createFixture(undefined, {}, (methods, root) =>
      managedSpawn(methods, root, undefined, {
        results: { "textDocument/references": manyReferenceLocations(root, overLimit) },
      }),
    );
    await activate(fixture, "python", 0);
    await registerSnapshot(fixture, fixture.root);

    const parsedOutput = output(await call(fixture, "references", "main.py", "python"));
    expect(parsedOutput).toMatchObject({
      ok: true,
      result: {
        status: "succeeded",
        data: { operation: "references", result: { truncated: true } },
      },
    });
    const serializedOutput = JSON.stringify(parsedOutput);
    expect(serializedOutput).toContain('"line":511');
    expect(serializedOutput).not.toContain('"line":512');
    const serializedAudit = JSON.stringify(listEditorAgentActionAudit(SESSION_ID));
    expect(serializedAudit).not.toContain('"line":512');
    expect(serializedAudit).not.toContain(fixture.root);
  });

  it(
    "keeps the resolved executable path and provider config directory out of the queued " +
      "payload, host output, and audit trail on both a succeeding and a fail-closed call (AC3)",
    async () => {
      const fixture = await createFixture();
      await activate(fixture, "python", 0);
      await registerSnapshot(fixture, fixture.root);

      const succeeded = output(await call(fixture, "diagnostics", "main.py", "python", "leak-ok"));
      expect(succeeded).toMatchObject({ ok: true, result: { status: "succeeded" } });

      rmSync(join(fixture.binDir, "pyright-langserver"));
      const failed = output(await call(fixture, "definition", "main.py", "python", "leak-fail"));
      expect(failed).toMatchObject({
        ok: true,
        result: { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE" } },
      });

      const forbidden = [fixture.binDir, fixture.stateDir, "pyright-langserver"];
      const queuedPayload = JSON.stringify(fixture.queuedRequests.map((request) => request.body));
      const hostOutput = JSON.stringify([succeeded, failed]);
      const auditTrail = JSON.stringify(listEditorAgentActionAudit(SESSION_ID));
      for (const value of forbidden) {
        expect(queuedPayload).not.toContain(value);
        expect(hostOutput).not.toContain(value);
        expect(auditTrail).not.toContain(value);
      }
    },
  );
});
