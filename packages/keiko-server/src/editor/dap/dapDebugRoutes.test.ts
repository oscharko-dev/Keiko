import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEBUG_PAYLOAD_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/dap-debug";

import { buildCspHeader } from "../../csp.js";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { SSE_HEADERS } from "../../sse.js";
import { createUiServer, UI_HOST } from "../../server.js";
import { STREAMING, type RouteContext } from "../../routes.js";
import type { UiStore } from "../../store/index.js";
import { breakpointStoreWorkspaceFingerprint, createBreakpointStore } from "./breakpointStore.js";
import {
  createDebugBrowserSessionRegistry,
  DEBUG_BROWSER_COOKIE_NAME,
  DEBUG_BROWSER_COOKIE_PATH,
  DEBUG_BROWSER_PROFILE_COOKIE_NAME,
  DEBUG_BROWSER_SESSION_TTL_MS,
  type DebugBrowserSessionRegistry,
} from "./dapBrowserSession.js";
import {
  createDapDebugRouteService,
  handleDebugEvents,
  type DapDebugRouteService,
} from "./dapDebugRoutes.js";
import { createDapEventBridge } from "./dapEventBridge.js";
import type { DapProcessManager, DapProcessStartInput } from "./dapProcessManager.js";
import { DapProtocolError } from "./dapProtocolClient.js";
import { createDebugReferenceStore } from "./dapReferenceStore.js";
import type { DebugSessionBinding, DebugSessionProjection } from "./debugSessionRegistry.js";
import { inspectDebugWorkspaceIdentity } from "./debugLaunchContext.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
} as const;
const ACTIVATION_REVISION = 7;

class FakeDebugManager implements DapProcessManager {
  public readonly starts: DapProcessStartInput[] = [];
  public readonly requests: {
    readonly sessionId: string;
    readonly command: string;
    readonly args: unknown;
    readonly lane: "control" | "inspection";
  }[] = [];
  public largeVariableResponse = false;
  public largeStackResponse = false;
  public stackTotalFrames = 1;
  public scopeCount = 1;
  public rejectedCommand: string | undefined;
  public malformedCommand: string | undefined;
  public delayedCommand: string | undefined;
  // Unlike rejectedCommand (which rejects every call to a given command name), this rejects only a
  // setBreakpoints call whose `source.path` matches -- needed to simulate an adapter that rejects the
  // rename's old-path clear while still accepting the new-path arm in the same reconciliation.
  public rejectedSetBreakpointsSourcePath: string | undefined;
  private releaseRequest: (() => void) | undefined;
  private readonly projections = new Map<string, DebugSessionProjection>();
  private readonly bindings = new Map<string, DebugSessionBinding>();

  public async start(input: DapProcessStartInput): Promise<void> {
    this.starts.push(input);
    this.bindings.set(input.identity.sessionId, {
      workspaceId: input.identity.workspaceId,
      workspacePartitionKey: input.identity.workspacePartitionKey,
      browserSessionBinding: input.identity.browserSessionBinding,
    });
    this.projections.set(input.identity.sessionId, projection(input));
    await input.configure?.({
      request: <T>(command: string, args: unknown): Promise<T> =>
        this.request(input.identity.sessionId, command, args, "inspection"),
    });
  }

  public request<T>(
    sessionId: string,
    command: string,
    args: unknown,
    lane: "control" | "inspection",
    _signal?: AbortSignal,
  ): Promise<T> {
    this.requests.push({ sessionId, command, args, lane });
    if (
      command === "setBreakpoints" &&
      this.rejectedSetBreakpointsSourcePath !== undefined &&
      (args as { readonly source?: { readonly path?: string } }).source?.path ===
        this.rejectedSetBreakpointsSourcePath
    ) {
      return Promise.reject(new DapProtocolError("ADAPTER_REJECTED"));
    }
    if (command === this.rejectedCommand) {
      return Promise.reject(new DapProtocolError("ADAPTER_REJECTED"));
    }
    if (command === this.malformedCommand) {
      return Promise.resolve({ breakpoints: [{ verified: "invalid" }] } as T);
    }
    if (command === this.delayedCommand) {
      return new Promise<T>((resolve) => {
        this.releaseRequest = (): void => {
          resolve(this.response(command, args) as T);
        };
      });
    }
    return Promise.resolve(this.response(command, args) as T);
  }

  public releaseDelayedRequest(): void {
    this.releaseRequest?.();
    this.releaseRequest = undefined;
  }

  public stop(sessionId: string): Promise<void> {
    const current = this.projections.get(sessionId);
    if (current !== undefined) this.projections.set(sessionId, { ...current, state: "stopped" });
    return Promise.resolve();
  }

  public revoke(sessionId: string): Promise<void> {
    this.revocations.push(sessionId);
    const current = this.projections.get(sessionId);
    if (current !== undefined) this.projections.set(sessionId, { ...current, state: "revoked" });
    return Promise.resolve();
  }

  public readonly revocations: string[] = [];

  public failMalformed(sessionId: string): Promise<void> {
    const current = this.projections.get(sessionId);
    if (current !== undefined) this.projections.set(sessionId, { ...current, state: "failed" });
    return Promise.resolve();
  }

  public sweepExpired(): Promise<void> {
    return Promise.resolve();
  }

  public reconcile(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public health(sessionId: string): DebugSessionProjection | undefined {
    return this.projections.get(sessionId);
  }

  public binding(sessionId: string): DebugSessionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  public boundSessionId(
    workspacePartitionKey: string,
    browserSessionBinding: string,
  ): string | undefined {
    for (const [sessionId, binding] of this.bindings) {
      if (
        binding.workspacePartitionKey === workspacePartitionKey &&
        binding.browserSessionBinding === browserSessionBinding
      ) {
        return sessionId;
      }
    }
    return undefined;
  }

  public workspaceSessionId(workspacePartitionKey: string): string | undefined {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.workspacePartitionKey === workspacePartitionKey) return sessionId;
    }
    return undefined;
  }

  public pauseContext(sessionId: string): ReturnType<DapProcessManager["pauseContext"]> {
    const current = this.projections.get(sessionId);
    return current?.state === "paused"
      ? { pauseGeneration: current.pauseGeneration, threadId: 101, allThreadsStopped: true }
      : undefined;
  }

  public setPaused(sessionId: string): void {
    const current = this.projections.get(sessionId);
    if (current !== undefined) {
      this.projections.set(sessionId, { ...current, state: "paused", pauseGeneration: 1 });
    }
  }

  private response(command: string, args: unknown): unknown {
    if (command === "threads") return { threads: [{ id: 101, name: "main" }] };
    if (command === "stackTrace") return this.stackResponse();
    if (command === "scopes") {
      return {
        scopes: Array.from({ length: this.scopeCount }, (_, index) => ({
          name: `Scope ${String(index)}`,
          variablesReference: 303 + index,
          expensive: false,
          namedVariables: 1,
        })),
      };
    }
    if (command === "variables") {
      if (this.largeVariableResponse) {
        return {
          variables: Array.from({ length: 200 }, (_, index) => ({
            name: `${String(index)}${"n".repeat(510)}`,
            value: "v".repeat(4_096),
            type: "t".repeat(256),
            variablesReference: 0,
          })),
        };
      }
      return {
        variables: [{ name: "counter", value: "1", type: "number", variablesReference: 404 }],
      };
    }
    if (command === "setVariable") {
      return { value: "2", type: "number", variablesReference: 0 };
    }
    if (command === "evaluate") {
      return { result: "2", type: "number", variablesReference: 505 };
    }
    if (command === "setBreakpoints") {
      const record = args as { readonly breakpoints?: readonly unknown[] };
      return { breakpoints: (record.breakpoints ?? []).map(() => ({ verified: true })) };
    }
    return {};
  }

  private stackResponse(): unknown {
    return this.largeStackResponse
      ? {
          stackFrames: Array.from({ length: 64 }, (_, index) => ({
            id: index + 1,
            name: "n".repeat(512),
            source: { path: `/keiko-execution-root/${"s".repeat(4_096)}` },
            line: index + 1,
            column: 1,
          })),
          totalFrames: 64,
        }
      : {
          stackFrames: [
            {
              id: 202,
              name: "main",
              source: { path: "/keiko-execution-root/src/app.ts" },
              line: 4,
              column: 2,
            },
          ],
          totalFrames: this.stackTotalFrames,
        };
  }
}

function projection(input: DapProcessStartInput): DebugSessionProjection {
  return {
    sessionId: input.identity.sessionId,
    targetKind: input.identity.targetKind,
    state: "running",
    terminalReason: undefined,
    activationRevision: input.identity.activationRevision,
    pauseGeneration: 0,
    startedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    outputAcceptedBytes: 0,
    outputTruncatedEvents: 0,
    pendingRequestCount: 0,
    startupAttemptCount: 1,
    health: "ready",
    supportsSetVariable: true,
  };
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

let server: Server;
let port = 0;
let staticRoot = "";
let workspaceRoot = "";
let secondWorkspaceRoot = "";
let stateDir = "";
let workspaceId = "";
let workspacePartition = "";
let secondWorkspaceId = "";
let store: UiStore;
let manager: FakeDebugManager;
let now = 0;
let tokenSequence = 0;
let referenceCapacity: number | undefined;
let browserSessions: DebugBrowserSessionRegistry;
let rejectEventPublication = false;
let activationRevision = ACTIVATION_REVISION;
let activationState: "available" | "notProvisioned" = "available";
let activationFailure = false;
let diagnosticRecords: ServerDiagnosticRecord[] = [];
const env: Record<string, string | undefined> = {};

function newBrowserSessions(): DebugBrowserSessionRegistry {
  return createDebugBrowserSessionRegistry({
    now: () => now,
    token: () => Buffer.alloc(32, ++tokenSequence),
  });
}

function debugService(): DapDebugRouteService {
  const breakpoints = createBreakpointStore({ stateDir });
  const bridge = createDapEventBridge();
  const events = {
    ...bridge,
    publish: (...args: Parameters<typeof bridge.publish>): boolean =>
      rejectEventPublication ? false : bridge.publish(...args),
  };
  const references = createDebugReferenceStore(
    referenceCapacity === undefined ? {} : { capacity: referenceCapacity },
  );
  return {
    manager,
    breakpoints,
    get browserSessions(): DebugBrowserSessionRegistry {
      return browserSessions;
    },
    references,
    events,
    activation: (): ReturnType<DapDebugRouteService["activation"]> => {
      if (activationFailure) return Promise.reject(new Error("activation unavailable"));
      return Promise.resolve({
        ok: true,
        schemaVersion: "1",
        adapterId: "node-typescript",
        revision: activationRevision,
        state: activationState,
        reasonCode: activationState === "available" ? "AVAILABLE" : "NOT_PROVISIONED",
        policyResult: "allowed",
      });
    },
    diagnosticSink: {
      record: (record): void => {
        diagnosticRecords.push(record);
      },
    },
    // Unit-level fixture: nothing built via this hand-rolled service exercises a rename. Coverage
    // for the real reconciliation behavior lives on the createDapDebugRouteService-built instance in
    // the "renameInstrumentation" describe block below.
    renameInstrumentation: vi.fn().mockResolvedValue(undefined),
  };
}

function handlerDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    dapDebug: debugService(),
  };
}

class FakeSseResponse extends EventEmitter {
  public readonly writes: string[] = [];
  public headers: Readonly<Record<string, string>> | undefined;
  public status: number | undefined;
  public destroyed = false;
  public writableEnded = false;

  public writeHead(status: number, headers: Readonly<Record<string, string>>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  public write(frame: string): boolean {
    this.writes.push(frame);
    return true;
  }

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function eventContext(cookie: string, response: FakeSseResponse): RouteContext {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.defineProperty(req, "headers", { value: { cookie }, configurable: true });
  return {
    correlationId: undefined,
    req,
    res: response as unknown as ServerResponse,
    params: {},
    url: new URL(
      `http://localhost/api/editor/debug/events?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  };
}

async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve) => candidate.listen(0, UI_HOST, resolve));
  return (candidate.address() as AddressInfo).port;
}

async function closeServer(candidate: Server = server): Promise<void> {
  await new Promise<void>((resolve) =>
    candidate.close(() => {
      resolve();
    }),
  );
}

async function startServer(): Promise<void> {
  const deps = handlerDeps();
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  port = await listen(probe);
  await closeServer(probe);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function enableDebug(): void {
  env.KEIKO_EDITOR_DEBUG = "1";
}

function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .join("; ");
}

async function bootstrap(id = workspaceId, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
    method: "POST",
    headers: cookie === undefined ? JSON_HEADERS : { ...JSON_HEADERS, Cookie: cookie },
    body: JSON.stringify({ schemaVersion: "1", workspaceId: id }),
  });
}

async function instrumentation(cookie?: string, id = workspaceId): Promise<Response> {
  const headers = cookie === undefined ? {} : { Cookie: cookie };
  return fetch(
    `${baseUrl()}/api/editor/debug/instrumentation?workspaceId=${encodeURIComponent(id)}`,
    { headers },
  );
}

async function rawRequest(
  path: string,
  body: string,
  headers: Readonly<Record<string, string>>,
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = request(
      {
        host: UI_HOST,
        port,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function deniedBody(response: Response): Promise<string> {
  expect(response.status).toBe(403);
  const text = await response.text();
  expect(text).toContain("DEBUG_CAPABILITY_DENIED");
  expect(text).not.toContain(workspaceRoot);
  expect(text).not.toContain(secondWorkspaceRoot);
  return text;
}

function breakpointMutationBody(
  fileId = "src/private-entry.ts",
  line = 12,
  expectedRevision = 0,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    workspaceId,
    expectedRevision,
    fileId,
    breakpoints: [
      {
        id: "request-breakpoint",
        fileId,
        line,
        enabled: true,
        kind: "line",
        verification: "pending",
      },
    ],
  };
}

function maximumBreakpointBody(
  fileId: string,
  count: number,
  expectedRevision: number,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    workspaceId,
    expectedRevision,
    fileId,
    breakpoints: Array.from({ length: count }, (_, index) => ({
      id: `${fileId.replaceAll("/", "_").replaceAll(".", "_")}_${String(index)}`,
      fileId,
      line: index + 1,
      enabled: true,
      condition: "c".repeat(1_024),
      hitCondition: "h".repeat(1_024),
      kind: "conditional",
      verification: "pending",
    })),
  };
}

function requiredFirst<T>(values: readonly T[]): T {
  const first = values[0];
  if (first === undefined) throw new Error("invalid route test fixture");
  return first;
}

interface CapturedSetBreakpointsArgs {
  readonly source?: { readonly path?: string };
  readonly breakpoints?: readonly { readonly line?: unknown }[];
}

function breakpointRequestPath(args: unknown): string | undefined {
  return (args as CapturedSetBreakpointsArgs).source?.path;
}

function breakpointRequestLines(args: unknown): readonly unknown[] {
  return ((args as CapturedSetBreakpointsArgs).breakpoints ?? []).map(
    (breakpoint) => breakpoint.line,
  );
}

// Recursively collect every [key, primitive-value] pair of a payload. Used to assert redaction in a
// key-scoped way (the raw DAP reference fields must be absent, and opaque *Ref tokens must not equal
// an internal reference) instead of scanning JSON.stringify output for substrings — which
// false-positives whenever a random opaque token or sessionId happens to contain a redacted digit
// sequence — or banning the sentinel values globally, which would false-positive on unrelated
// legitimate numeric fields.
function collectEntries(value: unknown, entries: [string, string][]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEntries(item, entries);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean") {
        entries.push([key, String(nested)]);
      } else {
        collectEntries(nested, entries);
      }
    }
  }
}

async function putBreakpoints(
  cookie: string,
  body: Record<string, unknown>,
  etag: string,
): Promise<Response> {
  return fetch(`${baseUrl()}/api/editor/debug/breakpoints`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, Cookie: cookie, "If-Match": etag },
    body: JSON.stringify(body),
  });
}

async function debugJson(
  path: string,
  cookie: string,
  body: Record<string, unknown>,
  method = "POST",
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: { ...JSON_HEADERS, ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  staticRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-debug-route-static-")));
  workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "keiko-debug-route-workspace-")));
  secondWorkspaceRoot = await realpath(
    await mkdtemp(join(tmpdir(), "keiko-debug-route-workspace-b-")),
  );
  stateDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-debug-route-state-")));
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot);
  store.createProject(secondWorkspaceRoot);
  workspaceId = breakpointStoreWorkspaceFingerprint(workspaceRoot);
  workspacePartition = inspectDebugWorkspaceIdentity(workspaceRoot).identityDigest;
  secondWorkspaceId = breakpointStoreWorkspaceFingerprint(secondWorkspaceRoot);
  manager = new FakeDebugManager();
  now = 0;
  tokenSequence = 0;
  referenceCapacity = undefined;
  rejectEventPublication = false;
  activationRevision = ACTIVATION_REVISION;
  activationState = "available";
  activationFailure = false;
  diagnosticRecords = [];
  browserSessions = newBrowserSessions();
  delete env.KEIKO_EDITOR_DEBUG;
  await startServer();
});

afterEach(async () => {
  await closeServer();
  await Promise.all(
    [staticRoot, workspaceRoot, secondWorkspaceRoot, stateDir].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("governed DAP debug routes", () => {
  it("projects the exact production manager and event bridge through a least-authority route bundle", () => {
    const events = createDapEventBridge();
    const service = createDapDebugRouteService({
      production: { manager, eventBridge: events },
      stateDir,
      now: () => now,
      activation: () =>
        Promise.resolve({
          ok: true,
          schemaVersion: "1",
          adapterId: "node-typescript",
          revision: ACTIVATION_REVISION,
          state: "available",
          reasonCode: "AVAILABLE",
          policyResult: "allowed",
        }),
    });

    expect(Object.isFrozen(service)).toBe(true);
    expect(service.manager).toBe(manager);
    expect(service.events).toBe(events);
    expect(Object.keys(service)).toStrictEqual([
      "manager",
      "breakpoints",
      "browserSessions",
      "references",
      "events",
      "activation",
      "renameInstrumentation",
    ]);
    expect("registry" in service).toBe(false);
    expect("lifecycleLedger" in service).toBe(false);
  });

  it("bootstraps when the canonical DAP service is composed without a legacy route flag", async () => {
    const response = await bootstrap();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).not.toBeNull();
  });

  it("bootstraps only an HttpOnly SameSite Strict API-scoped cookie", async () => {
    enableDebug();
    const response = await bootstrap();
    const setCookies = response.headers.getSetCookie();
    const setCookie = setCookies.join("\n");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(setCookie).toMatch(new RegExp(`${DEBUG_BROWSER_COOKIE_NAME}=[A-Za-z0-9_-]{43};`, "u"));
    expect(setCookie).toMatch(
      new RegExp(`${DEBUG_BROWSER_PROFILE_COOKIE_NAME}=[A-Za-z0-9_-]{43};`, "u"),
    );
    expect(setCookie).toContain(`Path=${DEBUG_BROWSER_COOKIE_PATH}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(text).toContain(`"workspaceId":"${workspaceId}"`);
    for (const cookie of cookieFrom(response).split("; ")) {
      expect(text).not.toContain(cookie.split("=", 2)[1] ?? "impossible-token");
    }
    expect(text).not.toContain(workspaceRoot);
  });

  it("reuses a valid browser capability when the debug panel bootstraps again", async () => {
    enableDebug();
    const first = await bootstrap();
    const cookie = cookieFrom(first);
    const repeated = await bootstrap(workspaceId, cookie);

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(repeated.headers.getSetCookie()).toEqual([]);
    expect((await instrumentation(cookie)).status).toBe(200);
  });

  it("rejects missing, malformed, duplicate, expired, restarted, and cross-workspace cookies", async () => {
    enableDebug();
    const issued = await bootstrap();
    const cookie = cookieFrom(issued);
    const baseline = await deniedBody(await instrumentation());

    expect(await deniedBody(await instrumentation(`${DEBUG_BROWSER_COOKIE_NAME}=short`))).toBe(
      baseline,
    );
    expect(await deniedBody(await instrumentation(`${cookie}; ${cookie}`))).toBe(baseline);
    expect(await deniedBody(await instrumentation(cookie, secondWorkspaceId))).toBe(baseline);

    now = DEBUG_BROWSER_SESSION_TTL_MS;
    expect(await deniedBody(await instrumentation(cookie))).toBe(baseline);

    const currentCookie = cookieFrom(await bootstrap());
    await closeServer();
    browserSessions = newBrowserSessions();
    await startServer();
    expect(await deniedBody(await instrumentation(currentCookie))).toBe(baseline);
  });

  it("inherits loopback Host, same-origin Origin, CSRF, and strict JSON defenses", async () => {
    enableDebug();
    const body = JSON.stringify({ schemaVersion: "1", workspaceId });
    const foreignHost = await rawRequest("/api/editor/debug/bootstrap", body, {
      ...JSON_HEADERS,
      Host: "attacker.invalid",
    });
    const foreignOrigin = await fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "https://attacker.invalid" },
      body,
    });
    const noCsrf = await fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const wrongMedia = await fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body,
    });
    const malformed = await fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{",
    });
    const openObject = await fetch(`${baseUrl()}/api/editor/debug/bootstrap`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ schemaVersion: "1", workspaceId, unexpected: true }),
    });

    expect(foreignHost.status).toBe(403);
    expect(foreignHost.body).toContain("FORBIDDEN_HOST");
    expect(foreignOrigin.status).toBe(403);
    expect(noCsrf.status).toBe(403);
    expect(wrongMedia.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(openObject.status).toBe(400);
  });

  it("rejects a request above the 256 KiB JSON ceiling", async () => {
    enableDebug();
    const oversized = `{"padding":"${"x".repeat(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes)}"}`;
    const response = await fetch(`${baseUrl()}/api/editor/debug/breakpoints`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: oversized,
    });

    expect(Buffer.byteLength(oversized)).toBeGreaterThan(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("enforces optimistic concurrency without mutating state on a stale write", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const accepted = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const stale = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const current = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly breakpoints: readonly unknown[];
    };

    expect(initial.revision).toBe(0);
    expect(accepted.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, reason: "conflict" });
    expect(current.revision).toBe(1);
    expect(current.breakpoints).toHaveLength(1);
  });

  it("surfaces the total breakpoint cap without silently evicting armed state", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    let state = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    for (let file = 0; file < 4; file += 1) {
      const fileId = `src/cap-${String(file)}.ts`;
      const response = await putBreakpoints(
        cookie,
        {
          schemaVersion: "1",
          workspaceId,
          expectedRevision: state.revision,
          fileId,
          breakpoints: Array.from({ length: 50 }, (_, index) => ({
            id: `request_${String(file)}_${String(index)}`,
            fileId,
            line: index + 1,
            enabled: true,
            kind: "line",
            verification: "pending",
          })),
        },
        state.etag,
      );
      expect(response.status).toBe(200);
      const accepted = (await response.json()) as { readonly snapshot: typeof state };
      state = accepted.snapshot;
    }

    const overflow = await putBreakpoints(
      cookie,
      {
        schemaVersion: "1",
        workspaceId,
        expectedRevision: state.revision,
        fileId: "src/overflow.ts",
        breakpoints: [
          {
            id: "request_overflow",
            fileId: "src/overflow.ts",
            line: 1,
            enabled: true,
            kind: "line",
            verification: "pending",
          },
        ],
      },
      state.etag,
    );
    const rejected = (await overflow.json()) as {
      readonly reason: string;
      readonly snapshot: { readonly revision: number; readonly breakpoints: readonly unknown[] };
    };

    expect(overflow.status).toBe(422);
    expect(rejected.reason).toBe("cap_exceeded");
    expect(rejected.snapshot.revision).toBe(state.revision);
    expect(rejected.snapshot.breakpoints).toHaveLength(200);
  });

  it("reconciles adapter breakpoint acknowledgement before reporting an armed state", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    expect(started.status).toBe(201);
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };

    const response = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const body = (await response.json()) as {
      readonly snapshot: {
        readonly revision: number;
        readonly breakpoints: readonly { readonly verification: string }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.snapshot.revision).toBe(initial.revision + 2);
    expect(requiredFirst(body.snapshot.breakpoints).verification).toBe("verified");
  });

  it("retries active breakpoint reconciliation from the latest snapshot after verification drift", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/private-entry.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    expect(started.status).toBe(201);
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };

    manager.delayedCommand = "setBreakpoints";
    const delayedEdit = putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    await vi.waitFor(() => {
      expect(manager.requests.filter((entry) => entry.command === "setBreakpoints")).toHaveLength(
        1,
      );
    });
    manager.delayedCommand = undefined;
    const afterDelayedCommit = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const currentEdit = await putBreakpoints(
      cookie,
      breakpointMutationBody("src/private-entry.ts", 34, afterDelayedCommit.revision),
      afterDelayedCommit.etag,
    );
    manager.releaseDelayedRequest();
    const driftedEdit = await delayedEdit;
    const persisted = (await (await instrumentation(cookie)).json()) as {
      readonly breakpoints: readonly { readonly line: number; readonly verification: string }[];
    };

    const calls = manager.requests.filter((entry) => entry.command === "setBreakpoints");
    expect(currentEdit.status).toBe(200);
    expect(driftedEdit.status).toBe(200);
    expect(calls.map((entry) => breakpointRequestLines(entry.args))).toStrictEqual([
      [12],
      [34],
      [34],
    ]);
    expect(requiredFirst(persisted.breakpoints)).toMatchObject({
      line: 34,
      verification: "verified",
    });
  });

  it("reconciles persisted pending breakpoints during session startup", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const persisted = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    expect(persisted.status).toBe(200);
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const state = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly breakpoints: readonly { readonly verification: string }[];
    };
    expect(started.status).toBe(201);
    expect(state.revision).toBe(initial.revision + 2);
    expect(requiredFirst(state.breakpoints).verification).toBe("verified");
  });

  it("recovers a replayed configure closure after a concurrent breakpoint edit (KEIKO-0097)", async () => {
    // dapProcessManager reuses the SAME `configure` closure across its internal launch retries. This
    // reproduces that reuse directly: capture the closure a real session-start built, let a
    // breakpoint edit land afterward (simulating the race with an in-flight launch), then replay the
    // SAME closure exactly as a retry would and assert it observes the edit instead of replaying
    // whatever it read on its first run.
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const firstEdit = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    expect(firstEdit.status).toBe(200);

    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    expect(started.status).toBe(201);
    const session = (await started.json()) as { readonly sessionId: string };
    const configure = manager.starts.at(-1)?.configure;
    expect(configure).toBeDefined();
    // Stop the session so the concurrent edit below persists as pending instead of being live-armed
    // through the (unrelated) active-session dispatch path -- isolating the closure-staleness bug
    // this finding is about from that separate reconciliation path.
    await manager.stop(session.sessionId);

    const beforeSecondEdit = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const secondEdit = await putBreakpoints(
      cookie,
      {
        schemaVersion: "1",
        workspaceId,
        expectedRevision: beforeSecondEdit.revision,
        fileId: "src/private-entry.ts",
        breakpoints: [
          {
            id: "request-breakpoint",
            fileId: "src/private-entry.ts",
            line: 34,
            enabled: true,
            kind: "line",
            verification: "pending",
          },
        ],
      },
      beforeSecondEdit.etag,
    );
    expect(secondEdit.status).toBe(202);
    const beforeReplay = (await (await instrumentation(cookie)).json()) as {
      readonly breakpoints: readonly { readonly verification: string }[];
    };
    expect(requiredFirst(beforeReplay.breakpoints).verification).toBe("pending");

    await configure?.({
      request: <T>(command: string, args: unknown): Promise<T> =>
        manager.request(session.sessionId, command, args, "inspection"),
    }).catch(() => undefined);

    const final = (await (await instrumentation(cookie)).json()) as {
      readonly breakpoints: readonly { readonly verification: string }[];
    };
    expect(requiredFirst(final.breakpoints).verification).toBe("verified");
  });

  it("reports persisted but not armed when an active adapter rejects breakpoint delivery", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    expect(started.status).toBe(201);
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly etag: string;
    };
    manager.rejectedCommand = "setBreakpoints";
    const response = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const body = (await response.json()) as {
      readonly activation: { readonly state: string; readonly armed: boolean };
    };
    const persisted = (await (await instrumentation(cookie)).json()) as {
      readonly breakpoints: readonly { readonly verification: string }[];
    };
    expect(response.status).toBe(202);
    expect(body.activation).toStrictEqual({ state: "persisted", armed: false });
    expect(requiredFirst(persisted.breakpoints).verification).toBe("pending");
  });

  it("tears down a session and surfaces an opaque correlated 500 for malformed adapter data", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    const initial = (await (await instrumentation(cookie)).json()) as { readonly etag: string };
    manager.malformedCommand = "setBreakpoints";
    const response = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get("x-keiko-correlation-id")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(text).not.toContain("DAP_RESPONSE_INVALID");
    expect(text).not.toContain(workspaceRoot);
    expect(manager.health(session.sessionId)?.state).toBe("failed");
  });

  it("reports persisted but not armed for rejected exception-breakpoint delivery", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    expect(started.status).toBe(201);
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    manager.rejectedCommand = "setExceptionBreakpoints";
    const response = await debugJson(
      "/api/editor/debug/exception-breakpoints",
      cookie,
      {
        schemaVersion: "1",
        workspaceId,
        expectedRevision: initial.revision,
        filters: [{ filterId: "caught", enabled: true }],
      },
      "PUT",
      { "If-Match": initial.etag },
    );
    const state = (await (await instrumentation(cookie)).json()) as {
      readonly exceptionFilters: readonly { readonly filterId: string }[];
    };
    expect(response.status).toBe(202);
    expect(state.exceptionFilters).toStrictEqual([{ filterId: "caught", enabled: true }]);
  });

  it("fails closed on malformed exception-breakpoint adapter responses", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    manager.malformedCommand = "setExceptionBreakpoints";
    const response = await debugJson(
      "/api/editor/debug/exception-breakpoints",
      cookie,
      {
        schemaVersion: "1",
        workspaceId,
        expectedRevision: initial.revision,
        filters: [{ filterId: "caught", enabled: true }],
      },
      "PUT",
      { "If-Match": initial.etag },
    );
    expect(response.status).toBe(500);
    expect(manager.health(session.sessionId)?.state).toBe("failed");
  });

  it("reports persisted but not armed when clear-all cannot reach the active adapter", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly etag: string;
    };
    await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);
    const populated = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    manager.rejectedCommand = "setExceptionBreakpoints";
    const response = await fetch(
      `${baseUrl()}/api/editor/debug/instrumentation?workspaceId=${encodeURIComponent(workspaceId)}&expectedRevision=${String(populated.revision)}`,
      {
        method: "DELETE",
        headers: { ...JSON_HEADERS, Cookie: cookie, "If-Match": populated.etag },
        body: "{}",
      },
    );
    const cleared = (await (await instrumentation(cookie)).json()) as {
      readonly breakpoints: readonly unknown[];
      readonly exceptionFilters: readonly unknown[];
    };
    expect(response.status).toBe(202);
    expect(cleared.breakpoints).toStrictEqual([]);
    expect(cleared.exceptionFilters).toStrictEqual([
      { filterId: "uncaught", enabled: false },
      { filterId: "caught", enabled: false },
    ]);
  });

  it("keeps maximum instrumentation HTTP projections below 256 KiB with explicit omission counts", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    let state = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    for (const [fileId, count] of [
      ["src/maximum-a.ts", 64],
      ["src/maximum-b.ts", 64],
      ["src/maximum-c.ts", 64],
      ["src/maximum-d.ts", 8],
    ] as const) {
      const response = await putBreakpoints(
        cookie,
        maximumBreakpointBody(fileId, count, state.revision),
        state.etag,
      );
      const diagnostic = (await response.clone().json()) as {
        readonly reason?: string;
        readonly snapshot?: { readonly revision: number; readonly etag: string };
      };
      expect(
        response.status,
        `${fileId}:${String(state.revision)}:${state.etag}:${diagnostic.reason ?? "ok"}:${String(diagnostic.snapshot?.revision ?? -1)}:${diagnostic.snapshot?.etag ?? "missing"}`,
      ).toBe(200);
      state = ((await response.json()) as { readonly snapshot: typeof state }).snapshot;
    }

    const response = await instrumentation(cookie);
    const text = await response.text();
    const body = JSON.parse(text) as {
      readonly truncated: boolean;
      readonly breakpointRetainedCount: number;
      readonly breakpointOmittedCount: number;
    };
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
    expect(body.truncated).toBe(true);
    expect(body.breakpointRetainedCount + body.breakpointOmittedCount).toBe(200);
    expect(body.breakpointOmittedCount).toBeGreaterThan(0);
  });

  it("bounds event-unavailable mutation responses with explicit omission counts", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    let state = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    for (const fileId of ["src/maximum-a.ts", "src/maximum-b.ts", "src/maximum-c.ts"] as const) {
      const response = await putBreakpoints(
        cookie,
        maximumBreakpointBody(fileId, 64, state.revision),
        state.etag,
      );
      expect(response.status).toBe(200);
      state = ((await response.json()) as { readonly snapshot: typeof state }).snapshot;
    }

    rejectEventPublication = true;
    const response = await putBreakpoints(
      cookie,
      maximumBreakpointBody("src/maximum-d.ts", 8, state.revision),
      state.etag,
    );
    const text = await response.text();
    const body = JSON.parse(text) as {
      readonly error: { readonly code: string };
      readonly snapshot: {
        readonly truncated: boolean;
        readonly breakpointRetainedCount: number;
        readonly breakpointOmittedCount: number;
      };
    };
    expect(response.status).toBe(503);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
    expect(body.error.code).toBe("EVENT_UNAVAILABLE");
    expect(body.snapshot.truncated).toBe(true);
    expect(body.snapshot.breakpointRetainedCount + body.snapshot.breakpointOmittedCount).toBe(200);
    expect(body.snapshot.breakpointOmittedCount).toBeGreaterThan(0);
  });

  it("revokes before dispatch when the workspace activation revision changes", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const before = manager.requests.length;
    activationRevision += 1;

    const response = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("STALE_ACTIVATION");
    expect(manager.revocations).toStrictEqual([session.sessionId]);
    expect(manager.requests).toHaveLength(before);
    expect(manager.health(session.sessionId)?.state).toBe("revoked");
  });

  it("treats activation resolver failure as synchronous revocation before dispatch", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const before = manager.requests.length;
    activationFailure = true;

    const response = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });

    expect(response.status).toBe(403);
    expect(manager.revocations).toStrictEqual([session.sessionId]);
    expect(manager.requests).toHaveLength(before);
  });

  it("emits a redacted operator diagnostic when the activation resolver throws before dispatch", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    activationFailure = true;

    const response = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });

    expect(response.status).toBe(403);
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]).toMatchObject({
      correlationId: workspaceId,
      operation: "dap.activation.revalidate",
      source: "dap.debug-routes.activation-resolver",
      message: "Debug activation resolver failed.",
    });
    expect(JSON.stringify(diagnosticRecords)).not.toContain("activation unavailable");
    expect(JSON.stringify(diagnosticRecords)).not.toContain(workspaceRoot);
  });

  it("emits a redacted operator diagnostic when the activation resolver throws during bootstrap", async () => {
    enableDebug();
    activationFailure = true;

    const response = await bootstrap();

    expect(response.status).toBe(403);
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]).toMatchObject({
      correlationId: workspaceId,
      operation: "dap.activation.resolve",
      source: "dap.debug-routes.activation-resolver",
      message: "Debug activation resolver failed.",
    });
    expect(JSON.stringify(diagnosticRecords)).not.toContain("activation unavailable");
    expect(JSON.stringify(diagnosticRecords)).not.toContain(workspaceRoot);
  });

  it("revalidates activation before active instrumentation dispatch", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly etag: string;
    };
    const before = manager.requests.length;
    activationState = "notProvisioned";

    const response = await putBreakpoints(cookie, breakpointMutationBody(), initial.etag);

    expect(response.status).toBe(202);
    expect(manager.revocations).toStrictEqual([session.sessionId]);
    expect(manager.requests).toHaveLength(before);
    expect(manager.health(session.sessionId)?.state).toBe("revoked");
  });

  it("projects stack, scopes, variables, setVariable, controls, and registered watches opaquely", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const initial = (await (await instrumentation(cookie)).json()) as {
      readonly revision: number;
      readonly etag: string;
    };
    const watchesResponse = await debugJson(
      "/api/editor/debug/watches",
      cookie,
      {
        schemaVersion: "1",
        workspaceId,
        expectedRevision: initial.revision,
        watches: [{ watchId: "request_watch", expression: "counter", enabled: true }],
      },
      "PUT",
      { "If-Match": initial.etag },
    );
    const watches = (await watchesResponse.json()) as {
      readonly snapshot: { readonly watches: readonly { readonly watchId: string }[] };
    };
    const watchId = requiredFirst(watches.snapshot.watches).watchId;
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as {
      readonly sessionId: string;
      readonly pauseGeneration: number;
    };
    manager.setPaused(session.sessionId);

    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 10,
    });
    const stackBody = (await stack.json()) as {
      readonly frames: readonly { readonly frameRef: string; readonly sourceFileId?: string }[];
    };
    const frameRef = requiredFirst(stackBody.frames).frameRef;
    const scopes = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const scopesBody = (await scopes.json()) as {
      readonly scopes: readonly { readonly scopeRef: string }[];
    };
    const scopeRef = requiredFirst(scopesBody.scopes).scopeRef;
    const variables = await debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: scopeRef,
    });
    const variablesBody = (await variables.json()) as {
      readonly nodes: readonly { readonly variableRef?: string }[];
    };
    const variableRef = requiredFirst(variablesBody.nodes).variableRef ?? "";
    const setVariable = await debugJson("/api/editor/debug/variables/set", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef,
      value: "2",
    });
    const evaluated = await debugJson("/api/editor/debug/watches/evaluate", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      watchId,
    });
    const evaluatedBody = (await evaluated.json()) as { readonly variableRef?: string };
    const readOnlySet = await debugJson("/api/editor/debug/variables/set", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: evaluatedBody.variableRef ?? "",
      value: "hostile",
    });

    expect(watchesResponse.status).toBe(200);
    expect(started.status).toBe(201);
    expect(stack.status).toBe(200);
    expect(scopes.status).toBe(200);
    expect(variables.status).toBe(200);
    expect(setVariable.status).toBe(200);
    expect(evaluated.status).toBe(200);
    expect(readOnlySet.status).toBe(403);
    expect(requiredFirst(stackBody.frames).sourceFileId).toBe("src/app.ts");
    // The client projection must expose only opaque *Ref tokens: the raw DAP reference fields ("id"
    // carrying frame 202, "variablesReference" carrying 303/404) must never appear, and an opaque
    // reference token must never equal one of the internal numeric references. Scope the numeric
    // checks to reference-carrying keys so unrelated legitimate numbers (line, column, counts) can
    // never trigger a false failure, and never substring-scan random opaque tokens or the sessionId.
    const internalReferences = new Set(["202", "303", "404"]);
    for (const body of [stackBody, scopesBody, variablesBody]) {
      const entries: [string, string][] = [];
      collectEntries(body, entries);
      for (const [key, value] of entries) {
        expect(key).not.toBe("id");
        expect(key).not.toBe("variablesReference");
        if (key.endsWith("Ref")) expect(internalReferences.has(value)).toBe(false);
      }
    }
    expect(manager.requests).toContainEqual({
      sessionId: session.sessionId,
      command: "setVariable",
      args: { variablesReference: 303, name: "counter", value: "2" },
      lane: "inspection",
    });
    expect(manager.requests).toContainEqual({
      sessionId: session.sessionId,
      command: "evaluate",
      args: { expression: "counter", context: "watch" },
      lane: "inspection",
    });

    const continued = await debugJson("/api/editor/debug/control", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      action: "continue",
      pauseGeneration: 1,
    });
    const staleScope = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const status = await fetch(
      `${baseUrl()}/api/editor/debug/sessions/${encodeURIComponent(session.sessionId)}`,
      { headers: { Cookie: cookie } },
    );
    const stopped = await fetch(
      `${baseUrl()}/api/editor/debug/sessions/${encodeURIComponent(session.sessionId)}`,
      { method: "DELETE", headers: { ...JSON_HEADERS, Cookie: cookie }, body: "{}" },
    );
    expect(continued.status).toBe(200);
    expect(staleScope.status).toBe(409);
    expect(status.status).toBe(200);
    expect(stopped.status).toBe(200);
  });

  it("caps and validates hostile scope arrays before minting pause references", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;
    manager.scopeCount = 1_001;

    const response = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const body = (await response.json()) as {
      readonly scopes: readonly unknown[];
      readonly retainedCount: number;
      readonly omittedCount: number;
      readonly truncated: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.scopes).toHaveLength(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame);
    expect(body.retainedCount).toBe(DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame);
    expect(body.omittedCount).toBe(1_001 - DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame);
    expect(body.truncated).toBe(true);
  });

  it("fails the session closed when retained scopes exceed reference capacity", async () => {
    await closeServer();
    referenceCapacity = 1;
    await startServer();
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;

    const response = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });

    expect(response.status).toBe(500);
    expect(manager.health(session.sessionId)?.state).toBe("failed");
  });

  it("drops only complete variable records to keep a 200-variable response below 256 KiB", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;
    const scopes = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const scopeRef = requiredFirst(
      ((await scopes.json()) as { readonly scopes: readonly { readonly scopeRef: string }[] })
        .scopes,
    ).scopeRef;
    manager.largeVariableResponse = true;

    const response = await debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: scopeRef,
    });
    const text = await response.text();
    const body = JSON.parse(text) as {
      readonly nodes: readonly unknown[];
      readonly retainedCount: number;
      readonly omittedCount: number;
      readonly truncated: boolean;
    };

    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
    expect(body.truncated).toBe(true);
    expect(body.nodes).toHaveLength(body.retainedCount + 1);
    expect(body.nodes.at(-1)).toMatchObject({ kind: "truncated", reason: "width" });
    expect(body.retainedCount + body.omittedCount).toBe(200);
    expect(body.omittedCount).toBeGreaterThan(0);
  });

  it("rejects an older in-flight variable projection after setVariable resets the epoch", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;
    const scopes = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const scopeRef = requiredFirst(
      ((await scopes.json()) as { readonly scopes: readonly { readonly scopeRef: string }[] })
        .scopes,
    ).scopeRef;
    const initialVariables = await debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: scopeRef,
    });
    const variableRef = requiredFirst(
      (
        (await initialVariables.json()) as {
          readonly nodes: readonly { readonly variableRef?: string }[];
        }
      ).nodes,
    ).variableRef;
    manager.delayedCommand = "variables";
    const staleProjection = debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: scopeRef,
    });
    await vi.waitFor(() => {
      expect(manager.requests.filter((request) => request.command === "variables")).toHaveLength(2);
    });
    const changed = await debugJson("/api/editor/debug/variables/set", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef,
      value: "2",
    });
    manager.releaseDelayedRequest();
    expect(changed.status).toBe(200);
    expect((await staleProjection).status).toBe(409);
  });

  it("returns typed cumulative-node truncation instead of a reference-capacity 500", async () => {
    await closeServer();
    referenceCapacity = 2;
    await startServer();
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;
    const scopes = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    const scopeRef = requiredFirst(
      ((await scopes.json()) as { readonly scopes: readonly { readonly scopeRef: string }[] })
        .scopes,
    ).scopeRef;
    const before = manager.requests.filter((request) => request.command === "variables").length;
    const response = await debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef: scopeRef,
    });
    const body = (await response.json()) as {
      readonly nodes: readonly { readonly kind: string; readonly reason?: string }[];
    };
    expect(response.status).toBe(200);
    expect(body.nodes).toStrictEqual([
      { kind: "truncated", reason: "nodeLimit", omittedCount: 1, truncated: true },
    ]);
    expect(manager.requests.filter((request) => request.command === "variables")).toHaveLength(
      before + 1,
    );
  });

  it("stops variable expansion at depth four without another adapter request", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    const stack = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const frameRef = requiredFirst(
      ((await stack.json()) as { readonly frames: readonly { readonly frameRef: string }[] })
        .frames,
    ).frameRef;
    const scopes = await debugJson("/api/editor/debug/scopes", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      frameRef,
    });
    let variableRef = requiredFirst(
      ((await scopes.json()) as { readonly scopes: readonly { readonly scopeRef: string }[] })
        .scopes,
    ).scopeRef;
    for (let depth = 1; depth <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxDepth; depth += 1) {
      const expanded = await debugJson("/api/editor/debug/variables", cookie, {
        schemaVersion: "1",
        sessionId: session.sessionId,
        pauseGeneration: 1,
        variableRef,
      });
      const body = (await expanded.json()) as {
        readonly nodes: readonly { readonly variableRef?: string }[];
      };
      variableRef = requiredFirst(body.nodes).variableRef ?? "";
      expect(variableRef).not.toBe("");
    }
    const before = manager.requests.filter((request) => request.command === "variables").length;
    const truncated = await debugJson("/api/editor/debug/variables", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      variableRef,
    });
    const body = (await truncated.json()) as { readonly nodes: readonly unknown[] };
    expect(truncated.status).toBe(200);
    expect(body.nodes).toStrictEqual([
      { kind: "truncated", reason: "depth", omittedCount: 1, truncated: true },
    ]);
    expect(manager.requests.filter((request) => request.command === "variables")).toHaveLength(
      before,
    );
  });

  it("pages stacks only through pause-bound server cursors", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    manager.stackTotalFrames = 2;
    const first = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 1,
    });
    const firstBody = (await first.json()) as { readonly nextCursor?: string };
    const second = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      cursor: firstBody.nextCursor,
      levels: 1,
    });
    const rawOffset = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 1,
      levels: 1,
    });
    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(second.status).toBe(200);
    expect(rawOffset.status).toBe(400);
    expect(manager.requests).toContainEqual({
      sessionId: session.sessionId,
      command: "stackTrace",
      args: { threadId: 101, startFrame: 1, levels: 1 },
      lane: "inspection",
    });
  });

  it("drops only complete stack frames to keep a maximum page below 256 KiB", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const started = await debugJson("/api/editor/debug/sessions", cookie, {
      schemaVersion: "1",
      workspaceId,
      target: { kind: "file", fileId: "src/app.ts" },
      activationRevision: ACTIVATION_REVISION,
    });
    const session = (await started.json()) as { readonly sessionId: string };
    manager.setPaused(session.sessionId);
    manager.largeStackResponse = true;
    const response = await debugJson("/api/editor/debug/stack", cookie, {
      schemaVersion: "1",
      sessionId: session.sessionId,
      pauseGeneration: 1,
      startFrame: 0,
      levels: 64,
    });
    const text = await response.text();
    const body = JSON.parse(text) as {
      readonly frames: readonly unknown[];
      readonly retainedCount: number;
      readonly omittedCount: number;
      readonly nextCursor?: string;
    };
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
    expect(body.frames).toHaveLength(body.retainedCount);
    expect(body.retainedCount + body.omittedCount).toBe(64);
    expect(body.omittedCount).toBeGreaterThan(0);
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  });

  it("never returns raw host paths, target ids, capsule paths, or adapter identities", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    const targetId = "npm-script:sensitive-catalog-target";
    const response = await fetch(`${baseUrl()}/api/editor/debug/sessions`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Cookie: cookie },
      body: JSON.stringify({
        schemaVersion: "1",
        workspaceId,
        target: { kind: "catalog", targetId },
        activationRevision: ACTIVATION_REVISION,
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(manager.starts).toHaveLength(1);
    expect(manager.starts[0]).toMatchObject({ adapterRuntime: "node", adapterProviderId: "node" });
    for (const secret of [workspaceRoot, stateDir, targetId, "/keiko-execution-root"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("adapterRuntime");
    expect(text).not.toContain("adapterProviderId");
    expect(text).not.toContain('"node"');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHttpResponseBytes,
    );
  });

  it("rejects malformed and hostile session identifiers without reflecting them", async () => {
    enableDebug();
    const cookie = cookieFrom(await bootstrap());
    for (const sessionId of ["%00", "..", "${hostile}", "a".repeat(129)]) {
      const response = await fetch(
        `${baseUrl()}/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
        { headers: { Cookie: cookie } },
      );
      const text = await response.text();
      expect(response.status).toBe(404);
      expect(text).not.toContain(sessionId);
      expect(text).not.toContain(workspaceRoot);
    }
  });

  it("streams bounded replay, ready, live event, heartbeat, and close cleanup via shared SSE", async () => {
    vi.useFakeTimers();
    try {
      enableDebug();
      const service = debugService();
      const issued = service.browserSessions.issue(workspacePartition);
      if (!issued.ok) throw new Error("invalid browser capability fixture");
      const cookie = issued.setCookies.map((value) => value.split(";", 1)[0] ?? "").join("; ");
      const capability =
        cookie
          .split("; ")
          .find((value) => value.startsWith(`${DEBUG_BROWSER_COOKIE_NAME}=`))
          ?.split("=", 2)[1] ?? "";
      const response = new FakeSseResponse();
      const deps = { ...handlerDeps(), dapDebug: service };

      const outcome = await handleDebugEvents(eventContext(cookie, response), deps);
      expect(outcome).toBe(STREAMING);
      expect(response.status).toBe(200);
      expect(response.headers).toStrictEqual(SSE_HEADERS);
      expect(response.writes.join("")).toContain("event: editor-debug:snapshot");
      expect(response.writes.join("")).toContain("event: ready\ndata: {}\n\n");

      expect(
        service.events.publish(
          {
            workspacePartitionKey: workspacePartition,
            browserSessionBinding: breakpointStoreWorkspaceFingerprint(capability),
          },
          {
            kind: "breakpoints-changed",
            workspaceId,
            revision: 1,
            breakpointCount: 1,
            verifiedCount: 0,
          },
        ),
      ).toBe(true);
      const live = response.writes.join("");
      expect(live).toContain("id: 1\nevent: editor-debug:breakpoints-changed\ndata:");

      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.writes).toContain(": keep-alive\n\n");
      response.emit("close");
      const writesAfterClose = response.writes.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(response.writes).toHaveLength(writesAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

// KEIKO-0179 follow-up (Codex P1, twice-raised on PR #3141): a rename during an active debug
// session used to re-key the persisted store and tell the browser panel something changed, while
// the live DAP adapter stayed armed on the now-nonexistent old path. renameInstrumentation is the
// single owning-layer entry point files.ts's rename route now delegates to; these tests exercise it
// directly against a fake bound session + fake adapter transport (FakeDebugManager), reusing this
// file's existing fixtures rather than standing up a second one.
describe("renameInstrumentation orchestration (KEIKO-0179 follow-up, Codex P1 on PR #3141)", () => {
  // debugService() (used by the rest of this file) is a hand-rolled fixture whose
  // renameInstrumentation is a no-op stub -- these tests need the real, wired implementation, which
  // only the production factory attaches (createDapDebugRouteService's self-referencing closure).
  // eventBridge is accepted (rather than always built fresh) so a caller can subscribe a channel on
  // the exact bridge instance the service dispatches through before triggering a rename.
  function buildRenameService(eventBridge = createDapEventBridge()): DapDebugRouteService {
    return createDapDebugRouteService({
      production: { manager, eventBridge },
      stateDir,
      now: () => now,
      activation: () =>
        Promise.resolve({
          ok: true,
          schemaVersion: "1",
          adapterId: "node-typescript",
          revision: ACTIVATION_REVISION,
          state: "available",
          reasonCode: "AVAILABLE",
          policyResult: "allowed",
        }),
      diagnosticSink: {
        record: (record): void => {
          diagnosticRecords.push(record);
        },
      },
    });
  }

  async function bindLiveSession(browserSessionBinding: string): Promise<void> {
    await manager.start({
      identity: {
        sessionId: `${browserSessionBinding}-session`,
        workspaceId,
        workspacePartitionKey: workspacePartition,
        browserSessionBinding,
        targetKind: "file",
        activationRevision: ACTIVATION_REVISION,
        network: "none",
        filesystem: "executionRoot",
      },
      adapterRuntime: "node",
      adapterProviderId: "node-typescript",
      planCandidate: {},
    });
  }

  it("clears the old path and arms the new one on the adapter, publishing the change exactly once", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    await bindLiveSession("rename-binding");
    const publishSpy = vi.spyOn(service.events, "publish");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);

    const setBreakpointsCalls = manager.requests.filter(
      (entry) => entry.command === "setBreakpoints",
    );
    expect(setBreakpointsCalls).toHaveLength(2);
    expect(setBreakpointsCalls[0]?.args).toMatchObject({
      source: { path: "/keiko-execution-root/src/app.ts" },
      breakpoints: [],
    });
    const armCall = setBreakpointsCalls[1]?.args as { readonly breakpoints: readonly unknown[] };
    expect(setBreakpointsCalls[1]?.args).toMatchObject({
      source: { path: "/keiko-execution-root/src/renamed.ts" },
    });
    expect(armCall.breakpoints).toHaveLength(1);

    expect(publishSpy).toHaveBeenCalledExactlyOnceWith(
      { workspacePartitionKey: workspacePartition, browserSessionBinding: "rename-binding" },
      expect.objectContaining({ kind: "breakpoints-changed", workspaceId }),
    );

    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId)).toEqual([
        "src/renamed.ts",
      ]);
      expect(migrated.snapshot.breakpoints[0]?.verification).toBe("verified");
    }
  });

  it("re-arms a renamed path from the latest snapshot after verification drift", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    await bindLiveSession("rename-drift-binding");
    manager.delayedCommand = "setBreakpoints";

    const rename = service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);
    await vi.waitFor(() => {
      const calls = manager.requests.filter((entry) => entry.command === "setBreakpoints");
      expect(calls).toHaveLength(1);
      expect(breakpointRequestPath(requiredFirst(calls).args)).toBe(
        "/keiko-execution-root/src/app.ts",
      );
    });
    manager.delayedCommand = undefined;
    const renamed = service.breakpoints.snapshot(workspaceRoot);
    if (!renamed.ok) throw new Error("expected a renamed breakpoint snapshot");
    const concurrentEdit = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      renamed.snapshot.revision,
      renamed.snapshot.etag,
      "src/renamed.ts",
      [{ line: 9, enabled: true }],
    );
    expect(concurrentEdit.ok).toBe(true);

    manager.releaseDelayedRequest();
    await rename;

    const calls = manager.requests.filter((entry) => entry.command === "setBreakpoints");
    expect(calls.map((entry) => breakpointRequestPath(entry.args))).toStrictEqual([
      "/keiko-execution-root/src/app.ts",
      "/keiko-execution-root/src/renamed.ts",
      "/keiko-execution-root/src/renamed.ts",
    ]);
    expect(calls.map((entry) => breakpointRequestLines(entry.args))).toStrictEqual([[], [4], [9]]);
    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints).toMatchObject([
        { fileId: "src/renamed.ts", line: 9, verification: "verified" },
      ]);
    }
  });

  it("re-keys the store but never touches the adapter when no debug session is bound", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    const publishSpy = vi.spyOn(service.events, "publish");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);

    expect(manager.requests.filter((entry) => entry.command === "setBreakpoints")).toHaveLength(0);
    expect(publishSpy).not.toHaveBeenCalled();
    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId)).toEqual([
        "src/renamed.ts",
      ]);
    }
  });

  it("reconciles every pair in one call and publishes once for a directory rename", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(secondWorkspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const first = service.breakpoints.setBreakpointsForFile(
      secondWorkspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 1, enabled: true }],
    );
    expect(first.ok).toBe(true);
    const second = service.breakpoints.setBreakpointsForFile(
      secondWorkspaceRoot,
      first.snapshot.revision,
      first.snapshot.etag,
      "src/lib.ts",
      [{ line: 2, enabled: true }],
    );
    expect(second.ok).toBe(true);
    const secondWorkspacePartition =
      inspectDebugWorkspaceIdentity(secondWorkspaceRoot).identityDigest;
    await manager.start({
      identity: {
        sessionId: "dir-rename-session",
        workspaceId: secondWorkspaceId,
        workspacePartitionKey: secondWorkspacePartition,
        browserSessionBinding: "dir-rename-binding",
        targetKind: "file",
        activationRevision: ACTIVATION_REVISION,
        network: "none",
        filesystem: "executionRoot",
      },
      adapterRuntime: "node",
      adapterProviderId: "node-typescript",
      planCandidate: {},
    });
    const publishSpy = vi.spyOn(service.events, "publish");

    await service.renameInstrumentation(secondWorkspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "lib/app.ts" },
      { previousFileId: "src/lib.ts", nextFileId: "lib/lib.ts" },
    ]);

    expect(manager.requests.filter((entry) => entry.command === "setBreakpoints")).toHaveLength(4);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const migrated = service.breakpoints.snapshot(secondWorkspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId).sort()).toEqual([
        "lib/app.ts",
        "lib/lib.ts",
      ]);
    }
  });

  // Review round 8, Codex P2 (finding A): reconcileRenamedPair used to discard the old-path clear's
  // outcome outright, so an adapter reject/timeout there was invisible -- the new path still got
  // armed and the change still published as a clean success, leaving the adapter possibly armed at
  // both the renamed-away old path and the new one with zero diagnostic.
  it("diagnoses a rejected old-path clear but still arms the new path and publishes", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    await bindLiveSession("reject-old-path-binding");
    manager.rejectedSetBreakpointsSourcePath = "/keiko-execution-root/src/app.ts";
    const publishSpy = vi.spyOn(service.events, "publish");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);

    const setBreakpointsCalls = manager.requests.filter(
      (entry) => entry.command === "setBreakpoints",
    );
    expect(setBreakpointsCalls).toHaveLength(2);
    expect(setBreakpointsCalls[0]?.args).toMatchObject({
      source: { path: "/keiko-execution-root/src/app.ts" },
    });
    const armCall = setBreakpointsCalls[1]?.args as { readonly breakpoints: readonly unknown[] };
    expect(setBreakpointsCalls[1]?.args).toMatchObject({
      source: { path: "/keiko-execution-root/src/renamed.ts" },
    });
    expect(armCall.breakpoints).toHaveLength(1);

    // The new path is armed and verified regardless of the old-path clear having been rejected.
    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId)).toEqual([
        "src/renamed.ts",
      ]);
      expect(migrated.snapshot.breakpoints[0]?.verification).toBe("verified");
    }

    // The change still publishes exactly once, reporting the reconciled new-path state.
    expect(publishSpy).toHaveBeenCalledExactlyOnceWith(
      {
        workspacePartitionKey: workspacePartition,
        browserSessionBinding: "reject-old-path-binding",
      },
      expect.objectContaining({ kind: "breakpoints-changed", workspaceId }),
    );

    // The degraded old-path clear is surfaced as its own redacted diagnostic, distinct from the
    // outer best-effort catch's operation tag -- this is the fix: on unfixed code this array is
    // empty because the old-path clear's outcome was discarded before ever reaching a diagnostic.
    const degraded = diagnosticRecords.filter(
      (record) =>
        record.operation === "dap.debug-routes.rename-instrumentation.old-path-clear-degraded",
    );
    expect(degraded).toHaveLength(1);
    expect(JSON.stringify(degraded)).not.toContain(workspaceRoot);
    expect(JSON.stringify(degraded)).not.toContain("src/app.ts");
  });

  // Review round 8, Codex P2 (finding B): EditorDebugSessionHost opens the browser's SSE debug-event
  // stream and bootstraps instrumentation before any debuggee launches, so a rename can land while a
  // stream is already subscribed on the workspace's partition yet no DapProcessManager session is
  // bound anywhere. The subscribed panel must still learn about the rename.
  it("publishes to an already-subscribed SSE channel on rename even when no debug session is bound", async () => {
    const eventBridge = createDapEventBridge();
    const service = buildRenameService(eventBridge);
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);

    const received: unknown[] = [];
    const subscription = eventBridge.subscribe({
      channel: {
        workspacePartitionKey: workspacePartition,
        browserSessionBinding: "pre-launch-binding",
      },
      onEvent: (envelope) => {
        received.push(envelope.event);
      },
    });
    expect(subscription.kind).toBe("ok");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);

    // No live session anywhere -- the adapter is never touched.
    expect(manager.requests.filter((entry) => entry.command === "setBreakpoints")).toHaveLength(0);
    // But the already-open SSE stream still learns about the rename -- on unfixed code this array is
    // empty because runRenameInstrumentation returns as soon as liveDebugWorkspace is undefined.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "breakpoints-changed", workspaceId });

    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId)).toEqual([
        "src/renamed.ts",
      ]);
    }
  });

  // Codex review round 5 on PR #3141: a renameFile rejection used to vanish — the pair was skipped
  // silently, and an all-rejected migration returned with no diagnostic and no event, leaving the
  // old-path breakpoints orphaned with nothing to tell an operator why.
  it("diagnoses a rejected re-key (destination over the per-file cap) instead of returning silently", async () => {
    const service = buildRenameService();
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const capFill = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/full.ts",
      Array.from({ length: 64 }, (_, index) => ({ line: index + 1, enabled: true })),
    );
    expect(capFill.ok).toBe(true);
    if (!capFill.ok) throw new Error("expected the cap fill to commit");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      capFill.snapshot.revision,
      capFill.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    const publishSpy = vi.spyOn(service.events, "publish");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/full.ts" },
    ]);

    const rejected = diagnosticRecords.filter((record) =>
      record.operation.endsWith("re-key-rejected"),
    );
    expect(rejected).toHaveLength(1);
    expect(publishSpy).not.toHaveBeenCalled();
    const untouched = service.breakpoints.snapshot(workspaceRoot);
    expect(untouched.ok).toBe(true);
    if (untouched.ok) {
      const perFile = untouched.snapshot.breakpoints.map((entry) => entry.fileId);
      expect(perFile.filter((fileId) => fileId === "src/app.ts")).toHaveLength(1);
      expect(perFile.filter((fileId) => fileId === "src/full.ts")).toHaveLength(64);
    }
  });

  // Codex P2 (real, PR #3141): with an active session, a throw from
  // reconcileRenamedInstrumentation (malformed adapter response, unexpected error) used to land in
  // runRenameInstrumentation's catch, which only emitted the diagnostic -- the store had already
  // committed the rename (renameBreakpointRecords runs before the try), but nothing ever told a
  // subscribed panel, so it kept the OLD fileIds/revision indefinitely. On unfixed code the
  // `received` array below stays empty because the catch is diagnostic-only.
  it("still publishes the migrated snapshot to a subscribed channel when adapter reconciliation throws", async () => {
    const eventBridge = createDapEventBridge();
    const service = buildRenameService(eventBridge);
    const initial = service.breakpoints.snapshot(workspaceRoot);
    if (!initial.ok) throw new Error("expected an available breakpoint snapshot");
    const armed = service.breakpoints.setBreakpointsForFile(
      workspaceRoot,
      initial.snapshot.revision,
      initial.snapshot.etag,
      "src/app.ts",
      [{ line: 4, enabled: true }],
    );
    expect(armed.ok).toBe(true);
    if (!armed.ok) throw new Error("expected the arm to commit");
    const preRenameRevision = armed.snapshot.revision;

    await bindLiveSession("malformed-reconcile-binding");
    // Every setBreakpoints call (old-path clear and new-path arm alike) resolves with a body that
    // fails adapter-shape validation, so verificationUpdates throws DAP_RESPONSE_INVALID out of the
    // reconciliation loop instead of returning normally.
    manager.malformedCommand = "setBreakpoints";

    const received: unknown[] = [];
    const subscription = eventBridge.subscribe({
      channel: {
        workspacePartitionKey: workspacePartition,
        browserSessionBinding: "malformed-reconcile-binding",
      },
      onEvent: (envelope) => {
        received.push(envelope.event);
      },
    });
    expect(subscription.kind).toBe("ok");

    await service.renameInstrumentation(workspaceRoot, [
      { previousFileId: "src/app.ts", nextFileId: "src/renamed.ts" },
    ]);

    // The diagnostic still fires -- reconciliation genuinely failed.
    const failures = diagnosticRecords.filter(
      (record) => record.operation === "dap.debug-routes.rename-instrumentation",
    );
    expect(failures).toHaveLength(1);

    // But the already-migrated (pre-verification) snapshot still reaches the subscribed channel.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "breakpoints-changed", workspaceId });
    const event = received[0] as { readonly revision: number };
    expect(event.revision).toBeGreaterThanOrEqual(preRenameRevision);

    const migrated = service.breakpoints.snapshot(workspaceRoot);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) {
      expect(migrated.snapshot.breakpoints.map((entry) => entry.fileId)).toEqual([
        "src/renamed.ts",
      ]);
    }
  });
});
