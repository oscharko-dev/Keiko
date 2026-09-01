import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "../../observability/index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import {
  createOrdinaryWorkspaceRootAccess,
  type WorkspaceRootAccess,
} from "../../task-workspace/workspace-root-access.js";
import {
  createWorkspaceWatchService,
  type WorkspaceNativeWatchHandle,
  type WorkspaceWatchAdapter,
  type WorkspaceWatchAdapterArgs,
  type WorkspaceWatchRawEvent,
  type WorkspaceWatchService,
} from "./workspaceWatchService.js";

interface FakeHandle extends WorkspaceNativeWatchHandle {
  readonly close: Mock<() => void>;
}

class FakeAdapter implements WorkspaceWatchAdapter {
  public readonly calls: WorkspaceWatchAdapterArgs[] = [];
  public readonly handles: FakeHandle[] = [];

  public watch(args: WorkspaceWatchAdapterArgs): WorkspaceNativeWatchHandle {
    this.calls.push(args);
    const handle: FakeHandle = { recursive: true, close: vi.fn<() => void>() };
    this.handles.push(handle);
    return handle;
  }

  public emit(event: WorkspaceWatchRawEvent): void {
    this.calls.at(-1)?.onEvent(event);
  }
}

let server: Server;
let staticRoot = "";
let workspaceRoot = "";
let port = 0;
let adapter: FakeAdapter;
let watchService: WorkspaceWatchService;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) =>
    srv.close(() => {
      resolve();
    }),
  );
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function baseDeps(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  store.createProject(workspaceRoot);
  adapter = new FakeAdapter();
  watchService = createWorkspaceWatchService({
    adapter,
    coalesceMs: 0,
    idleTearDownMs: 0,
    replayCapacity: 1,
  });
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    workspaceWatchService: watchService,
  };
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-watch-static-")));
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-watch-route-root-")));
  const built = await buildServer(baseDeps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function readUntil(response: Response, needle: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("missing SSE response body");
  const decoder = new TextDecoder();
  let collected = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`missing SSE frame before deadline: ${needle}`));
      // Generous per-frame budget: under coverage instrumentation the SSE round-trip is much
      // slower than an uninstrumented run, and a too-tight deadline false-REDs the coverage job.
    }, 15_000);
  });
  try {
    return await Promise.race([
      (async (): Promise<string> => {
        while (!collected.includes(needle)) {
          const chunk = await reader.read();
          if (chunk.done) return collected;
          collected += decoder.decode(chunk.value, { stream: true });
        }
        return collected;
      })(),
      deadline,
    ]);
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function waitForBaselineSeed(): Promise<void> {
  adapter.emit({ eventType: "change", filename: "__baseline_probe__.missing" });
  await vi.waitFor(
    () => {
      expect(watchService.snapshot(workspaceRoot).queueDepth).toBe(0);
    },
    { interval: 5, timeout: 15_000 },
  );
}

// Standalone fixture for the authority-revocation test below: it needs its own adapter/service
// (kept off the module-level `adapter`/`watchService` the other tests share via `baseDeps()`) and
// a `workspaceRootAccessResolver` whose answer can flip mid-test, so `reproveRoot` can be made to
// fail on demand from a subscriber that already reached a live stream.
function buildRevocableDeps(root: string): {
  deps: UiHandlerDeps;
  revoke: () => void;
  adapter: FakeAdapter;
} {
  const store = createInMemoryUiStore();
  store.createProject(root);
  const revocableAdapter = new FakeAdapter();
  const service = createWorkspaceWatchService({
    adapter: revocableAdapter,
    coalesceMs: 0,
    idleTearDownMs: 0,
    replayCapacity: 1,
  });
  let revoked = false;
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    workspaceWatchService: service,
    workspaceRootAccessResolver: (requestedRoot: string): WorkspaceRootAccess | undefined =>
      revoked ? undefined : createOrdinaryWorkspaceRootAccess(requestedRoot),
  };
  return {
    deps,
    adapter: revocableAdapter,
    revoke: (): void => {
      revoked = true;
    },
  };
}

describe("workspace watch authority revocation logging (#3347)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("records a catalogued, correlated op before closing an SSE stream whose authority was revoked", async () => {
    const revocableRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-watch-revoke-root-")));
    const sink: BufferedServerLogSink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const { deps, adapter: revocableAdapter, revoke } = buildRevocableDeps(revocableRoot);
    const built = await buildServer(deps);
    try {
      const controller = new AbortController();
      const stream = await fetch(
        `http://${UI_HOST}:${String(built.port)}/api/editor/workspace-watch/events?root=${encodeURIComponent(
          revocableRoot,
        )}`,
        { signal: controller.signal },
      );
      const correlationId = stream.headers.get("x-keiko-correlation-id");
      expect(correlationId).not.toBeNull();
      try {
        await readUntil(stream, "event: ready");
        revoke();
        // Any subsequent watcher event forces the live subscriber's per-event reprove check
        // (workspaceWatchService.ts's `emit()`), which now fails and fires `onAuthorityRevoked`.
        revocableAdapter.emit({ eventType: "change", filename: "revoked-trigger.txt" });
        await vi.waitFor(
          () => {
            expect(
              sink.events.some((event) => event.op === "editor.workspace-watch.authority-revoked"),
            ).toBe(true);
          },
          { interval: 5, timeout: 15_000 },
        );
      } finally {
        controller.abort();
        await stream.body?.cancel().catch(() => undefined);
      }
      const revokedEvent = sink.events.find(
        (event) => event.op === "editor.workspace-watch.authority-revoked",
      );
      expect(revokedEvent).toBeDefined();
      expect(revokedEvent?.category).toBe("security");
      expect(revokedEvent?.correlationId).toBe(correlationId);
      expect(revokedEvent?.errorKind).toBe("WATCH_AUTHORITY_REVOKED");
      expect(JSON.stringify(revokedEvent)).not.toContain(revocableRoot);
    } finally {
      await closeServer(built.server);
      await rm(revocableRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("workspace watch routes", () => {
  it("returns content-free health snapshots without absolute workspace roots", async () => {
    const response = await fetch(
      `${baseUrl()}/api/editor/workspace-watch/snapshot?root=${encodeURIComponent(workspaceRoot)}`,
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("rootToken");
    expect(text).not.toContain(workspaceRoot);
  });

  it("streams snapshot, replayable deltas, and explicit snapshot-required gaps", async () => {
    const controller = new AbortController();
    const stream = await fetch(
      `${baseUrl()}/api/editor/workspace-watch/events?root=${encodeURIComponent(workspaceRoot)}`,
      { signal: controller.signal },
    );
    let stale: Response | undefined;
    try {
      // `ready` is emitted only after the server has registered the watch subscription. Waiting for
      // it prevents the fixture event below from racing an unregistered SSE listener under coverage.
      const initial = await readUntil(stream, "event: ready");
      expect(initial).toContain("editor-watch:snapshot");
      expect(initial).not.toContain(workspaceRoot);
      await waitForBaselineSeed();

      await writeFile(join(workspaceRoot, "route-created.txt"), "RAW_BODY_SHOULD_NOT_LEAK", "utf8");
      adapter.emit({ eventType: "rename", filename: "route-created.txt" });
      const created = await readUntil(stream, "editor-watch:created");
      expect(created).toContain('"relativePath":"route-created.txt"');
      expect(created).not.toContain("RAW_BODY_SHOULD_NOT_LEAK");

      await writeFile(join(workspaceRoot, "route-second.txt"), "second", "utf8");
      adapter.emit({ eventType: "rename", filename: "route-second.txt" });
      await readUntil(stream, "route-second.txt");
      stale = await fetch(
        `${baseUrl()}/api/editor/workspace-watch/events?root=${encodeURIComponent(
          workspaceRoot,
        )}&lastEventId=0`,
      );
      const staleFrames = await readUntil(stale, "editor-watch:snapshot-required");
      expect(staleFrames).toContain('"requiresSnapshot":true');
    } finally {
      await stale?.body?.cancel();
      controller.abort();
      await stream.body?.cancel().catch(() => undefined);
    }
    // Four sequential SSE round-trips; the default 15s test budget is too tight for all of them
    // once coverage instrumentation slows each frame down, so give the whole case explicit room.
  }, 60_000);
});
