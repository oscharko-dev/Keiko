import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  resolveDarwinGitExecutable,
} from "@oscharko-dev/keiko-sandbox";
import {
  toolCallingConfigurationFingerprint,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
} from "../coding-sidecar-gateway.js";
import { parseImageUrlContentPart } from "../coding-sidecar-image-parts.js";
import { buildRedactor, type UiHandlerDeps } from "../deps.js";
import { STREAMING, type RouteResult } from "../routes.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { buildOpenCodeLaunchProfile, openCodeConfigDirectory } from "./opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  createOpenCodeV2HttpClient,
  parseOpenCodeV2ChildEndpoint,
  type OpenCodeV2HttpClient,
} from "./opencodeV2HttpClient.js";

/**
 * Original-runtime proof for native image input (#3897 S14, review P2). The pinned executable runs
 * under the real native Seatbelt wrapper with the profile `buildOpenCodeLaunchProfile` produces; a
 * scripted model asks for a native `read` of a small synthetic PNG, and the stub gateway records
 * the provider request that follows. With image input declared that request carries exactly one
 * `image_url` part holding the file's bytes; declared text-only (the default) it carries none and
 * the file's bytes appear nowhere in the request. A second pair runs the same original runtime
 * against the PRODUCTIVE sidecar route (`handleCodingSidecarGatewayChatCompletions`, scripted only
 * at the model-gateway port), so the request the route hands the gateway is observed too. Run with
 * KEIKO_OPENCODE_REAL_BINARY and KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "m".repeat(43);
const RUN_ID = "run-native-image";
const FACADE_CAPABILITY = "fixture-facade-capability";
const IMAGE_FILE = "pixel.png";
const MAX_FIXTURE_BODY_BYTES = 4 * 1_024 * 1_024;

interface Recorded {
  readonly url: string;
  readonly body: unknown;
}

interface Stub {
  readonly server: Server;
  port: number;
  readonly requests: Recorded[];
}

/** The model endpoint a run talks to: where OpenCode posts, and how the fixture shuts it down. */
interface ModelEndpoint {
  readonly url: string;
  readonly close: () => Promise<void>;
  /** Tool-call turns still to script; each answers one request whose last message is the user's. */
  toolTurns: number;
}

interface GatewayStub extends Stub, ModelEndpoint {}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
  readonly png: Buffer;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** A valid 32x32 solid-red RGB PNG, built from its chunks so the fixture needs no asset file. */
function syntheticPng(): Buffer {
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(size * 3).fill(Buffer.from([255, 0, 0])),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_FIXTURE_BODY_BYTES) throw new Error("fixture-body-oversized");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body is recorded as text; the assertions only read JSON bodies.
    return text;
  }
}

async function startStub(
  respond: (stub: Stub, recorded: Recorded, response: ServerResponse) => void,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: { server?: Server; port: number; requests: Recorded[] } = { port: 0, requests };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readRequestBody(request)
      .then((bytes) => {
        const recorded = { url: request.url ?? "", body: parseJson(bytes.toString("utf8")) };
        requests.push(recorded);
        respond(stub as Stub, recorded, response);
      })
      .catch(() => response.writeHead(500).end());
  });
  stub.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  stub.port = address.port;
  return stub as Stub;
}

async function closeStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    stub.server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function streamedTurn(response: ServerResponse, delta: unknown, finish: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    frame({
      id: "native-image",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
  );
  response.end(
    frame({
      id: "native-image",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + "data: [DONE]\n\n",
  );
}

function lastRole(body: unknown): unknown {
  const messages = object(body)?.messages;
  return Array.isArray(messages) ? object(messages.at(-1))?.role : undefined;
}

/** The first user-ending request issues the scripted read; every other request just finishes. */
async function startGateway(): Promise<GatewayStub> {
  const stub = await startStub((self, recorded, response) => {
    const gateway = self as GatewayStub;
    if (gateway.toolTurns > 0 && lastRole(recorded.body) === "user") {
      gateway.toolTurns -= 1;
      const call = {
        index: 0,
        id: `call_image_${String(self.requests.length)}`,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: IMAGE_FILE }) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  return Object.assign(stub, {
    toolTurns: 0,
    url: `http://127.0.0.1:${String(stub.port)}/v1`,
    close: (): Promise<void> => closeStub(stub),
  });
}

async function startFacade(): Promise<Stub> {
  return await startStub((_self, _recorded, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"effect":"allow"}');
  });
}

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-image-")));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const png = syntheticPng();
  writeFileSync(join(workspace, IMAGE_FILE), png);
  const git = resolveDarwinGitExecutable();
  const initialized = spawnSync(git.path, ["init", "-q", workspace], {
    env: {
      HOME: state,
      PATH: dirname(git.path),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (initialized.status !== 0) throw new Error("fixture-git-initialization-failed");
  return { root, workspace, state, png };
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
  readonly config: Record<string, unknown> | undefined;
}

function materializePrivateConfiguration(state: string, config: string): void {
  const configRoot = join(state, "config", "opencode");
  for (const path of [
    join(configRoot, "plugins"),
    join(state, "home"),
    join(state, "state"),
    join(state, "tmp"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "opencode.json"), config, { mode: 0o600 });
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  endpoints: { readonly gatewayUrl: string; readonly facade: Stub },
  imageInput: boolean,
): Launched {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
      ...(imageInput ? { imageInput: true } : {}),
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  materializePrivateConfiguration(fixture.state, profile.config);
  const git = resolveDarwinGitExecutable();
  const { gatewayUrl } = endpoints;
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl,
    runId: RUN_ID,
    treeBindingId: "a".repeat(64),
    envelopeDigest: "b".repeat(64),
    runtimeArtifactDigest: "c".repeat(64),
    modelProfileDigest: "d".repeat(64),
    profile: "keiko-native",
    filesystem: {
      workspaceRoot: fixture.workspace,
      workspaceAccess: "read-write",
      privateStateRoot: fixture.state,
      runtimeReadRoot: runtimeRoot,
      protectedWriteRoots: [openCodeConfigDirectory(fixture.state)],
    },
  });
  const command = buildRuntimeGatewaySeatbeltCommand(policy, binary, profile.args, git.path);
  const password = profile.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) throw new Error("fixture-password-missing");
  return {
    password,
    config: object(profile.configValue),
    child: spawn(command.command, [...command.args], {
      cwd: fixture.workspace,
      env: {
        ...profile.env,
        PATH: `${dirname(git.path)}:/usr/bin:/bin`,
        KEIKO_MODEL_GATEWAY_URL: gatewayUrl,
        KEIKO_MODEL_GATEWAY_CAPABILITY: GATEWAY_CAPABILITY,
        KEIKO_TOOL_FACADE_URL: `http://127.0.0.1:${String(endpoints.facade.port)}/native-policy`,
        KEIKO_TOOL_FACADE_CAPABILITY: FACADE_CAPABILITY,
        KEIKO_CODING_RUN_ID: RUN_ID,
        KEIKO_CODING_MODE: "governed-assist",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

async function childEndpoint(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("fixture-startup-timeout"));
    }, 20_000);
    const onData = (bytes: Buffer): void => {
      for (const line of bytes.toString("utf8").split("\n")) {
        const endpoint = parseOpenCodeV2ChildEndpoint(line + "\n");
        if (endpoint !== undefined) {
          clearTimeout(timeout);
          resolve(endpoint);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-startup-failed"));
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("fixture-child-exited"));
    });
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
}

interface ProductiveGateway extends ModelEndpoint {
  /** The requests the production route handed to the model gateway, in order. */
  readonly requests: GatewayRequest[];
  /** The HTTP status the route answered each OpenCode request with. */
  readonly statuses: number[];
}

function gatewayConfig(imageInput: boolean): GatewayConfig {
  const provider = {
    modelId: "image-fixture-model",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "image-fixture-provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment" as const,
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  return {
    providers: [provider],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: provider.modelId,
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
        structuredOutput: true,
        streaming: true,
        supportsImageInput: imageInput,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "low",
        latencyClass: "standard",
        throughputHint: "functional",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
}

function modelResponse(partial: Partial<NormalizedResponse>): NormalizedResponse {
  return {
    modelId: "image-fixture-model",
    content: "",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "image-fixture-request",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
    ...partial,
  };
}

/** The scripted model: one native read of the image, then a plain final answer. */
function scriptedModelTurn(
  script: { toolTurns: number },
  request: GatewayRequest,
): NormalizedResponse {
  if (script.toolTurns > 0 && request.messages.at(-1)?.role === "user") {
    script.toolTurns -= 1;
    return modelResponse({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_image_route", name: "read", arguments: { path: IMAGE_FILE } }],
    });
  }
  return modelResponse({ content: "Fixture turn completed." });
}

async function serveRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiHandlerDeps,
  statuses: number[],
): Promise<void> {
  res.once("finish", () => statuses.push(res.statusCode));
  let result: RouteResult | typeof STREAMING;
  try {
    result = await handleCodingSidecarGatewayChatCompletions(
      {
        correlationId: undefined,
        req,
        res,
        params: {},
        url: new URL(req.url ?? "/", "http://127.0.0.1"),
      },
      deps,
    );
  } catch {
    res.writeHead(500).end();
    return;
  }
  if (result === STREAMING) return;
  res.writeHead(result.status, { "Content-Type": "application/json", ...result.headers });
  res.end(JSON.stringify(result.body));
}

/**
 * The production sidecar route on a loopback listener, wired like production (native readiness
 * registry, runtime capability authenticator) with only the model-gateway port scripted: the
 * recorded `GatewayRequest` is what the route would hand the Model Gateway.
 */
async function startProductiveGateway(imageInput: boolean): Promise<ProductiveGateway> {
  const config = gatewayConfig(imageInput);
  const requests: GatewayRequest[] = [];
  const statuses: number[] = [];
  const state = { toolTurns: 0 };
  const script = (request: GatewayRequest): NormalizedResponse => {
    requests.push(request);
    return scriptedModelTurn(state, request);
  };
  const deps = {
    config,
    configPresent: true,
    evidenceStore: {
      put: (): string => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    codingSidecarGatewayChatFactory:
      () =>
      (request: GatewayRequest): Promise<NormalizedResponse> =>
        Promise.resolve(script(request)),
    codingSidecarGatewayChatStreamFactory:
      () =>
      (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<GatewayStreamChunk> {
          const response = script(request);
          await Promise.resolve();
          if (response.content !== "") yield { type: "delta", token: response.content };
          yield { type: "done", response };
        },
      }),
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade"): unknown =>
        capability === GATEWAY_CAPABILITY && audience === "model-gateway"
          ? { ok: true, binding: { runId: RUN_ID } }
          : { ok: false },
      reservePromptTokens: () => ({ ok: true, runId: RUN_ID }),
    },
    openCodeGatewayReadinessRegistry: createOpenCodeGatewayReadinessRegistry("native"),
    codingWorkbenchEvidenceStore: {
      put: (): string => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
  } as unknown as UiHandlerDeps;
  const server = createServer((req, res) => {
    void serveRoute(req, res, deps, statuses);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-listener-invalid");
  return {
    requests,
    statuses,
    get toolTurns(): number {
      return state.toolTurns;
    },
    set toolTurns(value: number) {
      state.toolTurns = value;
    },
    url: `http://127.0.0.1:${String(address.port)}/api/coding-sidecar/gateway`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

interface Run<M extends ModelEndpoint> {
  readonly fixture: Fixture;
  readonly model: M;
  readonly client: OpenCodeV2HttpClient;
  readonly sessionId: string;
  readonly config: Record<string, unknown> | undefined;
}

async function withRun<M extends ModelEndpoint>(
  imageInput: boolean,
  startModel: (imageInput: boolean) => Promise<M>,
  body: (run: Run<M>) => Promise<void>,
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const fixture = createFixture();
  const [model, facade] = [await startModel(imageInput), await startFacade()];
  const launched = launch(
    fixture,
    realpathSync(BINARY),
    realpathSync(RESOURCE_ROOT),
    { gatewayUrl: model.url, facade },
    imageInput,
  );
  try {
    const client = createOpenCodeV2HttpClient({
      endpoint: await childEndpoint(launched.child),
      password: launched.password,
    });
    expect((await client.info()).version).toBe(OPENCODE_PINNED_VERSION);
    const session = await client.createSession(fixture.workspace);
    if (typeof session.id !== "string") throw new Error("fixture-session-invalid");
    await body({ fixture, model, client, sessionId: session.id, config: launched.config });
  } finally {
    await stopChild(launched.child);
    await Promise.all([model.close(), closeStub(facade)]);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** The request that carries the scripted read's result back to the model. */
function followUpRequest(gateway: Stub): Recorded | undefined {
  return gateway.requests.find((recorded) => {
    const messages = object(recorded.body)?.messages;
    return Array.isArray(messages) && messages.some((message) => object(message)?.role === "tool");
  });
}

/** What the runtime sent back to the model as the result of the scripted tool call. */
function toolResultText(recorded: Recorded): string {
  const messages = object(recorded.body)?.messages;
  if (!Array.isArray(messages)) return "";
  const result = messages
    .map(object)
    .filter((message) => message?.role === "tool")
    .at(-1);
  return typeof result?.content === "string" ? result.content : "";
}

/** Every `image_url` content part of a request, with the role of the message that carries it. */
function imageParts(
  recorded: Recorded | undefined,
): readonly { readonly role: unknown; readonly part: Record<string, unknown> }[] {
  const messages = object(recorded?.body)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    const entry = object(message);
    const content = entry?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown) => {
      const record = object(part);
      return record?.type === "image_url" ? [{ role: entry?.role, part: record }] : [];
    });
  });
}

async function readScriptedImage(run: Run<GatewayStub>): Promise<Recorded> {
  run.model.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Look at the image in the workspace.");
  await expect.poll(() => followUpRequest(run.model), { timeout: 60_000 }).not.toBeUndefined();
  const followUp = followUpRequest(run.model);
  if (followUp === undefined) throw new Error("fixture-follow-up-missing");
  return followUp;
}

/** The request the route handed the gateway after the scripted read's result came back. */
function routeFollowUp(gateway: ProductiveGateway): GatewayRequest | undefined {
  return gateway.requests.find((request) =>
    request.messages.some((message) => message.role === "tool"),
  );
}

function gatewayImageParts(
  request: GatewayRequest,
): readonly { readonly role: string; readonly url: string }[] {
  return request.messages.flatMap((message) =>
    (message.contentParts ?? []).flatMap((part) =>
      part.type === "image_url" ? [{ role: message.role, url: part.image_url.url }] : [],
    ),
  );
}

async function readThroughRoute(run: Run<ProductiveGateway>): Promise<GatewayRequest> {
  run.model.toolTurns = 1;
  await run.client.prompt(run.sessionId, "Look at the image in the workspace.");
  await expect.poll(() => routeFollowUp(run.model), { timeout: 60_000 }).not.toBeUndefined();
  const followUp = routeFollowUp(run.model);
  if (followUp === undefined) throw new Error("fixture-route-follow-up-missing");
  return followUp;
}

function modelCapabilities(config: Record<string, unknown> | undefined): unknown {
  const provider = object(object(config?.providers)?.["keiko-runtime"]);
  return object(object(provider?.models)?.coding)?.capabilities;
}

describe("pinned native OpenCode image input", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "hands a read workspace image to a model that declares image input, once and byte for byte",
    async () => {
      await withRun(true, startGateway, async (run) => {
        expect(modelCapabilities(run.config)).toEqual({
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        });
        const followUp = await readScriptedImage(run);
        const images = imageParts(followUp);
        expect(images).toHaveLength(1);
        const url = object(images[0]?.part.image_url)?.url;
        expect(url).toBe(`data:image/png;base64,${run.fixture.png.toString("base64")}`);
        // The production validator admits exactly what the original runtime emitted.
        const admitted = parseImageUrlContentPart(images[0]?.part);
        expect(admitted).toEqual({ kind: "ok", part: images[0]?.part });
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: a model that declares text only receives no image and none of the file's bytes",
    async () => {
      await withRun(false, startGateway, async (run) => {
        expect(modelCapabilities(run.config)).toEqual({
          tools: true,
          input: ["text"],
          output: ["text"],
        });
        const followUp = await readScriptedImage(run);
        expect(imageParts(followUp)).toHaveLength(0);
        // The original runtime itself tells the model it cannot see the image, as standalone.
        expect(toolResultText(followUp)).toContain("does not support image input");
        expect(JSON.stringify(followUp.body)).not.toContain(run.fixture.png.toString("base64"));
        expect(JSON.stringify(run.model.requests)).not.toContain("image_url");
      });
    },
    120_000,
  );
  it.skipIf(skip)(
    "the productive sidecar route admits the original runtime's image request and hands the gateway one image part",
    async () => {
      await withRun(true, startProductiveGateway, async (run) => {
        const followUp = await readThroughRoute(run);
        expect(gatewayImageParts(followUp)).toEqual([
          { role: "user", url: `data:image/png;base64,${run.fixture.png.toString("base64")}` },
        ]);
        // The route answered every request the original runtime made with success.
        expect(run.model.statuses.length).toBeGreaterThanOrEqual(2);
        expect(run.model.statuses.every((status) => status === 200)).toBe(true);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: the productive sidecar route hands the gateway no image when the runtime declares text only",
    async () => {
      await withRun(false, startProductiveGateway, async (run) => {
        const followUp = await readThroughRoute(run);
        expect(gatewayImageParts(followUp)).toEqual([]);
        expect(run.model.statuses.every((status) => status === 200)).toBe(true);
      });
    },
    120_000,
  );
});
