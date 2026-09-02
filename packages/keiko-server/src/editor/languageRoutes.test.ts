import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedLspProcessHealthSnapshot,
  ManagedLspShellConfiguration,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/language-service";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { RouteResult } from "../routes.js";
import type { UiStore } from "../store/index.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { requestRootAccessResolver, type ResolvedProjectRoot } from "../files.js";
import type { WorkspaceRootAccessOutcome } from "../task-workspace/workspace-root-access.js";
import {
  clientAbortSignal,
  handleEditorLanguage,
  handleEditorLanguageCapabilities,
  handleEditorLanguageCapabilitiesForRoute,
  handleEditorLanguageSemanticTokens,
  managedActivationAuthorization,
  managedActivationRecheck,
  type EditorLanguageRouteOptions,
} from "./languageRoutes.js";
import type { ManagedLspControlSnapshot } from "./lsp/managedLspControl.js";
import { createManagedLspActivationStore } from "./lsp/managedLspActivationStore.js";
import { createManagedLspControlService } from "./lsp/managedLspControl.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProvider(body: unknown, id: string, availability: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.providers)) return false;
  return body.providers.some(
    (provider) =>
      isRecord(provider) && provider.id === id && provider.availability === availability,
  );
}

function provider(body: unknown, id: string): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.providers)) return undefined;
  return body.providers.find((entry): entry is Record<string, unknown> => {
    return isRecord(entry) && entry.id === id;
  });
}

function negotiatedHealth(
  operations: ManagedLspProcessHealthSnapshot["negotiatedOperations"],
): ManagedLspProcessHealthSnapshot {
  return {
    schemaVersion: "1",
    managerId: "managed-python",
    language: "python",
    status: "READY",
    restartCount: 0,
    configurationRevision: 1,
    negotiatedOperations: operations,
    lastTransitionTimestampMs: 1,
    pendingRequestCount: 0,
    requestCount: 0,
    successCount: 0,
    timeoutCount: 0,
    cancellationCount: 0,
    failureCount: 0,
    latency: {
      count: 0,
      totalMs: 0,
      maximumMs: 0,
      lessThanOrEqual10Ms: 0,
      lessThanOrEqual50Ms: 0,
      lessThanOrEqual250Ms: 0,
      lessThanOrEqual1Second: 0,
      greaterThan1Second: 0,
    },
  };
}

function schemaVersion(body: unknown): unknown {
  return isRecord(body) ? body.schemaVersion : undefined;
}

function rawPostContext(raw: string): RouteContext {
  const req = Readable.from([Buffer.from(raw, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    correlationId: undefined,
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/language"),
  };
}

function postContext(body: unknown): RouteContext {
  return rawPostContext(JSON.stringify(body));
}

function getContext(path: string): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([]) as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

function postContextWithResponseClose(body: unknown, writableEnded: boolean): RouteContext {
  const ctx = postContext(body);
  const res = {
    writableEnded,
    on(event: string, listener: () => void) {
      if (event === "close") {
        listener();
      }
      return res;
    },
  } as unknown as ServerResponse;
  return { ...ctx, res };
}

describe("clientAbortSignal", () => {
  it("does not treat a normally completed request close as client cancellation", () => {
    const context = postContext({});
    Object.defineProperty(context.req, "complete", { value: true, configurable: true });
    const signal = clientAbortSignal(context);

    context.req.emit("close");
    expect(signal.aborted).toBe(false);

    context.req.emit("aborted");
    expect(signal.aborted).toBe(true);
  });
});

let root: string;
let store: UiStore;

function deps(
  redactor: UiHandlerDeps["redactor"] = buildRedactor({}),
  env: UiHandlerDeps["env"] = {},
): UiHandlerDeps {
  return {
    store,
    redactor,
    env,
    workspaceScriptTrust: { trustLevelForRoot: () => "trusted" },
  } as unknown as UiHandlerDeps;
}

function redactEveryString(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/")) {
      return value;
    }
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map(redactEveryString);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactEveryString(entry)]),
    );
  }
  return value;
}

const stableLanguageOptions: EditorLanguageRouteOptions = { now: () => 0 };

function grantedOrdinaryAccess(canonicalRoot: string): WorkspaceRootAccessOutcome {
  return {
    decision: "granted",
    access: { kind: "ordinary", canonicalRoot, fs: nodeWorkspaceFs },
  };
}

function tsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  });
}

function shellConfiguration(revision: number, etag: string): ManagedLspShellConfiguration {
  return {
    schemaVersion: "1",
    language: "shell",
    revision,
    etag,
    activation: "enabled",
    runtime: { kind: "operatorApproved", runtimeId: "shell-lsp" },
    provenance: {
      activation: "workspace",
      runtime: "operatorProvisioning",
      settings: "workspace",
    },
    restartRequired: false,
    restartFields: [],
    settings: {
      dialect: "bash",
      sourcePolicy: "workspaceOnly",
      shellCheck: {
        mode: "disabled",
        severity: "warning",
        excludedCodes: [],
        includePaths: [],
        externalSources: false,
      },
    },
  };
}

function positionOf(text: string, needle: string, offset = 0): { line: number; character: number } {
  const index = text.indexOf(needle, offset);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function rangeOf(
  text: string,
  needle: string,
): {
  start: { line: number; character: number };
  end: { line: number; character: number };
} {
  const start = positionOf(text, needle);
  return { start, end: { line: start.line, character: start.character + needle.length } };
}

async function writeProject(files: Readonly<Record<string, string>>): Promise<void> {
  await writeFile(join(root, "tsconfig.json"), tsconfig(), "utf8");
  for (const [relativePath, text] of Object.entries(files)) {
    await writeFile(join(root, relativePath), text, "utf8");
  }
}

function postLanguage(
  body: unknown,
  redactor: UiHandlerDeps["redactor"] = buildRedactor({}),
  options: EditorLanguageRouteOptions = stableLanguageOptions,
): Promise<RouteResult> {
  return handleEditorLanguage(postContext(body), deps(redactor), options);
}

function routeRequestFor(operation: string, decl: string, main: string): unknown {
  if (operation === "definition" || operation === "references" || operation === "renamePrepare") {
    const text = operation === "definition" ? main : decl;
    return {
      operation,
      root,
      document: {
        path: operation === "definition" ? "src/main.ts" : "src/decl.ts",
        languageId: "typescript",
        text,
      },
      position: positionOf(
        text,
        "sharedValue",
        operation === "definition" ? text.indexOf("use") : 0,
      ),
    };
  }
  if (operation === "renameApply") {
    return {
      operation,
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
      newName: "renamedValue",
    };
  }
  if (operation === "codeActions") {
    return {
      operation,
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      range: rangeOf(main, "sharedValue"),
      diagnostics: [],
    };
  }
  return {
    operation,
    root,
    document: { path: "src/main.ts", languageId: "typescript", text: main },
    position: positionOf(main, "sharedValue"),
  };
}

function expectUnknownArray(value: unknown, label: string): readonly unknown[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value as readonly unknown[];
}

function expectNavigationShape(result: Record<string, unknown>): void {
  const locations = expectUnknownArray(result.locations, "locations");
  expect(locations).not.toHaveLength(0);
  if (!isRecord(locations[0])) throw new Error("location must be an object");
  expect(typeof locations[0].path).toBe("string");
}

function expectRenameApplyShape(result: Record<string, unknown>): void {
  const files = expectUnknownArray(result.files, "files");
  if (!isRecord(files[0])) throw new Error("rename file must be an object");
  expect(typeof files[0].path).toBe("string");
  expect(Array.isArray(files[0].edits)).toBe(true);
  expect(typeof files[0].expectedContentHash).toBe("string");
}

function expectRangeShape(value: unknown): void {
  if (!isRecord(value)) throw new Error("range must be an object");
  expect(isRecord(value.start)).toBe(true);
  expect(isRecord(value.end)).toBe(true);
}

function expectLanguageResultShape(body: unknown, operation: string): void {
  expect(body).toMatchObject({ operation });
  if (!isRecord(body) || !isRecord(body.result)) throw new Error("missing result body");
  const result = body.result;
  if (operation === "definition" || operation === "references") {
    expectNavigationShape(result);
    return;
  }
  if (operation === "renamePrepare") {
    expectRangeShape(result.range);
    expect(typeof result.placeholder).toBe("string");
    return;
  }
  if (operation === "renameApply") {
    expectRenameApplyShape(result);
    return;
  }
  if (operation === "signatureHelp") {
    expectUnknownArray(result.signatures, "signatures");
    expect(result.returnedCount).toEqual(expect.any(Number));
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-ls-route-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/editor/language/capabilities", () => {
  it("advertises the registered providers", () => {
    const result = handleEditorLanguageCapabilities();
    expect(result.status).toBe(200);
    expect(schemaVersion(result.body)).toBe("1");
    expect(hasProvider(result.body, "typescript", "available")).toBe(true);
    expect(hasProvider(result.body, "python-lsp", "unavailable")).toBe(true);
  });

  it("overrides host provider descriptors from workspace-aware executable detection", async () => {
    const bin = await mkdtemp(join(tmpdir(), "keiko-route-lsp-bin-"));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);

      const result = await handleEditorLanguageCapabilitiesForRoute(
        getContext(`/api/editor/language/capabilities?root=${encodeURIComponent(root)}`),
        deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
        { hostLanguageCommandRules: [{ executable: "pyright-langserver" }] },
      );

      expect(result.status).toBe(200);
      expect(hasProvider(result.body, "python-lsp", "available")).toBe(true);
      expect(hasProvider(result.body, "go-lsp", "unavailable")).toBe(true);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("reports policy-blocked host providers with a content-free unavailable reason", async () => {
    const result = await handleEditorLanguageCapabilitiesForRoute(
      getContext(`/api/editor/language/capabilities?root=${encodeURIComponent(root)}`),
      deps(buildRedactor({}), { KEIKO_EDITOR_LSP_PYTHON: "1" }),
      { hostLanguageCommandRules: [] },
    );

    expect(result.status).toBe(200);
    const body = result.body as { providers: { id: string; unavailableReason?: string }[] };
    const python = body.providers.find((provider) => provider.id === "python-lsp");
    expect(python?.unavailableReason).toBe(
      "Required host language tool is blocked by host execution policy.",
    );
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("uses canonical workspace activation instead of allowing a legacy env flag to bypass default-off", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-control-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-control-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const context = getContext(
        `/api/editor/language/capabilities?root=${encodeURIComponent(root)}`,
      );
      const controlledDeps = {
        ...deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
        managedLspControl,
      };

      const defaultOff = await handleEditorLanguageCapabilitiesForRoute(context, controlledDeps, {
        hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
      });
      expect(hasProvider(defaultOff.body, "python-lsp", "unavailable")).toBe(true);

      await managedLspControl.mutate({
        action: "activate",
        actorClass: "localHuman",
        expectedRevision: 0,
        idempotencyKey: "activate-python-capabilities",
        language: "python",
        root,
      });
      const unavailableInitialization = vi.fn(() => Promise.resolve(undefined));
      const awaitingNegotiation = await handleEditorLanguageCapabilitiesForRoute(
        context,
        { ...controlledDeps, env: { PATH: bin } },
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          initializeManagedProvider: unavailableInitialization,
        },
      );
      expect(hasProvider(awaitingNegotiation.body, "python-lsp", "unavailable")).toBe(true);
      expect(unavailableInitialization).toHaveBeenCalledOnce();

      const negotiatedInitialization = vi.fn(() =>
        Promise.resolve(negotiatedHealth(["diagnostics"])),
      );
      const activated = await handleEditorLanguageCapabilitiesForRoute(
        context,
        { ...controlledDeps, env: { PATH: bin } },
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          initializeManagedProvider: negotiatedInitialization,
        },
      );
      expect(hasProvider(activated.body, "python-lsp", "available")).toBe(true);
      expect(provider(activated.body, "python-lsp")?.operations).toEqual(["diagnostics"]);
      expect(negotiatedInitialization).toHaveBeenCalledOnce();
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Reading capabilities warms the managed pool, so it re-proves root authority exactly like the
  // diagnostics and semantic-token routes. It previously answered 200 with an empty descriptor
  // list, which is the same body a workspace with no managed language server returns — a client
  // could not tell a revoked root from an unconfigured one.
  it("refuses with 403 DENIED when root authority is revoked during the managed control read", async () => {
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-caps-revoked-state-")));
    try {
      let granted = true;
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const revokingDeps = {
        ...deps(),
        managedLspControl: {
          ...managedLspControl,
          // Revocation lands in the awaited window the route opens: the snapshot is the real one,
          // and authority is gone by the time the descriptors would be built.
          read: async (requestedRoot: string): Promise<ManagedLspControlSnapshot | undefined> => {
            const snapshot = await managedLspControl.read(requestedRoot);
            granted = false;
            return snapshot;
          },
        },
        workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccessOutcome =>
          granted ? grantedOrdinaryAccess(requestedRoot) : { decision: "denied" },
      } as unknown as UiHandlerDeps;
      const admitted: ResolvedProjectRoot = {
        root,
        realRoot: root,
        access: { kind: "ordinary", canonicalRoot: root, fs: nodeWorkspaceFs },
      };
      const context = getContext(
        `/api/editor/language/capabilities?root=${encodeURIComponent(root)}`,
      );

      const result = await handleEditorLanguageCapabilitiesForRoute(context, revokingDeps, {
        // The production seam, not a stand-in: the closure the route builds for itself.
        reproveRootAccess: requestRootAccessResolver(context, revokingDeps, admitted),
      });

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "DENIED" } });
      expect(JSON.stringify(result.body)).not.toContain(root);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/editor/language", () => {
  it("degrades semantic-token requests to syntax highlighting when Rust is not activated", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/lib.rs"), "fn main() {}\n", "utf8");
    const result = await handleEditorLanguageSemanticTokens(
      postContext({
        schemaVersion: "1",
        root,
        document: {
          path: "src/lib.rs",
          languageId: "rust",
          text: "fn main() {}\n",
          version: 2,
        },
      }),
      deps(),
    );

    expect(result).toEqual({ status: 200, body: { schemaVersion: "1", supported: false } });
  });

  // The semantic-token route awaits the same managed control read before it may reach the provider
  // pool. A root whose authority is revoked during that await must be refused, not answered with
  // the ordinary "not supported" fallback that a caller cannot distinguish from a healthy workspace.
  it("refuses semantic tokens when managed-root authority is revoked during the control read", async () => {
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-semantic-revoked-state-")));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/lib.rs"), "fn main() {}\n", "utf8");
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const spawn = vi.fn((): never => {
        throw new Error("spawn must remain unreachable");
      });
      let granted = true;
      const revokableDeps = {
        ...deps(),
        managedLspControl: {
          ...managedLspControl,
          read: (requestedRoot: string): Promise<ManagedLspControlSnapshot> => {
            granted = false;
            return managedLspControl.read(requestedRoot);
          },
        },
        workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccessOutcome =>
          granted ? grantedOrdinaryAccess(requestedRoot) : { decision: "denied" },
      } as unknown as UiHandlerDeps;

      const result = await handleEditorLanguageSemanticTokens(
        postContext({
          schemaVersion: "1",
          root,
          document: { path: "src/lib.rs", languageId: "rust", text: "fn main() {}\n", version: 2 },
        }),
        revokableDeps,
        { hostLanguageSpawn: spawn },
      );

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "DENIED" } });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed semantic-token request fields before provider dispatch", async () => {
    const result = await handleEditorLanguageSemanticTokens(
      postContext({
        schemaVersion: "1",
        root,
        document: { path: "../escape.rs", languageId: "rust", text: "x", version: 1 },
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("does not spawn a legacy-env-enabled provider while canonical workspace activation is absent", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-operation-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-operation-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      let spawned = false;
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const result = await handleEditorLanguage(
        postContext({
          operation: "diagnostics",
          root,
          document: { path: "src/a.py", languageId: "python", text: "value = 1\n" },
        }),
        {
          ...deps(buildRedactor({}), { PATH: bin, KEIKO_EDITOR_LSP_PYTHON: "1" }),
          managedLspControl,
        },
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          hostLanguageSpawn: () => {
            spawned = true;
            throw new Error("spawn must remain unreachable");
          },
        },
      );

      expect(result.status).toBe(422);
      expect(spawned).toBe(false);
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rechecks live trust immediately before pool acquisition and closes the snapshot race", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-trust-race-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-trust-race-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      await managedLspControl.mutate({
        action: "activate",
        actorClass: "localHuman",
        expectedRevision: 0,
        idempotencyKey: "activate-before-trust-race",
        language: "python",
        root,
      });
      const spawn = vi.fn((): never => {
        throw new Error("spawn must remain unreachable");
      });
      const restrictedDeps = {
        ...deps(buildRedactor({}), { PATH: bin }),
        managedLspControl,
        workspaceScriptTrust: { trustLevelForRoot: () => "restricted" as const },
      } as unknown as UiHandlerDeps;

      const result = await handleEditorLanguage(
        postContext({
          operation: "diagnostics",
          root,
          document: { path: "src/a.py", languageId: "python", text: "value = 1\n" },
        }),
        restrictedDeps,
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          hostLanguageSpawn: spawn,
        },
      );

      expect(result.status).toBe(422);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // #3347 owner P1: the route awaits the managed-LSP control read before it may spawn or reuse a
  // LONG-LIVED language server. Admission proved authority before that await; this proves the
  // re-proof after it is load-bearing on its own — admission itself still succeeds here, only the
  // follow-up resolver denies (the same isolation managedLspRoutes.test.ts uses).
  it("fails closed when managed-root authority is revoked during the managed control read", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-revoked-bin-")));
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-route-revoked-state-")));
    try {
      const pyright = join(bin, "pyright-langserver");
      await writeFile(pyright, "#!/bin/sh\n", "utf8");
      await chmod(pyright, 0o755);
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      await managedLspControl.mutate({
        action: "activate",
        actorClass: "localHuman",
        expectedRevision: 0,
        idempotencyKey: "activate-before-revocation",
        language: "python",
        root,
      });
      const spawn = vi.fn((): never => {
        throw new Error("spawn must remain unreachable");
      });
      let granted = true;
      const revokableDeps = {
        ...deps(buildRedactor({}), { PATH: bin }),
        managedLspControl: {
          ...managedLspControl,
          read: (requestedRoot: string): Promise<ManagedLspControlSnapshot> => {
            // The revocation lands DURING the control read: exactly the await between admission
            // and the pooled spawn that the finding names.
            granted = false;
            return managedLspControl.read(requestedRoot);
          },
        },
        workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccessOutcome =>
          granted ? grantedOrdinaryAccess(requestedRoot) : { decision: "denied" },
      } as unknown as UiHandlerDeps;

      const result = await handleEditorLanguage(
        postContext({
          operation: "diagnostics",
          root,
          document: { path: "src/a.py", languageId: "python", text: "value = 1\n" },
        }),
        revokableDeps,
        {
          hostLanguageCommandRules: [{ executable: "pyright-langserver" }],
          hostLanguageSpawn: spawn,
        },
      );

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "DENIED" } });
      // A 403 alone would still pass with the process already started. No language server may be
      // spawned for a root whose authority no longer re-proves.
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("returns diagnostics for an overlay with a type error", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x: number = 'no';\n" },
      }),
      deps(),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "diagnostics" });
    const body = result.body as { result: { diagnostics: unknown[] } };
    expect(body.result.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns completion items", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "completion",
        root,
        document: {
          path: "src/a.ts",
          languageId: "typescript",
          text: "const value = { alpha: 1 };\nvalue.\n",
        },
        position: { line: 1, character: 6 },
      }),
      deps(),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    const body = result.body as { result: { items: { label: string }[] } };
    expect(body.result.items.map((item) => item.label)).toContain("alpha");
  });

  it("returns formatting edits for a poorly spaced overlay", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "formatting",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
        options: { tabSize: 2, insertSpaces: true },
      }),
      deps(),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "formatting" });
    const body = result.body as { result: { edits: { newText: string }[] } };
    expect(body.result.edits.length).toBeGreaterThan(0);
  });

  it("does not redact formatting edits that are applied back to the buffer", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "formatting",
        root,
        document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
        options: { tabSize: 2, insertSpaces: true },
      }),
      deps(redactEveryString),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    const body = result.body as { operation: string; result: { edits: { newText: string }[] } };
    expect(body.operation).toBe("formatting");
    expect(body.result.edits.length).toBeGreaterThan(0);
    expect(body.result.edits.map((edit) => edit.newText)).not.toContain("[REDACTED]");
  });

  it("serves definition, references, rename, code actions, and signature help for TypeScript", async () => {
    const decl = "export const sharedValue = 1;\n";
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    const overloads =
      "export function choose(value: string): string;\n" +
      "export function choose(value: number): number;\n" +
      "export function choose(value: string | number): string | number { return value; }\n" +
      "export const result = choose(1);\n";
    await writeProject({ "src/decl.ts": decl, "src/main.ts": main, "src/overloads.ts": overloads });

    const definition = await postLanguage({
      operation: "definition",
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      position: positionOf(main, "sharedValue", main.indexOf("use")),
    });
    const references = await postLanguage({
      operation: "references",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
    });
    const renamePrepare = await postLanguage({
      operation: "renamePrepare",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
    });
    const renameApply = await postLanguage({
      operation: "renameApply",
      root,
      document: { path: "src/decl.ts", languageId: "typescript", text: decl },
      position: positionOf(decl, "sharedValue"),
      newName: "renamedValue",
    });
    const signatureHelp = await postLanguage({
      operation: "signatureHelp",
      root,
      document: { path: "src/overloads.ts", languageId: "typescript", text: overloads },
      position: positionOf(overloads, "1", overloads.indexOf("choose(1")),
    });

    expect(definition).toMatchObject({ status: 200, body: { operation: "definition" } });
    expect(references).toMatchObject({ status: 200, body: { operation: "references" } });
    expect(renamePrepare).toMatchObject({ status: 200, body: { operation: "renamePrepare" } });
    expect(renameApply).toMatchObject({ status: 200, body: { operation: "renameApply" } });
    expect(signatureHelp).toMatchObject({ status: 200, body: { operation: "signatureHelp" } });
    expectLanguageResultShape(definition.body, "definition");
    expectLanguageResultShape(references.body, "references");
    expectLanguageResultShape(renamePrepare.body, "renamePrepare");
    expectLanguageResultShape(renameApply.body, "renameApply");
    expectLanguageResultShape(signatureHelp.body, "signatureHelp");
  });

  it("serves code actions for a TypeScript diagnostic", async () => {
    const main = "export const result = helperValue;\n";
    await writeProject({
      "src/helper.ts": "export const helperValue = 1;\n",
      "src/main.ts": main,
    });

    const result = await postLanguage({
      operation: "codeActions",
      root,
      document: { path: "src/main.ts", languageId: "typescript", text: main },
      range: rangeOf(main, "helperValue"),
      diagnostics: [
        {
          range: rangeOf(main, "helperValue"),
          severity: "error",
          message: "Cannot find name 'helperValue'.",
          source: "typescript",
          code: "2304",
        },
      ],
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "codeActions" });
    const body = result.body as { result: { actions: { edits: unknown[] | null }[] } };
    expect(body.result.actions.some((action) => (action.edits?.length ?? 0) > 0)).toBe(true);
  });

  it("redacts code-action display labels without mutating edit text", async () => {
    const main = "export const result = helperValue;\n";
    await writeProject({
      "src/helper.ts": "export const helperValue = 1;\n",
      "src/main.ts": main,
    });

    const result = await postLanguage(
      {
        operation: "codeActions",
        root,
        document: { path: "src/main.ts", languageId: "typescript", text: main },
        range: rangeOf(main, "helperValue"),
        diagnostics: [
          {
            range: rangeOf(main, "helperValue"),
            severity: "error",
            message: "Cannot find name 'helperValue'.",
            source: "typescript",
            code: "2304",
          },
        ],
      },
      redactEveryString,
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      operation: string;
      result: { actions: { title: string; edits: { newText: string }[] | null }[] };
    };
    const action = body.result.actions.find((entry) => (entry.edits?.length ?? 0) > 0);
    expect(body.operation).toBe("codeActions");
    expect(action?.title).toBe("[REDACTED]");
    expect(action?.edits?.map((edit) => edit.newText)).not.toContain("[REDACTED]");
  });

  it("fails closed when TypeScript project discovery exceeds workspace caps", async () => {
    const main = "export const value = 1;\n";
    const files: Record<string, string> = { "src/main.ts": main };
    for (let index = 0; index < 6; index += 1) {
      files[`src/many-${String(index)}.ts`] = "export const value = 1;\n";
    }
    await writeProject(files);

    const result = await postLanguage(
      {
        operation: "diagnostics",
        root,
        document: { path: "src/main.ts", languageId: "typescript", text: main },
      },
      buildRedactor({}),
      {
        ...stableLanguageOptions,
        limits: { ...DEFAULT_LANGUAGE_SERVICE_LIMITS, maxWorkspaceReadFiles: 2 },
      },
    );

    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ error: { code: "DOCUMENT_TOO_LARGE" } });
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("rejects unadvertised language and operation pairs without echoing content", async () => {
    const result = await postLanguage({
      operation: "renamePrepare",
      root,
      document: { path: "src/a.json", languageId: "json", text: '{"secret":"value"}\n' },
      position: { line: 0, character: 2 },
    });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_OPERATION" } });
    expect(JSON.stringify(result.body)).not.toContain("secret");
  });

  it.each([
    ["definition", true],
    ["references", true],
    ["renamePrepare", true],
    ["renameApply", false],
    ["codeActions", false],
    ["signatureHelp", true],
  ] as const)("routes redaction for %s", async (operation, shouldRedact) => {
    const decl = "export const sharedValue = 1;\n";
    const main = "import { sharedValue } from './decl.js';\nexport const use = sharedValue;\n";
    await writeProject({ "src/decl.ts": decl, "src/main.ts": main });
    const request = routeRequestFor(operation, decl, main);

    const result = await postLanguage(request, redactEveryString);

    expect(result.status).toBe(200);
    const body = result.body as { operation?: string };
    expect(body.operation).toBe(shouldRedact ? "[REDACTED]" : operation);
  });

  it("cancels analysis when the response closes before finishing", async () => {
    const result = await handleEditorLanguage(
      postContextWithResponseClose(
        {
          operation: "diagnostics",
          root,
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
        },
        false,
      ),
      deps(),
      stableLanguageOptions,
    );
    expect(result.status).toBe(499);
    expect(result.body).toMatchObject({ error: { code: "CANCELLED" } });
  });

  it("does not cancel analysis for a response close after completion", async () => {
    const result = await handleEditorLanguage(
      postContextWithResponseClose(
        {
          operation: "diagnostics",
          root,
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
        },
        true,
      ),
      deps(),
      stableLanguageOptions,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ operation: "diagnostics" });
  });

  it("rejects a malformed request with 400 INVALID_REQUEST", async () => {
    const result = await handleEditorLanguage(postContext({ operation: "rename" }), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a body that is not valid JSON with 400 BAD_REQUEST", async () => {
    const result = await handleEditorLanguage(rawPostContext("{ not json"), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects an unsupported language with 422", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path: "src/a.py", languageId: "python", text: "x = 1" },
      }),
      deps(),
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_LANGUAGE" } });
  });

  it.each([
    {
      title: "denies an overlay path that escapes the workspace root",
      path: "../escape.ts",
    },
    { title: "denies an absolute overlay path", path: "/etc/passwd" },
    {
      title: "denies an overlay path with a deny-listed segment inside the root",
      path: ".git/config.ts",
    },
  ])("$title", async ({ path }) => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root,
        document: { path, languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "DENIED" } });
  });

  it("rejects an empty root before resolving", async () => {
    const result = await handleEditorLanguage(
      postContext({
        operation: "diagnostics",
        root: "",
        document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
      }),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});

// #3347 owner P1: `activationStillAuthorized` is the callback the provider pool invokes immediately
// before it may acquire or REUSE a warm, long-lived language server. It previously answered only
// "is this workspace still script-trusted", so an archived or identity-replaced worktree kept its
// server. These prove the recheck now carries the workspace-root proof itself — the route call
// sites cannot open the window between this callback and the pool's acquisition, so the callback is
// exercised directly (the same reason managedActivationAuthorization is exported).
describe("managedActivationRecheck — the pool-facing authority recheck", () => {
  function recheckFor(
    granted: () => boolean,
    trustLevel: () => "trusted" | "restricted",
  ): () => boolean {
    const recheckDeps = {
      ...deps(),
      workspaceScriptTrust: { trustLevelForRoot: trustLevel },
      workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccessOutcome =>
        granted() ? grantedOrdinaryAccess(requestedRoot) : { decision: "denied" },
    } as unknown as UiHandlerDeps;
    const admitted: ResolvedProjectRoot = {
      root,
      realRoot: root,
      access: { kind: "ordinary", canonicalRoot: root, fs: nodeWorkspaceFs },
    };
    return managedActivationRecheck(recheckDeps, root, {
      // The production seam, not a hand-written stand-in: this is the closure the routes pass.
      reproveRootAccess: requestRootAccessResolver(postContext({}), recheckDeps, admitted),
    });
  }

  it("permits acquisition while the admitted root still re-proves and stays trusted", () => {
    expect(
      recheckFor(
        () => true,
        () => "trusted",
      )(),
    ).toBe(true);
  });

  it("refuses acquisition once workspace-root authority is revoked, with trust unchanged", () => {
    let granted = true;
    const recheck = recheckFor(
      () => granted,
      () => "trusted",
    );
    expect(recheck()).toBe(true);
    granted = false;
    expect(recheck()).toBe(false);
  });

  it("still refuses acquisition when script trust drops while the root re-proves", () => {
    expect(
      recheckFor(
        () => true,
        () => "restricted",
      )(),
    ).toBe(false);
  });
});

describe("managedActivationAuthorization", () => {
  it("withholds desired configuration until an explicit restart succeeds", async () => {
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-restart-gate-state-")));
    try {
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      const initial = await managedLspControl.read(root);
      const configured = await managedLspControl.mutate({
        action: "configure",
        actorClass: "localHuman",
        expectedRevision: 0,
        expectedEtag: initial.etag,
        idempotencyKey: "configure-before-restart",
        language: "shell",
        root,
        configuration: shellConfiguration(0, initial.etag),
      });
      if (configured.kind !== "ok") throw new Error("configuration setup failed");
      const controlledDeps = { ...deps(), managedLspControl };

      const pending = await managedActivationAuthorization(controlledDeps, root, "shell");

      expect(pending).toEqual({ authorized: false });

      const restarted = await managedLspControl.mutate({
        action: "restart",
        actorClass: "localHuman",
        expectedRevision: 1,
        expectedEtag: configured.etag,
        idempotencyKey: "restart-before-serve",
        language: "shell",
        root,
      });
      expect(restarted.kind).toBe("ok");

      const ready = await managedActivationAuthorization(controlledDeps, root, "shell");
      expect(ready).toMatchObject({
        authorized: true,
        configuration: { revision: 2, restartRequired: false },
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("evaluates authorization against the given languageId, not a fixed language", async () => {
    const stateDir = await realpath(
      await mkdtemp(join(tmpdir(), "keiko-managed-authorization-state-")),
    );
    try {
      const managedLspControl = createManagedLspControlService({
        store: createManagedLspActivationStore({ stateDir }),
        processEnv: {},
        provisioning: () => true,
        disposePoolEntry: () => Promise.resolve(),
        workspaceTrust: () => "trusted",
        runtimeApproved: () => true,
        configurationSafe: () => true,
        projectEvidence: () => "projected",
        mutex: createWorkspaceMutexRegistry(),
      });
      await managedLspControl.mutate({
        action: "activate",
        actorClass: "localHuman",
        expectedRevision: 0,
        idempotencyKey: "activate-python-authorization",
        language: "python",
        root,
      });
      const controlledDeps = { ...deps(), managedLspControl };

      // Python is activated: the same call site logic used by handleEditorLanguageSemanticTokens
      // and runEditorLanguageOperation must authorize it when asked about "python".
      const python = await managedActivationAuthorization(controlledDeps, root, "python");
      expect(python?.authorized).toBe(true);

      // Rust is NOT activated: a call site that hardcodes "rust" instead of forwarding the
      // request's own document.languageId would incorrectly report this workspace as authorized
      // for Rust too. It must not.
      const rust = await managedActivationAuthorization(controlledDeps, root, "rust");
      expect(rust?.authorized).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
