import { createHash } from "node:crypto";
import { ScriptedGovernedTools, type ScriptedToolPhase } from "./_governedTools.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";

import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

import type { PortableSidecarRuntimeVerification } from "../../update-portable-sidecar-verification.js";
import type {
  FunctionalPortableOpenCodeRuntime,
  ProductionOpenCodeBackendInput,
} from "../productionOpenCodeBackend.js";
import { parseOpenCodeHistory } from "../opencodeProtocol.js";
import { OPENCODE_MODEL_VISIBLE_TOOLS, OPENCODE_PINNED_VERSION } from "../opencodeToolSchemas.js";
import {
  OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  projectOpenCodeProtocolSurface,
} from "../opencodeProtocolSurface.js";
import {
  createRuntimeProcessSupervisor,
  type RuntimeProcessBackend,
  type RuntimeProcessSupervisor,
  type RuntimeProcessTree,
  type RuntimeSupervisorLaunchRequest,
  type RuntimeTreeSignal,
} from "../runtimeProcessSupervisor.js";

const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const RECEIPT = `sha256:${"0".repeat(64)}`;
const PROTOCOL_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const MAX_FAKE_BODY_BYTES = 1024 * 1024;
const MAX_FAKE_AGENT_STEPS = 12;
const FAKE_SESSION_ID = "ses_functional0000000001";

/** OpenAPI projection served by the scripted child; it projects to the pinned handshake digest. */
const FUNCTIONAL_OPENCODE_OPENAPI = {
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

const PROTOCOL_HANDSHAKE_DIGEST = projectOpenCodeProtocolSurface(
  FUNCTIONAL_OPENCODE_OPENAPI,
).digest;

/** OpenCode v1.17.17 strips unsupported JSON Schema keywords before forwarding this tool. */
const VERIFICATION_PROJECTED_SCHEMA = {
  type: "object",
  properties: {
    verifierId: {
      type: "string",
      enum: ["test", "targeted-test", "typecheck", "lint", "build"],
    },
  },
  required: ["verifierId"],
} as const;

/** The exact model-visible tool projection an OpenCode child presents to the gateway. */
function functionalGatewayTools(): readonly Record<string, unknown>[] {
  return OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => ({
    type: "function",
    function: {
      name,
      parameters: name === "keiko_verification" ? VERIFICATION_PROJECTED_SCHEMA : parameters,
    },
  }));
}

interface DirectTree extends RuntimeProcessTree {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly exits: Set<(code: number | null) => void>;
  exited: boolean;
  exitCode: number | null;
}

export function functionalArtifactAvailable(): boolean {
  return BINARY !== undefined && RESOURCE_ROOT !== undefined;
}

/** Copies the operator-staged real OpenCode artifact into the test root (env-gated, macOS/Windows). */
export function stagedFunctionalPortable(testRoot: string): FunctionalPortableOpenCodeRuntime {
  const stagedRoot = required("KEIKO_OPENCODE_REAL_RESOURCE_ROOT", RESOURCE_ROOT);
  const stagedBinary = required("KEIKO_OPENCODE_REAL_BINARY", BINARY);
  const target = platformTarget();
  const executablePath = "payload/bin/opencode";
  const resources = [executablePath, "payload/evidence/LICENSE", "payload/evidence/sbom.cdx.json"];
  if (resolve(stagedBinary) !== join(resolve(stagedRoot), executablePath)) {
    throw new Error("functional-opencode-binary-not-staged");
  }
  const installRoot = join(testRoot, "portable-resource");
  for (const file of resources) copyResource(resolve(stagedRoot), installRoot, file);
  const binary = join(installRoot, executablePath);
  if (digest(resolve(stagedBinary)) !== digest(binary)) {
    throw new Error("functional-opencode-binary-copy-mismatch");
  }
  // The staged artifact IS the pinned binary: its live /doc re-projects onto the product
  // surface pin, not onto the scripted harness surface digest.
  const sidecar = {
    ...verification(installRoot, target),
    protocolHandshakeDigest: OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  };
  return {
    evidenceClass: "functional-not-platform-qualified",
    installRoot,
    target,
    sidecar,
    qualification: qualification(target),
    nativeHelperPath: join(installRoot, "runtime", "native", "functional-not-used"),
  };
}

/**
 * Stages a scripted, content-controlled portable payload for the in-process fake OpenCode child.
 * The declared target/qualification are fixture identities; the scripted supervisor mirrors them,
 * so the composition runs unchanged on any CI host without a real binary.
 */
export function scriptedFunctionalPortable(testRoot: string): FunctionalPortableOpenCodeRuntime {
  const target: UpdatePortableTarget = "macos-arm64";
  const installRoot = join(testRoot, "portable-resource");
  const files: readonly (readonly [string, string])[] = [
    ["payload/bin/opencode", "#!/bin/sh\nexit 0\n"],
    ["payload/evidence/LICENSE", "functional license evidence\n"],
    ["payload/evidence/sbom.cdx.json", '{"bomFormat":"CycloneDX"}\n'],
  ];
  for (const [file, body] of files) {
    const path = join(installRoot, file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeExecutable(path, body);
  }
  return {
    evidenceClass: "functional-not-platform-qualified",
    installRoot,
    target,
    sidecar: verification(installRoot, target),
    qualification: qualification(target),
    nativeHelperPath: join(installRoot, "runtime", "native", "functional-not-used"),
  };
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { encoding: "utf8" });
  chmodSync(path, 0o755);
}

export function createFunctionalSupervisor(
  portable: FunctionalPortableOpenCodeRuntime,
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: new DirectChildBackend(portable.qualification),
    qualifications: [portable.qualification],
  });
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0)
    throw new Error(`functional-opencode-env-missing:${name}`);
  return value;
}

function platformTarget(): UpdatePortableTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "macos-x64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error("functional-opencode-platform-unsupported");
}

function qualification(
  target: UpdatePortableTarget,
): FunctionalPortableOpenCodeRuntime["qualification"] {
  return target === "windows-x64"
    ? { platform: "win32", arch: "x64", backend: "windows-job-object", releaseReceipt: RECEIPT }
    : {
        platform: "darwin",
        arch: target === "macos-arm64" ? "arm64" : "x64",
        backend: "macos-app-sandbox",
        releaseReceipt: RECEIPT,
      };
}

function copyResource(sourceRoot: string, targetRoot: string, file: string): void {
  const source = join(sourceRoot, file);
  if (!existsSync(source) || !statSync(source).isFile())
    throw new Error("functional-opencode-staged-proof-missing");
  const target = join(targetRoot, file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  chmodSync(target, statSync(source).mode & 0o777);
}

function verification(
  installRoot: string,
  target: UpdatePortableTarget,
): PortableSidecarRuntimeVerification {
  const payloadRootPath = "payload";
  const executablePath = "payload/bin/opencode";
  const executable = join(installRoot, executablePath);
  const executableDigest = digest(executable);
  const payloadRoot = join(installRoot, payloadRootPath);
  const relativeExecutable = relative(payloadRoot, executable).split("\\").join("/");
  const payloadSha256 = payloadDigest(payloadRoot, [
    relativeExecutable,
    "evidence/LICENSE",
    "evidence/sbom.cdx.json",
  ]);
  return {
    payloadRootPath,
    executablePath,
    shippedExecutableSha256: executableDigest,
    executableTreeSha256: digestText(`${relativeExecutable}\0${executableDigest}\0`),
    licenseEvidencePath: "payload/evidence/LICENSE",
    licenseEvidenceSha256: digest(join(installRoot, "payload/evidence/LICENSE")),
    sbomEvidencePath: "payload/evidence/sbom.cdx.json",
    sbomEvidenceSha256: digest(join(installRoot, "payload/evidence/sbom.cdx.json")),
    protocolSchemaRawSha256: PROTOCOL_SCHEMA_SHA256,
    protocolHandshakeDigest: PROTOCOL_HANDSHAKE_DIGEST,
    protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1",
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
    summary: verificationSummary(target, payloadSha256, executable),
  };
}

function verificationSummary(
  target: UpdatePortableTarget,
  payloadSha256: string,
  executable: string,
): PortableSidecarRuntimeVerification["summary"] {
  return {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstreamName: "opencode",
    upstreamVersion: OPENCODE_PINNED_VERSION,
    adapterName: "keiko-coding-sidecar",
    adapterVersion: "1",
    protocolVersion: "http-sse",
    platformTarget: target,
    payloadSha256,
    payloadSha256Prefix: payloadSha256.slice(0, 12),
    sizeBytes: statSync(executable).size,
    status: "verified",
  };
}

function payloadDigest(root: string, files: readonly string[]): string {
  return digestText(
    [...files]
      .sort()
      .map((file) => `${file}\0${digest(join(root, file))}\0`)
      .join(""),
  );
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class DirectChildBackend implements RuntimeProcessBackend {
  public constructor(public readonly identity: RuntimeProcessBackend["identity"]) {}

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tree: DirectTree = {
      treeId: request.recoveryHandle,
      child,
      stdout: child.stdout,
      stderr: child.stderr,
      exits: new Set(),
      exited: false,
      exitCode: null,
      onTreeExit(callback): void {
        if (tree.exited) callback(tree.exitCode);
        else tree.exits.add(callback);
      },
    };
    child.once("exit", (code) => {
      settle(tree, code);
    });
    child.once("error", () => {
      settle(tree, null);
    });
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const direct = tree as DirectTree;
    if (!direct.exited) direct.child.kill(signal === "graceful" ? "SIGTERM" : "SIGKILL");
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<boolean> {
    const direct = tree as DirectTree;
    if (direct.exited) return true;
    return await new Promise<boolean>((resolveWait) => {
      const timeout = setTimeout(() => {
        resolveWait(direct.exited);
      }, timeoutMs);
      timeout.unref();
      direct.exits.add(() => {
        clearTimeout(timeout);
        resolveWait(true);
      });
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve((tree as DirectTree).exited);
  }
}

function settle(tree: DirectTree, code: number | null): void {
  if (tree.exited) return;
  tree.exited = true;
  tree.exitCode = code;
  for (const listener of tree.exits) listener(code);
  tree.exits.clear();
}

interface FakeHistoryRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface FakeGatewayTurn {
  readonly content: string;
  readonly toolCalls: readonly FakeToolCall[];
}

type FakeQuestionOutcome =
  | { readonly kind: "answered"; readonly answers: readonly (readonly string[])[] }
  | { readonly kind: "rejected" };

interface PendingFakeQuestion {
  readonly row: Record<string, unknown>;
  readonly settle: (outcome: FakeQuestionOutcome) => void;
}

const FAKE_TOOL_ACTIONS: Readonly<
  Record<string, { readonly action: string; readonly arguments: readonly string[] }>
> = {
  keiko_workspace_discover: { action: "discover", arguments: ["query", "maxResults"] },
  keiko_workspace_read: { action: "read", arguments: ["relativePath"] },
  keiko_changeset_edit: { action: "edit", arguments: ["changeset"] },
  keiko_verification: { action: "verification", arguments: ["verifierId"] },
  keiko_research_fetch: { action: "egress", arguments: ["target"] },
  keiko_skill: { action: "skill", arguments: ["skillId"] },
  keiko_child_agent: { action: "child-agent", arguments: ["objective", "maxToolCalls"] },
};

/**
 * In-process scripted OpenCode child. It speaks the pinned HTTP/SSE protocol surface behind the
 * per-run Basic-auth secret, bridges gateway tool calls to the governed tool facade, and surfaces
 * `question` tool calls through the /question endpoints — exactly the loop the real binary runs.
 */
/** Test-only seam: plays the model's own tool-call selection for `FakeOpenCodeChild.callGateway`. */
export interface ScriptedModelTurnInput {
  readonly modelTurn: (transcript: readonly Record<string, unknown>[]) => FakeGatewayTurn;
  readonly toolFacadeFetch?: typeof globalThis.fetch;
}

class FakeOpenCodeChild {
  private readonly governedTools: ScriptedGovernedTools | undefined;
  private readonly scriptedModelTurn: ScriptedModelTurnInput["modelTurn"] | undefined;
  private readonly password: string;
  private readonly gatewayUrl: string;
  private readonly gatewayCapability: string;
  private readonly toolFacadeUrl: string;
  private readonly toolFacadeCapability: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly historyRows: FakeHistoryRow[] = [];
  private readonly sseClients = new Set<ServerResponse>();
  private readonly questions = new Map<string, PendingFakeQuestion>();
  private readonly transcript: Record<string, unknown>[] = [];
  private readonly historyFixtureFailures: string[] = [];
  private readonly requestTargets: string[] = [];
  private historySequence = 0;
  private liveEventSequence = 0;
  private questionSequence = 0;
  private messageSequence = 0;
  private fixtureTimeMs = 1_700_000_000_000;
  private sessionCreated = false;
  private busy = false;
  private finished = 0;
  private turnTail: Promise<void> = Promise.resolve();
  private turnController: AbortController | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(
    env: Readonly<Record<string, string>>,
    generatedTools = false,
    observePhase?: (event: ScriptedToolPhase) => void,
    scriptedModel?: ScriptedModelTurnInput,
  ) {
    this.governedTools = generatedTools
      ? new ScriptedGovernedTools({
          env,
          ...(observePhase === undefined ? {} : { observePhase }),
          sessionId: FAKE_SESSION_ID,
          broadcast: (type, properties): void => {
            this.broadcast(type, properties);
          },
          ...(scriptedModel?.toolFacadeFetch === undefined
            ? {}
            : { fetch: scriptedModel.toolFacadeFetch }),
        })
      : undefined;
    this.scriptedModelTurn = scriptedModel?.modelTurn;
    this.password = requiredEnv(env, "OPENCODE_SERVER_PASSWORD");
    this.gatewayUrl = requiredEnv(env, "KEIKO_MODEL_GATEWAY_URL");
    this.gatewayCapability = requiredEnv(env, "KEIKO_MODEL_GATEWAY_CAPABILITY");
    this.toolFacadeUrl = requiredEnv(env, "KEIKO_TOOL_FACADE_URL");
    this.toolFacadeCapability = requiredEnv(env, "KEIKO_TOOL_FACADE_CAPABILITY");
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  public fixtureFailures(): readonly string[] {
    return [...this.historyFixtureFailures];
  }

  public requestedTargets(): readonly string[] {
    return [...this.requestTargets];
  }

  public listen(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        resolvePort((this.server.address() as AddressInfo).port);
      });
    });
  }

  public completedTurns(): number {
    return this.finished;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    this.turnController?.abort();
    this.governedTools?.close();
    for (const pending of this.questions.values()) pending.settle({ kind: "rejected" });
    this.questions.clear();
    for (const client of this.sseClients) client.destroy();
    this.sseClients.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => {
      this.server.close(() => {
        resolveClose();
      });
    });
    await this.turnTail;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.requestTargets.push(request.url ?? "/");
      const body = await readBoundedBody(request);
      if (!this.authorized(request)) {
        response.writeHead(401).end();
        return;
      }
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      this.route(request.method ?? "GET", path, body, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}`;
    return request.headers.authorization === expected;
  }

  // eslint-disable-next-line complexity -- the finite pinned endpoint table is intentionally explicit.
  private route(method: string, path: string, body: string, response: ServerResponse): void {
    if (method === "GET" && path === "/global/health") {
      json(response, { healthy: true, version: OPENCODE_PINNED_VERSION });
    } else if (method === "GET" && path === "/doc") {
      json(response, FUNCTIONAL_OPENCODE_OPENAPI);
    } else if (method === "GET" && path === "/global/event") {
      this.openEvents(response);
    } else if (method === "POST" && path === "/session") {
      this.createSession(response);
    } else if (method === "GET" && path === "/session") {
      json(response, [{ id: FAKE_SESSION_ID }]);
    } else if (method === "GET" && path === "/session/status") {
      json(response, this.busy ? { [FAKE_SESSION_ID]: { type: "busy" } } : {});
    } else if (method === "GET" && path === "/permission") {
      json(response, this.governedTools?.rows() ?? []);
    } else if (method === "GET" && path === "/question") {
      json(
        response,
        [...this.questions.values()].map((pending) => pending.row),
      );
    } else if (method === "POST" && path === "/sync/history") {
      json(response, this.historyRows);
    } else if (this.routePermission(method, path, body, response)) {
      return;
    } else {
      this.routeDynamic(method, path, body, response);
    }
  }

  private routePermission(
    method: string,
    path: string,
    body: string,
    response: ServerResponse,
  ): boolean {
    const permission = /^\/permission\/([^/]+)\/reply$/u.exec(path);
    if (method === "POST" && permission !== null) {
      json(response, this.governedTools?.reply(permission[1] ?? "", body) ?? false);
      return true;
    }
    return false;
  }

  private routeDynamic(method: string, path: string, body: string, response: ServerResponse): void {
    const prompt = /^\/session\/([^/]+)\/prompt_async$/u.exec(path);
    if (method === "POST" && prompt !== null) {
      this.acceptPrompt(prompt[1] ?? "", body, response);
      return;
    }
    const abort = /^\/session\/([^/]+)\/abort$/u.exec(path);
    if (method === "POST" && abort !== null) {
      this.turnController?.abort();
      json(response, true);
      return;
    }
    const question = /^\/question\/([^/]+)\/(reply|reject)$/u.exec(path);
    if (method === "POST" && question !== null) {
      this.settleQuestion(question[1] ?? "", question[2] === "reply", body, response);
      return;
    }
    response.writeHead(404).end();
  }

  private acceptPrompt(sessionId: string, body: string, response: ServerResponse): void {
    if (sessionId !== FAKE_SESSION_ID) {
      response.writeHead(404).end();
      return;
    }
    const text = promptText(body);
    response.writeHead(204).end();
    const controller = new AbortController();
    this.turnController = controller;
    this.turnTail = this.turnTail.then(() => this.runTurn(text, controller));
  }

  private settleQuestion(
    requestId: string,
    answered: boolean,
    body: string,
    response: ServerResponse,
  ): void {
    const pending = this.questions.get(requestId);
    if (pending === undefined) {
      json(response, false);
      return;
    }
    this.questions.delete(requestId);
    pending.settle(
      answered ? { kind: "answered", answers: parseAnswers(body) } : { kind: "rejected" },
    );
    json(response, true);
  }

  private createSession(response: ServerResponse): void {
    if (!this.sessionCreated) {
      this.sessionCreated = true;
      this.appendHistory("session.created.1", {
        sessionID: FAKE_SESSION_ID,
        info: { id: FAKE_SESSION_ID },
      });
    }
    json(response, { id: FAKE_SESSION_ID });
  }

  private openEvents(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    this.sseClients.add(response);
    response.once("close", () => this.sseClients.delete(response));
    this.writeLiveEvent(response, "server.connected", {});
  }

  private broadcast(type: string, properties: Record<string, unknown>): void {
    for (const client of this.sseClients) this.writeLiveEvent(client, type, properties);
  }

  private writeLiveEvent(
    client: ServerResponse,
    type: string,
    properties: Record<string, unknown>,
  ): void {
    this.liveEventSequence += 1;
    const payload = { id: `evt_live${String(this.liveEventSequence)}`, type, properties };
    if (!client.writableEnded && !client.destroyed) {
      client.write(`data: ${JSON.stringify({ payload })}\n\n`);
    }
  }

  private appendHistory(type: string, data: Record<string, unknown>): void {
    const row = {
      id: `evt_h${String(this.historyRows.length + 1)}`,
      aggregate_id: FAKE_SESSION_ID,
      seq: this.historySequence++,
      type,
      data,
    };
    const parsed = parseOpenCodeHistory([row]);
    if (!parsed.ok) this.historyFixtureFailures.push(`${type}:${parsed.reason}`);
    this.historyRows.push(row);
    this.broadcast("history.updated", {});
  }

  private async runTurn(text: string, controller: AbortController): Promise<void> {
    if (this.closed) return;
    this.busy = true;
    this.appendHistory("session.status", { sessionID: FAKE_SESSION_ID, status: "busy" });
    this.broadcast("session.status", { sessionID: FAKE_SESSION_ID, status: { type: "busy" } });
    const userMessageId = this.appendUserMessage(text);
    this.transcript.push({ role: "user", content: text });
    try {
      await this.agentLoop(controller.signal, userMessageId);
    } catch {
      // A denied gateway or tool exchange settles the turn; the session returns to idle.
    }
    this.busy = false;
    this.finished += 1;
    this.appendHistory("session.idle", { sessionID: FAKE_SESSION_ID });
    this.broadcast("session.idle", { sessionID: FAKE_SESSION_ID });
  }

  private async agentLoop(signal: AbortSignal, userMessageId: string): Promise<void> {
    for (let step = 0; step < MAX_FAKE_AGENT_STEPS; step += 1) {
      if (signal.aborted) return;
      const turn = await this.callGateway(signal);
      const assistantMessageId = this.beginAssistantMessage(userMessageId, turn.content);
      this.transcript.push(assistantMessage(turn));
      if (turn.toolCalls.length === 0) {
        this.completeAssistantMessage(userMessageId, assistantMessageId, "stop");
        return;
      }
      for (const call of turn.toolCalls) {
        if (call.name !== "question") this.appendToolPart(assistantMessageId, call, "pending");
        if (call.name !== "question") this.appendToolPart(assistantMessageId, call, "running");
        const output = await this.executeToolCall(call, signal);
        if (call.name !== "question") {
          this.appendToolPart(assistantMessageId, call, "completed", output);
        }
        this.transcript.push({ role: "tool", content: output, tool_call_id: call.id });
      }
      this.completeAssistantMessage(userMessageId, assistantMessageId, "tool-calls");
    }
  }

  private appendUserMessage(text: string): string {
    const messageId = this.nextMessageId("user");
    const created = this.nextFixtureTime();
    this.appendHistory("message.updated.1", {
      sessionID: FAKE_SESSION_ID,
      info: {
        id: messageId,
        sessionID: FAKE_SESSION_ID,
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: "keiko-runtime", modelID: "coding" },
      },
    });
    this.appendHistory("message.part.updated.1", {
      sessionID: FAKE_SESSION_ID,
      part: {
        id: `prt_${messageId}_text`,
        sessionID: FAKE_SESSION_ID,
        messageID: messageId,
        type: "text",
        text,
      },
      time: this.nextFixtureTime(),
    });
    return messageId;
  }

  private beginAssistantMessage(parentId: string, text: string): string {
    const messageId = this.nextMessageId("assistant");
    const created = this.nextFixtureTime();
    this.appendHistory("message.updated.1", {
      sessionID: FAKE_SESSION_ID,
      info: assistantHistoryInfo(messageId, parentId, { created }),
    });
    for (const [index, chunk] of splitFunctionalText(expandFunctionalDisplayText(text)).entries()) {
      this.appendHistory("message.part.updated.1", {
        sessionID: FAKE_SESSION_ID,
        part: {
          id: `prt_${messageId}_text_${String(index + 1)}`,
          sessionID: FAKE_SESSION_ID,
          messageID: messageId,
          type: "text",
          text: chunk,
        },
        time: this.nextFixtureTime(),
      });
    }
    return messageId;
  }

  private completeAssistantMessage(
    parentId: string,
    messageId: string,
    finish: "stop" | "tool-calls",
  ): void {
    const completed = this.nextFixtureTime();
    this.appendHistory("message.updated.1", {
      sessionID: FAKE_SESSION_ID,
      info: assistantHistoryInfo(messageId, parentId, {
        created: completed - 1,
        completed,
        finish,
      }),
    });
  }

  private appendToolPart(
    messageId: string,
    call: FakeToolCall,
    status: "pending" | "running" | "completed",
    output = "",
  ): void {
    const time = this.nextFixtureTime();
    this.appendHistory("message.part.updated.1", {
      sessionID: FAKE_SESSION_ID,
      part: fakeToolPart(messageId, call, status, output, time),
      time,
    });
  }

  private nextMessageId(role: "user" | "assistant"): string {
    this.messageSequence += 1;
    return `msg_${role}_${String(this.messageSequence)}`;
  }

  private nextFixtureTime(): number {
    this.fixtureTimeMs += 1;
    return this.fixtureTimeMs;
  }

  /**
   * Runs one user turn through the REAL agent loop (`callGateway` -> `executeToolCall` ->
   * `callToolFacade` -> the governed generated-tool bundle) driven directly, in-process, rather
   * than through the HTTP `prompt_async` endpoint -- the scripted model is a same-process test
   * double, so there is no process boundary to cross. Resolves once the turn ends (the scripted
   * model returns no further tool calls) and returns every completed tool part the turn appended
   * to durable history, in call order -- the same tool-event evidence a real transcript produces.
   */
  public async runScriptedUserTurn(
    text: string,
  ): Promise<readonly ScriptedGovernedTranscriptToolResult[]> {
    const before = this.historyRows.length;
    const controller = new AbortController();
    this.turnController = controller;
    await this.runTurn(text, controller);
    return this.historyRows.slice(before).flatMap((row) => completedToolResult(row));
  }

  private async callGateway(signal: AbortSignal): Promise<FakeGatewayTurn> {
    if (this.scriptedModelTurn !== undefined) {
      if (signal.aborted) throw new Error("functional-gateway-denied");
      return this.scriptedModelTurn([...this.transcript]);
    }
    const response = await fetch(`${this.gatewayUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.gatewayCapability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "coding",
        messages: this.transcript,
        tools: functionalGatewayTools(),
      }),
    });
    if (!response.ok) throw new Error("functional-gateway-denied");
    return parseGatewayTurn((await response.json()) as Record<string, unknown>);
  }

  private executeToolCall(call: FakeToolCall, signal: AbortSignal): Promise<string> {
    if (call.name === "question") return this.askQuestion(call, signal);
    if (call.name === "todowrite") return Promise.resolve(executeBuiltInTodoWrite(call));
    return this.callToolFacade(call, signal);
  }

  /**
   * A rejected (or aborted) question fails the tool and ends the turn, like the real binary.
   * The real v1.17.17 publishes its question lifecycle live-only over /global/event — question
   * rows never reach the durable history — so the fake mirrors exactly that.
   */
  private askQuestion(call: FakeToolCall, signal: AbortSignal): Promise<string> {
    this.questionSequence += 1;
    const id = `que_functional${String(this.questionSequence)}`;
    const row = { id, sessionID: FAKE_SESSION_ID, questions: call.args.questions };
    return new Promise<string>((resolveQuestion, rejectQuestion) => {
      const settled = (outcome: FakeQuestionOutcome): void => {
        signal.removeEventListener("abort", onAbort);
        this.broadcast(outcome.kind === "answered" ? "question.replied" : "question.rejected", {
          sessionID: FAKE_SESSION_ID,
          requestID: id,
        });
        if (outcome.kind === "answered") resolveQuestion(JSON.stringify(outcome));
        else rejectQuestion(new Error("functional-question-rejected"));
      };
      const onAbort = (): void => {
        this.questions.delete(id);
        settled({ kind: "rejected" });
      };
      this.questions.set(id, { row, settle: settled });
      signal.addEventListener("abort", onAbort, { once: true });
      this.broadcast("question.asked", { id, sessionID: FAKE_SESSION_ID });
    });
  }

  private async callToolFacade(call: FakeToolCall, signal: AbortSignal): Promise<string> {
    this.appendHistory("session.next.tool.called", {
      timestamp: new Date(this.nextFixtureTime()).toISOString(),
      sessionID: FAKE_SESSION_ID,
      assistantMessageID: "msg_functional",
      callID: call.id,
      tool: call.name,
      provider: "keiko",
    });
    // The generated-tool bundle is self-describing (every tool it ships is dispatchable, and it
    // fails closed on its own for one it does not) -- FAKE_TOOL_ACTIONS is only the legacy,
    // hand-mapped action table for the non-generated fetch path below, so it must never gate a
    // generated-tools call. Gating on it here silently swallowed every #3386/#3387/#3388 git/CI
    // tool name as `{"status":"invalid"}` before this call ever reached `governedTools.execute`.
    if (this.governedTools !== undefined) return this.governedTools.execute(call, signal);
    const definition = FAKE_TOOL_ACTIONS[call.name];
    if (definition === undefined) return '{"status":"invalid"}';
    const identity = `${FAKE_SESSION_ID}:${call.id}`;
    const response = await fetch(this.toolFacadeUrl, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.toolFacadeCapability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: definition.action,
        actionId: identity,
        idempotencyKey: identity,
        ...Object.fromEntries(definition.arguments.map((name) => [name, call.args[name]])),
      }),
    });
    if (!response.ok) return '{"status":"failed"}';
    return await response.text();
  }
}

/** Mirrors the v1.17.17 built-in: full-replace todo state, no facade round-trip, no tool event. */
function executeBuiltInTodoWrite(call: FakeToolCall): string {
  return JSON.stringify(call.args.todos ?? [], null, 2);
}

function splitFunctionalText(value: string): readonly string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += 4096) {
    chunks.push(value.slice(start, start + 4096));
  }
  return chunks;
}

function expandFunctionalDisplayText(value: string): string {
  if (value.length === 0) return value;
  return `${value.slice(0, 256)}${"x".repeat(4096 * 5)}${value.slice(-128)}`;
}

function assistantHistoryInfo(
  messageId: string,
  parentId: string,
  time: { readonly created: number; readonly completed?: number; readonly finish?: string },
): Record<string, unknown> {
  return {
    id: messageId,
    sessionID: FAKE_SESSION_ID,
    role: "assistant",
    time:
      time.completed === undefined
        ? { created: time.created }
        : { created: time.created, completed: time.completed },
    parentID: parentId,
    modelID: "coding",
    providerID: "keiko-runtime",
    mode: "build",
    agent: "build",
    path: { cwd: "/private/workspace", root: "/private/workspace" },
    cost: 0,
    tokens: emptyTokenCounts(),
    ...(time.finish === undefined ? {} : { finish: time.finish }),
  };
}

function fakeToolPart(
  messageId: string,
  call: FakeToolCall,
  status: "pending" | "running" | "completed",
  output: string,
  time: number,
): Record<string, unknown> {
  const input = call.args;
  const state =
    status === "pending"
      ? { status, input, raw: JSON.stringify(input) }
      : status === "running"
        ? { status, input, title: call.name, metadata: {}, time: { start: time } }
        : {
            status,
            input,
            output,
            title: call.name,
            metadata: {},
            time: { start: time - 1, end: time },
          };
  return {
    id: `prt_tool_${call.id}`,
    sessionID: FAKE_SESSION_ID,
    messageID: messageId,
    type: "tool",
    callID: call.id,
    tool: call.name,
    state,
  };
}

function emptyTokenCounts(): Record<string, unknown> {
  return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function requiredEnv(env: Readonly<Record<string, string>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`functional-opencode-child-env-missing:${name}`);
  }
  return value;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function readBoundedBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FAKE_BODY_BYTES) reject(new Error("functional-opencode-body-oversized"));
      else chunks.push(chunk);
    });
    request.once("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

function promptText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { parts?: readonly { text?: string }[] };
    return parsed.parts?.[0]?.text ?? "";
  } catch {
    return "";
  }
}

function parseAnswers(body: string): readonly (readonly string[])[] {
  try {
    const parsed = JSON.parse(body) as { answers?: readonly (readonly string[])[] };
    return parsed.answers ?? [];
  } catch {
    return [];
  }
}

function assistantMessage(turn: FakeGatewayTurn): Record<string, unknown> {
  return {
    role: "assistant",
    content: turn.content,
    ...(turn.toolCalls.length === 0
      ? {}
      : {
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
  };
}

function parseGatewayTurn(body: Record<string, unknown>): FakeGatewayTurn {
  const choices = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[]) : [];
  const message = isRecord(choices[0]?.message) ? choices[0].message : {};
  const rawCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Record<string, unknown>[])
    : [];
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: rawCalls.map(parseToolCall).filter((call): call is FakeToolCall => call !== null),
  };
}

function parseToolCall(value: Record<string, unknown>): FakeToolCall | null {
  const fn = isRecord(value.function) ? value.function : undefined;
  if (fn === undefined || typeof value.id !== "string" || typeof fn.name !== "string") return null;
  try {
    const args: unknown = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : {};
    return { id: value.id, name: fn.name, args: isRecord(args) ? args : {} };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows one durable history row to its completed tool-call result, when it carries one. */
function completedToolResult(row: FakeHistoryRow): readonly ScriptedGovernedTranscriptToolResult[] {
  if (row.type !== "message.part.updated.1") return [];
  const part = row.data.part;
  if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) return [];
  if (part.state.status !== "completed") return [];
  if (typeof part.callID !== "string" || typeof part.tool !== "string") return [];
  if (typeof part.state.output !== "string") return [];
  return [{ callId: part.callID, tool: part.tool, output: part.state.output }];
}

interface ScriptedTree extends RuntimeProcessTree {
  readonly child: FakeOpenCodeChild;
  readonly exits: Set<(code: number | null) => void>;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exited: boolean;
}

class ScriptedChildBackend implements RuntimeProcessBackend {
  public constructor(
    public readonly identity: RuntimeProcessBackend["identity"],
    private readonly children: FakeOpenCodeChild[],
    private readonly generatedTools: boolean,
    private readonly observePhase?: (event: ScriptedToolPhase) => void,
  ) {}

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new FakeOpenCodeChild(request.env, this.generatedTools, this.observePhase);
    this.children.push(child);
    const tree: ScriptedTree = {
      treeId: request.recoveryHandle,
      child,
      stdout,
      stderr,
      exits: new Set(),
      exited: false,
      onTreeExit(callback): void {
        if (tree.exited) callback(0);
        else tree.exits.add(callback);
      },
    };
    child
      .listen()
      .then((port) => {
        if (!tree.exited)
          stdout.write(`opencode server listening on http://127.0.0.1:${String(port)}\n`);
      })
      .catch(() => {
        if (!stdout.writableEnded) stdout.end();
      });
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, _signal: RuntimeTreeSignal): void {
    const scripted = tree as ScriptedTree;
    void scripted.child.close().then(() => {
      settleScripted(scripted);
    });
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<boolean> {
    const scripted = tree as ScriptedTree;
    if (scripted.exited) return true;
    return await new Promise<boolean>((resolveWait) => {
      const timeout = setTimeout(() => {
        resolveWait(scripted.exited);
      }, timeoutMs);
      timeout.unref();
      scripted.exits.add(() => {
        clearTimeout(timeout);
        resolveWait(true);
      });
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve((tree as ScriptedTree).exited);
  }
}

function settleScripted(tree: ScriptedTree): void {
  if (tree.exited) return;
  tree.exited = true;
  tree.stdout.end();
  tree.stderr.end();
  for (const listener of tree.exits) listener(0);
  tree.exits.clear();
}

export interface ScriptedOpenCodeHarness {
  readonly createSupervisor: NonNullable<ProductionOpenCodeBackendInput["createSupervisor"]>;
  readonly children: readonly FakeOpenCodeChild[];
  readonly closeAll: () => Promise<void>;
}

/** Scripted supervisor seam for `createProductionOpenCodeBackend`; no real binary is required. */
export function createScriptedOpenCodeHarness(
  options: {
    readonly generatedTools?: boolean;
    readonly observePhase?: (event: ScriptedToolPhase) => void;
  } = {},
): ScriptedOpenCodeHarness {
  const children: FakeOpenCodeChild[] = [];
  return {
    children,
    createSupervisor: ({ portable }): RuntimeProcessSupervisor =>
      createRuntimeProcessSupervisor({
        backend: new ScriptedChildBackend(
          {
            platform: portable.qualification.platform,
            arch: portable.qualification.arch,
            backend: portable.qualification.backend,
          },
          children,
          options.generatedTools === true,
          options.observePhase,
        ),
        qualifications: [portable.qualification],
      }),
    closeAll: async (): Promise<void> => {
      for (const child of children.splice(0)) await child.close();
    },
  };
}

/** One completed tool part a scripted transcript's model-driven turn appended to durable history. */
export interface ScriptedGovernedTranscriptToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly output: string;
}

export interface ScriptedGovernedTranscriptChild {
  /**
   * Runs one user turn through the real scripted-child agent loop (`callGateway` ->
   * `executeToolCall` -> `callToolFacade` -> the governed generated-tool bundle): the caller's
   * `modelTurn` plays the model's own tool-call selection -- exactly the seam a real transcript's
   * `/chat/completions` response fills for `FakeOpenCodeChild.callGateway` -- so which tool runs
   * next is decided outside the test body, from the accumulated transcript, the same way a real
   * model decides from it. Resolves once the turn ends (no further tool calls) and returns every
   * tool result the turn produced, in call order.
   */
  readonly runTurn: (userText: string) => Promise<readonly ScriptedGovernedTranscriptToolResult[]>;
  readonly close: () => Promise<void>;
}

/**
 * A scripted OpenCode child driven in-process for a MODEL-SELECTED tool-call proof. It reuses the
 * exact same `FakeOpenCodeChild`/`ScriptedGovernedTools` machinery `createScriptedOpenCodeHarness`
 * wires for a full pipeline run, minus the `RuntimeProcessSupervisor`/HTTP-gateway plumbing a full
 * production composition needs only to route a real model call to this same child in a live run --
 * the model's tool-call selection itself is supplied directly as `modelTurn`, so a caller assembles
 * a real generated-tool-backed facade (as `createScriptedOpenCodeHarness` callers already do) and
 * proves the SAME dispatch path a real transcript uses, without re-deriving it.
 */
export function createScriptedGovernedTranscriptChild(input: {
  readonly runId: string;
  readonly toolFacadeFetch: typeof globalThis.fetch;
  readonly modelTurn: (transcript: readonly Record<string, unknown>[]) => FakeGatewayTurn;
  readonly observePhase?: (event: ScriptedToolPhase) => void;
}): ScriptedGovernedTranscriptChild {
  const env = {
    OPENCODE_SERVER_PASSWORD: "scripted-transcript-password",
    KEIKO_MODEL_GATEWAY_URL: "http://scripted-transcript.invalid/model-gateway",
    KEIKO_MODEL_GATEWAY_CAPABILITY: "scripted-transcript-model-capability",
    KEIKO_TOOL_FACADE_URL: "http://scripted-transcript.invalid/tool-facade",
    KEIKO_TOOL_FACADE_CAPABILITY: "scripted-transcript-tool-capability",
    KEIKO_CODING_RUN_ID: input.runId,
  };
  const child = new FakeOpenCodeChild(env, true, input.observePhase, {
    modelTurn: input.modelTurn,
    toolFacadeFetch: input.toolFacadeFetch,
  });
  return {
    runTurn: (userText): Promise<readonly ScriptedGovernedTranscriptToolResult[]> =>
      child.runScriptedUserTurn(userText),
    close: (): Promise<void> => child.close(),
  };
}
