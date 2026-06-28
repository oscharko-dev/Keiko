// Issue #1388 — /api/containers/* route integration tests. A FakeContainerRunnerManager replaces the
// real spawn-backed manager so these tests never run a real container. The createUiServer fixture
// mirrors command-runner-routes.test.ts so the CSRF guard, host-check, and SSE framer run live.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ContainerCapabilityResponse,
  ContainerRunnerEvent,
  ContainerRunResult,
  ContainerTaskCatalog,
} from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { createUiServer, UI_HOST } from "../server.js";
import { ContainerRunnerError } from "./containerRunner-errors.js";
import type {
  ContainerRunInput,
  ContainerRunnerEventEmitter,
  ContainerRunnerManager,
} from "./containerRunner.js";

interface FakeOptions {
  readonly anyAvailable?: boolean;
  readonly result?: Partial<ContainerRunResult>;
  readonly abortReturns?: boolean;
}

const PILOT_ID = "container-pilot:diagnostic";

class FakeContainerRunnerManager implements ContainerRunnerManager {
  public readonly executed: ContainerRunInput[] = [];
  public readonly aborted: string[] = [];
  private readonly subscribers = new Set<ContainerRunnerEventEmitter>();
  private readonly opts: FakeOptions;
  private nextId = 1;

  public constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  private get available(): boolean {
    return this.opts.anyAvailable ?? true;
  }

  public readonly capability = (): Promise<ContainerCapabilityResponse> =>
    Promise.resolve({
      schemaVersion: "1",
      generatedAtMs: 1,
      deadlineMs: 4_000,
      engines: [
        this.available
          ? { engine: "docker", state: "available", version: "24.0.7" }
          : { engine: "docker", state: "missing", unavailableReason: "executable-not-found" },
      ],
      anyAvailable: this.available,
    });

  public readonly listCatalog = (projectId: string): Promise<ContainerTaskCatalog> =>
    Promise.resolve({
      schemaVersion: "1",
      projectId,
      engineAvailable: this.available,
      tasks: this.available
        ? [
            {
              id: PILOT_ID,
              kind: "diagnostic",
              label: "pilot",
              image: "docker.io/library/alpine:3.20",
              args: ["sh", "-c", "echo ok"],
              engine: "docker",
            },
          ]
        : [],
    });

  public readonly execute = (input: ContainerRunInput): Promise<ContainerRunResult> => {
    if (!this.available) {
      return Promise.reject(new ContainerRunnerError("CONTAINER_ENGINE_UNAVAILABLE", "No engine."));
    }
    this.executed.push(input);
    const runId = `run-${String(this.nextId++)}`;
    this.emit({ kind: "run-started", runId, payload: { taskId: input.taskId } });
    return Promise.resolve({
      schemaVersion: "1",
      runId,
      taskId: input.taskId,
      kind: "diagnostic",
      engine: "docker",
      exitCode: 0,
      durationMs: 1,
      truncated: false,
      timedOut: false,
      failureReason: "none",
      stdout: "ok",
      stderr: "",
      ...this.opts.result,
    });
  };

  public readonly abort = (runId: string): boolean => {
    this.aborted.push(runId);
    return this.opts.abortReturns ?? true;
  };

  public readonly subscribe = (listener: ContainerRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly inFlightCount = (): number => 0;

  public emitExternal(event: ContainerRunnerEvent): void {
    this.emit(event);
  }

  private emit(event: ContainerRunnerEvent): void {
    for (const listener of [...this.subscribers]) {
      listener(event);
    }
  }
}

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let port: number;
let deps: UiHandlerDeps;
let containerRunner: FakeContainerRunnerManager;
let store: ReturnType<typeof createInMemoryUiStore>;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
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

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function baseDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store,
    containerRunner,
  };
}

async function rebuild(override: Partial<UiHandlerDeps> = {}): Promise<void> {
  await closeServer();
  deps = { ...baseDeps(), ...override };
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-ctr-routes-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "keiko-ctr-ws-"));
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "fixture");
  containerRunner = new FakeContainerRunnerManager();
  deps = baseDeps();
  const built = await buildServer(deps);
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  store.close();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("GET /api/containers/capability", () => {
  it("returns the probe response for a registered root", async () => {
    const res = await fetch(
      `${baseUrl()}/api/containers/capability?root=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContainerCapabilityResponse;
    expect(body.anyAvailable).toBe(true);
  });

  it("returns 403 WORKSPACE_NOT_REGISTERED for an unregistered root", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/capability?root=/not/registered`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("WORKSPACE_NOT_REGISTERED");
  });

  it("allows a host-level probe with no root (capability is host-level)", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/capability`);
    expect(res.status).toBe(200);
  });

  it("returns 503 when the container runner is not configured", async () => {
    await rebuild({ containerRunner: undefined });
    const res = await fetch(`${baseUrl()}/api/containers/capability`);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/containers/catalog", () => {
  it("lists tasks when an engine is available", async () => {
    const res = await fetch(
      `${baseUrl()}/api/containers/catalog?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContainerTaskCatalog;
    expect(body.tasks.map((task) => task.id)).toContain(PILOT_ID);
  });

  it("returns 503 CONTAINER_ENGINE_UNAVAILABLE when no engine is available", async () => {
    containerRunner = new FakeContainerRunnerManager({ anyAvailable: false });
    await rebuild({ containerRunner });
    const res = await fetch(
      `${baseUrl()}/api/containers/catalog?projectId=${encodeURIComponent(workspaceRoot)}`,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONTAINER_ENGINE_UNAVAILABLE");
  });

  it("requires a projectId query parameter", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/catalog`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/containers/runs", () => {
  it("runs a task and returns the structured result", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: PILOT_ID }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContainerRunResult;
    expect(body.failureReason).toBe("none");
    expect(containerRunner.executed[0]?.taskId).toBe(PILOT_ID);
  });

  it("applies Layer-2 redaction to stdout/stderr", async () => {
    containerRunner = new FakeContainerRunnerManager({ result: { stdout: "tok=SECRET-VALUE" } });
    await rebuild({
      containerRunner,
      redactor: (value: unknown): unknown =>
        typeof value === "string" ? value.replace("SECRET-VALUE", "[REDACTED]") : value,
    });
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: PILOT_ID }),
    });
    const body = (await res.json()) as ContainerRunResult;
    expect(body.stdout).toBe("tok=[REDACTED]");
  });

  it("rejects without the CSRF header", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: workspaceRoot, taskId: PILOT_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid request body with 400", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown task id with 404", async () => {
    containerRunner = new (class extends FakeContainerRunnerManager {
      public override readonly execute = (): Promise<ContainerRunResult> =>
        Promise.reject(new ContainerRunnerError("TASK_NOT_FOUND", "unknown"));
    })();
    await rebuild({ containerRunner });
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an oversized body with 413", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: "x".repeat(20_000) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 503 on an engine-unavailable governance failure", async () => {
    containerRunner = new FakeContainerRunnerManager({ anyAvailable: false });
    await rebuild({ containerRunner });
    const res = await fetch(`${baseUrl()}/api/containers/runs`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ projectId: workspaceRoot, taskId: PILOT_ID }),
    });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/containers/runs/:runId", () => {
  it("cancels a known in-flight run", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/runs/run-1`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(200);
    expect(containerRunner.aborted).toContain("run-1");
  });

  it("returns 404 for an unknown run", async () => {
    containerRunner = new FakeContainerRunnerManager({ abortReturns: false });
    await rebuild({ containerRunner });
    const res = await fetch(`${baseUrl()}/api/containers/runs/run-x`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RUN_NOT_FOUND");
  });
});

describe("GET /api/containers/events", () => {
  it("opens an SSE stream and frames events as container:<kind>, redacted", async () => {
    const res = await fetch(`${baseUrl()}/api/containers/events`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")?.startsWith("text/event-stream")).toBe(true);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    setTimeout(() => {
      containerRunner.emitExternal({
        kind: "run-completed",
        runId: "run-99",
        payload: { note: "SECRET-VALUE" },
      });
    }, 30);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const { value } = (await reader?.read()) ?? { value: undefined };
      if (value !== undefined) chunks.push(decoder.decode(value));
      if (chunks.join("").includes("container:run-completed")) break;
    }
    void reader?.cancel();
    const stream = chunks.join("");
    expect(stream).toContain("event: ready");
    expect(stream).toContain("event: container:run-completed");
    expect(stream).toContain('"runId":"run-99"');
  });
});
