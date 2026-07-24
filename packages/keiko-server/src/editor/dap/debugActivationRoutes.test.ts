import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { createEditorSettingsControlService } from "../settings/editorSettingsControl.js";
import {
  createEditorSettingsStore,
  formatEditorSettingsEtag,
} from "../settings/editorSettingsStore.js";
import { createDebugActivationControlService } from "./debugActivationControl.js";

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let stateDir: string;
let port: number;

async function listen(instance: Server): Promise<number> {
  await new Promise<void>((resolve) => instance.listen(0, UI_HOST, resolve));
  return (instance.address() as AddressInfo).port;
}

async function closeServer(instance: Server = server): Promise<void> {
  await new Promise<void>((resolve) =>
    instance.close(() => {
      resolve();
    }),
  );
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
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

function deps(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  store.createProject(workspaceRoot);
  const debugActivationControl = createDebugActivationControlService({
    mutex: createWorkspaceMutexRegistry(),
    productSupport: () => "supported",
    deploymentPolicy: () => "allowed",
    provisioning: () => "provisioned",
    disposeActiveSession: vi.fn(() => Promise.resolve()),
  });
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    debugActivationControl,
    editorSettingsControl: createEditorSettingsControlService({
      store: createEditorSettingsStore({ stateDir }),
      mutex: createWorkspaceMutexRegistry(),
      debugActivation: debugActivationControl,
    }),
  };
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-debug-activation-static-")));
  workspaceRoot = await realpath(
    await mkdtemp(join(tmpdir(), "keiko-debug-activation-workspace-")),
  );
  stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-debug-activation-state-")));
  const built = await buildServer(deps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await Promise.all(
    [staticRoot, workspaceRoot, stateDir].map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function settings(): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings?root=${encodeURIComponent(workspaceRoot)}`);
}

async function mutate(
  action: "activate" | "deactivate",
  etag: string,
  body: Record<string, unknown> = { root: workspaceRoot, expectedRevision: 0 },
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/settings/debug/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "Idempotency-Key": `debug-${action}`,
      "If-Match": etag,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("debug activation routes", () => {
  it("accepts a precondition ETag that carries an active profile revision", async () => {
    // Regression: #2528 added the `-p<n>` profile segment to the settings ETag, but this route
    // kept a private pattern without it. Every debug activation failed with 400 as soon as any
    // editor profile was active, while the settings route accepted the very same token.
    const withProfile = formatEditorSettingsEtag(await realpath(workspaceRoot), {
      userRevision: 0,
      workspaceRevision: 0,
      rootRevision: 0,
      profileRevision: 3,
    });
    expect(withProfile).toContain("-p3-");

    const response = await mutate("activate", withProfile);

    expect(response.status).toBe(200);
  });

  it("activates through the canonical workspace setting and returns the derived summary", async () => {
    const initial = await settings();
    const response = await mutate("activate", initial.headers.get("etag") ?? "");
    const body = (await response.json()) as {
      readonly snapshot: {
        readonly debugging: { readonly state: string };
        readonly settings: readonly { readonly id: string; readonly value: unknown }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.snapshot.debugging.state).toBe("available");
    expect(body.snapshot.settings.find((entry) => entry.id === "debuggingEnabled")?.value).toBe(
      true,
    );
  });

  it("rejects unknown actions, unknown body keys, oversized input, and missing CSRF", async () => {
    const initial = await settings();
    const etag = initial.headers.get("etag") ?? "";

    await expect(
      mutate("activate", etag, { root: workspaceRoot, expectedRevision: 0, action: "restart" }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      mutate("activate", etag, { root: workspaceRoot, expectedRevision: 0, extra: true }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      mutate("activate", etag, { root: "x".repeat(64 * 1024 + 1), expectedRevision: 0 }),
    ).resolves.toMatchObject({ status: 413 });
    await expect(
      mutate("activate", etag, undefined, { "X-Keiko-CSRF": "" }),
    ).resolves.toMatchObject({
      status: 403,
    });
  });

  it("inherits loopback Host and same-origin Origin enforcement", async () => {
    const initial = await settings();
    const etag = initial.headers.get("etag") ?? "";
    await expect(
      mutate("activate", etag, undefined, { Origin: "http://evil.example" }),
    ).resolves.toMatchObject({
      status: 403,
    });

    const body = JSON.stringify({ root: workspaceRoot, expectedRevision: 0 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: UI_HOST,
          port,
          path: "/api/editor/settings/debug/activate",
          method: "POST",
          headers: {
            Host: "evil.example",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "X-Keiko-CSRF": "1",
            "Idempotency-Key": "foreign-host",
            "If-Match": etag,
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

    expect(status).toBe(403);
  });
});
