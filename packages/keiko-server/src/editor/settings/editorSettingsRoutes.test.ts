import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import {
  createEditorSettingsControlService,
  type EditorSettingsControlService,
} from "./editorSettingsControl.js";
import { createEditorSettingsEventBus } from "./editorSettingsEvents.js";
import { createEditorSettingsStore } from "./editorSettingsStore.js";

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let stateDir: string;
let port: number;

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
    editorSettingsControl: createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir }),
      mutex: createWorkspaceMutexRegistry(),
    }),
    editorSettingsEvents: createEditorSettingsEventBus(),
  };
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-settings-static-")));
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-settings-root-")));
  stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-settings-state-")));
  const built = await buildServer(baseDeps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await Promise.all(
    [staticRoot, workspaceRoot, stateDir].map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function snapshot(root = workspaceRoot): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings?root=${encodeURIComponent(root)}`);
}

async function mutation(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function setBody(expectedRevision = 0): Record<string, unknown> {
  return {
    schemaVersion: "1",
    root: workspaceRoot,
    scope: "workspace",
    action: "set",
    expectedRevision,
    values: { fontSize: 18 },
  };
}

async function mutationWithHost(host: string, etag: string): Promise<number> {
  const body = JSON.stringify(setBody());
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: UI_HOST,
        port,
        path: "/api/editor/settings",
        method: "PATCH",
        headers: {
          Host: host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Keiko-CSRF": "1",
          "If-Match": etag,
          "Idempotency-Key": "foreign-host",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function readUntil(response: Response, needle: string): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("missing SSE response body");
  const decoder = new TextDecoder();
  let collected = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (collected.includes(needle)) return collected;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 50);
      }),
    ]);
    if (chunk === null) continue;
    if (chunk.done) return collected;
    collected += decoder.decode(chunk.value, { stream: true });
  }
  return collected;
}

describe("editor settings control routes", () => {
  it("returns a no-store effective snapshot with source provenance", async () => {
    const response = await snapshot();
    const body = (await response.json()) as {
      readonly storeState: string;
      readonly settings: readonly {
        readonly id: string;
        readonly value: unknown;
        readonly source: string;
      }[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toMatch(/^"edm7-0-0-/u);
    expect(body.storeState).toBe("absent");
    expect(body.settings.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 13,
      source: "builtInDefault",
    });
  });

  it("accepts a revision-guarded workspace setting mutation and resets it", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";
    const changed = await mutation(setBody(), {
      "If-Match": etag,
      "Idempotency-Key": "workspace-font",
    });
    const changedBody = (await changed.json()) as { readonly etag: string };
    const reset = await mutation(
      {
        schemaVersion: "1",
        root: workspaceRoot,
        scope: "workspace",
        action: "reset",
        expectedRevision: 1,
        settingIds: ["fontSize"],
      },
      { "If-Match": changedBody.etag, "Idempotency-Key": "reset-workspace-font" },
    );

    expect(changed.status).toBe(200);
    expect(changedBody.etag).toMatch(/^"edm7-0-1-/u);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ kind: "ok", changed: true });
  });

  it("streams a content-free settings event after an accepted mutation", async () => {
    const controller = new AbortController();
    const events = await fetch(
      `${baseUrl()}/api/editor/settings/events?root=${encodeURIComponent(workspaceRoot)}`,
      { signal: controller.signal },
    );
    const initial = await snapshot();
    const changed = await mutation(setBody(), {
      "If-Match": initial.headers.get("etag") ?? "",
      "Idempotency-Key": "workspace-font-event",
    });
    const stream = await readUntil(events, "editor-settings:changed");
    controller.abort();

    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(changed.status).toBe(200);
    expect(stream).toContain("event: editor-settings:changed");
    expect(stream).toContain('"settingIds":["fontSize"]');
    expect(stream).not.toContain(workspaceRoot);
  });

  it("returns 409 for stale revisions and reused idempotency keys", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";
    const first = await mutation(setBody(), {
      "If-Match": etag,
      "Idempotency-Key": "workspace-font-once",
    });
    const stale = await mutation(setBody(), {
      "If-Match": etag,
      "Idempotency-Key": "workspace-font-stale",
    });
    const reused = await mutation(
      { ...setBody(), values: { fontSize: 19 } },
      {
        "If-Match": etag,
        "Idempotency-Key": "workspace-font-once",
      },
    );

    expect(first.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_REVISION" } });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("rejects a workspace mutation guarded by an etag from a different root", async () => {
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-editor-settings-other-")));
    try {
      const otherSnapshot = await snapshot(otherRoot);
      const response = await mutation(setBody(), {
        "If-Match": otherSnapshot.headers.get("etag") ?? "",
        "Idempotency-Key": "wrong-root-token",
      });
      const unchanged = await snapshot();

      expect(otherSnapshot.status).toBe(200);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(unchanged.headers.get("etag")).toMatch(/^"edm7-0-0-/u);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("inherits the central CSRF and same-origin gates for writes", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";
    const missingCsrf = await fetch(`${baseUrl()}/api/editor/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": etag,
        "Idempotency-Key": "no-csrf",
      },
      body: JSON.stringify(setBody()),
    });

    expect(missingCsrf.status).toBe(403);
    await expect(mutationWithHost("evil.example", etag)).resolves.toBe(403);
  });

  it("rejects invalid workspace-scoped settings before persistence", async () => {
    const initial = await snapshot();
    const response = await mutation(
      {
        schemaVersion: "1",
        root: workspaceRoot,
        scope: "workspace",
        action: "set",
        expectedRevision: 0,
        values: { minimap: true },
      },
      { "If-Match": initial.headers.get("etag") ?? "", "Idempotency-Key": "bad-minimap" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });
});

const USER_ETAG_REVISION_ZERO = '"edm7-0-0-user"';

function userSetBody(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    scope: "user",
    action: "set",
    expectedRevision: 0,
    values: { fontSize: 16 },
  };
}

async function rebuildWithDeps(overrides: Partial<UiHandlerDeps>): Promise<void> {
  await closeServer();
  const built = await buildServer({ ...baseDeps(), ...overrides });
  server = built.server;
  port = built.port;
}

async function rebuildWithMutateOverride(
  mutateStub: EditorSettingsControlService["mutate"],
): Promise<void> {
  await closeServer();
  const deps = baseDeps();
  const original = deps.editorSettingsControl;
  if (original === undefined) throw new Error("expected editor settings control");
  const wrapped: EditorSettingsControlService = {
    stateDir: original.stateDir,
    read: original.read,
    mutate: mutateStub,
  };
  const built = await buildServer({ ...deps, editorSettingsControl: wrapped });
  server = built.server;
  port = built.port;
}

describe("editor settings routes — degraded control plane", () => {
  it("returns 503 on GET when the editor settings control is unavailable", async () => {
    await rebuildWithDeps({ editorSettingsControl: undefined });
    const response = await snapshot();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "STATE_UNAVAILABLE" },
    });
  });

  it("returns 503 on PATCH when the editor settings control is unavailable", async () => {
    await rebuildWithDeps({ editorSettingsControl: undefined });
    const response = await mutation(setBody(), {
      "If-Match": USER_ETAG_REVISION_ZERO,
      "Idempotency-Key": "no-control-patch",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "STATE_UNAVAILABLE" },
    });
  });

  it("returns 503 on events when the settings event bus is unavailable", async () => {
    await rebuildWithDeps({ editorSettingsEvents: undefined });
    const response = await fetch(
      `${baseUrl()}/api/editor/settings/events?root=${encodeURIComponent(workspaceRoot)}`,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "STATE_UNAVAILABLE" },
    });
  });
});

describe("editor settings routes — malformed patch requests", () => {
  it.each([
    { name: "schemaVersion mismatch", override: { schemaVersion: "0" } },
    { name: "invalid scope value", override: { scope: "system" } },
    { name: "invalid action value", override: { action: "delete" } },
    { name: "negative expectedRevision", override: { expectedRevision: -1 } },
    { name: "non-integer expectedRevision", override: { expectedRevision: 1.5 } },
    { name: "workspace root not a string", override: { root: 42 } },
    { name: "empty root string", override: { root: "" } },
    { name: "reset action with values instead of settingIds", override: { action: "reset" } },
    { name: "unknown top-level key", override: { extraneous: true } },
  ])("returns 400 INVALID_REQUEST for $name", async ({ override }) => {
    const initial = await snapshot();
    const response = await mutation(
      { ...setBody(), ...override },
      {
        "If-Match": initial.headers.get("etag") ?? "",
        "Idempotency-Key": `malformed-${String(Math.random())}`,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("returns 400 INVALID_REQUEST when the Idempotency-Key header is missing", async () => {
    const initial = await snapshot();
    const response = await fetch(`${baseUrl()}/api/editor/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
        "If-Match": initial.headers.get("etag") ?? "",
      },
      body: JSON.stringify(setBody()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });
});

describe("editor settings routes — control mutation failure results", () => {
  it("returns 400 with the reason code when the control reports an invalid mutation", async () => {
    await rebuildWithMutateOverride(() =>
      Promise.resolve({ kind: "invalid", code: "VALUE_OUT_OF_BOUNDS" }),
    );
    const response = await mutation(userSetBody(), {
      "If-Match": USER_ETAG_REVISION_ZERO,
      "Idempotency-Key": "stub-invalid",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALUE_OUT_OF_BOUNDS" },
    });
  });

  it("returns 503 STATE_UNAVAILABLE when the control reports the store is unavailable", async () => {
    await rebuildWithMutateOverride(() =>
      Promise.resolve({ kind: "unavailable", code: "STATE_UNAVAILABLE" }),
    );
    const response = await mutation(userSetBody(), {
      "If-Match": USER_ETAG_REVISION_ZERO,
      "Idempotency-Key": "stub-unavailable",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "STATE_UNAVAILABLE" },
    });
  });
});
