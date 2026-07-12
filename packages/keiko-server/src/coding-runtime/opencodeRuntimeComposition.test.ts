import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessBackend,
  type RuntimeProcessTree,
  type RuntimeSupervisorLaunchRequest,
} from "./runtimeProcessSupervisor.js";
import type { CodingToolFacade } from "./codingToolFacadePorts.js";
import {
  OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeProtocolSurface,
} from "./opencodeProtocolSurface.js";
import { CODING_TOOL_MAX_BODY_BYTES } from "./codingToolIpc.js";

const dirs: string[] = [];
const MODEL_CAPABILITY = "m".repeat(43);
const TOOL_CAPABILITY = "t".repeat(43);
const FIXTURE_RUN_ID = "run-2254";
const OPENCODE_VERSION = "1.17.17";
const FIXED_SESSION_TITLE = "Keiko governed runtime";
const OPENCODE_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const OPENAPI = {
  openapi: "3.1.0",
  paths: {
    "/global/health": {
      get: {
        security: [{ basicAuth: [] }],
        responses: {
          "200": { $ref: "#/components/responses/Health" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/global/event": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/EventStream" } },
      },
    },
    "/doc": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/sync/history": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/History" } },
      },
    },
    "/session": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Sessions" } },
      },
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Session" } },
      },
    },
    "/session/status": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/SessionStatus" } },
      },
    },
    "/session/{sessionID}/prompt_async": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/session/{sessionID}/abort": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/permission": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/permission/{requestID}/reply": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/question": {
      get: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/question/{requestID}/reply": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
    "/question/{requestID}/reject": {
      post: {
        security: [{ basicAuth: [] }],
        responses: { "200": { $ref: "#/components/responses/Health" } },
      },
    },
  },
  components: {
    securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
    responses: {
      Health: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
      },
      Unauthorized: { description: "unauthorized" },
      EventStream: { content: { "text/event-stream": { schema: { type: "string" } } } },
      History: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/History" } } },
      },
      Sessions: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/SessionList" } } },
      },
      Session: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
      },
      SessionStatus: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/SessionStatusMap" } },
        },
      },
    },
    schemas: {
      Health: {
        type: "object",
        required: ["healthy", "version"],
        properties: { healthy: { type: "boolean" }, version: { type: "string" } },
      },
      History: { type: "array", items: { $ref: "#/components/schemas/Event" } },
      Event: {
        type: "object",
        required: ["id", "aggregate_id", "seq", "type", "data"],
        properties: {
          id: { type: "string" },
          aggregate_id: { type: "string" },
          seq: { type: "integer" },
          type: { type: "string" },
          data: { type: "object" },
        },
      },
      Session: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      SessionList: {
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
      SessionStatusMap: {
        type: "object",
        additionalProperties: { $ref: "#/components/schemas/SessionStatus" },
      },
      SessionStatus: {
        oneOf: [
          { type: "object", required: ["type"], properties: { type: { const: "idle" } } },
          { type: "object", required: ["type"], properties: { type: { const: "busy" } } },
          {
            type: "object",
            required: ["type", "attempt", "message", "next"],
            properties: {
              type: { const: "retry" },
              attempt: { type: "integer" },
              message: { type: "string" },
              next: { type: "number" },
            },
          },
        ],
      },
    },
  },
} as const;
const PROTOCOL_HANDSHAKE_DIGEST = projectOpenCodeProtocolSurface(OPENAPI).digest;

interface OpenCodeRuntimeComposition {
  readonly manager: {
    start(request: Record<string, unknown>): unknown;
    stop(runId: string): Promise<unknown>;
    health(): unknown;
  };
  readonly toolBridge: {
    readonly url: string;
    handle(input: {
      readonly method: "POST";
      readonly headers: Headers;
      readonly body: string;
    }): Promise<{ readonly status: number; readonly body: string }>;
  };
  readonly runPort: {
    readonly submitTask: (runId: string, text: string) => Promise<boolean>;
    readonly abortTask: (runId: string) => Promise<boolean>;
    readonly waitForTerminal: (runId: string, signal: AbortSignal) => Promise<boolean>;
    readonly listQuestions: (runId: string) => Promise<readonly TestQuestionRequest[]>;
    readonly answerQuestion: (
      runId: string,
      requestId: string,
      answers: readonly (readonly string[])[],
    ) => Promise<boolean>;
    readonly rejectQuestion: (runId: string, requestId: string) => Promise<boolean>;
  };
}

interface TestQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
  }[];
}

interface OpenCodeRuntimeCompositionModule {
  createOpenCodeRuntimeComposition(input: {
    readonly portable: {
      readonly verification: PortableSidecarRuntimeVerification & {
        readonly protocolSchemaRawSha256: string;
        readonly protocolHandshakeDigest: string;
        readonly protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1";
      };
      readonly resourceRoot: string;
      readonly target: "macos-arm64";
    };
    readonly stateBaseRoot: string;
    readonly capabilities: {
      readonly modelGatewayCapability: string;
      readonly toolFacadeCapability: string;
    };
    /** Private bridge limits are intentionally configurable for deterministic boundary tests. */
    readonly toolBridge?: {
      readonly requestDeadlineMs: number;
      readonly maxInFlight: number;
    };
    readonly toolFacade: CodingToolFacade;
    readonly governedEventSink: {
      readonly execute: (
        identityKey: string,
        event: Readonly<Record<string, unknown>>,
      ) => Promise<"applied" | "duplicate">;
    };
    readonly gatewayReadiness: {
      readonly waitForObservedRequest: () => Promise<boolean>;
      readonly clear: () => void;
    };
    readonly fetch: typeof globalThis.fetch;
    readonly supervisor: ReturnType<typeof createRuntimeProcessSupervisor>;
    readonly authorityLifecycle: {
      readonly revokeRuntime: (runId: string) => boolean | Promise<boolean>;
      readonly abortInFlightActions: (runId: string) => boolean | Promise<boolean>;
      readonly markRuntimeRecoveryRequired: (runId: string) => boolean | Promise<boolean>;
      readonly releaseRuntimeAfterReap: (
        runId: string,
        receipt: unknown,
      ) => boolean | Promise<boolean>;
    };
  }): OpenCodeRuntimeComposition;
}

async function compositionModule(): Promise<OpenCodeRuntimeCompositionModule> {
  const moduleName = "./opencodeRuntimeComposition.js";
  return (await import(moduleName)) as OpenCodeRuntimeCompositionModule;
}

function tempDir(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(value);
  return value;
}

function requestPath(url: URL | RequestInfo): string {
  if (typeof url === "string") return new URL(url).pathname;
  if (url instanceof URL) return url.pathname;
  return new URL(url.url).pathname;
}

function portableFixture(resourceRoot: string): {
  readonly executablePath: string;
  readonly verification: PortableSidecarRuntimeVerification & {
    readonly protocolSchemaRawSha256: string;
    readonly protocolHandshakeDigest: string;
    readonly protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1";
  };
} {
  const payloadRootPath = "runtime/sidecars/opencode-compatible";
  const payloadRoot = join(resourceRoot, payloadRootPath);
  const executablePath = join(payloadRoot, "opencode");
  mkdirSync(payloadRoot, { recursive: true });
  writeFileSync(executablePath, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(executablePath, 0o755);
  writeFileSync(join(payloadRoot, "LICENSE"), "approved license\n");
  writeFileSync(join(payloadRoot, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  const digest = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const executableDigest = digest(executablePath);
  const licenseDigest = digest(join(payloadRoot, "LICENSE"));
  const sbomDigest = digest(join(payloadRoot, "sbom.cdx.json"));
  const executableTreeSha256 = createHash("sha256")
    .update(`opencode\0${executableDigest}\0`, "utf8")
    .digest("hex");
  const payloadSha256 = createHash("sha256")
    .update(
      `LICENSE\0${licenseDigest}\0opencode\0${executableDigest}\0sbom.cdx.json\0${sbomDigest}\0`,
      "utf8",
    )
    .digest("hex");
  return {
    executablePath,
    verification: {
      payloadRootPath,
      executablePath: `${payloadRootPath}/opencode`,
      shippedExecutableSha256: executableDigest,
      executableTreeSha256,
      licenseEvidencePath: `${payloadRootPath}/LICENSE`,
      licenseEvidenceSha256: licenseDigest,
      sbomEvidencePath: `${payloadRootPath}/sbom.cdx.json`,
      sbomEvidenceSha256: sbomDigest,
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: OPENCODE_VERSION,
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        protocolVersion: "http-sse",
        platformTarget: "macos-arm64",
        payloadSha256,
        payloadSha256Prefix: payloadSha256.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
      availability: {
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      },
      protocolSchemaRawSha256: OPENCODE_SCHEMA_SHA256,
      protocolHandshakeDigest: PROTOCOL_HANDSHAKE_DIGEST,
      protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1",
    },
  };
}

interface HttpResult {
  readonly status: number;
  readonly body: Buffer;
}

function openHttpRequest(
  url: string,
  options: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): { readonly client: ClientRequest; readonly response: Promise<HttpResult> } {
  let settle = (_result: HttpResult): void => undefined;
  const response = new Promise<HttpResult>((resolve) => {
    settle = resolve;
  });
  const client = httpRequest(
    url,
    { method: options.method ?? "POST", headers: options.headers, agent: false },
    (result) => {
      const chunks: Buffer[] = [];
      result.on("data", (chunk: Buffer) => chunks.push(chunk));
      result.on("end", () => {
        settle({ status: result.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    },
  );
  // Disconnects are expected in cancellation tests; the assertion is on the facade signal.
  client.on("error", () => {
    settle({ status: 0, body: Buffer.alloc(0) });
  });
  return { client, response };
}

async function responseBeforeEof(response: Promise<HttpResult>): Promise<HttpResult | undefined> {
  return await Promise.race([
    response,
    new Promise<undefined>((resolve) => {
      setTimeout(resolve, 250);
    }),
  ]);
}

async function startBridgeFixture(
  facade: CodingToolFacade,
  toolBridge: { readonly requestDeadlineMs: number; readonly maxInFlight: number } = {
    requestDeadlineMs: 50,
    maxInFlight: 1,
  },
  control?: {
    readonly startTimeoutMs?: number;
    readonly historyResponse?: Promise<Response>;
    readonly expectedStart?: Readonly<Record<string, unknown>>;
    readonly onSseCancel?: () => void;
    readonly sseFrame?: string;
    readonly historyCalls?: Readonly<Record<string, number>>[];
    readonly governedEvents?: Readonly<Record<string, unknown>>[];
    readonly runControl?: {
      readonly promptBodies: string[];
      readonly abortSessions: string[];
      readonly statusResponses: unknown[];
      readonly questionResponses?: unknown[];
      readonly questionRequests?: {
        readonly method: string;
        readonly path: string;
        readonly body?: string;
      }[];
    };
    readonly afterStart?: (
      runtime: OpenCodeRuntimeComposition,
      runRoot: string,
    ) => void | Promise<void>;
  },
): Promise<{ readonly runtime: OpenCodeRuntimeComposition; stop(): Promise<void> }> {
  const root = tempDir("keiko-opencode-tool-bridge-");
  const resourceRoot = join(root, "resources");
  const portable = portableFixture(resourceRoot);
  mkdirSync(join(root, "workspace"), { recursive: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const supervisor = createRuntimeProcessSupervisor({
    backend: {
      identity: { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" },
      spawnOwnedTree: (): RuntimeProcessTree => {
        stdout.end("opencode server listening on http://127.0.0.1:43123\n");
        return {
          treeId: "tool-bridge-tree",
          stdout,
          stderr,
          onTreeExit: (): void => undefined,
        };
      },
      signalTree: (): void => undefined,
      waitForCompleteTreeExit: (): Promise<true> => Promise.resolve(true),
      reconcileTreeExit: (): Promise<false> => Promise.resolve(false),
    },
    qualifications: [
      {
        platform: "darwin",
        arch: "arm64",
        backend: "macos-app-sandbox",
        releaseReceipt: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  const sseFrame = new TextEncoder().encode(
    control?.sseFrame ??
      'data: {"payload":{"id":"evt_server","type":"server.connected","properties":{}}}\n\n',
  );
  let readinessAbortPending = false;
  // eslint-disable-next-line complexity -- finite mock endpoint table is intentionally explicit.
  const fetch = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
    const path = requestPath(url);
    if (path === "/global/health" && new Headers(init?.headers).get("authorization") === null)
      return Promise.resolve(new Response("", { status: 401 }));
    if (path === "/global/health")
      return Promise.resolve(
        new Response(JSON.stringify({ healthy: true, version: OPENCODE_VERSION }), {
          headers: { "content-type": "application/json" },
        }),
      );
    if (path === "/doc")
      return Promise.resolve(
        new Response(JSON.stringify(OPENAPI), { headers: { "content-type": "application/json" } }),
      );
    if (path === "/global/event")
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller): void {
              controller.enqueue(sseFrame);
            },
            cancel(): void {
              control?.onSseCancel?.();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    if (path === "/sync/history") {
      if (control?.historyCalls !== undefined && typeof init?.body === "string") {
        control.historyCalls.push(JSON.parse(init.body) as Readonly<Record<string, number>>);
      }
      return (
        control?.historyResponse ??
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt_created",
                aggregate_id: "ses_tool",
                seq: 0,
                type: "session.created.1",
                data: { sessionID: "ses_tool", info: { id: "ses_tool", title: "private" } },
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        )
      );
    }
    if (path.endsWith("/prompt_async")) {
      if (typeof init?.body === "string" && init.body.includes("runtime readiness handshake")) {
        readinessAbortPending = true;
      } else if (typeof init?.body === "string") {
        control?.runControl?.promptBodies.push(init.body);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith("/abort")) {
      if (readinessAbortPending) readinessAbortPending = false;
      else control?.runControl?.abortSessions.push(path.split("/")[2] ?? "");
      return Promise.resolve(
        new Response("true", { headers: { "content-type": "application/json" } }),
      );
    }
    if (path === "/session/status") {
      const statuses = control?.runControl?.statusResponses;
      const value = statuses?.length === 1 ? statuses[0] : statuses?.shift();
      return Promise.resolve(
        new Response(JSON.stringify(value ?? {}), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (path === "/question") {
      const responses = control?.runControl?.questionResponses;
      const value = responses?.length === 1 ? responses[0] : responses?.shift();
      return Promise.resolve(
        new Response(JSON.stringify(value ?? []), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (path.startsWith("/question/")) {
      control?.runControl?.questionRequests?.push({
        method: init?.method ?? "GET",
        path,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Promise.resolve(
        new Response("true", { headers: { "content-type": "application/json" } }),
      );
    }
    if (path === "/session" && init?.method === "POST")
      return Promise.resolve(
        new Response('{"id":"ses_tool"}', { headers: { "content-type": "application/json" } }),
      );
    if (path === "/session")
      return Promise.resolve(
        new Response('[{"id":"ses_tool"}]', { headers: { "content-type": "application/json" } }),
      );
    return Promise.resolve(new Response("", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
  const readinessAwareFacade: CodingToolFacade = {
    execute: (input) =>
      input.body === '{"action":"permission-event","requestId":"keiko-readiness"}'
        ? Promise.resolve({ status: "observed", evidence: [] })
        : facade.execute(input),
  };
  const runtime = (await compositionModule()).createOpenCodeRuntimeComposition({
    portable: { verification: portable.verification, resourceRoot, target: "macos-arm64" },
    stateBaseRoot: join(root, "state"),
    capabilities: {
      modelGatewayCapability: MODEL_CAPABILITY,
      toolFacadeCapability: TOOL_CAPABILITY,
    },
    toolBridge,
    toolFacade: readinessAwareFacade,
    governedEventSink: {
      execute: (_identityKey, event): Promise<"applied"> => {
        control?.governedEvents?.push(event);
        return Promise.resolve("applied");
      },
    },
    gatewayReadiness: {
      waitForObservedRequest: (): Promise<boolean> => Promise.resolve(true),
      clear: (): void => undefined,
    },
    fetch,
    supervisor,
    authorityLifecycle: {
      revokeRuntime: (): true => true,
      abortInFlightActions: (): true => true,
      markRuntimeRecoveryRequired: (): true => true,
      releaseRuntimeAfterReap: (): true => true,
    },
  });
  const started = await Promise.resolve(
    runtime.manager.start({
      runId: FIXTURE_RUN_ID,
      treeBindingId: "b".repeat(64),
      taskRef: "issue-2254",
      workspaceRoot: join(root, "workspace"),
      adapterKind: "opencode-compatible",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      requestedMode: "supervised-coding",
      effectiveMode: "supervised-coding",
      executablePath: portable.executablePath,
      managedRoot: join(resourceRoot, "runtime/sidecars/opencode-compatible"),
      gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      modelProfileId: "coding-safe-openai-compatible",
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: 20,
      startTimeoutMs: control?.startTimeoutMs ?? 100,
      confinement: {
        platform: "darwin",
        arch: "arm64",
        backend: "macos-app-sandbox",
        releaseReceipt: `sha256:${"a".repeat(64)}`,
      },
    }),
  );
  expect(started).toEqual(
    control?.expectedStart ?? { ok: true, runId: FIXTURE_RUN_ID, status: "ready" },
  );
  await control?.afterStart?.(runtime, join(root, "state", FIXTURE_RUN_ID));
  return {
    runtime,
    stop: async (): Promise<void> => {
      await runtime.manager.stop(FIXTURE_RUN_ID);
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unmounted OpenCode runtime composition", () => {
  // eslint-disable-next-line complexity -- this audit fixture keeps lifecycle evidence co-located.
  it("prepares secret-safe state before spawn, proves the private runtime, and disposes only after reap", async () => {
    expect(OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256).toBe(
      "e1db492f2ac661f2b44da6ef3d7e58ed34856621a2c58de4610640e1291266f6",
    );
    const root = tempDir("keiko-opencode-composition-");
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "resources");
    const portable = portableFixture(resourceRoot);
    const executable = portable.executablePath;
    const stateBaseRoot = join(root, "state-base");
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(workspaceRoot, "opencode.json"),
      JSON.stringify({ model: "hostile/model", tools: { bash: true } }),
    );
    mkdirSync(join(workspaceRoot, ".opencode"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".opencode", "opencode.json"),
      JSON.stringify({ permission: { "*": "allow" }, tools: { edit: true } }),
    );
    const order: string[] = [];
    let launch: RuntimeSupervisorLaunchRequest | undefined;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exits: ((code: number | null) => void)[] = [];
    let releaseReap: (() => void) | undefined;
    const backend: RuntimeProcessBackend = {
      identity: { platform: "darwin", arch: "arm64", backend: "macos-app-sandbox" },
      spawnOwnedTree: (request): RuntimeProcessTree => {
        order.push("spawn");
        launch = request;
        stdout.end("opencode server listening on http://127.0.0.1:43123\n");
        return {
          treeId: "tree-1",
          stdout,
          stderr,
          onTreeExit: (callback): void => {
            exits.push(callback);
          },
        };
      },
      signalTree: (): void => {
        order.push("terminate");
      },
      waitForCompleteTreeExit: (): Promise<boolean> =>
        new Promise((resolve) => {
          releaseReap = (): void => {
            for (const callback of exits) callback(0);
            resolve(true);
          };
        }),
      reconcileTreeExit: (): Promise<boolean> => Promise.resolve(false),
    };
    const supervisor = createRuntimeProcessSupervisor({
      backend,
      qualifications: [
        {
          platform: "darwin",
          arch: "arm64",
          backend: "macos-app-sandbox",
          releaseReceipt: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    const sseControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const sseCancellations: number[] = [];
    const sseFrame = new TextEncoder().encode(
      'event: message\ndata: {"payload":{"id":"evt_server","type":"server.connected","properties":{}}}\n\n',
    );
    const stream = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller): void {
          sseControllers.push(controller);
          controller.enqueue(sseFrame);
        },
        cancel(): void {
          sseCancellations.push(sseControllers.length - 1);
          order.push("sse-cancel");
        },
      });
    let readinessStatusReads = 0;
    // eslint-disable-next-line complexity -- the finite mock endpoint table is intentionally explicit.
    const fetchMock = vi.fn((url: URL | RequestInfo, init?: RequestInit) => {
      const path = requestPath(url);
      const authorization = new Headers(init?.headers).get("authorization");
      if (path === "/global/health" && authorization === null)
        return Promise.resolve(new Response("", { status: 401 }));
      expect(authorization).toMatch(/^Basic /u);
      if (path === "/global/health")
        return Promise.resolve(
          new Response(JSON.stringify({ healthy: true, version: OPENCODE_VERSION }), {
            headers: { "content-type": "application/json" },
          }),
        );
      if (path === "/doc") {
        return Promise.resolve(
          new Response(JSON.stringify(OPENAPI), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (path === "/global/event") {
        init?.signal?.addEventListener("abort", () => order.push("sse-abort"), { once: true });
        return Promise.resolve(
          new Response(stream(), { headers: { "content-type": "text/event-stream" } }),
        );
      }
      if (path === "/sync/history")
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt_created",
                aggregate_id: "ses_1",
                seq: 0,
                type: "session.created.1",
                data: { sessionID: "ses_1", info: { id: "ses_1", title: "private" } },
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        );
      if (path.endsWith("/prompt_async"))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (path.endsWith("/abort"))
        return Promise.resolve(
          new Response("false", { headers: { "content-type": "application/json" } }),
        );
      if (path === "/session/status")
        return Promise.resolve(
          new Response(
            JSON.stringify(readinessStatusReads++ < 4 ? { ses_1: { type: "busy" } } : {}),
            { headers: { "content-type": "application/json" } },
          ),
        );
      if (path === "/session" && init?.method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify({ id: "ses_1" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      if (path === "/session")
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "ses_1" }]), {
            headers: { "content-type": "application/json" },
          }),
        );
      return Promise.resolve(new Response("", { status: 404 }));
    });
    const fetch = fetchMock as unknown as typeof globalThis.fetch;
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) =>
        Promise.resolve(
          input.body === '{"action":"permission-event","requestId":"keiko-readiness"}'
            ? { status: "observed", evidence: [] }
            : {
                status: "completed",
                evidence: [],
                read: { text: "file contents", byteCount: 13, digest: "d".repeat(64) },
              },
        ),
      ) as CodingToolFacade["execute"],
    };
    const authorityOrder: string[] = [];
    const governedEvents: Readonly<Record<string, unknown>>[] = [];
    const authorityLifecycle = {
      revokeRuntime: (runId: string): true => {
        authorityOrder.push(`revoke:${runId}`);
        return true;
      },
      abortInFlightActions: (runId: string): true => {
        authorityOrder.push(`abort:${runId}`);
        return true;
      },
      markRuntimeRecoveryRequired: (runId: string): true => {
        authorityOrder.push(`recovery:${runId}`);
        return true;
      },
      releaseRuntimeAfterReap: (runId: string): true => {
        authorityOrder.push(`release:${runId}`);
        return true;
      },
    };
    const runtime = (await compositionModule()).createOpenCodeRuntimeComposition({
      portable: { verification: portable.verification, resourceRoot, target: "macos-arm64" },
      stateBaseRoot,
      capabilities: {
        modelGatewayCapability: MODEL_CAPABILITY,
        toolFacadeCapability: TOOL_CAPABILITY,
      },
      toolFacade: facade,
      governedEventSink: {
        execute: (_identityKey, event): Promise<"applied"> => {
          governedEvents.push(event);
          return Promise.resolve("applied");
        },
      },
      gatewayReadiness: {
        waitForObservedRequest: (): Promise<boolean> => Promise.resolve(true),
        clear: (): void => undefined,
      },
      fetch,
      supervisor,
      authorityLifecycle,
    });

    await expect(
      Promise.resolve(
        runtime.manager.start({
          runId: "run-1",
          treeBindingId: "a".repeat(64),
          taskRef: "issue-2254",
          workspaceRoot,
          adapterKind: "opencode-compatible",
          runtimeSource: "keiko-sidecar",
          modelSource: "keiko-model-gateway",
          requestedMode: "supervised-coding",
          effectiveMode: "supervised-coding",
          executablePath: executable,
          managedRoot: join(resourceRoot, "runtime/sidecars/opencode-compatible"),
          gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
          modelProfileId: "coding-safe-openai-compatible",
          args: ["--caller"],
          inheritedEnvAllowlist: [],
          shutdownTimeoutMs: 5,
          startTimeoutMs: 100,
          confinement: {
            platform: "darwin",
            arch: "arm64",
            backend: "macos-app-sandbox",
            releaseReceipt: `sha256:${"a".repeat(64)}`,
          },
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(readinessStatusReads).toBe(5);
    const sessionCreate = fetchMock.mock.calls.find(
      ([url, init]) => requestPath(url) === "/session" && init?.method === "POST",
    );
    expect(sessionCreate?.[1]?.body).toBe(JSON.stringify({ title: FIXED_SESSION_TITLE }));
    expect(new Headers(sessionCreate?.[1]?.headers).get("content-type")).toBe("application/json");
    for (const [url, init] of fetchMock.mock.calls) {
      if (requestPath(url).endsWith("/prompt_async")) {
        expect(typeof init?.body).toBe("string");
        if (typeof init?.body === "string") {
          expect(init.body).not.toContain(FIXED_SESSION_TITLE);
        }
      }
    }
    // #2254: readiness consumes the hint, but must retain the authenticated stream for the
    // post-ready supervisor. The SSE payload is deliberately the exact nested message shape.
    expect(order).toEqual(["spawn"]);
    expect(sseCancellations).toEqual([]);
    expect(launch?.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"]);
    const runRoot = join(stateBaseRoot, "run-1");
    expect(launch?.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(launch?.env.OPENCODE_CONFIG_DIR).toBe(join(runRoot, "config", "opencode"));
    expect(
      fetchMock.mock.calls.some(([url]) => url instanceof URL && url.pathname === "/doc"),
    ).toBe(true);
    expect(
      new Set([
        launch?.env.KEIKO_MODEL_GATEWAY_CAPABILITY,
        launch?.env.KEIKO_TOOL_FACADE_CAPABILITY,
        launch?.env.OPENCODE_SERVER_PASSWORD,
      ]),
    ).toHaveLength(3);
    for (const path of [
      runRoot,
      join(runRoot, "config"),
      join(runRoot, "config", "opencode"),
      join(runRoot, "config", "opencode", "tools"),
      join(runRoot, "state"),
    ])
      expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const path of [
      join(runRoot, "config", "opencode", "opencode.json"),
      join(runRoot, "config", "opencode", "tools", "keiko_workspace_read.ts"),
      join(runRoot, "config", "opencode", "tools", "keiko_changeset_edit.ts"),
    ])
      expect(statSync(path).mode & 0o777).toBe(0o600);
    const files = [
      join(runRoot, "config", "opencode", "opencode.json"),
      join(runRoot, "config", "opencode", "tools", "keiko_workspace_read.ts"),
      join(runRoot, "config", "opencode", "tools", "keiko_changeset_edit.ts"),
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(files).not.toContain(MODEL_CAPABILITY);
    expect(files).not.toContain(TOOL_CAPABILITY);
    expect(files).not.toContain(launch?.env.OPENCODE_SERVER_PASSWORD ?? "");
    expect(files).not.toContain(FIXED_SESSION_TITLE);
    expect(JSON.stringify(governedEvents)).not.toContain(FIXED_SESSION_TITLE);
    expect(files).toContain("Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}");
    const paths = fetchMock.mock.calls.map(([url]) => requestPath(url));
    expect(paths.indexOf("/session")).toBeLessThan(paths.lastIndexOf("/session"));
    expect(paths.indexOf("/sync/history")).toBeGreaterThan(paths.indexOf("/session"));
    expect(new URL(runtime.toolBridge.url).hostname).toBe("127.0.0.1");
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: '{"action":"read"}',
      }),
    ).resolves.toEqual({
      status: 200,
      body: JSON.stringify({
        status: "completed",
        evidence: [],
        read: { text: "file contents", byteCount: 13, digest: "d".repeat(64) },
      }),
    });
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong", origin: "http://evil.test" }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong" }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 401 });
    expect(facade.execute).toHaveBeenCalledTimes(2);
    expect(facade.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: '{"action":"permission-event","requestId":"keiko-readiness"}',
        capability: TOOL_CAPABILITY,
      }),
    );
    const stopping = runtime.manager.stop("run-1");
    await vi.waitFor(() => {
      expect(order).toContain("terminate");
    });
    // Disposal is deferred until the supervisor provides an authentic reap result.
    expect(() => {
      accessSync(runRoot, constants.F_OK);
    }).not.toThrow();
    expect(sseCancellations).toEqual([0]);
    expect(order.indexOf("sse-abort")).toBeLessThan(order.indexOf("terminate"));
    releaseReap?.();
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(authorityOrder).toEqual(["revoke:run-1", "abort:run-1", "release:run-1"]);
    await expect(
      runtime.toolBridge.handle({
        method: "POST",
        headers: new Headers({ authorization: `Bearer ${TOOL_CAPABILITY}` }),
        body: '{"action":"read"}',
      }),
    ).resolves.toMatchObject({ status: 503 });
    expect(() => {
      accessSync(runRoot, constants.F_OK);
    }).toThrow();
  });
});

describe("private OpenCode run control", () => {
  const facade: CodingToolFacade = {
    execute: vi.fn(() =>
      Promise.resolve({
        status: "completed",
        evidence: [],
        read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
      }),
    ) as CodingToolFacade["execute"],
  };

  it("accepts a schema-compatible explicit idle readiness status", async () => {
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{ ses_tool: { type: "idle" } }],
      },
    });
    await fixture.stop();
  });

  it("stops terminal polling when the handshake deadline aborts", async () => {
    const fixture = await startBridgeFixture(facade, undefined, {
      startTimeoutMs: 35,
      expectedStart: { ok: false, failureCode: "start-timeout", retryable: true },
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{ ses_tool: { type: "busy" } }],
      },
    });
    expect(fixture.runtime.manager.health()).toEqual({ status: "stopped" });
    await fixture.stop();
  });

  it("syncs once for a non-fixed live control without identity catch-up or failure", async () => {
    const historyCalls: Readonly<Record<string, number>>[] = [];
    const fixture = await startBridgeFixture(facade, undefined, {
      sseFrame:
        'data: {"payload":{"id":"evt_live_only","type":"session.status","properties":{"sessionID":"ses_other","status":{"type":"busy"}}}}\n\n',
      historyCalls,
    });
    try {
      expect(historyCalls).toEqual([{}, { ses_tool: 0 }]);
    } finally {
      await fixture.stop();
    }
  });

  it("ignores status omission before activity, then completes on busy followed by omission", async () => {
    const prompt = "SENTINEL_PRIVATE_RUN_PROMPT";
    const governedEvents: Readonly<Record<string, unknown>>[] = [];
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}, {}, { ses_tool: { type: "busy" } }, {}] as unknown[],
    };
    let runRoot = "";
    const fixture = await startBridgeFixture(facade, undefined, {
      governedEvents,
      runControl,
      afterStart: (_runtime, root): void => {
        runRoot = root;
      },
    });

    await expect(fixture.runtime.runPort.submitTask("unknown-run", prompt)).resolves.toBe(false);
    await expect(fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, prompt)).resolves.toBe(true);
    const terminalWait = new AbortController();
    const terminalDeadline = setTimeout(() => {
      terminalWait.abort();
    }, 1_000);
    await expect(
      fixture.runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, terminalWait.signal),
    ).resolves.toBe(true);
    clearTimeout(terminalDeadline);
    expect(runControl.statusResponses).toEqual([{}]);
    await expect(fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID)).resolves.toBe(true);
    expect(runControl.abortSessions).toEqual(["ses_tool"]);
    expect(runControl.promptBodies).toEqual([
      JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    ]);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fixture.runtime.runPort.waitForTerminal(FIXTURE_RUN_ID, aborted.signal),
    ).resolves.toBe(false);
    const retained = [
      JSON.stringify(governedEvents),
      readFileSync(join(runRoot, "config", "opencode", "opencode.json"), "utf8"),
      readFileSync(join(runRoot, "config", "opencode", "tools", "keiko_workspace_read.ts"), "utf8"),
      readFileSync(join(runRoot, "config", "opencode", "tools", "keiko_changeset_edit.ts"), "utf8"),
    ].join("\n");
    expect(retained).not.toContain(prompt);

    await fixture.stop();
    await expect(fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "after stop")).resolves.toBe(
      false,
    );
    await expect(fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID)).resolves.toBe(false);
  });

  it("settles abort only after HTTP success and authoritative terminal control", async () => {
    const runControl = {
      promptBodies: [] as string[],
      abortSessions: [] as string[],
      statusResponses: [{}, { ses_tool: { type: "busy" } }] as unknown[],
    };
    const fixture = await startBridgeFixture(facade, undefined, { runControl });
    try {
      await expect(
        fixture.runtime.runPort.submitTask(FIXTURE_RUN_ID, "bounded abort task"),
      ).resolves.toBe(true);
      const terminal = fixture.runtime.runPort.waitForTerminal(
        FIXTURE_RUN_ID,
        AbortSignal.timeout(2_000),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      let abortSettled = false;
      const aborting = fixture.runtime.runPort.abortTask(FIXTURE_RUN_ID).finally(() => {
        abortSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runControl.abortSessions).toEqual(["ses_tool"]);
      expect(abortSettled).toBe(false);
      runControl.statusResponses.splice(0, 1, {});
      await expect(aborting).resolves.toBe(true);
      await expect(terminal).resolves.toBe(true);
    } finally {
      await fixture.stop();
    }
  });

  it("exposes only fixed-session questions through bounded answer and reject run controls", async () => {
    const questionRequests: {
      readonly method: string;
      readonly path: string;
      readonly body?: string;
    }[] = [];
    const pending = [
      {
        id: "que_fixed",
        sessionID: "ses_tool",
        questions: [
          {
            question: "Approve the bounded edit?",
            header: "Approval",
            options: [{ label: "Approve", description: "Continue" }],
          },
        ],
      },
      {
        id: "que_other",
        sessionID: "ses_other",
        questions: [{ question: "Private other session", header: "Other", options: [] }],
      },
    ];
    const fixture = await startBridgeFixture(facade, undefined, {
      runControl: {
        promptBodies: [],
        abortSessions: [],
        statusResponses: [{}],
        questionResponses: [pending],
        questionRequests,
      },
    });
    try {
      await expect(fixture.runtime.runPort.listQuestions("unknown-run")).resolves.toEqual([]);
      await expect(fixture.runtime.runPort.listQuestions(FIXTURE_RUN_ID)).resolves.toEqual([
        pending[0],
      ]);
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_other", [["Approve"]]),
      ).resolves.toBe(false);
      await expect(
        fixture.runtime.runPort.rejectQuestion("unknown-run", "que_fixed"),
      ).resolves.toBe(false);
      await expect(
        fixture.runtime.runPort.answerQuestion(FIXTURE_RUN_ID, "que_fixed", [["Approve"]]),
      ).resolves.toBe(true);
      await expect(
        fixture.runtime.runPort.rejectQuestion(FIXTURE_RUN_ID, "que_fixed"),
      ).resolves.toBe(true);
      expect(questionRequests).toEqual([
        { method: "POST", path: "/question/que_fixed/reply", body: '{"answers":[["Approve"]]}' },
        { method: "POST", path: "/question/que_fixed/reject" },
      ]);
      expect(JSON.stringify(questionRequests)).not.toContain("Approve the bounded edit?");
    } finally {
      await fixture.stop();
    }
  });
});

describe("private OpenCode tool bridge", () => {
  const completed = {
    status: "completed" as const,
    evidence: [],
    read: { text: "fixture", byteCount: 7, digest: "f".repeat(64) },
  };
  const authorized = { authorization: `Bearer ${TOOL_CAPABILITY}` };

  it("closes an adapter whose handshake succeeds after manager timeout disposal", async () => {
    let releaseHistory: (() => void) | undefined;
    const historyResponse = new Promise<Response>((resolve) => {
      releaseHistory = (): void => {
        resolve(
          new Response(
            JSON.stringify([
              {
                id: "evt_tool",
                aggregate_id: "ses_tool",
                seq: 0,
                type: "session.status",
                data: { sessionID: "ses_tool", status: "idle" },
              },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        );
      };
    });
    let sseCancellations = 0;
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(
      facade,
      { requestDeadlineMs: 1_000, maxInFlight: 1 },
      {
        startTimeoutMs: 20,
        historyResponse,
        expectedStart: { ok: false, failureCode: "start-timeout", retryable: true },
        onSseCancel: (): void => {
          sseCancellations += 1;
        },
        afterStart: async (runtime, runRoot): Promise<void> => {
          expect(runtime.manager.health()).toEqual({ status: "stopped" });
          expect(() => {
            accessSync(runRoot, constants.F_OK);
          }).toThrow();
          await expect(
            runtime.toolBridge.handle({
              method: "POST",
              headers: new Headers(authorized),
              body: "{}",
            }),
          ).resolves.toMatchObject({ status: 503 });
          releaseHistory?.();
          await vi.waitFor(() => {
            expect(sseCancellations).toBe(1);
          });
          expect(runtime.manager.health()).toEqual({ status: "stopped" });
        },
      },
    );
    await fixture.stop();
  });

  it("rejects an unauthorized chunked request before EOF or any facade call", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    const request = openHttpRequest(fixture.runtime.toolBridge.url, {
      headers: { "transfer-encoding": "chunked" },
    });
    try {
      request.client.write('{"action":"read"');
      await expect(responseBeforeEof(request.response)).resolves.toMatchObject({ status: 401 });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      request.client.end();
      await fixture.stop();
    }
  });

  it("rejects Origin, non-POST paths, and oversized declared bodies before reading them", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    const origin = openHttpRequest(fixture.runtime.toolBridge.url, {
      headers: {
        ...authorized,
        origin: "http://untrusted.invalid",
        "transfer-encoding": "chunked",
      },
    });
    const wrongMethod = openHttpRequest(fixture.runtime.toolBridge.url, {
      method: "GET",
      headers: { ...authorized, "transfer-encoding": "chunked" },
    });
    const wrongPath = openHttpRequest(
      fixture.runtime.toolBridge.url.replace(/\/tool$/u, "/other"),
      {
        headers: { ...authorized, "transfer-encoding": "chunked" },
      },
    );
    const oversized = openHttpRequest(fixture.runtime.toolBridge.url, {
      headers: {
        ...authorized,
        "content-length": String(CODING_TOOL_MAX_BODY_BYTES + 1),
      },
    });
    try {
      origin.client.write("{");
      wrongMethod.client.write("{");
      wrongPath.client.write("{");
      oversized.client.flushHeaders();
      await expect(responseBeforeEof(origin.response)).resolves.toMatchObject({ status: 403 });
      await expect(responseBeforeEof(wrongMethod.response)).resolves.toMatchObject({ status: 404 });
      await expect(responseBeforeEof(wrongPath.response)).resolves.toMatchObject({ status: 404 });
      await expect(responseBeforeEof(oversized.response)).resolves.toMatchObject({ status: 413 });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      origin.client.end();
      wrongMethod.client.end();
      wrongPath.client.end();
      oversized.client.end(Buffer.alloc(CODING_TOOL_MAX_BODY_BYTES + 1));
      await fixture.stop();
    }
  });

  it("uses a fatal UTF-8 decoder and preserves the exact ingress byte boundary", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade);
    const exact = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    const invalidUtf8 = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    try {
      exact.client.end(
        Buffer.concat([
          Buffer.from("{}", "utf8"),
          Buffer.alloc(CODING_TOOL_MAX_BODY_BYTES - 2, 0x20),
        ]),
      );
      await expect(exact.response).resolves.toMatchObject({ status: 200 });
      invalidUtf8.client.end(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
      await expect(invalidUtf8.response).resolves.toMatchObject({ status: 400 });
      expect(facade.execute).toHaveBeenCalledOnce();
    } finally {
      exact.client.destroy();
      invalidUtf8.client.destroy();
      await fixture.stop();
    }
  });

  it("applies one absolute deadline while reading an authorized body", async () => {
    const facade: CodingToolFacade = { execute: vi.fn(() => Promise.resolve(completed)) };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 30, maxInFlight: 1 });
    const request = openHttpRequest(fixture.runtime.toolBridge.url, {
      headers: { ...authorized, "transfer-encoding": "chunked" },
    });
    try {
      request.client.write('{"action":"read"');
      await expect(responseBeforeEof(request.response)).resolves.toMatchObject({ status: 408 });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      request.client.end();
      await fixture.stop();
    }
  });

  it("bounds admitted facade work before a second request is delegated", async () => {
    const releases: (() => void)[] = [];
    const facade: CodingToolFacade = {
      execute: vi.fn(
        () =>
          new Promise<typeof completed>((resolve) => {
            releases.push((): void => {
              resolve(completed);
            });
          }),
      ),
    };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 1_000, maxInFlight: 1 });
    const first = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    const second = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    try {
      first.client.end('{"action":"read"}');
      await vi.waitFor(() => {
        expect(facade.execute).toHaveBeenCalledOnce();
      });
      second.client.end('{"action":"read"}');
      await expect(responseBeforeEof(second.response)).resolves.toMatchObject({ status: 429 });
      expect(facade.execute).toHaveBeenCalledOnce();
    } finally {
      for (const release of releases) release();
      first.client.destroy();
      second.client.destroy();
      await fixture.stop();
    }
  });

  it("aborts delayed governed work when the client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
        const { signal } = input;
        observedSignal = signal;
        release?.();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(completed);
            },
            { once: true },
          );
        });
      }) as CodingToolFacade["execute"],
    };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 1_000, maxInFlight: 1 });
    const request = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    try {
      request.client.end('{"action":"read"}');
      await invoked;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      request.client.destroy();
      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
      });
    } finally {
      request.client.destroy();
      await fixture.stop();
    }
  });

  it("passes a deadline signal to a delayed facade request", async () => {
    let observedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const facade: CodingToolFacade = {
      execute: vi.fn((input: Parameters<CodingToolFacade["execute"]>[0]) => {
        const { signal } = input;
        observedSignal = signal;
        release?.();
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve(completed);
            },
            { once: true },
          );
        });
      }) as CodingToolFacade["execute"],
    };
    const fixture = await startBridgeFixture(facade, { requestDeadlineMs: 30, maxInFlight: 1 });
    const request = openHttpRequest(fixture.runtime.toolBridge.url, { headers: authorized });
    try {
      request.client.end('{"action":"read"}');
      await invoked;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
      });
      await expect(request.response).resolves.toMatchObject({ status: 408 });
    } finally {
      request.client.destroy();
      await fixture.stop();
    }
  });
});
