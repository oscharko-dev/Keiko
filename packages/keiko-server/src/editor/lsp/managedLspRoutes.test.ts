import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagedLspShellConfiguration } from "@oscharko-dev/keiko-contracts";

import { createWorkspaceMutexRegistry } from "../../task-workspace/mutex.js";
import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { createManagedLspActivationStore } from "./managedLspActivationStore.js";
import { createManagedLspControlService } from "./managedLspControl.js";

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let stateDir: string;
let port: number;
const dispose = vi.fn(() => Promise.resolve());

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
  const probe = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps,
  });
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
  const managedLspControl = createManagedLspControlService({
    store: createManagedLspActivationStore({ stateDir }),
    processEnv: {},
    provisioning: () => true,
    disposePoolEntry: dispose,
    runtimeApproved: (_language, runtimeId) => runtimeId.endsWith("-lsp"),
    configurationSafe: () => true,
    projectEvidence: () => "projected",
    mutex: createWorkspaceMutexRegistry(),
    now: () => 1_725_000_000_000,
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
    managedLspControl,
  };
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-managed-lsp-static-")));
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-managed-lsp-workspace-")));
  stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-managed-lsp-state-")));
  dispose.mockClear();
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

async function snapshot(): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/lsp/settings?root=${encodeURIComponent(workspaceRoot)}`);
}

async function mutation(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/lsp/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function activateBody(expectedRevision = 0): Record<string, unknown> {
  return { root: workspaceRoot, language: "python", action: "activate", expectedRevision };
}

function shellConfigureBody(etag: string): Record<string, unknown> {
  const configuration: ManagedLspShellConfiguration = {
    schemaVersion: "1",
    language: "shell",
    revision: 0,
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
      dialect: "posix",
      sourcePolicy: "workspaceOnly",
      shellCheck: {
        mode: "workspace",
        severity: "info",
        excludedCodes: ["SC1090"],
        includePaths: [],
        externalSources: false,
      },
    },
  };
  return {
    root: workspaceRoot,
    language: "shell",
    action: "configure",
    expectedRevision: 0,
    configuration,
  };
}

async function mutationWithHost(host: string): Promise<number> {
  const body = JSON.stringify(activateBody());
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: UI_HOST,
        port,
        path: "/api/editor/lsp/settings",
        method: "PUT",
        headers: {
          Host: host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Keiko-CSRF": "1",
          "If-Match": '"lspcfg-0-aaaaaaaaaaaaaaaa"',
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

describe("managed LSP same-origin control routes", () => {
  it("returns a default-off, no-store snapshot and ETag for all five languages", async () => {
    const response = await snapshot();
    const body = (await response.json()) as {
      readonly storeState: string;
      readonly languages: readonly { readonly state: string }[];
      readonly settings: readonly { readonly workspaceActivation: string }[];
      readonly configurations: readonly unknown[];
      readonly health: readonly unknown[];
      readonly providerMetadata: readonly {
        readonly language: string;
        readonly configurationSource: string;
        readonly runtimeIdentitySource: string;
      }[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toMatch(/^"lspcfg-0-/u);
    expect(body.storeState).toBe("absent");
    expect(body.languages).toHaveLength(5);
    expect(body.languages.every((entry) => entry.state === "disabled")).toBe(true);
    expect(body.settings.every((entry) => entry.workspaceActivation === "unset")).toBe(true);
    expect(body.configurations).toEqual([]);
    expect(body.health).toEqual([]);
    expect(body.providerMetadata).toEqual([
      {
        language: "python",
        configurationSource: "workspaceConfiguration",
        runtimeIdentitySource: "interpreter",
      },
    ]);
  });

  it("surfaces a project-level pyproject.toml as the reported configuration precedence", async () => {
    await writeFile(
      join(workspaceRoot, "pyproject.toml"),
      "[tool.pyright]\ntypeCheckingMode='basic'\n",
    );

    const response = await snapshot();
    const body = (await response.json()) as {
      readonly providerMetadata: readonly {
        readonly language: string;
        readonly configurationSource: string;
      }[];
    };

    expect(body.providerMetadata).toEqual([
      {
        language: "python",
        configurationSource: "pyproject",
        runtimeIdentitySource: "interpreter",
      },
    ]);
  });

  it("accepts a revision-guarded explicit restart after activation", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";
    const activated = await mutation(activateBody(), {
      "If-Match": etag,
      "Idempotency-Key": "activate-before-restart",
    });
    const activatedBody = (await activated.json()) as { readonly etag: string };

    const restarted = await mutation(
      { root: workspaceRoot, language: "python", action: "restart", expectedRevision: 1 },
      { "If-Match": activatedBody.etag, "Idempotency-Key": "explicit-restart" },
    );

    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toMatchObject({ kind: "ok", changed: true, revision: 2 });
    expect(dispose).toHaveBeenLastCalledWith(workspaceRoot, "python");
  });

  it("inherits the central JSON and CSRF gate for writes", async () => {
    const response = await fetch(`${baseUrl()}/api/editor/lsp/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activateBody()),
    });

    expect(response.status).toBe(403);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects a foreign Origin before the route is dispatched", async () => {
    const response = await mutation(activateBody(), {
      Origin: "https://attacker.invalid",
      "If-Match": '"lspcfg-0-aaaaaaaaaaaaaaaa"',
      "Idempotency-Key": "foreign-origin",
    });

    expect(response.status).toBe(403);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback Host before the route is dispatched", async () => {
    const status = await mutationWithHost("attacker.invalid");

    expect(status).toBe(403);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("accepts an activation once, replays it idempotently, and returns no request content", async () => {
    const current = await snapshot();
    const etag = current.headers.get("etag") ?? "";
    const headers = { "If-Match": etag, "Idempotency-Key": "activate-python-route" };

    const accepted = await mutation(activateBody(), headers);
    const replay = await mutation(activateBody(), headers);
    const acceptedText = await accepted.text();

    expect(accepted.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(acceptedText).not.toContain(workspaceRoot);
    expect(acceptedText).not.toContain("activate-python-route");
  });

  it("returns a typed stale-revision conflict without state, evidence, or process side effects", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";
    await mutation(activateBody(), { "If-Match": etag, "Idempotency-Key": "first-route-write" });
    const before = (await (await snapshot()).json()) as { readonly evidenceCount: number };

    const stale = await mutation(
      { ...activateBody(), action: "deactivate" },
      { "If-Match": etag, "Idempotency-Key": "stale-route-write" },
    );
    const after = (await (await snapshot()).json()) as { readonly evidenceCount: number };

    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_REVISION" } });
    expect(after.evidenceCount).toBe(before.evidenceCount);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("configures Shell through the route and surfaces the negotiated dialect and ShellCheck mode", async () => {
    const initial = await snapshot();
    const etag = initial.headers.get("etag") ?? "";

    const configured = await mutation(shellConfigureBody(etag), {
      "If-Match": etag,
      "Idempotency-Key": "configure-shell-route",
    });
    const body = (await (await snapshot()).json()) as {
      readonly configurations: readonly {
        readonly language: string;
        readonly settings: {
          readonly dialect: string;
          readonly shellCheck: { readonly mode: string; readonly severity: string };
        };
      }[];
    };

    expect(configured.status).toBe(200);
    const shellConfiguration = body.configurations.find((entry) => entry.language === "shell");
    expect(shellConfiguration).toMatchObject({
      settings: {
        dialect: "posix",
        shellCheck: { mode: "workspace", severity: "info" },
      },
    });
  });

  it("bounds and strictly validates mutation bodies without reflecting sentinel content", async () => {
    const response = await mutation(
      { ...activateBody(), unknown: `SENTINEL_SECRET_${"x".repeat(70_000)}` },
      {
        "If-Match": '"lspcfg-0-aaaaaaaaaaaaaaaa"',
        "Idempotency-Key": "oversized-body",
      },
    );
    const text = await response.text();

    expect(response.status).toBe(413);
    expect(text).not.toContain("SENTINEL_SECRET");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("fails closed after the selected workspace is deleted", async () => {
    await rm(workspaceRoot, { recursive: true, force: true });

    const response = await snapshot();

    expect(response.status).toBe(400);
    expect(dispose).not.toHaveBeenCalled();
  });
});
