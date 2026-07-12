import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import {
  createWorkspaceWatchService,
  type WorkspaceNativeWatchHandle,
  type WorkspaceWatchAdapter,
  type WorkspaceWatchAdapterArgs,
  type WorkspaceWatchRawEvent,
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
    workspaceWatchService: createWorkspaceWatchService({
      adapter,
      coalesceMs: 0,
      idleTearDownMs: 0,
      replayCapacity: 1,
    }),
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
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (collected.includes(needle)) return collected;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null);
          }, 25);
        }),
      ]);
      if (chunk === null) continue;
      if (chunk.done) return collected;
      collected += decoder.decode(chunk.value, { stream: true });
    }
    return collected;
  } finally {
    reader.releaseLock();
  }
}

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
    const initial = await readUntil(stream, "editor-watch:snapshot");
    expect(initial).not.toContain(workspaceRoot);

    await writeFile(join(workspaceRoot, "route-created.txt"), "RAW_BODY_SHOULD_NOT_LEAK", "utf8");
    adapter.emit({ eventType: "rename", filename: "route-created.txt" });
    const created = await readUntil(stream, "editor-watch:created");
    expect(created).toContain('"relativePath":"route-created.txt"');
    expect(created).not.toContain("RAW_BODY_SHOULD_NOT_LEAK");

    await writeFile(join(workspaceRoot, "route-second.txt"), "second", "utf8");
    adapter.emit({ eventType: "rename", filename: "route-second.txt" });
    await readUntil(stream, "route-second.txt");
    const stale = await fetch(
      `${baseUrl()}/api/editor/workspace-watch/events?root=${encodeURIComponent(
        workspaceRoot,
      )}&lastEventId=0`,
    );
    const staleFrames = await readUntil(stale, "editor-watch:snapshot-required");
    expect(staleFrames).toContain('"requiresSnapshot":true');
    await stale.body?.cancel();
    controller.abort();
  });
});
