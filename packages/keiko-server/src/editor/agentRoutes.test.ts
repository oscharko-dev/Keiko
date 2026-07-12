import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS,
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentAction,
  parseEditorAgentQueryGitData,
  isEditorAgentSessionSnapshot,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type EditorAgentAction,
  type EditorAgentGovernedAuthorityReference,
  type EditorAgentActionResult,
  type EditorAgentActionStatus,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import type { GitProcessOptions, GitProcessResult } from "@oscharko-dev/keiko-git";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { STREAMING, type RouteContext } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createAutonomousDeliveryApprovalStore } from "../coding-runtime/autonomousDeliveryApprovalStore.js";
import * as workspaceSearchRoutes from "./workspaceSearchRoutes.js";
import { EDITOR_AGENT_ACTION_TIMEOUT_MS, editorAgentRegistry } from "./agentSessionRegistry.js";
import {
  _resetEditorAgentStateForTests,
  _setEditorAgentPatchWriterForTests,
  handleEditorAgentActions,
  handleEditorAgentAuthority,
  handleEditorAgentAudit,
  handleEditorAgentEvents,
  handleEditorAgentSessions,
  handleEditorAgentSnapshot,
} from "./agentRoutes.js";
import type { EditorAgentActionAuditRecord } from "@oscharko-dev/keiko-contracts";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";

const HASH = "a".repeat(64);
const PREPARED_CHANGESET_WIRE_LIMIT_BYTES = 65_536;
const PATCH_SOURCE_LIMIT_BYTES = 1_000_000;
let bridgeDecisionCapability: string | undefined;
let agentAuthorityRef: EditorAgentGovernedAuthorityReference | undefined;
const bridgeDecisionCapabilities = new Map<string, string>();
let bridgeStreamSequence = 0;
type ChangesetFile = NonNullable<EditorAgentAction["changeset"]>["files"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function actionResultStatus(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result)) return undefined;
  return typeof body.result.status === "string" ? body.result.status : undefined;
}

function actionConflictCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.conflict)) {
    return undefined;
  }
  return typeof body.result.conflict.code === "string" ? body.result.conflict.code : undefined;
}

function actionResult(body: unknown): EditorAgentActionResult {
  if (!isRecord(body) || !isRecord(body.result)) throw new Error("expected action result");
  return body.result as unknown as EditorAgentActionResult;
}

function responseSnapshot(body: unknown): EditorAgentSessionSnapshot {
  if (!isRecord(body) || !isRecord(body.snapshot)) throw new Error("expected snapshot response");
  return body.snapshot as unknown as EditorAgentSessionSnapshot;
}

function responseBridgeCapability(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.bridgeDecisionCapability === "string"
    ? body.bridgeDecisionCapability
    : undefined;
}

function responseAuthorityRef(body: unknown): EditorAgentGovernedAuthorityReference | undefined {
  if (!isRecord(body) || !isRecord(body.authorityRef)) return undefined;
  const { runId, envelopeDigest } = body.authorityRef;
  return typeof runId === "string" && typeof envelopeDigest === "string"
    ? { runId, envelopeDigest }
    : undefined;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function authorityEnvelope(
  workspaceRoot: string,
  requestedMode: CodingWorkbenchMode = "autonomous-delivery",
  deploymentCeiling: CodingWorkbenchMode = "governed-assist",
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2121",
    localUser: "local-operator",
    taskRefs: ["issue-2121"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(workspaceRoot),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
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
    approvalProofDigest: HASH,
  };
}

function authorityRouteRequest(
  envelope: CodingWorkbenchAuthorityEnvelope,
  deploymentCeiling: CodingWorkbenchMode = "governed-assist",
): {
  readonly body: Record<string, unknown>;
  readonly deps: Parameters<typeof handleEditorAgentAuthority>[1];
} {
  const approvalStore = createAutonomousDeliveryApprovalStore();
  return {
    body: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      authorityEnvelope: envelope,
      confirmation: approvalStore.issue(envelope, "2026-07-10T00:00:00.000Z"),
    },
    deps: {
      autonomousDeliveryApprovalStore: approvalStore,
      autonomousDeliveryDeploymentCeiling: deploymentCeiling,
    },
  };
}

function registerTestAuthority(
  workspaceRoot: string,
  requestedMode: CodingWorkbenchMode = "autonomous-delivery",
): void {
  const registered = editorAgentAuthorityRegistry.register(
    authorityEnvelope(workspaceRoot, requestedMode),
    "governed-assist",
    new Date().toISOString(),
  );
  if (!registered.ok) throw new Error("expected editor authority registration");
  agentAuthorityRef = registered.authorityRef;
}

function context(body: unknown = {}, path = "/api/editor/agent/actions"): RouteContext {
  const requestBody =
    isEditorAgentAction(body) &&
    !Object.prototype.hasOwnProperty.call(body, "authorityRef") &&
    agentAuthorityRef !== undefined
      ? { ...body, authorityRef: agentAuthorityRef }
      : body;
  const req = Readable.from([
    Buffer.from(JSON.stringify(requestBody), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

// Build a minimal snapshot for a given workspaceRoot and optional activeFile.
function snapshot(workspaceRoot = "/repo", activeFile = "src/a.ts"): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot,
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile, openFiles: [activeFile] }],
    dirtyFiles: [],
    activeFile,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    activeFileContentHash: HASH,
    textMode: "none",
    updatedAt: 1,
  };
}

function action(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    sessionId: "session-1",
    type: "save",
    expectedContentHash: HASH,
    ...(agentAuthorityRef === undefined ? {} : { authorityRef: agentAuthorityRef }),
    ...overrides,
  };
}

// Connect a session-scoped SSE bridge so the session is "live" (Issue #1392). Returns the captured
// frames plus a close() that drops the bridge. Bridge liveness gates action queueing: without a live
// bridge a queued action is answered NO_ACTIVE_BRIDGE (AC1).
function connectBridge(
  sessionId: string | readonly string[] | undefined,
  capabilityOverride?: string | readonly string[] | null,
  bridgeStreamIdOverride?: string,
): {
  readonly frames: () => string;
  readonly close: () => void;
  readonly outcome: ReturnType<typeof handleEditorAgentEvents>;
  readonly requestUrl: () => string | undefined;
  readonly contextUrl: () => string;
} {
  const writes: string[] = [];
  const closeHandlers: (() => void)[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ServerResponse;
  const req = { on: vi.fn() } as unknown as IncomingMessage;
  const sessionIds: readonly string[] =
    sessionId === undefined ? [] : Array.isArray(sessionId) ? sessionId : [sessionId];
  const overrides = isStringArray(capabilityOverride) ? capabilityOverride : undefined;
  const capabilities = sessionIds.map((id, index) => {
    if (overrides !== undefined) return overrides[index];
    if (typeof capabilityOverride === "string") return capabilityOverride;
    return capabilityOverride === null ? undefined : bridgeDecisionCapabilities.get(id);
  });
  const queryParts = sessionIds.map((id) => `sessionId=${encodeURIComponent(id)}`);
  if (sessionIds.length > 0) {
    bridgeStreamSequence += 1;
    queryParts.push(
      `bridgeStreamId=${bridgeStreamIdOverride ?? bridgeStreamSequence.toString(16).padStart(32, "0")}`,
    );
  }
  for (const capability of capabilities) {
    if (capability !== undefined) {
      queryParts.push(`bridgeDecisionCapability=${encodeURIComponent(capability)}`);
    }
  }
  const query = queryParts.length === 0 ? "" : `?${queryParts.join("&")}`;
  (req as { url?: string }).url = `/api/editor/agent/events${query}`;
  const url = new URL(`http://localhost/api/editor/agent/events${query}`);
  const outcome = handleEditorAgentEvents({
    req,
    res,
    params: {},
    url,
  });
  return {
    frames: (): string => writes.join(""),
    outcome,
    requestUrl: (): string | undefined => req.url,
    contextUrl: (): string => url.toString(),
    close: (): void => {
      for (const cb of closeHandlers) cb();
    },
  };
}

function actionFailureCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.failure)) {
    return undefined;
  }
  return typeof body.result.failure.code === "string" ? body.result.failure.code : undefined;
}

// Register a snapshot WITHOUT connecting a bridge, so the session is registered but not live.
async function registerSnapshotOnly(
  overrides: Partial<EditorAgentSessionSnapshot> = {},
): Promise<void> {
  const nextSnapshot = { ...snapshot(), ...overrides };
  registerTestAuthority(nextSnapshot.workspaceRoot);
  const existingCapability = bridgeDecisionCapabilities.get(nextSnapshot.sessionId);
  const registered = await handleEditorAgentSnapshot(
    context(
      {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot: nextSnapshot,
        ...(existingCapability === undefined
          ? {}
          : { bridgeDecisionCapability: existingCapability }),
      },
      "/api/editor/agent/snapshot",
    ),
  );
  const issued = responseBridgeCapability(registered.body);
  if (issued !== undefined) bridgeDecisionCapabilities.set(nextSnapshot.sessionId, issued);
  bridgeDecisionCapability = bridgeDecisionCapabilities.get("session-1");
}

// Register a snapshot AND connect its live bridge, so a following action can be queued. The existing
// preflight-conflict tests reach their structural conflict before the liveness gate regardless, but
// the tests that expect a 202 queue need a live bridge present.
async function registerSnapshot(workspaceRoot?: string, activeFile?: string): Promise<void> {
  await registerSnapshotOnly(snapshot(workspaceRoot, activeFile));
  connectBridge("session-1");
}

function writeWorkspaceFile(root: string, file: string, content: string): void {
  const absolute = join(root, file);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function readWorkspaceFile(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function oneLineModifyPatch(
  changes: readonly { readonly file: string; readonly before: string; readonly after: string }[],
): string {
  return changes
    .flatMap(({ file, before, after }) => [
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `-${before}`,
      `+${after}`,
    ])
    .join("\n");
}

function changesetActionFor(
  root: string,
  patch: string,
  files: readonly string[],
  selectedFiles?: readonly string[],
  overrides: Partial<EditorAgentAction> = {},
): EditorAgentAction {
  const declared: readonly ChangesetFile[] = files.map((file) => ({
    file,
    expectedContentHash: sha256(readWorkspaceFile(root, file)),
  }));
  return action({
    type: "applyChangeset",
    expectedContentHash: undefined,
    expectedDocumentVersion: undefined,
    changeset: {
      patch,
      files: declared,
      ...(selectedFiles === undefined ? {} : { selectedFiles }),
    },
    ...overrides,
  });
}

async function registerChangesetSnapshot(
  root: string,
  activeFile: string,
  openFiles: readonly string[],
  dirtyFiles: readonly string[] = [],
): Promise<ReturnType<typeof connectBridge>> {
  const content = readWorkspaceFile(root, activeFile);
  const stats = statSync(join(root, activeFile));
  await registerSnapshotOnly({
    workspaceRoot: root,
    activeFile,
    panes: [{ paneId: "pane-1", activeFile, openFiles }],
    dirtyFiles,
    documentVersion: {
      sizeBytes: stats.size,
      modifiedAt: stats.mtimeMs,
      contentHash: sha256(content),
    },
    activeFileContentHash: sha256(content),
  });
  return connectBridge("session-1");
}

async function postActionResult(
  original: EditorAgentAction,
  status: EditorAgentActionStatus,
  sessionId = original.sessionId,
  capabilityOverride?: string | null,
  deps?: Parameters<typeof handleEditorAgentActions>[1],
): Promise<Awaited<ReturnType<typeof handleEditorAgentActions>>> {
  const capability =
    capabilityOverride === null ? undefined : (capabilityOverride ?? bridgeDecisionCapability);
  return handleEditorAgentActions(
    context({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      ...(capability === undefined ? {} : { bridgeDecisionCapability: capability }),
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: original.actionId,
        sessionId,
        status,
        ...(status === "conflict"
          ? { conflict: { code: "INVALID_EDITS", message: "Browser reported a conflict." } }
          : {}),
      },
    }),
    deps,
  );
}

function runtimeMutationDeps(
  runtimeMutationLease: NonNullable<UiHandlerDeps["runtimeMutationLease"]>,
): Parameters<typeof handleEditorAgentActions>[1] {
  return { runtimeMutationLease, store: {} } as Parameters<typeof handleEditorAgentActions>[1];
}

function lastEmittedAction(frames: string): EditorAgentAction {
  const frame = frames
    .split("\n\n")
    .filter((candidate) => candidate.includes("event: editor-agent:action"))
    .at(-1);
  const data = frame?.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("expected emitted action frame");
  const event = JSON.parse(data.slice("data: ".length)) as EditorAgentEvent;
  if (event.type !== "action") throw new Error("expected action event");
  return event.action;
}

afterEach(() => {
  bridgeDecisionCapability = undefined;
  agentAuthorityRef = undefined;
  bridgeDecisionCapabilities.clear();
  bridgeStreamSequence = 0;
  _resetEditorAgentStateForTests();
  vi.useRealTimers();
});

describe("server-resolved navigation and search actions (#2218)", () => {
  it("resolves a definition through the existing language handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-nav-"));
    const store = createInMemoryUiStore();
    mkdirSync(join(root, "src"), { recursive: true });
    const text = "const target = 1;\ntarget;\n";
    writeFileSync(join(root, "src", "a.ts"), text, "utf8");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const deps = { store, redactor: buildRedactor({}), env: {} } as unknown as UiHandlerDeps;
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "navigateSymbol",
            expectedContentHash: undefined,
            target: {
              file: "src/a.ts",
              selection: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
              },
            },
            navigateSymbol: {
              operation: "definition",
              document: { path: "src/a.ts", languageId: "typescript", text },
              position: { line: 1, character: 0 },
            },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(200);
      const result = actionResult(response.body);
      expect(result.status).toBe("succeeded");
      expect(result.data).toMatchObject({ operation: "definition" });
      const data = result.data as {
        readonly result: {
          readonly locations: readonly {
            readonly path: string;
            readonly range: { readonly start: { readonly line: number } };
          }[];
        };
      };
      expect(data.result.locations[0]?.path).toBe("src/a.ts");
      expect(data.result.locations[0]?.range.start.line).toBe(0);
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({ actionType: "navigateSymbol", mutating: false }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns bounded ranked workspace-search results through the existing search handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-search-"));
    const store = createInMemoryUiStore();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function parseConfig(): void {}\n", "utf8");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const deps = { store, redactor: buildRedactor({}), env: {} } as unknown as UiHandlerDeps;
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "searchWorkspace",
            expectedContentHash: undefined,
            searchWorkspace: { mode: "text", query: "parseConfig", maxResults: 1 },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(200);
      const result = actionResult(response.body);
      expect(result.status).toBe("succeeded");
      const data = result.data as {
        readonly results: readonly { readonly path: string; readonly score: number }[];
        readonly truncated: boolean;
      };
      expect(data.results[0]?.path).toBe("src/a.ts");
      expect(typeof data.results[0]?.score).toBe("number");
      expect(data.truncated).toBe(false);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive server-resolved targets before invoking a handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-containment-"));
    const store = createInMemoryUiStore();
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const deps = { store, redactor: buildRedactor({}), env: {} } as unknown as UiHandlerDeps;
    try {
      const searchHandler = vi.spyOn(workspaceSearchRoutes, "handleEditorWorkspaceSearch");
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "searchWorkspace",
            expectedContentHash: undefined,
            target: { file: ".env" },
            searchWorkspace: { mode: "text", query: "SECRET", scopePath: ".env" },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("OUT_OF_SCOPE");
      expect(searchHandler).not.toHaveBeenCalled();
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({
          actionType: "searchWorkspace",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
        }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("server-resolved git query action (#2298)", () => {
  const gitOk = (
    stdout: string,
  ): { exitCode: 0; signal: null; stdout: string; stderr: ""; truncated: false } => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    truncated: false,
  });

  const gitFailure = (): {
    exitCode: 1;
    signal: null;
    stdout: "";
    stderr: string;
    truncated: false;
  } => ({
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "bounded fixture failure",
    truncated: false,
  });

  function gitResponseFor(root: string, args: readonly string[]): ReturnType<typeof gitOk> {
    if (args.includes("rev-parse")) return gitOk(`${root}\n`);
    if (args.includes("status")) return gitOk("## main\0 M src/a.ts\0?? .env\0");
    if (args.includes("diff")) {
      const marker = args.includes("--cached") ? "staged value" : "unstaged value";
      return gitOk(
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-const a = 1;",
          `+const a = "${marker}";`,
          "",
        ].join("\n"),
      );
    }
    if (args.includes("blame")) {
      return gitOk(
        Array.from({ length: 33 }, (_unused, index) => {
          const line = index + 1;
          return `0000000000000000000000000000000000000000 ${String(line)} ${String(line)} 1\nauthor Alice\nauthor-time 1700000000\nauthor-tz +0000\nsummary blame ${String(line)}\n\tconst line${String(line)} = true;\n`;
        }).join(""),
      );
    }
    return gitOk("");
  }

  function dispatchingGitRunner(root: string): ReturnType<typeof vi.fn> {
    return vi.fn((args: readonly string[]) => Promise.resolve(gitResponseFor(root, args)));
  }

  function gitDeps(
    store: ReturnType<typeof createInMemoryUiStore>,
    runner: unknown,
  ): UiHandlerDeps {
    return {
      store,
      redactor: buildRedactor({}),
      env: {},
      gitRouteOptions: { runner, maxDiffBytes: 4096, maxStatusBytes: 4096, maxChanges: 50 },
    } as unknown as UiHandlerDeps;
  }

  it("aggregates bounded, redacted status, diff, and blame for one workspace file (AC2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n", "utf8");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["status", "diff", "blame"] },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(200);
      const result = actionResult(response.body);
      expect(result.status).toBe("succeeded");
      const parsed = parseEditorAgentQueryGitData(result.data);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      const data = parsed.value;
      expect(data.target).toEqual({ basename: "a.ts", pathHash: sha256("src/a.ts") });
      expect(data.aspects.status).toMatchObject({ state: "available", branch: "main" });
      expect(JSON.stringify(data.aspects.status)).not.toContain(".env");
      expect(data.aspects.diff?.staged?.scope).toBe("staged");
      expect(data.aspects.diff?.unstaged?.scope).toBe("unstaged");
      expect(JSON.stringify(data.aspects.diff)).toContain("staged value");
      expect(JSON.stringify(data.aspects.diff)).toContain("unstaged value");
      expect(data.aspects.blame?.lines).toHaveLength(32);
      expect(data.caps.maxBlameLines).toBe(32);
      expect(data.omissions).toContainEqual({ aspect: "blame", reason: "out-of-budget" });
      const diffCommands = runner.mock.calls
        .map((call) => call[0] as readonly string[])
        .filter((args) => args.includes("diff"));
      expect(diffCommands).toHaveLength(2);
      expect(diffCommands.some((args) => args.includes("--cached"))).toBe(true);
      expect(diffCommands.some((args) => !args.includes("--cached"))).toBe(true);
      const statusCommand = runner.mock.calls
        .map((call) => call[0] as readonly string[])
        .find((args) => args.includes("status"));
      expect(statusCommand?.at(-1)).toBe(":(literal)src/a.ts");
      const blameCommand = runner.mock.calls
        .map((call) => call[0] as readonly string[])
        .find((args) => args.includes("blame"));
      expect(blameCommand).toContain("1,33");
      const records = auditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        actionType: "queryGit",
        effectClass: "workspace-read",
        mutating: false,
        targetBasename: "a.ts",
        targetPathHash: sha256("src/a.ts"),
      });
      expect(records[0]).not.toHaveProperty("targetPath");
      const serializedAudit = JSON.stringify(records[0]);
      expect(serializedAudit).not.toContain("staged value");
      expect(serializedAudit).not.toContain("unstaged value");
      expect(serializedAudit).not.toContain("const line");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires and reserves workspace-read authority before any git read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-authority-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            authorityRef: undefined,
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["status"] },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("POLICY_DENIED");
      expect(runner).not.toHaveBeenCalled();
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({
          actionType: "queryGit",
          effectClass: "workspace-read",
          denyReason: "authority-missing",
        }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a mismatched audit target before invoking any git read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-target-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "README.md" },
            queryGit: { path: "src/a.ts", aspects: ["status"] },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("OUT_OF_SCOPE");
      expect(runner).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns real staged and unstaged file context from a hermetic fixture repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-fixture-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    const runGit = (args: readonly string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    try {
      runGit(["init", "-q", "-b", "main"]);
      runGit(["config", "user.name", "Keiko Fixture"]);
      runGit(["config", "user.email", "fixture@invalid.example"]);
      runGit(["config", "commit.gpgsign", "false"]);
      const baseline = Array.from(
        { length: 40 },
        (_unused, index) => `export const line${String(index + 1)} = ${String(index + 1)};`,
      );
      writeWorkspaceFile(root, "src/a.ts", `${baseline.join("\n")}\n`);
      writeWorkspaceFile(root, "src/unrelated.ts", "export const unrelated = false;\n");
      runGit(["add", "src/a.ts", "src/unrelated.ts"]);
      runGit(["commit", "-q", "-m", "fixture baseline"]);
      const staged = [...baseline];
      staged[0] = "export const line1 = 100;";
      writeWorkspaceFile(root, "src/a.ts", `${staged.join("\n")}\n`);
      runGit(["add", "src/a.ts"]);
      const mixed = [...staged];
      mixed[10] = "export const line11 = 1100;";
      writeWorkspaceFile(root, "src/a.ts", `${mixed.join("\n")}\n`);
      writeWorkspaceFile(root, "src/unrelated.ts", "export const unrelated = true;\n");
      writeWorkspaceFile(root, ".env", "FIXTURE_SECRET=not-returned\n");
      await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
      const deps = {
        store,
        redactor: buildRedactor({}),
        env: {},
        gitRouteOptions: { timeoutMs: 5_000 },
      } as unknown as UiHandlerDeps;
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["status", "diff", "blame"] },
          }),
        ),
        deps,
      );
      const result = actionResult(response.body);
      expect(response.status).toBe(200);
      expect(result.status).toBe("succeeded");
      const serialized = JSON.stringify(result.data);
      expect(serialized).toContain("line1 = 100");
      expect(serialized).toContain("line11 = 1100");
      expect(serialized).not.toContain("unrelated.ts");
      expect(serialized).not.toContain(".env");
      expect(serialized).not.toContain(root);
      const data = result.data as {
        readonly aspects?: { readonly blame?: { readonly lines?: readonly unknown[] } };
        readonly omissions?: readonly { readonly aspect: string; readonly reason: string }[];
      };
      expect(data.aspects?.blame?.lines).toHaveLength(32);
      expect(data.omissions).toContainEqual({ aspect: "blame", reason: "out-of-budget" });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape before repository resolution or any git read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-agent-git-outside-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(outside, "secret.ts", "export const secret = true;\n");
    symlinkSync(outside, join(root, "linked-outside"), "dir");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "linked-outside/secret.ts" },
            queryGit: {
              path: "linked-outside/secret.ts",
              aspects: ["status", "diff", "blame"],
            },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("OUT_OF_SCOPE");
      expect(runner).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("audits a symlink swapped after admission as a denied boundary action", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-race-"));
    const outside = mkdtempSync(join(tmpdir(), "keiko-agent-git-race-outside-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "export const inside = true;\n");
    writeWorkspaceFile(outside, "secret.ts", "export const secret = true;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        rmSync(join(root, "src", "a.ts"));
        symlinkSync(join(outside, "secret.ts"), join(root, "src", "a.ts"), "file");
        return Promise.resolve(gitOk(`${root}\n`));
      }
      return Promise.resolve(gitResponseFor(root, args));
    });
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["status", "diff", "blame"] },
          }),
        ),
        gitDeps(store, runner),
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("OUT_OF_SCOPE");
      expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain("status");
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({
          actionType: "queryGit",
          disposition: "denied",
          denyReason: "workspace-boundary-escape",
        }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("propagates request aborts to an in-flight git read and starts no later aspects", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-abort-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "export const value = true;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    let markStatusStarted: (() => void) | undefined;
    const statusStarted = new Promise<void>((resolveStarted) => {
      markStatusStarted = resolveStarted;
    });
    let observedAbort = false;
    let statusCalls = 0;
    const runner = vi.fn((args: readonly string[], options: GitProcessOptions) => {
      if (args.includes("rev-parse")) return Promise.resolve(gitOk(`${root}\n`));
      if (!args.includes("status")) return Promise.resolve(gitResponseFor(root, args));
      statusCalls += 1;
      if (statusCalls > 1) return Promise.resolve(gitResponseFor(root, args));
      markStatusStarted?.();
      return new Promise<GitProcessResult>((resolveResult) => {
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolveResult(gitFailure());
          },
          { once: true },
        );
      });
    });
    const requestAction = action({
      type: "queryGit",
      expectedContentHash: undefined,
      target: { file: "src/a.ts" },
      queryGit: { path: "src/a.ts", aspects: ["status", "diff", "blame"] },
    });
    const baseContext = context(requestAction);
    const responseEvents = Object.assign(new EventEmitter(), { writableEnded: false });
    const requestContext = {
      ...baseContext,
      res: responseEvents as unknown as ServerResponse,
    };
    try {
      const firstResponse = handleEditorAgentActions(requestContext, gitDeps(store, runner));
      await statusStarted;
      responseEvents.emit("close");
      const cancelled = await firstResponse;
      expect(observedAbort).toBe(true);
      expect(actionResult(cancelled.body).status).toBe("failed");
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({ actionType: "queryGit", outcome: "failed" }),
      ]);
      const invoked = runner.mock.calls.flatMap((call) => call[0]);
      expect(invoked).not.toContain("diff");
      expect(invoked).not.toContain("blame");
      const retry = await handleEditorAgentActions(context(requestAction), gitDeps(store, runner));
      expect(actionResult(retry.body).status).toBe("succeeded");
      expect(statusCalls).toBe(2);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps successful aspects when a diff layer is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-partial-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "const a = 1;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(gitOk(`${root}\n`));
      if (args.includes("status")) return Promise.resolve(gitOk("## main\0 M src/a.ts\0"));
      if (args.includes("diff") && args.includes("--cached")) {
        return Promise.resolve(gitFailure());
      }
      return Promise.resolve(gitResponseFor(root, args));
    });
    const diagnostics: ServerDiagnosticRecord[] = [];
    const deps = {
      ...gitDeps(store, runner),
      diagnostics: {
        record: (record: ServerDiagnosticRecord): void => void diagnostics.push(record),
      },
    } as UiHandlerDeps;
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["diff", "blame"] },
          }),
        ),
        deps,
      );
      const result = actionResult(response.body);
      expect(result.status).toBe("succeeded");
      const data = result.data as {
        readonly aspects?: Readonly<Record<string, unknown>>;
        readonly omissions?: readonly { readonly aspect: string; readonly reason: string }[];
      };
      expect(isRecord(data.aspects?.blame)).toBe(true);
      expect(data.omissions).toContainEqual({
        aspect: "diff",
        scope: "staged",
        reason: "unavailable",
        machineReason: "git-error",
      });
      expect(JSON.stringify(data.aspects?.diff)).toContain("unstaged value");
      expect(diagnostics).toMatchObject([
        expect.objectContaining({
          correlationId: "action-1",
          operation: "editor.agent.queryGit.diff",
        }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the staged diff when the unstaged layer is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-partial-unstaged-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "const a = 1;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(gitOk(`${root}\n`));
      if (args.includes("status")) return Promise.resolve(gitOk("## main\0 M src/a.ts\0"));
      if (args.includes("diff") && !args.includes("--cached")) {
        return Promise.resolve(gitFailure());
      }
      return Promise.resolve(gitResponseFor(root, args));
    });
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["diff"] },
          }),
        ),
        gitDeps(store, runner),
      );
      const parsed = parseEditorAgentQueryGitData(actionResult(response.body).data);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      expect(JSON.stringify(parsed.value.aspects.diff?.staged)).toContain("staged value");
      expect(parsed.value.aspects.diff?.unstaged).toBeUndefined();
      expect(parsed.value.omissions).toContainEqual({
        aspect: "diff",
        scope: "unstaged",
        reason: "unavailable",
        machineReason: "git-error",
      });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops an oversized aspect with explicit omission before retaining the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-budget-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "const a = 1;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const largeLines = Array.from(
      { length: 300 },
      (_unused, index) => `+${String(index).padStart(4, "0")}${"x".repeat(1_000)}`,
    );
    const largeDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,300 @@",
      ...largeLines,
      "",
    ].join("\n");
    const runner = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(gitOk(`${root}\n`));
      if (args.includes("status")) return Promise.resolve(gitOk("## main\0 M src/a.ts\0"));
      if (args.includes("diff")) return Promise.resolve(gitOk(largeDiff));
      return Promise.resolve(gitResponseFor(root, args));
    });
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["status", "diff"] },
          }),
        ),
        deps,
      );
      const result = actionResult(response.body);
      expect(Buffer.byteLength(JSON.stringify(result.data), "utf8")).toBeLessThanOrEqual(
        192 * 1024,
      );
      const data = result.data as {
        readonly aspects?: Readonly<Record<string, unknown>>;
        readonly omissions?: readonly { readonly aspect: string; readonly reason: string }[];
      };
      expect(isRecord(data.aspects?.status)).toBe(true);
      expect(data.omissions).toContainEqual({ aspect: "diff", reason: "out-of-budget" });
      expect(data.aspects).not.toHaveProperty("diff");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts diff and blame content before returning agent data", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-redaction-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    writeWorkspaceFile(root, "src/a.ts", "const a = 1;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const secret = "sk-git-query-redaction-1234567890abcdef";
    const runner = vi.fn((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(gitOk(`${root}\n`));
      if (args.includes("status")) return Promise.resolve(gitOk("## main\0 M src/a.ts\0"));
      if (args.includes("diff")) {
        return Promise.resolve(
          gitOk(
            `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+${secret}\n`,
          ),
        );
      }
      if (args.includes("blame")) {
        return Promise.resolve(
          gitOk(
            `0000000000000000000000000000000000000000 1 1 1\nauthor Alice\nauthor-time 1700000000\nauthor-tz +0000\nsummary ${secret}\n\t${secret}\n`,
          ),
        );
      }
      return Promise.resolve(gitOk(""));
    });
    const deps = {
      ...gitDeps(store, runner),
      redactor: buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    } as UiHandlerDeps;
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "src/a.ts" },
            queryGit: { path: "src/a.ts", aspects: ["diff", "blame"] },
          }),
        ),
        deps,
      );
      const serialized = JSON.stringify(actionResult(response.body).data);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("[REDACTED]");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts a secret-shaped target basename from results, replay state, and audit", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-target-redaction-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    const secret = "sk-query-target-1234567890abcdef";
    const path = `src/${secret}.ts`;
    writeWorkspaceFile(root, path, "export const value = true;\n");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: path });
    const runner = dispatchingGitRunner(root);
    const deps = {
      ...gitDeps(store, runner),
      redactor: buildRedactor({ KEIKO_DEFAULT_API_KEY: secret }),
    } as UiHandlerDeps;
    const request = action({
      type: "queryGit",
      expectedContentHash: undefined,
      target: { file: path },
      queryGit: { path, aspects: ["status"] },
    });
    try {
      const first = await handleEditorAgentActions(context(request), deps);
      const replay = await handleEditorAgentActions(context(request), deps);
      expect(JSON.stringify(first.body)).not.toContain(secret);
      expect(JSON.stringify(replay.body)).not.toContain(secret);
      expect(JSON.stringify(auditRecords())).not.toContain(secret);
      expect(actionResult(replay.body).data).toEqual(actionResult(first.body).data);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a sensitive git-query target before invoking any git read (AC3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-deny-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: ".env" },
            queryGit: { path: ".env", aspects: ["status", "diff", "blame"] },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(403);
      expect(actionConflictCode(response.body)).toBe("OUT_OF_SCOPE");
      expect(runner).not.toHaveBeenCalled();
      expect(auditRecords()).toMatchObject([
        expect.objectContaining({
          actionType: "queryGit",
          disposition: "denied",
          denyReason: "denied-sensitive-path",
        }),
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace-escaping git-query target before invoking any git read (AC3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-agent-git-escape-"));
    const store = createInMemoryUiStore();
    store.createProject(root, "fixture");
    await registerSnapshotOnly({ workspaceRoot: root, activeFile: "src/a.ts" });
    const runner = dispatchingGitRunner(root);
    const deps = gitDeps(store, runner);
    try {
      const response = await handleEditorAgentActions(
        context(
          action({
            type: "queryGit",
            expectedContentHash: undefined,
            target: { file: "../escape.ts" },
            queryGit: { path: "../escape.ts", aspects: ["status"] },
          }),
        ),
        deps,
      );
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Original tests (unchanged) ────────────────────────────────────────────────────────────────

describe("editor agent routes", () => {
  it("registers a validated Authority Envelope and returns only its bounded reference", async () => {
    const request = authorityRouteRequest(authorityEnvelope("/repo"));
    const result = await handleEditorAgentAuthority(
      context(request.body, "/api/editor/agent/authority"),
      request.deps,
    );
    expect(result.status).toBe(200);
    expect(responseAuthorityRef(result.body)).toEqual(
      expect.objectContaining({ runId: "run-2121" }),
    );
    expect(JSON.stringify(result.body)).not.toContain("local-operator");
    expect(JSON.stringify(result.body)).not.toContain("autonomous-delivery");
    const replay = await handleEditorAgentAuthority(
      context(request.body, "/api/editor/agent/authority"),
      request.deps,
    );
    expect(replay.status).toBe(403);
  });

  it("rejects an Authority Envelope that is expired or exceeds the server ceiling", async () => {
    const expiredEnvelope = {
      ...authorityEnvelope("/repo"),
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const expiredRequest = authorityRouteRequest(expiredEnvelope);
    const expired = await handleEditorAgentAuthority(
      context(expiredRequest.body, "/api/editor/agent/authority"),
      expiredRequest.deps,
    );
    const wrongCeilingEnvelope = authorityEnvelope(
      "/repo",
      "supervised-coding",
      "supervised-coding",
    );
    const wrongCeilingRequest = authorityRouteRequest(wrongCeilingEnvelope);
    const wrongCeiling = await handleEditorAgentAuthority(
      context(wrongCeilingRequest.body, "/api/editor/agent/authority"),
      wrongCeilingRequest.deps,
    );
    expect(expired.status).toBe(403);
    expect(wrongCeiling.status).toBe(403);
  });

  it("lists only browser sessions with a live authenticated bridge", async () => {
    const registered = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    expect(registered.status).toBe(200);
    expect(handleEditorAgentSessions().body).toEqual({ sessions: [] });
    const capability = responseBridgeCapability(registered.body);
    if (capability === undefined) throw new Error("expected bridge capability");
    const bridge = connectBridge("session-1", capability);
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: "session-1" })],
    });
    bridge.close();
    expect(handleEditorAgentSessions().body).toEqual({ sessions: [] });
  });

  it("switches pane discovery by bridge liveness while retaining idle snapshots", async () => {
    await registerSnapshotOnly({ sessionId: "pane-session-1", windowId: "window-pane-1" });
    await registerSnapshotOnly({ sessionId: "pane-session-2", windowId: "window-pane-2" });
    const firstCapability = bridgeDecisionCapabilities.get("pane-session-1");
    const secondCapability = bridgeDecisionCapabilities.get("pane-session-2");
    if (firstCapability === undefined || secondCapability === undefined) {
      throw new Error("expected pane bridge capabilities");
    }

    const first = connectBridge("pane-session-1", firstCapability);
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [{ sessionId: "pane-session-1" }],
    });
    first.close();
    const second = connectBridge("pane-session-2", secondCapability);
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [{ sessionId: "pane-session-2" }],
    });
    expect(editorAgentRegistry.snapshotFor("pane-session-1")).toBeDefined();
    expect(editorAgentRegistry.snapshotFor("pane-session-2")).toBeDefined();
    second.close();
  });

  it("replaces stale liveness when one browser stream reconnects with a new pane session", async () => {
    await registerSnapshotOnly({ sessionId: "pane-session-1", windowId: "window-pane-1" });
    await registerSnapshotOnly({ sessionId: "pane-session-2", windowId: "window-pane-2" });
    const firstCapability = bridgeDecisionCapabilities.get("pane-session-1");
    const secondCapability = bridgeDecisionCapabilities.get("pane-session-2");
    if (firstCapability === undefined || secondCapability === undefined) {
      throw new Error("expected pane bridge capabilities");
    }
    const streamId = "f".repeat(32);

    connectBridge("pane-session-1", firstCapability, streamId);
    connectBridge("pane-session-2", secondCapability, streamId);

    expect(editorAgentRegistry.hasLiveBridge("pane-session-1")).toBe(false);
    expect(editorAgentRegistry.hasLiveBridge("pane-session-2")).toBe(true);
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [{ sessionId: "pane-session-2" }],
    });
  });

  it("issues one bridge capability and never exposes it through session discovery or global SSE", async () => {
    const observer = connectBridge(undefined);
    const registered = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), textMode: "activeFile", text: "PRIVATE_SNAPSHOT_TEXT" },
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const capability = responseBridgeCapability(registered.body);
    if (capability === undefined) throw new Error("expected bridge capability");
    const bridge = connectBridge("session-1", capability);

    expect(capability).toHaveLength(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS);
    const discovery = JSON.stringify(handleEditorAgentSessions().body);
    expect(discovery).not.toContain(capability);
    expect(discovery).not.toContain("PRIVATE_SNAPSHOT_TEXT");
    expect(handleEditorAgentSessions().body).toMatchObject({
      sessions: [{ textMode: "none" }],
    });
    expect(observer.frames()).not.toContain("PRIVATE_SNAPSHOT_TEXT");
    expect(observer.frames()).not.toContain(capability);
    bridge.close();
    observer.close();
  });

  it("rotates a stale capability only while the existing session is idle", async () => {
    const registered = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const capability = responseBridgeCapability(registered.body);
    if (capability === undefined) throw new Error("expected bridge capability");
    const takeover = { ...snapshot(), workspaceRoot: "/forged", updatedAt: 2 };

    const missing = await handleEditorAgentSnapshot(
      context(
        { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, kind: "snapshot", snapshot: takeover },
        "/api/editor/agent/snapshot",
      ),
    );
    expect(missing.status).toBe(200);
    const rotated = responseBridgeCapability(missing.body);
    if (rotated === undefined) throw new Error("expected rotated bridge capability");
    const bridge = connectBridge("session-1", rotated);
    expect(bridge.outcome).toBe(STREAMING);

    const wrongWhileLive = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: takeover,
          bridgeDecisionCapability: "B".repeat(
            EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS,
          ),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const refreshed = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), updatedAt: 3 },
          bridgeDecisionCapability: rotated,
        },
        "/api/editor/agent/snapshot",
      ),
    );

    expect(wrongWhileLive.status).toBe(403);
    expect(refreshed.status).toBe(200);
    expect(responseBridgeCapability(refreshed.body)).toBeUndefined();
    expect(editorAgentRegistry.snapshotFor("session-1")?.workspaceRoot).toBe("/repo");
    expect(JSON.stringify(wrongWhileLive.body)).not.toContain(rotated);
    expect(capability).not.toBe(rotated);
    bridge.close();
  });

  it("requires an active browser bridge before queueing write actions", async () => {
    const result = await handleEditorAgentActions(context(action()));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
  });

  it("queues actions idempotently and rejects divergent replays", async () => {
    await registerSnapshot();
    const first = await handleEditorAgentActions(context(action()));
    const replay = await handleEditorAgentActions(context(action()));
    const divergent = await handleEditorAgentActions(context(action({ type: "format" })));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(divergent.status).toBe(409);
  });

  it("rejects an out-of-enum action origin at the route boundary (#2119)", async () => {
    const result = await handleEditorAgentActions(
      context({ ...action(), origin: "chat:conversation-content" }),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("opens an SSE stream with a ready frame", () => {
    const writes: string[] = [];
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const req = {
      on: vi.fn(),
    } as unknown as IncomingMessage;
    const result = handleEditorAgentEvents({
      req,
      res,
      params: {},
      url: new URL("http://localhost/api/editor/agent/events"),
    });
    expect(result).toBe(STREAMING);
    expect(writes.join("")).toContain("event: ready");
  });

  it("authenticates every session-scoped SSE bridge without exposing capabilities", async () => {
    await registerSnapshotOnly();
    await registerSnapshotOnly({ sessionId: "session-2" });
    const first = bridgeDecisionCapabilities.get("session-1");
    const second = bridgeDecisionCapabilities.get("session-2");
    if (first === undefined || second === undefined) throw new Error("expected capabilities");

    const missing = connectBridge("session-1", null);
    const wrong = connectBridge("session-1", "B".repeat(43));
    const crossSession = connectBridge("session-1", second);
    const authenticated = connectBridge(["session-1", "session-2"]);

    for (const rejected of [missing, wrong, crossSession]) {
      expect(rejected.outcome).toMatchObject({
        status: 403,
        body: { error: { code: "BRIDGE_CAPABILITY_INVALID" } },
      });
      expect(rejected.frames()).toBe("");
      expect(JSON.stringify(rejected.outcome)).not.toContain(first);
      expect(JSON.stringify(rejected.outcome)).not.toContain(second);
    }
    expect(authenticated.outcome).toBe(STREAMING);
    expect(authenticated.frames()).toContain("event: ready");
    expect(authenticated.requestUrl()).not.toContain("bridgeDecisionCapability");
    expect(authenticated.contextUrl()).not.toContain("bridgeDecisionCapability");
    expect(authenticated.contextUrl()).toContain("sessionId=session-1");
    expect(authenticated.contextUrl()).toContain("sessionId=session-2");
    expect(crossSession.requestUrl()).not.toContain("bridgeDecisionCapability");
    expect(crossSession.contextUrl()).not.toContain("bridgeDecisionCapability");
    expect(crossSession.contextUrl()).toContain("sessionId=session-1");
    authenticated.close();
  });
});

describe("editor agent routes diagnostics detail (Issue #2118)", () => {
  const diagnostic = {
    severity: "hint",
    range: { start: { line: 3, character: 5 }, end: { line: 3, character: 11 } },
    message: "Use readonly",
  } as const;

  it("round-trips valid diagnostic detail through ingestion and read projection", async () => {
    const diagnosticsDetail = { items: [diagnostic], truncated: false } as const;
    const posted = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), diagnosticsDetail },
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const read = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(posted.status).toBe(200);
    expect(responseSnapshot(posted.body).diagnosticsDetail).toEqual(diagnosticsDetail);
    expect(responseSnapshot(read.body).diagnosticsDetail).toEqual(diagnosticsDetail);
  });

  it("keeps omitted diagnostic detail absent on ingestion and read", async () => {
    const posted = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: snapshot(),
        },
        "/api/editor/agent/snapshot",
      ),
    );
    const read = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(posted.body).not.toHaveProperty("snapshot.diagnosticsDetail");
    expect(read.body).not.toHaveProperty("snapshot.diagnosticsDetail");
  });

  it("preserves an upstream diagnostic truncation marker", async () => {
    editorAgentRegistry.registerSnapshot(
      {
        ...snapshot(),
        diagnosticsDetail: { items: [diagnostic], truncated: true },
      },
      "d".repeat(64),
    );

    const result = await handleEditorAgentSnapshot(
      context({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION }, "/api/editor/agent/snapshot"),
    );

    expect(responseSnapshot(result.body).diagnosticsDetail).toEqual({
      items: [diagnostic],
      truncated: true,
    });
  });

  it.each([
    [
      "an oversized item list",
      {
        items: Array.from({ length: EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS + 1 }, () => diagnostic),
        truncated: false,
      },
    ],
    [
      "an overlength message",
      {
        items: [
          {
            ...diagnostic,
            message: "x".repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
          },
        ],
        truncated: false,
      },
    ],
  ])("rejects %s at ingestion", async (_case, diagnosticsDetail) => {
    const result = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), diagnosticsDetail },
        },
        "/api/editor/agent/snapshot",
      ),
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "INVALID_REQUEST",
          message: "snapshot must be a valid editor agent session snapshot",
        },
      },
    });
  });

  it("re-caps invalid registry detail on a text-free read projection", async () => {
    const unicodeCharacter = "\u{1f600}";
    const diagnosticsSummary = { errors: 1, warnings: 2, infos: 3 };
    const invalidSnapshot = {
      ...snapshot(),
      diagnosticsSummary,
      diagnosticsDetail: {
        items: Array.from({ length: EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS + 1 }, () => ({
          ...diagnostic,
          message: unicodeCharacter.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
        })),
        truncated: false,
      },
    } as unknown as EditorAgentSessionSnapshot;
    editorAgentRegistry.registerSnapshot(invalidSnapshot, "d".repeat(64));

    const result = await handleEditorAgentSnapshot(
      context(
        { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, textMode: "none" },
        "/api/editor/agent/snapshot",
      ),
    );
    const shaped = responseSnapshot(result.body);
    const detail = shaped.diagnosticsDetail;

    expect(isEditorAgentSessionSnapshot(shaped)).toBe(true);
    expect(shaped.diagnosticsSummary).toEqual(diagnosticsSummary);
    expect(detail?.items).toHaveLength(EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS);
    expect(Array.from(detail?.items[0]?.message ?? "")).toHaveLength(
      EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
    );
    expect(detail?.items[0]?.message).toBe(
      unicodeCharacter.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    );
    expect(detail?.truncated).toBe(true);
  });
});

// ─── Issue #1394 preflight checks (ADR-0058 D2) ───────────────────────────────────────────────

describe("editor agent routes — Issue #1394 preflight checks", () => {
  // ── Conflict code helper ──────────────────────────────────────────────────────────────────────

  // ── AC1: version / hash mismatch (existing preflight, confirmed with structured codes) ───────

  it("returns 409 VERSION_MISMATCH when expectedDocumentVersion hash mismatches", async () => {
    await registerSnapshot();
    const mismatchedVersion = { sizeBytes: 1, modifiedAt: 1, contentHash: "b".repeat(64) };
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "save",
          idempotencyKey: "ik-vmm",
          actionId: "a-vmm",
          expectedDocumentVersion: mismatchedVersion,
          expectedContentHash: undefined,
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("VERSION_MISMATCH");
  });

  it("returns 409 CONTENT_HASH_MISMATCH when expectedContentHash mismatches", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "save",
          idempotencyKey: "ik-chm",
          actionId: "a-chm",
          expectedDocumentVersion: undefined,
          expectedContentHash: "c".repeat(64),
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("CONTENT_HASH_MISMATCH");
  });

  // ── AC2: structural edit validation (INVALID_EDITS) ─────────────────────────────────────────

  it("returns 409 INVALID_EDITS for an applyTextEdits action with an inverted range", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-inv",
          actionId: "a-inv",
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 5, character: 0 }, end: { line: 2, character: 0 } },
              newText: "bad",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
  });

  it("returns 409 INVALID_EDITS for same-line inverted range (end char before start char)", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-inv2",
          actionId: "a-inv2",
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 2, character: 10 }, end: { line: 2, character: 3 } },
              newText: "bad",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
  });

  it("returns 400 INVALID_REQUEST for an applyTextEdits action with a negative coordinate (fails contract parsing)", async () => {
    // Negative line/character values are rejected by isNonNegativeInteger in the contract parser
    // BEFORE preflight runs, so the response is 400 INVALID_REQUEST not 409.
    // The INVALID_EDITS path for negative coords is covered at the validator unit level in
    // editor-agent.test.ts (validateAgentTextEdits returns an error string for negatives).
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        // This body is intentionally NOT an EditorAgentAction because -1 fails isNonNegativeInteger.
        {
          schemaVersion: "1",
          actionId: "a-neg",
          idempotencyKey: "ik-neg",
          sessionId: "session-1",
          type: "applyTextEdits",
          textEdits: [
            {
              range: { start: { line: -1, character: 0 }, end: { line: 0, character: 5 } },
              newText: "x",
            },
          ],
        },
      ),
    );
    expect(result.status).toBe(400);
  });

  // ── AC5: containment check (OUT_OF_SCOPE) ───────────────────────────────────────────────────

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting an absolute path", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-abs",
          actionId: "a-abs",
          target: { file: "/abs/x" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting a path with '..'", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-dotdot",
          actionId: "a-dotdot",
          target: { file: "../escape/secret.ts" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("returns 409 OUT_OF_SCOPE for an applyTextEdits action targeting a Windows drive path", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          idempotencyKey: "ik-win",
          actionId: "a-win",
          target: { file: "C:/evil.ts" },
          expectedContentHash: undefined,
          expectedDocumentVersion: undefined,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "x",
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  // ── applyPatch preflight: OUT_OF_SCOPE scenarios ─────────────────────────────────────────────

  describe("applyPatch preflight — OUT_OF_SCOPE (Issue #1394)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 OUT_OF_SCOPE for a multi-file unified diff", async () => {
      await registerSnapshot(tmpDir);

      // Create both files the diff touches so path resolution succeeds.
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(tmpDir, "b.ts"), "const b = 2;\n", "utf8");

      const multiFileDiff = [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "-const a = 1;",
        "+const a = 10;",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "-const b = 2;",
        "+const b = 20;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-multifile",
            actionId: "a-multifile",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: multiFileDiff,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });

    it("returns 409 OUT_OF_SCOPE for a binary diff (GIT binary patch marker)", async () => {
      await registerSnapshot(tmpDir);

      const binaryDiff = [
        "diff --git a/img.png b/img.png",
        "index 0000000..1111111 100644",
        "GIT binary patch",
        "literal 10",
        "zcmZQz0MBk=",
        "",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-binary",
            actionId: "a-binary",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: binaryDiff,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });

    it("returns 409 OUT_OF_SCOPE when patch target.file contains '..'", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-patchdotdot",
            actionId: "a-patchdotdot",
            target: { file: "../outside.ts" },
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "--- a/../outside.ts\n+++ b/../outside.ts\n@@ -1 +1 @@\n-old\n+new\n",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    });
  });

  // ── applyPatch preflight: INVALID_EDITS scenarios ────────────────────────────────────────────

  describe("applyPatch preflight — INVALID_EDITS (Issue #1394)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 INVALID_EDITS for a malformed/empty diff", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-malformed",
            actionId: "a-malformed",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "this is not a unified diff at all",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });

    it("returns 409 INVALID_EDITS for an empty patch string", async () => {
      await registerSnapshot(tmpDir);

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-empty",
            actionId: "a-empty",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            patch: "",
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });
  });

  // ── applyPatch: valid single-file patch — 202 queued + emitted textEdits ─────────────────────

  describe("applyPatch — valid single-file patch (Issue #1394 EMIT INVARIANT)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-valid-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 202 queued for a valid single-file patch against an existing file", async () => {
      // Arrange: write the pre-image to disk so validatePatch + computeFileContent can read it.
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      const filePath = join(srcDir, "widget.ts");
      const preImage = "export const VALUE = 1;\n";
      writeFileSync(filePath, preImage, "utf8");

      // snapshot.activeFile must equal the patch's single file path so deriveAgentPatchTextEdits
      // does not reject the patch as targeting a different file than the open buffer.
      await registerSnapshot(tmpDir, "src/widget.ts");

      const validSingleFileDiff = [
        "--- a/src/widget.ts",
        "+++ b/src/widget.ts",
        "@@ -1,1 +1,1 @@",
        "-export const VALUE = 1;",
        "+export const VALUE = 42;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-valid",
            actionId: "a-valid",
            // #1391 AC2: write actions must pin a revision. The hash matches the registered snapshot,
            // so the precondition is satisfied and the patch queues normally.
            expectedContentHash: HASH,
            patch: validSingleFileDiff,
          }),
        ),
      );

      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    it("preserves chat origin on queued applyPatch and emits content-free audit (#2119)", async () => {
      const relativePath = "src/chat-origin.ts";
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "chat-origin.ts"), "CHAT_PATCH_BEFORE\n", "utf8");
      await registerSnapshot(tmpDir, relativePath);
      const observer = connectBridge("session-1");
      const patch = [
        `--- a/${relativePath}`,
        `+++ b/${relativePath}`,
        "@@ -1,1 +1,1 @@",
        "-CHAT_PATCH_BEFORE",
        "+CHAT_PATCH_AFTER",
      ].join("\n");
      const proposed = {
        ...action({
          type: "applyPatch",
          actionId: "a-chat-patch",
          idempotencyKey: "ik-chat-patch",
          origin: "chat",
          target: {
            file: relativePath,
            selection: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
          patch,
        }),
        prompt: "AUDIT_CHAT_PROMPT",
      };

      const result = await handleEditorAgentActions(context(proposed));

      expect(result.status).toBe(202);
      expect(lastEmittedAction(observer.frames()).origin).toBe("chat");
      const records = auditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.origin).toBe("chat");
      expect(records[0]?.targetPath).toBe(relativePath);
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain(patch);
      for (const forbidden of [
        "CHAT_PATCH_BEFORE",
        "CHAT_PATCH_AFTER",
        "AUDIT_CHAT_PROMPT",
        "selection",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it("captures emitted action textEdits via SSE subscriber for a valid patch", async () => {
      // Arrange: write the pre-image to disk.
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      const filePath = join(srcDir, "calc.ts");
      const preImage = "export const X = 1;\n";
      writeFileSync(filePath, preImage, "utf8");

      // snapshot.activeFile must equal the patch's single file path (F3 guard in server).
      await registerSnapshot(tmpDir, "src/calc.ts");

      // Tap the SSE subscriber by setting up a fake response.
      const emittedFrames: string[] = [];
      const fakeRes = {
        writeHead: vi.fn(),
        write: vi.fn((chunk: string) => {
          emittedFrames.push(chunk);
          return true;
        }),
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ServerResponse;
      const fakeReq = { on: vi.fn() } as unknown as IncomingMessage;
      const capability = bridgeDecisionCapabilities.get("session-1");
      if (capability === undefined) throw new Error("expected bridge capability");
      handleEditorAgentEvents({
        req: fakeReq,
        res: fakeRes,
        params: {},
        url: new URL(
          `http://localhost/api/editor/agent/events?sessionId=session-1&bridgeStreamId=${"e".repeat(32)}&bridgeDecisionCapability=${encodeURIComponent(capability)}`,
        ),
      });

      const validDiff = [
        "--- a/src/calc.ts",
        "+++ b/src/calc.ts",
        "@@ -1,1 +1,1 @@",
        "-export const X = 1;",
        "+export const X = 99;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-emit",
            actionId: "a-emit",
            // #1391 AC2: pin the revision (hash matches the registered snapshot) so the patch queues.
            expectedContentHash: HASH,
            patch: validDiff,
          }),
        ),
      );

      // The server should have queued the action.
      expect(result.status).toBe(202);

      // Extract and parse the SSE frames.
      const actionFrames = emittedFrames.filter((f) => f.includes("editor-agent:action"));
      expect(actionFrames.length).toBeGreaterThanOrEqual(1);

      const lastActionFrame = actionFrames.at(-1) ?? "";
      const dataLine = lastActionFrame.split("\n").find((line) => line.startsWith("data:"));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse((dataLine ?? "data:{}").slice("data:".length)) as EditorAgentEvent;
      expect(parsed.type).toBe("action");
      if (parsed.type !== "action") throw new Error("unexpected type");

      // The EMIT INVARIANT: the emitted action must have textEdits populated (whole-doc replace).
      expect(parsed.action.textEdits).toBeDefined();
      expect(Array.isArray(parsed.action.textEdits)).toBe(true);
      expect(parsed.action.textEdits?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(parsed.action.requiresReview).toBe(false);

      // The textEdits must produce the patched content when applied to the pre-image.
      // We verify this with applyTextEditsToText from @oscharko-dev/keiko-editor.
      const { applyTextEditsToText } = await import("@oscharko-dev/keiko-editor");
      const mappedEdits = (parsed.action.textEdits ?? []).map((edit) => ({
        range: {
          start: { line: edit.range.start.line, column: edit.range.start.character },
          end: { line: edit.range.end.line, column: edit.range.end.character },
        },
        newText: edit.newText,
      }));
      const applied = applyTextEditsToText(preImage, mappedEdits);
      expect(applied).toContain("export const X = 99;");
    });

    it("revalidates the active snapshot before confirming a direct patch", async () => {
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "stale.ts"), "export const X = 1;\n", "utf8");
      await registerSnapshot(tmpDir, "src/stale.ts");
      const proposed = action({
        type: "applyPatch",
        actionId: "a-stale-confirmation",
        idempotencyKey: "ik-stale-confirmation",
        expectedContentHash: HASH,
        patch: [
          "--- a/src/stale.ts",
          "+++ b/src/stale.ts",
          "@@ -1 +1 @@",
          "-export const X = 1;",
          "+export const X = 2;",
        ].join("\n"),
      });

      expect((await handleEditorAgentActions(context(proposed))).status).toBe(202);
      await registerSnapshotOnly({
        workspaceRoot: tmpDir,
        activeFile: "src/stale.ts",
        panes: [{ paneId: "pane-1", activeFile: "src/stale.ts", openFiles: ["src/stale.ts"] }],
        dirtyFiles: ["src/stale.ts"],
        activeFileContentHash: "b".repeat(64),
      });
      const result = await postActionResult(proposed, "succeeded");

      expect(result.status).toBe(200);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("DIRTY");
    });

    it("revalidates Authority Envelope expiry before confirming a direct patch", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, "expiry.ts"), "export const X = 1;\n", "utf8");
      await registerSnapshot(tmpDir, "src/expiry.ts");
      const expiring = authorityEnvelope(tmpDir);
      const registered = editorAgentAuthorityRegistry.register(
        { ...expiring, expiresAt: "2026-07-10T00:00:01.000Z" },
        "governed-assist",
        new Date().toISOString(),
      );
      if (!registered.ok) throw new Error("expected expiring authority registration");
      agentAuthorityRef = registered.authorityRef;
      const proposed = action({
        type: "applyPatch",
        actionId: "a-expired-confirmation",
        idempotencyKey: "ik-expired-confirmation",
        expectedContentHash: HASH,
        patch: [
          "--- a/src/expiry.ts",
          "+++ b/src/expiry.ts",
          "@@ -1 +1 @@",
          "-export const X = 1;",
          "+export const X = 2;",
        ].join("\n"),
      });

      expect((await handleEditorAgentActions(context(proposed))).status).toBe(202);
      vi.setSystemTime(new Date("2026-07-10T00:00:02.000Z"));
      const result = await postActionResult(proposed, "succeeded");

      expect(result.status).toBe(200);
      expect(actionConflictCode(result.body)).toBe("POLICY_DENIED");
    });

    it("derives a single-file patch preview from its one bounded admission read", async () => {
      const srcDir = join(tmpDir, "src");
      mkdirSync(srcDir);
      const filePath = join(srcDir, "diagnostic.ts");
      writeFileSync(filePath, "export const X = 1;\n", "utf8");
      await registerSnapshot(tmpDir, "src/diagnostic.ts");
      const originalRead = nodeWorkspaceFs.readFileUtf8.bind(nodeWorkspaceFs);
      const reads: string[] = [];
      vi.spyOn(nodeWorkspaceFs, "readFileUtf8").mockImplementation((path) => {
        reads.push(path);
        return originalRead(path);
      });
      const patch = [
        "--- a/src/diagnostic.ts",
        "+++ b/src/diagnostic.ts",
        "@@ -1 +1 @@",
        "-export const X = 1;",
        "+export const X = 2;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(action({ type: "applyPatch", patch, actionId: "diagnostic-action" })),
      );

      expect(result.status).toBe(202);
      expect(reads).toEqual([filePath]);
      vi.restoreAllMocks();
    });
  });

  // ── DIRTY conflict: 409 conflict code DIRTY emitted on SSE stream (F1/AC3) ─────────────────────

  describe("DIRTY conflict — code DIRTY emitted over SSE (F1/AC3)", () => {
    it("returns 409 DIRTY and emits the conflict result on the SSE stream", async () => {
      // Arrange: register a snapshot that marks the active file as dirty.
      await handleEditorAgentSnapshot(
        context(
          {
            schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
            kind: "snapshot",
            snapshot: {
              ...snapshot(),
              dirtyFiles: ["src/a.ts"],
            },
          },
          "/api/editor/agent/snapshot",
        ),
      );

      // Tap the SSE subscriber BEFORE posting the action.
      const emittedFrames: string[] = [];
      const fakeRes = {
        writeHead: vi.fn(),
        write: vi.fn((chunk: string) => {
          emittedFrames.push(chunk);
          return true;
        }),
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ServerResponse;
      const fakeReq = { on: vi.fn() } as unknown as IncomingMessage;
      handleEditorAgentEvents({
        req: fakeReq,
        res: fakeRes,
        params: {},
        url: new URL("http://localhost/api/editor/agent/events"),
      });

      // Act: submit a non-save write action against the dirty buffer.
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "format",
            idempotencyKey: "ik-dirty",
            actionId: "a-dirty",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );

      // Assert: 409 with conflict code DIRTY.
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("DIRTY");

      // Assert: the conflict result was also emitted on the SSE stream (proves F1/AC3).
      const resultFrames = emittedFrames.filter((f) => f.includes("editor-agent:result"));
      expect(resultFrames.length).toBeGreaterThanOrEqual(1);

      const lastResultFrame = resultFrames.at(-1) ?? "";
      const dataLine = lastResultFrame.split("\n").find((line) => line.startsWith("data:"));
      expect(dataLine).toBeDefined();
      const parsed = JSON.parse((dataLine ?? "data:{}").slice("data:".length)) as EditorAgentEvent;
      expect(parsed.type).toBe("result");
      if (parsed.type !== "result") throw new Error("unexpected type");
      expect(parsed.result.status).toBe("conflict");
      expect(parsed.result.conflict?.code).toBe("DIRTY");
    });
  });

  // ── F7: server-authoritative overlap check for applyTextEdits ────────────────────────────────

  describe("applyTextEdits preflight — overlapping ranges (F7 server-authoritative)", () => {
    it("returns 409 INVALID_EDITS when two textEdit ranges overlap", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyTextEdits",
            idempotencyKey: "ik-overlap",
            actionId: "a-overlap",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            textEdits: [
              {
                // Edit 0: covers characters 0..10 on line 0
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                newText: "first",
              },
              {
                // Edit 1: starts at character 5 — overlaps with edit 0's [0,10)
                range: { start: { line: 0, character: 5 }, end: { line: 0, character: 15 } },
                newText: "second",
              },
            ],
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("INVALID_EDITS");
    });
  });

  // ── F3: applyPatch targeting a file other than snapshot.activeFile => failed ─────────────────

  describe("applyPatch — patch targets file other than snapshot.activeFile (F3)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-f3-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    it("returns 409 failed when the patch file does not match snapshot.activeFile", async () => {
      // Arrange: the snapshot's activeFile is src/a.ts but the patch targets src/b.ts.
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(tmpDir, "b.ts"), "const b = 2;\n", "utf8");

      // Register snapshot with activeFile pointing at a.ts; patch targets b.ts.
      await registerSnapshot(tmpDir, "src/a.ts");

      const patchTargetingB = [
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1,1 +1,1 @@",
        "-const b = 2;",
        "+const b = 99;",
      ].join("\n");

      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-f3",
            actionId: "a-f3",
            // #1391 AC2: pin the revision so the action clears the precondition gate and reaches the
            // file-mismatch derivation path this test exercises (the patch targets b.ts, not a.ts).
            expectedContentHash: HASH,
            patch: patchTargetingB,
          }),
        ),
      );

      // deriveAgentPatchTextEdits returns null (file mismatch) => queueAndEmitAction returns 409
      // with status "failed" (not a preflight conflict).
      expect(result.status).toBe(409);
      const body = result.body;
      if (
        typeof body === "object" &&
        body !== null &&
        "result" in body &&
        typeof (body as Record<string, unknown>).result === "object"
      ) {
        const res = (body as Record<string, unknown>).result as Record<string, unknown>;
        expect(res.status).toBe("failed");
      }
    });
  });

  // ── Issue #1391 AC2: write actions require a version/hash precondition (PRECONDITION_REQUIRED) ──

  describe("write precondition — PRECONDITION_REQUIRED (Issue #1391 AC2)", () => {
    it("returns 409 PRECONDITION_REQUIRED for a save with neither version nor hash", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "save",
            idempotencyKey: "ik-noprecond",
            actionId: "a-noprecond",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionResultStatus(result.body)).toBe("conflict");
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("returns 409 PRECONDITION_REQUIRED for structurally valid applyTextEdits without a precondition", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyTextEdits",
            idempotencyKey: "ik-edits-noprecond",
            actionId: "a-edits-noprecond",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
            textEdits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "hello",
              },
            ],
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("accepts a write that pins the revision by document version only (queues 202)", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "save",
            idempotencyKey: "ik-version-only",
            actionId: "a-version-only",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    it("requires a verifiable pin when the asserted document version is unavailable", async () => {
      await registerSnapshotOnly({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-version-unavailable",
            actionId: "a-version-unavailable",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      // Regression: this unverified assertion was previously treated as sufficient and queued.
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin when the asserted content hash is unavailable", async () => {
      await registerSnapshotOnly({ activeFileContentHash: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-hash-unavailable",
            actionId: "a-hash-unavailable",
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      // Regression: an asserted pin with no snapshot counterpart must not authorize a blind write.
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin when both snapshot counterparts are unavailable", async () => {
      await registerSnapshotOnly({
        documentVersion: undefined,
        activeFileContentHash: undefined,
      });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-both-unavailable",
            actionId: "a-both-unavailable",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("accepts a matching hash when the other asserted snapshot pin is unavailable", async () => {
      await registerSnapshotOnly({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-hash-match-version-unavailable",
            actionId: "a-hash-match-version-unavailable",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });

    // Issue #2115: the fail-closed unverifiable-precondition gate is shared across write action
    // types. Mirror the "save" coverage above for "format" to guard against a future per-type
    // divergence in this path.
    it("requires a verifiable pin for a format asserting an unverifiable document version", async () => {
      await registerSnapshotOnly({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "format",
            idempotencyKey: "ik-format-version-unavailable",
            actionId: "a-format-version-unavailable",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin for a format asserting an unverifiable content hash", async () => {
      await registerSnapshotOnly({ activeFileContentHash: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "format",
            idempotencyKey: "ik-format-hash-unavailable",
            actionId: "a-format-hash-unavailable",
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("rejects a mismatching hash even when the asserted version matches", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            idempotencyKey: "ik-version-match-hash-mismatch",
            actionId: "a-version-match-hash-mismatch",
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
            expectedContentHash: "b".repeat(64),
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("CONTENT_HASH_MISMATCH");
    });

    it("does not require a precondition for a non-write action (setSelection queues 202)", async () => {
      await registerSnapshot();
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "setSelection",
            idempotencyKey: "ik-nav",
            actionId: "a-nav",
            expectedContentHash: undefined,
            expectedDocumentVersion: undefined,
          }),
        ),
      );
      expect(result.status).toBe(202);
      expect(actionResultStatus(result.body)).toBe("queued");
    });
  });

  // Issue #2115: mirror the shared fail-closed unverifiable-precondition coverage above for
  // "applyPatch", which additionally requires a real workspace file so the patch clears structural
  // validation and the assertion actually exercises the precondition gate, not patch parsing.
  describe("write precondition — PRECONDITION_REQUIRED for applyPatch (Issue #2115)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "keiko-agent-2115-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      _resetEditorAgentStateForTests();
    });

    const validPatch = [
      "--- a/src/precond.ts",
      "+++ b/src/precond.ts",
      "@@ -1 +1 @@",
      "-const x = 1;",
      "+const x = 2;",
    ].join("\n");

    function registerPatchSnapshot(overrides: Partial<EditorAgentSessionSnapshot>): Promise<void> {
      return registerSnapshotOnly({
        workspaceRoot: tmpDir,
        activeFile: "src/precond.ts",
        panes: [{ paneId: "pane-1", activeFile: "src/precond.ts", openFiles: ["src/precond.ts"] }],
        ...overrides,
      });
    }

    it("requires a verifiable pin for applyPatch asserting an unverifiable document version", async () => {
      writeWorkspaceFile(tmpDir, "src/precond.ts", "const x = 1;\n");
      await registerPatchSnapshot({ documentVersion: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-patch-version-unavailable",
            actionId: "a-patch-version-unavailable",
            expectedContentHash: undefined,
            expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
            patch: validPatch,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });

    it("requires a verifiable pin for applyPatch asserting an unverifiable content hash", async () => {
      writeWorkspaceFile(tmpDir, "src/precond.ts", "const x = 1;\n");
      await registerPatchSnapshot({ activeFileContentHash: undefined });
      connectBridge("session-1");
      const result = await handleEditorAgentActions(
        context(
          action({
            type: "applyPatch",
            idempotencyKey: "ik-patch-hash-unavailable",
            actionId: "a-patch-hash-unavailable",
            expectedDocumentVersion: undefined,
            patch: validPatch,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("PRECONDITION_REQUIRED");
    });
  });
});

// ─── Issue #1392: bridge liveness, queue timeout/cleanup, bounded queue, scoped fan-out ──────────

function navAction(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return action({
    type: "setSelection",
    expectedContentHash: undefined,
    expectedDocumentVersion: undefined,
    ...overrides,
  });
}

describe("editor agent routes — Issue #1392 liveness and queue lifecycle", () => {
  it("returns NO_ACTIVE_BRIDGE when a snapshot is registered but no bridge is connected (AC1)", async () => {
    await registerSnapshotOnly();
    const result = await handleEditorAgentActions(context(action()));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("queues for a live bridge, then NO_ACTIVE_BRIDGE once the bridge disconnects (AC1)", async () => {
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    const queued = await handleEditorAgentActions(context(action()));
    expect(queued.status).toBe(202);

    bridge.close();
    const afterClose = await handleEditorAgentActions(
      context(action({ idempotencyKey: "ik-after-close", actionId: "a-after-close" })),
    );
    expect(afterClose.status).toBe(409);
    expect(actionConflictCode(afterClose.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("does not rotate a stale capability while an action remains pending", async () => {
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    expect((await handleEditorAgentActions(context(navAction()))).status).toBe(202);
    bridge.close();

    const rotated = await handleEditorAgentSnapshot(
      context(
        {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          kind: "snapshot",
          snapshot: { ...snapshot(), updatedAt: 2 },
        },
        "/api/editor/agent/snapshot",
      ),
    );

    expect(rotated.status).toBe(403);
    expect(editorAgentRegistry.pendingCount("session-1")).toBe(1);
  });

  it("treats one multi-session SSE stream as a live bridge for each listed session", async () => {
    await registerSnapshotOnly();
    await registerSnapshotOnly({ sessionId: "session-2" });
    const bridge = connectBridge(["session-1", "session-2"]);

    const queued1 = await handleEditorAgentActions(
      context(navAction({ actionId: "a-mux-1", idempotencyKey: "k-mux-1" })),
    );
    const queued2 = await handleEditorAgentActions(
      context(
        navAction({
          sessionId: "session-2",
          actionId: "a-mux-2",
          idempotencyKey: "k-mux-2",
        }),
      ),
    );

    expect(queued1.status).toBe(202);
    expect(queued2.status).toBe(202);
    expect(bridge.frames()).toContain("a-mux-1");
    expect(bridge.frames()).toContain("a-mux-2");

    bridge.close();
    const afterClose = await handleEditorAgentActions(
      context(
        navAction({
          sessionId: "session-2",
          actionId: "a-mux-after-close",
          idempotencyKey: "k-mux-after-close",
        }),
      ),
    );
    expect(afterClose.status).toBe(409);
    expect(actionConflictCode(afterClose.body)).toBe("NO_ACTIVE_BRIDGE");
  });

  it("times out a queued action, emits TIMED_OUT over SSE, and frees the queue (AC2)", async () => {
    vi.useFakeTimers();
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");

    const queued = await handleEditorAgentActions(context(action()));
    expect(queued.status).toBe(202);

    vi.advanceTimersByTime(EDITOR_AGENT_ACTION_TIMEOUT_MS + 1);

    expect(bridge.frames()).toContain("event: editor-agent:result");
    expect(bridge.frames()).toContain("TIMED_OUT");

    // The freed slot lets the same action id be queued again.
    const requeued = await handleEditorAgentActions(
      context(action({ idempotencyKey: "ik-requeue" })),
    );
    expect(requeued.status).toBe(202);
  });

  it("clears the pending timeout when the bridge reports a result (no late TIMED_OUT)", async () => {
    vi.useFakeTimers();
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    await handleEditorAgentActions(context(action()));

    const reported = await handleEditorAgentActions(
      context({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "result",
        bridgeDecisionCapability,
        result: {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: "action-1",
          sessionId: "session-1",
          status: "succeeded",
        },
      }),
    );
    expect(reported.status).toBe(200);

    vi.advanceTimersByTime(EDITOR_AGENT_ACTION_TIMEOUT_MS + 1);
    expect(bridge.frames()).toContain("succeeded");
    expect(bridge.frames()).not.toContain("TIMED_OUT");
  });

  it("rejects every forged or late terminal result and does not accept queued reports", async () => {
    vi.useFakeTimers();
    await registerSnapshotOnly();
    connectBridge("session-1");
    const statuses = ["succeeded", "failed", "conflict"] as const;
    const pending = statuses.map((status, index) =>
      navAction({
        actionId: `late-${status}`,
        idempotencyKey: `late-key-${String(index)}`,
      }),
    );
    for (const proposed of pending) {
      expect((await handleEditorAgentActions(context(proposed))).status).toBe(202);
    }
    vi.advanceTimersByTime(EDITOR_AGENT_ACTION_TIMEOUT_MS + 1);

    for (const [index, status] of statuses.entries()) {
      const proposed = pending[index];
      if (proposed === undefined) throw new Error("expected pending action");
      const late = await postActionResult(proposed, status);
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ error: { code: "ACTION_RESULT_NOT_PENDING" } });
    }

    const live = navAction({ actionId: "still-pending", idempotencyKey: "still-pending-key" });
    expect((await handleEditorAgentActions(context(live))).status).toBe(202);
    const queuedReport = await postActionResult(live, "queued");
    expect(queuedReport.status).toBe(400);
    expect(editorAgentRegistry.pendingCount("session-1")).toBe(1);
  });

  it("bounds the per-session queue and answers QUEUE_FULL with 429 (perf)", async () => {
    await registerSnapshotOnly();
    connectBridge("session-1");
    let lastStatus = 0;
    for (let i = 0; i < 64; i += 1) {
      const res = await handleEditorAgentActions(
        context(navAction({ actionId: `a-${String(i)}`, idempotencyKey: `k-${String(i)}` })),
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(202);

    const overflow = await handleEditorAgentActions(
      context(navAction({ actionId: "a-overflow", idempotencyKey: "k-overflow" })),
    );
    expect(overflow.status).toBe(429);
    expect(actionResultStatus(overflow.body)).toBe("failed");
    expect(actionFailureCode(overflow.body)).toBe("QUEUE_FULL");
  });

  it("rejects a second action reusing an in-flight actionId with 409 (distinct idempotency key)", async () => {
    await registerSnapshotOnly();
    connectBridge("session-1");
    const first = await handleEditorAgentActions(
      context(action({ actionId: "dup", idempotencyKey: "k1" })),
    );
    expect(first.status).toBe(202);

    // A distinct idempotency key clears the route-level replay guard, but the registry rejects the
    // re-used in-flight actionId so the first action's deadline is preserved (409, not 429).
    const second = await handleEditorAgentActions(
      context(action({ actionId: "dup", idempotencyKey: "k2" })),
    );
    expect(second.status).toBe(409);
    expect(actionResultStatus(second.body)).toBe("failed");
    expect(actionFailureCode(second.body)).toBeUndefined();
  });

  it("rejects a second mutation while allowing a nonmutating action to queue", async () => {
    await registerSnapshotOnly();
    connectBridge("session-1");
    const first = await handleEditorAgentActions(context(action()));
    const second = await handleEditorAgentActions(
      context(action({ actionId: "format-2", idempotencyKey: "format-key-2", type: "format" })),
    );
    const navigation = await handleEditorAgentActions(
      context(navAction({ actionId: "nav-2", idempotencyKey: "nav-key-2" })),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(actionResultStatus(second.body)).toBe("failed");
    expect(navigation.status).toBe(202);
  });

  it("delivers action bodies only to the target session bridge", async () => {
    await registerSnapshotOnly();
    const bridge1 = connectBridge("session-1");
    const bridge2 = connectBridge("session-2");
    const observer = connectBridge(undefined);

    await handleEditorAgentActions(
      context(navAction({ actionId: "a-fan", idempotencyKey: "k-fan" })),
    );

    expect(bridge1.frames()).toContain("event: editor-agent:action");
    expect(observer.frames()).not.toContain("event: editor-agent:action");
    expect(bridge2.frames()).not.toContain("event: editor-agent:action");
  });

  it("never writes raw source content to logs", async () => {
    const sink = vi.fn();
    vi.spyOn(console, "log").mockImplementation(sink);
    vi.spyOn(console, "info").mockImplementation(sink);
    vi.spyOn(console, "warn").mockImplementation(sink);
    vi.spyOn(console, "error").mockImplementation(sink);
    vi.spyOn(console, "debug").mockImplementation(sink);

    await registerSnapshotOnly({ text: "TOP_SECRET_SOURCE", textMode: "activeFile" });
    connectBridge("session-1");
    await handleEditorAgentActions(
      context(
        action({
          type: "applyTextEdits",
          expectedContentHash: HASH,
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "TOP_SECRET_EDIT",
            },
          ],
        }),
      ),
    );

    const logged = sink.mock.calls
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join(" ");
    expect(logged).not.toContain("TOP_SECRET_SOURCE");
    expect(logged).not.toContain("TOP_SECRET_EDIT");

    vi.restoreAllMocks();
  });
});

// ─── Issue #1395 (ADR-0062): policy taxonomy + bounded audit ─────────────────────────────────────

function auditRecords(sessionId = "session-1"): readonly EditorAgentActionAuditRecord[] {
  const result = handleEditorAgentAudit({
    req: {} as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(
      `http://localhost/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  });
  const body = result.body;
  if (!isRecord(body) || !Array.isArray(body.records)) return [];
  return body.records as readonly EditorAgentActionAuditRecord[];
}

function applyTextEditsAction(newText: string, file?: string): EditorAgentAction {
  return action({
    type: "applyTextEdits",
    expectedContentHash: HASH,
    ...(file === undefined ? {} : { target: { file } }),
    textEdits: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText },
    ],
  });
}

describe("active-buffer target binding", () => {
  it.each([
    action({ type: "format", target: { file: "src/other.ts" } }),
    action({ type: "save", target: { file: "src/other.ts" } }),
    action({
      type: "applyTextEdits",
      target: { file: "src/other.ts" },
      textEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "x",
        },
      ],
    }),
    action({ type: "applyPatch", target: { file: "src/other.ts" }, patch: "not reached" }),
    action({
      type: "setSelection",
      expectedContentHash: undefined,
      target: {
        file: "src/other.ts",
        selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    }),
  ])("rejects $type when its claimed file differs from the active snapshot", async (proposed) => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context({
        ...proposed,
        actionId: `target-${proposed.type}`,
        idempotencyKey: `target-key-${proposed.type}`,
      }),
    );

    expect(result.status).toBe(409);
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    for (const record of auditRecords()) expect(record.targetPath).toBe("src/a.ts");
  });

  it("rejects a claimed pane mismatch and accepts a normalized active-file spelling", async () => {
    await registerSnapshot();
    const mismatch = await handleEditorAgentActions(
      context(
        action({
          type: "setSelection",
          actionId: "pane-mismatch",
          idempotencyKey: "pane-mismatch-key",
          expectedContentHash: undefined,
          target: {
            paneId: "pane-other",
            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        }),
      ),
    );
    const normalized = await handleEditorAgentActions(
      context(
        action({
          type: "setSelection",
          actionId: "normalized-target",
          idempotencyKey: "normalized-target-key",
          expectedContentHash: undefined,
          target: {
            paneId: "pane-1",
            file: "./src/a.ts",
            selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        }),
      ),
    );

    expect(mismatch.status).toBe(409);
    expect(actionConflictCode(mismatch.body)).toBe("OUT_OF_SCOPE");
    expect(normalized.status).toBe(202);
  });

  it("fails closed for every active-buffer action when the snapshot has no active pane", async () => {
    await registerSnapshotOnly({ activePaneId: null, panes: [] });
    connectBridge("session-1");
    const unclaimed = await handleEditorAgentActions(
      context(
        action({
          type: "format",
          actionId: "pane-unclaimed",
          idempotencyKey: "pane-unclaimed-key",
        }),
      ),
    );
    const claimed = await handleEditorAgentActions(
      context(
        action({
          type: "format",
          actionId: "pane-unverified",
          idempotencyKey: "pane-unverified-key",
          target: { paneId: "pane-unverified" },
        }),
      ),
    );

    expect(unclaimed.status).toBe(409);
    expect(actionConflictCode(unclaimed.body)).toBe("OUT_OF_SCOPE");
    expect(claimed.status).toBe(409);
    expect(actionConflictCode(claimed.body)).toBe("OUT_OF_SCOPE");
  });

  it("fills missing targets and emits the exact active file and pane", async () => {
    await registerSnapshotOnly();
    const bridge = connectBridge("session-1");
    const selection = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    const result = await handleEditorAgentActions(
      context(
        navAction({
          actionId: "bound-target",
          idempotencyKey: "bound-target-key",
          target: { selection },
        }),
      ),
    );

    expect(result.status).toBe(202);
    expect(lastEmittedAction(bridge.frames()).target).toEqual({
      file: "src/a.ts",
      paneId: "pane-1",
      selection,
    });
  });
});

describe("applyChangeset server transaction (Issue #2117)", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-agent-changeset-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function arrangeTwoFiles(): { readonly patch: string; readonly action: EditorAgentAction } {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "A0\n");
    writeWorkspaceFile(workspaceRoot, "src/b.txt", "B0\n");
    const patch = oneLineModifyPatch([
      { file: "src/a.txt", before: "A0", after: "A1" },
      { file: "src/b.txt", before: "B0", after: "B1" },
    ]);
    return {
      patch,
      action: changesetActionFor(workspaceRoot, patch, ["src/a.txt", "src/b.txt"]),
    };
  }

  it("queues a multi-file changeset and an inactive open file with a server-derived preview", async () => {
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    const changeset = arranged.action.changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const forged = {
      ...arranged.action,
      changeset: {
        ...changeset,
        prepared: {
          files: [
            {
              file: "src/a.txt",
              kind: "modify" as const,
              textEdits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 1, character: 0 },
                  },
                  newText: "FORGED_PREVIEW\n",
                },
              ],
            },
          ],
        },
      },
    };
    const originalRead = nodeWorkspaceFs.readFileUtf8.bind(nodeWorkspaceFs);
    const reads: string[] = [];
    vi.spyOn(nodeWorkspaceFs, "readFileUtf8").mockImplementation((path) => {
      reads.push(path);
      return originalRead(path);
    });

    const queued = await handleEditorAgentActions(context(forged));

    expect(queued.status).toBe(202);
    expect(actionResultStatus(queued.body)).toBe("queued");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
    const emitted = lastEmittedAction(bridge.frames());
    expect(emitted.requiresReview).toBe(false);
    expect(emitted.changeset?.prepared?.files).toHaveLength(2);
    expect(JSON.stringify(emitted.changeset?.prepared)).not.toContain("FORGED_PREVIEW");
    expect(reads).toEqual([join(workspaceRoot, "src/a.txt"), join(workspaceRoot, "src/b.txt")]);
    vi.restoreAllMocks();
  });

  it("preserves chat origin through a queued applyChangeset and its audit record (#2119)", async () => {
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    const proposed = { ...arranged.action, origin: "chat" as const };

    const queued = await handleEditorAgentActions(context(proposed));

    expect(queued.status).toBe(202);
    expect(lastEmittedAction(bridge.frames()).origin).toBe("chat");
    const reported = await postActionResult(proposed, "conflict");
    expect(reported.status).toBe(200);
    expect(auditRecords().map((record) => record.origin)).toEqual(["chat", "chat"]);
  });

  it("queues a prepared changeset exactly at the wire text limit", async () => {
    const tail = "x".repeat(PREPARED_CHANGESET_WIRE_LIMIT_BYTES - 4);
    writeWorkspaceFile(workspaceRoot, "src/large.txt", `A0\n${tail}\n`);
    const patch = oneLineModifyPatch([{ file: "src/large.txt", before: "A0", after: "A1" }]);
    const proposed = changesetActionFor(workspaceRoot, patch, ["src/large.txt"]);
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/large.txt", [
      "src/large.txt",
    ]);

    const queued = await handleEditorAgentActions(context(proposed));

    expect(queued.status).toBe(202);
    const prepared = lastEmittedAction(bridge.frames()).changeset?.prepared;
    const preparedText = prepared?.files[0]?.textEdits[0]?.newText;
    expect(Buffer.byteLength(preparedText ?? "", "utf8")).toBe(PREPARED_CHANGESET_WIRE_LIMIT_BYTES);
  });

  it("fails closed before emitting a prepared changeset above the wire text limit", async () => {
    const tail = "x".repeat(PREPARED_CHANGESET_WIRE_LIMIT_BYTES - 3);
    writeWorkspaceFile(workspaceRoot, "src/large.txt", `A0\n${tail}\n`);
    const patch = oneLineModifyPatch([{ file: "src/large.txt", before: "A0", after: "A1" }]);
    const proposed = changesetActionFor(workspaceRoot, patch, ["src/large.txt"]);
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/large.txt", [
      "src/large.txt",
    ]);

    const rejected = await handleEditorAgentActions(context(proposed));

    expect(rejected.status).toBe(409);
    expect(actionConflictCode(rejected.body)).toBe("INVALID_EDITS");
    expect(bridge.frames()).not.toContain("event: editor-agent:action");
  });

  it("rejects an oversized source before reading or emitting its tiny changeset", async () => {
    const file = "src/oversized.txt";
    const content = `A0\n${"x".repeat(PATCH_SOURCE_LIMIT_BYTES - 2)}`;
    writeWorkspaceFile(workspaceRoot, file, content);
    const patch = oneLineModifyPatch([{ file, before: "A0", after: "A1" }]);
    const proposed = changesetActionFor(workspaceRoot, patch, [file]);
    const bridge = await registerChangesetSnapshot(workspaceRoot, file, [file]);
    const originalRead = nodeWorkspaceFs.readFileUtf8.bind(nodeWorkspaceFs);
    const reads: string[] = [];
    vi.spyOn(nodeWorkspaceFs, "readFileUtf8").mockImplementation((path) => {
      reads.push(path);
      return originalRead(path);
    });

    const rejected = await handleEditorAgentActions(context(proposed));

    expect(Buffer.byteLength(content, "utf8")).toBe(PATCH_SOURCE_LIMIT_BYTES + 1);
    expect(rejected.status).toBe(409);
    expect(actionConflictCode(rejected.body)).toBe("INVALID_EDITS");
    expect(reads).toEqual([]);
    expect(bridge.frames()).not.toContain("event: editor-agent:action");
    vi.restoreAllMocks();
  });

  it("strips unknown authority and capability fields before action emission and audit", async () => {
    const canary = "CAPABILITY_AUTHORITY_CANARY";
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    const proposed = {
      ...arranged.action,
      bridgeDecisionCapability: canary,
      authorityEnvelope: { canary },
      changeset: { ...arranged.action.changeset, authorityEnvelope: { canary } },
    };

    const queued = await handleEditorAgentActions(context(proposed));
    const terminal = await postActionResult(arranged.action, "failed");

    expect(queued.status).toBe(202);
    expect(terminal.status).toBe(200);
    expect(bridge.frames()).not.toContain(canary);
    expect(JSON.stringify(terminal.body)).not.toContain(canary);
    expect(JSON.stringify(auditRecords())).not.toContain(canary);
  });

  it.each([".env", ".ssh/id_rsa", ".keiko/state.json", ".aws/credentials"])(
    "rejects a safe plus deny-listed %s changeset with file attribution and no mutation",
    async (deniedPath) => {
      writeWorkspaceFile(workspaceRoot, "src/a.txt", "A0\n");
      writeWorkspaceFile(workspaceRoot, deniedPath, "SECRET=old\n");
      await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
      const patch = oneLineModifyPatch([
        { file: "src/a.txt", before: "A0", after: "A1" },
        { file: deniedPath, before: "SECRET=old", after: "SECRET=new" },
      ]);
      const proposed = changesetActionFor(workspaceRoot, patch, ["src/a.txt", deniedPath]);
      const originalRead = nodeWorkspaceFs.readFileUtf8.bind(nodeWorkspaceFs);
      const reads: string[] = [];
      vi.spyOn(nodeWorkspaceFs, "readFileUtf8").mockImplementation((path) => {
        reads.push(path);
        return originalRead(path);
      });

      const rejected = await handleEditorAgentActions(context(proposed));

      expect(rejected.status).toBe(409);
      expect(actionConflictCode(rejected.body)).toBe("OUT_OF_SCOPE");
      expect(actionResult(rejected.body).files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "src/a.txt", status: "failed" }),
          expect.objectContaining({
            file: deniedPath,
            status: "conflict",
          }),
        ]),
      );
      const deniedFile = actionResult(rejected.body).files?.find(
        (file) => file.file === deniedPath,
      );
      expect(deniedFile?.conflict).toMatchObject({ code: "OUT_OF_SCOPE", file: deniedPath });
      expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
      expect(readWorkspaceFile(workspaceRoot, deniedPath)).toBe("SECRET=old\n");
      expect(reads).not.toContain(join(workspaceRoot, deniedPath));
      vi.restoreAllMocks();
    },
  );

  it.each(["../outside.txt", "/tmp/outside.txt"])(
    "rejects an escaping changeset member %s before reading or queueing any file",
    async (escapingPath) => {
      const arranged = arrangeTwoFiles();
      const changeset = arranged.action.changeset;
      if (changeset === undefined) throw new Error("expected changeset");
      const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
      const proposed = {
        ...arranged.action,
        changeset: {
          ...changeset,
          files: [changeset.files[0], { file: escapingPath, expectedContentHash: HASH }],
        },
      };
      const reads: string[] = [];
      vi.spyOn(nodeWorkspaceFs, "readFileUtf8").mockImplementation((path) => {
        reads.push(path);
        throw new Error("an invalid changeset must not read the workspace");
      });

      const rejected = await handleEditorAgentActions(context(proposed));

      expect(rejected.status).toBe(400);
      expect(reads).toEqual([]);
      expect(bridge.frames()).not.toContain("event: editor-agent:action");
      expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
      expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
      vi.restoreAllMocks();
    },
  );

  it("attributes one stale member and applies zero changes", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    writeWorkspaceFile(workspaceRoot, "src/b.txt", "C0\n");

    const committed = await postActionResult(arranged.action, "succeeded");

    expect(committed.status).toBe(200);
    expect(actionConflictCode(committed.body)).toBe("CONTENT_HASH_MISMATCH");
    expect(actionResult(committed.body).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/a.txt", status: "failed" }),
        expect.objectContaining({
          file: "src/b.txt",
          status: "conflict",
        }),
      ]),
    );
    const staleFile = actionResult(committed.body).files?.find((file) => file.file === "src/b.txt");
    expect(staleFile?.conflict).toMatchObject({
      code: "CONTENT_HASH_MISMATCH",
      file: "src/b.txt",
    });
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("C0\n");
  });

  it("revalidates changeset authority expiry before the atomic commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    const expiring = authorityEnvelope(workspaceRoot);
    const registered = editorAgentAuthorityRegistry.register(
      { ...expiring, expiresAt: "2026-07-10T00:00:01.000Z" },
      "governed-assist",
      new Date().toISOString(),
    );
    if (!registered.ok) throw new Error("expected expiring authority registration");
    agentAuthorityRef = registered.authorityRef;
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    vi.setSystemTime(new Date("2026-07-10T00:00:02.000Z"));
    const denied = await postActionResult(arranged.action, "succeeded");

    expect(denied.status).toBe(200);
    expect(actionConflictCode(denied.body)).toBe("POLICY_DENIED");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("keeps a local changeset with an authority reference on the established audit path", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    registerTestAuthority(workspaceRoot);
    const runtimeMutationLease = {
      matches: vi.fn((): boolean => false),
      claim: vi.fn((): boolean => {
        throw new Error("a local editor action must not claim a runtime lease");
      }),
    } satisfies NonNullable<UiHandlerDeps["runtimeMutationLease"]>;

    expect(
      (
        await handleEditorAgentActions(
          context(arranged.action),
          runtimeMutationDeps(runtimeMutationLease),
        )
      ).status,
    ).toBe(202);
    const committed = await postActionResult(
      arranged.action,
      "succeeded",
      arranged.action.sessionId,
      undefined,
      runtimeMutationDeps(runtimeMutationLease),
    );

    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(runtimeMutationLease.matches).toHaveBeenCalledTimes(2);
    expect(runtimeMutationLease.claim).not.toHaveBeenCalled();
    expect(auditRecords().at(-2)).toMatchObject({ targetPath: "src/a.txt" });
    expect(auditRecords().at(-1)).toMatchObject({ targetPath: "src/a.txt" });
  });

  it.each([
    ["false", (): boolean => false],
    [
      "throw",
      (): never => {
        throw new Error("revoked");
      },
    ],
    ["replayed", (): boolean => false],
  ] as const)(
    "fails closed when a matching runtime mutation lease claim returns %s",
    async (_outcome, claim) => {
      const sentinelPath = "src/SENTINEL_RUNTIME_PATH.txt";
      const sentinelPatch = "SENTINEL_RUNTIME_PATCH";
      writeWorkspaceFile(workspaceRoot, sentinelPath, "before\n");
      const proposed = changesetActionFor(
        workspaceRoot,
        oneLineModifyPatch([{ file: sentinelPath, before: "before", after: sentinelPatch }]),
        [sentinelPath],
      );
      await registerChangesetSnapshot(workspaceRoot, sentinelPath, [sentinelPath]);
      registerTestAuthority(workspaceRoot);
      const writeFileUtf8 = vi.fn((_path: string, _content: string): void => undefined);
      const mkdirp = vi.fn((_path: string): void => undefined);
      const remove = vi.fn((_path: string): void => undefined);
      const rename = vi.fn((_from: string, _to: string): void => undefined);
      _setEditorAgentPatchWriterForTests({ writeFileUtf8, mkdirp, remove, rename });
      const runtimeMutationLease = {
        matches: vi.fn((): boolean => true),
        claim: vi.fn(
          (
            _request: Parameters<NonNullable<UiHandlerDeps["runtimeMutationLease"]>["claim"]>[0],
          ): boolean => claim(),
        ),
      } satisfies NonNullable<UiHandlerDeps["runtimeMutationLease"]>;

      expect(
        (
          await handleEditorAgentActions(
            context(proposed),
            runtimeMutationDeps(runtimeMutationLease),
          )
        ).status,
      ).toBe(202);
      const denied = await postActionResult(
        proposed,
        "succeeded",
        proposed.sessionId,
        undefined,
        runtimeMutationDeps(runtimeMutationLease),
      );

      expect(actionResultStatus(denied.body)).toBe("failed");
      expect(runtimeMutationLease.matches).toHaveBeenCalledTimes(1);
      expect(runtimeMutationLease.claim).toHaveBeenCalledTimes(1);
      const leaseRequest = runtimeMutationLease.claim.mock.calls[0]?.[0];
      if (leaseRequest === undefined) throw new Error("expected runtime mutation lease request");
      expect(leaseRequest).toMatchObject({
        runId: "run-2121",
        actionId: proposed.actionId,
        idempotencyKey: proposed.idempotencyKey,
      });
      expect(leaseRequest.envelopeDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(leaseRequest.workspaceRootDigest).toBe(editorAgentWorkspaceRootDigest(workspaceRoot));
      expect(writeFileUtf8).not.toHaveBeenCalled();
      expect(mkdirp).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(readWorkspaceFile(workspaceRoot, sentinelPath)).toBe("before\n");
      expect(JSON.stringify(denied.body)).not.toContain("SENTINEL_RUNTIME_");
      expect(JSON.stringify(auditRecords())).not.toContain("SENTINEL_RUNTIME_");
      expect(auditRecords().at(-2)).not.toHaveProperty("targetPath");
      expect(auditRecords().at(-1)).not.toHaveProperty("targetPath");
      expect(auditRecords().at(-1)).not.toHaveProperty("targetBasename");
      expect(auditRecords().at(-1)).not.toHaveProperty("targetPathHash");
    },
  );

  it("uses a true runtime mutation claim exactly once immediately before atomic apply", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    registerTestAuthority(workspaceRoot);
    const order: string[] = [];
    const writeFileUtf8 = vi.fn((_path: string, _content: string): void => {
      order.push("write");
    });
    _setEditorAgentPatchWriterForTests({
      writeFileUtf8,
      mkdirp: vi.fn((_path: string): void => undefined),
      remove: vi.fn((_path: string): void => undefined),
      rename: vi.fn((_from: string, _to: string): void => undefined),
    });
    const runtimeMutationLease = {
      matches: vi.fn((): boolean => true),
      claim: vi.fn((): boolean => {
        order.push("claim");
        return true;
      }),
    } satisfies NonNullable<UiHandlerDeps["runtimeMutationLease"]>;

    expect(
      (
        await handleEditorAgentActions(
          context(arranged.action),
          runtimeMutationDeps(runtimeMutationLease),
        )
      ).status,
    ).toBe(202);
    const committed = await postActionResult(
      arranged.action,
      "succeeded",
      arranged.action.sessionId,
      undefined,
      runtimeMutationDeps(runtimeMutationLease),
    );

    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(runtimeMutationLease.matches).toHaveBeenCalledTimes(1);
    expect(runtimeMutationLease.claim).toHaveBeenCalledTimes(1);
    expect(order).toEqual(expect.arrayContaining(["claim", "write"]));
    expect(order.indexOf("claim")).toBeLessThan(order.indexOf("write"));
    expect(auditRecords().at(-2)).not.toHaveProperty("targetPath");
    expect(auditRecords().at(-1)).not.toHaveProperty("targetPath");
  });

  it("revalidates every changeset member after a target becomes an outward symlink", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    const outsideRoot = mkdtempSync(join(tmpdir(), "keiko-agent-changeset-outside-"));
    const outsideFile = join(outsideRoot, "outside.txt");
    writeFileSync(outsideFile, "B0\n", "utf8");
    rmSync(join(workspaceRoot, "src/b.txt"));
    symlinkSync(outsideFile, join(workspaceRoot, "src/b.txt"));

    try {
      const denied = await postActionResult(arranged.action, "succeeded");
      expect(denied.status).toBe(200);
      expect(actionConflictCode(denied.body)).toBe("OUT_OF_SCOPE");
      expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
      expect(readFileSync(outsideFile, "utf8")).toBe("B0\n");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("applies nothing when the browser rejects the queued changeset", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const rejected = await postActionResult(arranged.action, "failed");

    expect(rejected.status).toBe(200);
    expect(actionResultStatus(rejected.body)).toBe("failed");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("atomically commits every selected file once after a succeeded acknowledgment", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const committed = await postActionResult(arranged.action, "succeeded");
    const replay = await postActionResult(arranged.action, "succeeded");

    expect(committed.status).toBe(200);
    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(actionResult(committed.body).files).toEqual([
      { file: "src/a.txt", status: "succeeded" },
      { file: "src/b.txt", status: "succeeded" },
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A1\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B1\n");
    expect(replay.status).toBe(409);
  });

  it("does not claim or commit for missing, wrong, or replayed bridge capabilities", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const missing = await postActionResult(arranged.action, "succeeded", "session-1", null);
    const wrong = await postActionResult(
      arranged.action,
      "succeeded",
      "session-1",
      "B".repeat(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS),
    );
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(editorAgentRegistry.pendingCount("session-1")).toBe(1);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");

    const committed = await postActionResult(arranged.action, "succeeded");
    const replayed = await postActionResult(arranged.action, "succeeded");
    expect(committed.status).toBe(200);
    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(replayed.status).toBe(409);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A1\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B1\n");
  });

  it("requires a live lease and verifiable active snapshot counterparts at commit time", async () => {
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    bridge.close();

    const disconnected = await postActionResult(arranged.action, "succeeded");
    expect(disconnected.status).toBe(409);
    expect(editorAgentRegistry.pendingCount("session-1")).toBe(1);
    connectBridge("session-1");
    const currentSnapshot = editorAgentRegistry.snapshotFor("session-1");
    if (currentSnapshot === undefined) throw new Error("expected current snapshot");
    await registerSnapshotOnly({
      ...currentSnapshot,
      documentVersion: undefined,
      activeFileContentHash: undefined,
      updatedAt: currentSnapshot.updatedAt + 1,
    });

    const unverifiable = await postActionResult(arranged.action, "succeeded");
    expect(unverifiable.status).toBe(200);
    expect(actionConflictCode(unverifiable.body)).toBe("PRECONDITION_REQUIRED");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("projects selectedFiles after full validation and reports non-selected members", async () => {
    const arranged = arrangeTwoFiles();
    const changeset = arranged.action.changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const selected: EditorAgentAction = {
      ...arranged.action,
      changeset: { ...changeset, selectedFiles: ["./src/b.txt"] },
    };
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(selected))).status).toBe(202);

    const committed = await postActionResult(selected, "succeeded");

    expect(actionResultStatus(committed.body)).toBe("succeeded");
    expect(actionResult(committed.body).files).toEqual([
      { file: "src/a.txt", status: "not-selected" },
      { file: "src/b.txt", status: "succeeded" },
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B1\n");
  });

  // Issue #2117: ADR-0125 D3 requires whole-action validation before selectedFiles projection, not
  // validation of only the selected subset. A hostile precondition on an unselected declared file
  // must fail the entire changeset, including the otherwise-valid selected files.
  it("fails the whole changeset when an unselected declared file carries a hostile precondition", async () => {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "A0\n");
    writeWorkspaceFile(workspaceRoot, "src/b.txt", "B0\n");
    writeWorkspaceFile(workspaceRoot, "src/c.txt", "C0\n");
    const patch = oneLineModifyPatch([
      { file: "src/a.txt", before: "A0", after: "A1" },
      { file: "src/b.txt", before: "B0", after: "B1" },
      { file: "src/c.txt", before: "C0", after: "C1" },
    ]);
    const proposed = changesetActionFor(
      workspaceRoot,
      patch,
      ["src/a.txt", "src/b.txt", "src/c.txt"],
      ["src/a.txt", "src/b.txt"],
    );
    const changeset = proposed.changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const hostile: EditorAgentAction = {
      ...proposed,
      changeset: {
        ...changeset,
        files: changeset.files.map((file) =>
          file.file === "src/c.txt" ? { ...file, expectedContentHash: "b".repeat(64) } : file,
        ),
      },
    };
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
      "src/c.txt",
    ]);

    const rejected = await handleEditorAgentActions(context(hostile));

    expect(rejected.status).toBe(409);
    expect(actionResultStatus(rejected.body)).toBe("conflict");
    expect(actionConflictCode(rejected.body)).toBe("CONTENT_HASH_MISMATCH");
    expect(actionResult(rejected.body).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/a.txt", status: "failed" }),
        expect.objectContaining({ file: "src/b.txt", status: "failed" }),
        expect.objectContaining({ file: "src/c.txt", status: "conflict" }),
      ]),
    );
    expect(bridge.frames()).not.toContain("event: editor-agent:action");
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/c.txt")).toBe("C0\n");
  });

  it("rolls back earlier files when the injected writer fails on a later member", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);
    const writer: WorkspaceWriter = {
      writeFileUtf8: (absolutePath, content): void => {
        if (absolutePath.endsWith("b.txt") && content === "B1\n") {
          throw new Error("forced writer failure");
        }
        writeFileSync(absolutePath, content, "utf8");
      },
      mkdirp: (absoluteDir): void => {
        mkdirSync(absoluteDir, { recursive: true });
      },
      remove: (absolutePath): void => {
        rmSync(absolutePath, { force: true });
      },
      rename: (fromAbsolute, toAbsolute): void => {
        renameSync(fromAbsolute, toAbsolute);
      },
    };
    _setEditorAgentPatchWriterForTests(writer);

    const failed = await postActionResult(arranged.action, "succeeded");

    expect(actionResultStatus(failed.body)).toBe("failed");
    expect(actionResult(failed.body).files).toEqual([
      expect.objectContaining({ file: "src/a.txt", status: "failed" }),
      expect.objectContaining({ file: "src/b.txt", status: "failed" }),
    ]);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
  });

  it("does not commit for unsolicited or cross-session forged success results", async () => {
    const arranged = arrangeTwoFiles();
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt", "src/b.txt"]);
    expect((await handleEditorAgentActions(context(arranged.action))).status).toBe(202);

    const unsolicited = await postActionResult(
      { ...arranged.action, actionId: "not-pending" },
      "succeeded",
    );
    const crossSession = await postActionResult(arranged.action, "succeeded", "session-2");

    expect(unsolicited.status).toBe(409);
    expect(crossSession.status).toBe(403);
    expect(readWorkspaceFile(workspaceRoot, "src/a.txt")).toBe("A0\n");
    expect(readWorkspaceFile(workspaceRoot, "src/b.txt")).toBe("B0\n");
    expect((await postActionResult(arranged.action, "failed")).status).toBe(200);
  });

  it("records bounded content-free queued and terminal accept, reject, and conflict audit", async () => {
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "AUDIT_BASE\n");
    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
    const acceptPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_BASE", after: "AUDIT_SECRET_ACCEPT" },
    ]);
    const accepted = changesetActionFor(workspaceRoot, acceptPatch, ["src/a.txt"], undefined, {
      actionId: "audit-accept",
      idempotencyKey: "audit-accept-key",
    });
    await handleEditorAgentActions(context(accepted));
    await postActionResult(accepted, "succeeded");

    await registerChangesetSnapshot(workspaceRoot, "src/a.txt", ["src/a.txt"]);
    const rejectPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_SECRET_ACCEPT", after: "AUDIT_SECRET_REJECT" },
    ]);
    const rejected = changesetActionFor(workspaceRoot, rejectPatch, ["src/a.txt"], undefined, {
      actionId: "audit-reject",
      idempotencyKey: "audit-reject-key",
    });
    await handleEditorAgentActions(context(rejected));
    await postActionResult(rejected, "failed");

    const conflictPatch = oneLineModifyPatch([
      { file: "src/a.txt", before: "AUDIT_SECRET_ACCEPT", after: "AUDIT_SECRET_CONFLICT" },
    ]);
    const conflicted = changesetActionFor(workspaceRoot, conflictPatch, ["src/a.txt"], undefined, {
      actionId: "audit-conflict",
      idempotencyKey: "audit-conflict-key",
    });
    await handleEditorAgentActions(context(conflicted));
    writeWorkspaceFile(workspaceRoot, "src/a.txt", "AUDIT_EXTERNAL\n");
    await postActionResult(conflicted, "succeeded");

    const records = auditRecords();
    expect(records.map((record) => record.outcome)).toEqual([
      "queued",
      "succeeded",
      "queued",
      "failed",
      "queued",
      "conflict",
    ]);
    expect(records).toHaveLength(6);
    expect(records.every((record) => (record.patchByteLength ?? 0) > 0)).toBe(true);
    expect(records.every((record) => record.summary.length <= 256)).toBe(true);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("AUDIT_SECRET_ACCEPT");
    expect(serialized).not.toContain("AUDIT_SECRET_REJECT");
    expect(serialized).not.toContain("AUDIT_SECRET_CONFLICT");
    expect(serialized).not.toContain("AUDIT_EXTERNAL");
  });

  it("applies the Authority Envelope mode ceiling in the existing action route", async () => {
    const arranged = arrangeTwoFiles();
    const bridge = await registerChangesetSnapshot(workspaceRoot, "src/a.txt", [
      "src/a.txt",
      "src/b.txt",
    ]);
    registerTestAuthority(workspaceRoot, "supervised-coding");
    const proposed = {
      ...arranged.action,
      authorityRef: agentAuthorityRef,
      requiresReview: false,
    };

    expect((await handleEditorAgentActions(context(proposed))).status).toBe(202);
    expect(lastEmittedAction(bridge.frames()).requiresReview).toBe(true);
    expect(auditRecords()[0]).toMatchObject({
      disposition: "review-required",
      effectClass: "content-mutation",
      reviewReason: "deterministic-risk-approval-required",
    });
  });
});

describe("agent editor action policy (Issue #1395 AC2)", () => {
  it("keeps pure navigation outside Authority Envelope consumption", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          type: "openFile",
          authorityRef: undefined,
          expectedContentHash: undefined,
          target: { file: "src/a.ts" },
        }),
      ),
    );

    expect(result.status).toBe(202);
    expect(actionResultStatus(result.body)).toBe("queued");
  });

  it("denies actions after the registered Authority Envelope budget is exhausted", async () => {
    await registerSnapshot();
    const limited = authorityEnvelope("/repo");
    const registered = editorAgentAuthorityRegistry.register(
      {
        ...limited,
        budget: { ...limited.budget, maxToolCalls: 1 },
      },
      "governed-assist",
      new Date().toISOString(),
    );
    if (!registered.ok) throw new Error("expected limited authority registration");
    agentAuthorityRef = registered.authorityRef;
    const first = action({ actionId: "budget-first", idempotencyKey: "budget-first-key" });
    const second = action({ actionId: "budget-second", idempotencyKey: "budget-second-key" });

    expect((await handleEditorAgentActions(context(first))).status).toBe(202);
    const denied = await handleEditorAgentActions(context(second));

    expect(denied.status).toBe(403);
    expect(actionConflictCode(denied.body)).toBe("POLICY_DENIED");
    expect(auditRecords().at(-1)?.denyReason).toBe("authority-budget-exceeded");
  });

  // Issue #2121: a replayed idempotency key must return the retained result without a second
  // Authority Envelope budget reservation. A one-slot budget makes any accidental re-reservation on
  // replay observable: the replay would itself be denied authority-budget-exceeded instead of
  // returning the original queued outcome.
  it("does not re-charge the Authority Envelope budget when a queued action is replayed", async () => {
    await registerSnapshot();
    const limited = authorityEnvelope("/repo");
    const registered = editorAgentAuthorityRegistry.register(
      { ...limited, budget: { ...limited.budget, maxToolCalls: 1 } },
      "governed-assist",
      new Date().toISOString(),
    );
    if (!registered.ok) throw new Error("expected limited authority registration");
    agentAuthorityRef = registered.authorityRef;
    const first = action({ actionId: "budget-replay-first", idempotencyKey: "budget-replay-key" });
    const second = action({
      actionId: "budget-replay-second",
      idempotencyKey: "budget-replay-second-key",
    });

    const queued = await handleEditorAgentActions(context(first));
    const replay = await handleEditorAgentActions(context(first));
    const denied = await handleEditorAgentActions(context(second));

    expect(queued.status).toBe(202);
    expect(actionResultStatus(queued.body)).toBe("queued");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(queued.body);
    expect(denied.status).toBe(403);
    expect(actionConflictCode(denied.body)).toBe("POLICY_DENIED");
    expect(auditRecords().at(-1)?.denyReason).toBe("authority-budget-exceeded");
  });

  it("charges applyTextEdits payload bytes against the Authority Envelope patch budget", async () => {
    await registerSnapshot();
    const limited = authorityEnvelope("/repo");
    const registered = editorAgentAuthorityRegistry.register(
      {
        ...limited,
        budget: { ...limited.budget, maxPatchBytes: 3 },
      },
      "governed-assist",
      new Date().toISOString(),
    );
    if (!registered.ok) throw new Error("expected limited authority registration");
    agentAuthorityRef = registered.authorityRef;

    const denied = await handleEditorAgentActions(
      context(applyTextEditsAction("four", "src/a.ts")),
    );

    expect(denied.status).toBe(403);
    expect(actionConflictCode(denied.body)).toBe("POLICY_DENIED");
    expect(auditRecords().at(-1)).toMatchObject({
      denyReason: "authority-budget-exceeded",
      patchByteLength: 4,
    });
  });

  it("denies missing and forged agent authority before queue admission", async () => {
    await registerSnapshot();
    const missing = action({ authorityRef: undefined });
    const forged = action({
      actionId: "action-forged",
      idempotencyKey: "idempotency-forged",
      authorityRef: { runId: "run-2121", envelopeDigest: "b".repeat(64) },
    });

    const missingResult = await handleEditorAgentActions(context(missing));
    const forgedResult = await handleEditorAgentActions(context(forged));

    expect(missingResult.status).toBe(403);
    expect(actionConflictCode(missingResult.body)).toBe("POLICY_DENIED");
    expect(forgedResult.status).toBe(403);
    expect(actionConflictCode(forgedResult.body)).toBe("POLICY_DENIED");
    expect(auditRecords().map((record) => record.denyReason)).toEqual([
      "authority-missing",
      "authority-invalid",
    ]);
  });

  it("binds a capability-backed local patch to server-derived Ask for approval authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-editor-local-authority-"));
    try {
      writeWorkspaceFile(root, "src/a.ts", "old\n");
      await registerSnapshot(root, "src/a.ts");
      const observer = connectBridge("session-1");
      const proposed = action({
        type: "applyPatch",
        origin: "agent",
        authorityRef: undefined,
        target: { file: "src/a.ts", paneId: "pane-1" },
        expectedContentHash: HASH,
        patch: oneLineModifyPatch([{ file: "src/a.ts", before: "old", after: "new" }]),
      });
      const capability = bridgeDecisionCapability;
      if (capability === undefined) throw new Error("expected bridge capability");
      const request = {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "action",
        action: proposed,
        bridgeDecisionCapability: capability,
      } as const;
      const result = await handleEditorAgentActions(context(request));
      const replay = await handleEditorAgentActions(context(request));
      const forged = await handleEditorAgentActions(
        context({ ...request, bridgeDecisionCapability: "B".repeat(43) }),
      );
      const unwrapped = await handleEditorAgentActions(
        context({
          ...proposed,
          actionId: "action-unwrapped",
          idempotencyKey: "idempotency-unwrapped",
        }),
      );

      expect(result.status).toBe(202);
      expect(replay.status).toBe(200);
      expect(forged.status).toBe(403);
      expect(unwrapped.status).toBe(403);
      expect(auditRecords()[0]).toMatchObject({ disposition: "allowed", origin: "chat" });
      expect(observer.frames()).toContain("editor-agent:action");
      expect(observer.frames()).not.toContain("authorityRef");
      expect(lastEmittedAction(observer.frames()).requiresReview).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for an unissued approval reference", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(
      context(
        action({
          approvalRef: {
            approvalId: "approval-unissued",
            actionId: "action-1",
            approvalProofDigest: HASH,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
      ),
    );
    expect(result.status).toBe(403);
    expect(actionConflictCode(result.body)).toBe("POLICY_DENIED");
    expect(auditRecords()[0]?.denyReason).toBe("approval-reference-invalid");
  });

  it("denies a write to a deny-listed sensitive path with OUT_OF_SCOPE", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(context(applyTextEditsAction("x", ".env")));
    expect(result.status).toBe(409);
    expect(actionResultStatus(result.body)).toBe("conflict");
    expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
  });

  it("admits a contained, non-sensitive write under the current mode policy", async () => {
    await registerSnapshot();
    const result = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(result.status).toBe(202);
    expect(actionResultStatus(result.body)).toBe("queued");
  });

  it("denies format and save to a deny-listed sensitive path with OUT_OF_SCOPE", async () => {
    await registerSnapshot();
    for (const type of ["format", "save"] as const) {
      const result = await handleEditorAgentActions(
        context(
          action({
            type,
            target: { file: ".env" },
            actionId: `a-${type}`,
            idempotencyKey: `ik-${type}`,
          }),
        ),
      );
      expect(result.status).toBe(409);
      expect(actionConflictCode(result.body)).toBe("OUT_OF_SCOPE");
    }
  });
});

describe("agent editor action audit (Issue #1395 AC1, AC3, AC4)", () => {
  it("records bounded audit metadata for a queued mutating action (AC1)", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    const records = auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.actionType).toBe("applyTextEdits");
    expect(records[0]?.disposition).toBe("allowed");
    expect(records[0]?.outcome).toBe("queued");
    expect(records[0]?.mutating).toBe(true);
    expect(records[0]?.editCount).toBe(1);
    expect(records[0]?.origin).toBe("agent");
  });

  it("records a denied action with its deny reason and conflict code (AC2, AC4)", async () => {
    await registerSnapshot(undefined, ".env");
    await handleEditorAgentActions(context(applyTextEditsAction("x", ".env")));
    const records = auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.disposition).toBe("denied");
    expect(records[0]?.denyReason).toBe("denied-sensitive-path");
    expect(records[0]?.conflictCode).toBe("OUT_OF_SCOPE");
  });

  it("does not audit an allowed navigation action", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(
      context(
        action({ type: "openFile", target: { file: "src/a.ts" }, expectedContentHash: undefined }),
      ),
    );
    expect(auditRecords()).toHaveLength(0);
  });

  it("never stores raw edit content in the audit feed (AC3)", async () => {
    await registerSnapshotOnly({ text: "AUDIT_SECRET_SOURCE", textMode: "activeFile" });
    connectBridge("session-1");
    await handleEditorAgentActions(context(applyTextEditsAction("AUDIT_SECRET_EDIT")));
    const serialized = JSON.stringify(auditRecords());
    expect(serialized).not.toContain("AUDIT_SECRET_EDIT");
    expect(serialized).not.toContain("AUDIT_SECRET_SOURCE");
    // The record still proves the action happened: it carries the edit COUNT, not the edit content.
    expect(auditRecords()[0]?.editCount).toBe(1);
  });

  it("scopes the audit feed to the requested session", async () => {
    await registerSnapshot();
    await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(auditRecords("session-1")).toHaveLength(1);
    expect(auditRecords("session-2")).toHaveLength(0);
  });

  it("does not duplicate the audit record on idempotent replay (AC1 bounded)", async () => {
    await registerSnapshot();
    const first = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(first.status).toBe(202);
    // Replaying the identical action returns the cached result and records no second audit entry.
    const replay = await handleEditorAgentActions(context(applyTextEditsAction("hello")));
    expect(replay.status).toBe(200);
    expect(auditRecords()).toHaveLength(1);
  });
});
