import {
  prepareNativeConfigurationRoot,
  spawnConfinedNativeChild,
  initializeFixtureGitWorkspace,
  removeFixtureRootAfterFailure,
} from "../../../../tests/support/opencode-native-launch.js";
import { type ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { resolveDarwinGitExecutable } from "@oscharko-dev/keiko-sandbox";
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
import { parseFileContentPart } from "../coding-sidecar-document-parts.js";
import { parseImageUrlContentPart } from "../coding-sidecar-image-parts.js";
import { buildRedactor, type UiHandlerDeps } from "../deps.js";
import { STREAMING, type RouteResult } from "../routes.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import { openCodeV2PromptFileData, type OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

import {
  createNativeSession,
  startNativeHttpByteListener,
  parseNativeHttpJson,
  closeNativeHttpStub as closeStub,
  withNativeHttpStub,
} from "../../../../tests/support/opencode-native-http.js";
import {
  nativeChildEndpoint as childEndpoint,
  withNativeChild,
} from "../../../../tests/support/opencode-native-child.js";

/**
 * Original-runtime proof for native media input: images (#3897 S14, review P2) and PDF documents
 * (#3906 AC1). The pinned executable runs under the real native Seatbelt wrapper with the profile
 * `buildOpenCodeLaunchProfile` produces; a scripted model asks for a native `read` of a small
 * synthetic PNG or PDF, and the stub gateway records the provider request that follows. With the
 * medium declared that request carries exactly one `image_url` or `file` part holding the file's
 * bytes; declared text-only (the default) it carries none and the file's bytes appear nowhere in
 * the request. A second set runs the same original runtime against the PRODUCTIVE sidecar route
 * (`handleCodingSidecarGatewayChatCompletions`, scripted only at the model-gateway port), so the
 * request the route hands the gateway is observed too. Run with KEIKO_OPENCODE_REAL_BINARY and
 * KEIKO_OPENCODE_REAL_RESOURCE_ROOT set; otherwise it is skipped.
 */
const BINARY = process.env.KEIKO_OPENCODE_REAL_BINARY;
const RESOURCE_ROOT = process.env.KEIKO_OPENCODE_REAL_RESOURCE_ROOT;
const GATEWAY_CAPABILITY = "m".repeat(43);
const RUN_ID = "run-native-media";
const FACADE_CAPABILITY = "fixture-facade-capability";
const IMAGE_FILE = "pixel.png";
const PDF_FILE = "brief.pdf";

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
  /** The workspace file each scripted turn asks the native `read` tool for. */
  readPath: string;
}

/** The media the admitted model declares beyond text. */
interface Media {
  readonly image: boolean;
  readonly pdf: boolean;
}

const TEXT_ONLY: Media = { image: false, pdf: false };
const IMAGE_INPUT: Media = { image: true, pdf: false };
const PDF_INPUT: Media = { image: false, pdf: true };

interface GatewayStub extends Stub, ModelEndpoint {}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
  readonly png: Buffer;
  readonly pdf: Buffer;
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

/** A minimal one-page PDF; the sidecar route checks only its `%PDF-` signature and size. */
function syntheticPdf(): Buffer {
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
      "",
    ].join("\n"),
    "latin1",
  );
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function startStub(
  respond: (stub: Stub, recorded: Recorded, response: ServerResponse) => void,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: Stub = { port: 0, requests, server: createServer() };
  await startNativeHttpByteListener(stub, (request, bytes, response) => {
    const recorded = {
      url: request.url ?? "",
      body: parseNativeHttpJson(bytes.toString("utf8")),
    };
    requests.push(recorded);
    respond(stub, recorded, response);
  });
  return stub;
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
        function: { name: "read", arguments: JSON.stringify({ path: gateway.readPath }) },
      };
      streamedTurn(response, { tool_calls: [call] }, "tool_calls");
      return;
    }
    streamedTurn(response, { content: "Fixture turn completed." }, "stop");
  });
  return Object.assign(stub, {
    toolTurns: 0,
    readPath: IMAGE_FILE,
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
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-native-image-"));
  try {
    const root = realpathSync(temporaryRoot);
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const png = syntheticPng();
    writeFileSync(join(workspace, IMAGE_FILE), png);
    const pdf = syntheticPdf();
    writeFileSync(join(workspace, PDF_FILE), pdf);
    initializeFixtureGitWorkspace(workspace, state);
    return { root, workspace, state, png, pdf };
  } catch (error) {
    removeFixtureRootAfterFailure(temporaryRoot, error);
  }
}

interface Launched {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly password: string;
  readonly config: Record<string, unknown> | undefined;
}

function materializePrivateConfiguration(state: string, config: string): void {
  const configRoot = prepareNativeConfigurationRoot(state, config);
  for (const [name, source] of Object.entries(createGeneratedOpenCodeV2Plugins("native")))
    writeFileSync(join(configRoot, "plugins", `${name}.ts`), source, { mode: 0o600 });
}

function launch(
  fixture: Fixture,
  binary: string,
  runtimeRoot: string,
  endpoints: { readonly gatewayUrl: string; readonly facade: Stub },
  media: Media,
): Launched {
  const profile = buildOpenCodeLaunchProfile({
    executable: binary,
    stateRoot: fixture.state,
    toolProfile: "native",
    contextGeometry: {
      contextWindowTokens: 32_768,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_096,
      ...(media.image ? { imageInput: true } : {}),
      ...(media.pdf ? { documentInput: true } : {}),
    },
  });
  if (!profile.ok) throw new Error("fixture-profile-invalid");
  materializePrivateConfiguration(fixture.state, profile.config);
  const { gatewayUrl } = endpoints;
  return {
    config: object(profile.configValue),
    ...spawnConfinedNativeChild({
      binary,
      profile,
      gitPath: resolveDarwinGitExecutable().path,
      workspace: fixture.workspace,
      state: fixture.state,
      runtimeRoot,
      gatewayUrl: gatewayUrl,
      gatewayCapability: GATEWAY_CAPABILITY,
      facadeUrl: `http://127.0.0.1:${String(endpoints.facade.port)}/native-policy`,
      facadeCapability: FACADE_CAPABILITY,
      runId: RUN_ID,
      mode: "governed-assist",
    }),
  };
}

interface ProductiveGateway extends ModelEndpoint {
  /** The requests the production route handed to the model gateway, in order. */
  readonly requests: GatewayRequest[];
  /** The HTTP status the route answered each OpenCode request with. */
  readonly statuses: number[];
}

function gatewayConfig(media: Media): GatewayConfig {
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
        supportsImageInput: media.image,
        supportsDocumentInput: media.pdf,
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

/** The scripted model: one native read of the scripted file, then a plain final answer. */
function scriptedModelTurn(
  script: { toolTurns: number; readPath: string },
  request: GatewayRequest,
): NormalizedResponse {
  if (script.toolTurns > 0 && request.messages.at(-1)?.role === "user") {
    script.toolTurns -= 1;
    return modelResponse({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_media_route", name: "read", arguments: { path: script.readPath } }],
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
async function startProductiveGateway(media: Media): Promise<ProductiveGateway> {
  const config = gatewayConfig(media);
  const requests: GatewayRequest[] = [];
  const statuses: number[] = [];
  const state = { toolTurns: 0, readPath: IMAGE_FILE };
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
    get readPath(): string {
      return state.readPath;
    },
    set readPath(value: string) {
      state.readPath = value;
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

/** The model endpoint remains its actual scripted or productive local owner. */
async function withModelEndpoint(model: ModelEndpoint, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    try {
      await model.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-model-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await model.close();
}

async function withRun<M extends ModelEndpoint>(
  media: Media,
  startModel: (media: Media) => Promise<M>,
  body: (run: Run<M>) => Promise<void>,
): Promise<void> {
  if (BINARY === undefined || RESOURCE_ROOT === undefined)
    throw new Error("fixture-binary-missing");
  expect(process.platform).toBe("darwin");
  const binary = BINARY;
  const resourceRoot = RESOURCE_ROOT;
  const fixture = createFixture();
  try {
    const model = await startModel(media);
    await withModelEndpoint(model, async (): Promise<void> => {
      const facade = await startFacade();
      await withNativeHttpStub(facade, async (): Promise<void> => {
        const launched = launch(
          fixture,
          realpathSync(binary),
          realpathSync(resourceRoot),
          { gatewayUrl: model.url, facade },
          media,
        );
        await withNativeChild(launched.child, async (): Promise<void> => {
          const { client, version, sessionId } = await createNativeSession(
            await childEndpoint(launched.child),
            launched.password,
            fixture.workspace,
          );
          expect(version).toBe(OPENCODE_PINNED_VERSION);
          await body({ fixture, model, client, sessionId, config: launched.config });
        });
      });
    });
  } catch (error) {
    try {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-root-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/** Every content part of one type in a request, with the role of the message that carries it. */
function mediaParts(
  recorded: Recorded | undefined,
  type: "image_url" | "file",
): readonly { readonly role: unknown; readonly part: Record<string, unknown> }[] {
  const messages = object(recorded?.body)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    const entry = object(message);
    const content = entry?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown) => {
      const record = object(part);
      return record?.type === type ? [{ role: entry?.role, part: record }] : [];
    });
  });
}

async function readScripted(run: Run<GatewayStub>, path: string): Promise<Recorded> {
  run.model.toolTurns = 1;
  run.model.readPath = path;
  await run.client.prompt(run.sessionId, `Look at ${path} in the workspace.`);
  await expect.poll(() => followUpRequest(run.model), { timeout: 60_000 }).not.toBeUndefined();
  const followUp = followUpRequest(run.model);
  if (followUp === undefined) throw new Error("fixture-follow-up-missing");
  return followUp;
}

/** The first request since `from` the route handed the gateway with a read's result in it. */
function routeFollowUp(gateway: ProductiveGateway, from: number): GatewayRequest | undefined {
  return gateway.requests
    .slice(from)
    .find((request) => request.messages.some((message) => message.role === "tool"));
}

/** The image URL or document data of every media part the route handed the gateway. */
function gatewayMediaParts(
  request: GatewayRequest,
): readonly { readonly role: string; readonly data: string }[] {
  return request.messages.flatMap((message) =>
    (message.contentParts ?? []).flatMap((part) => {
      if (part.type === "image_url") return [{ role: message.role, data: part.image_url.url }];
      if (part.type === "file") return [{ role: message.role, data: part.file.file_data }];
      return [];
    }),
  );
}

async function readThroughRoute(
  run: Run<ProductiveGateway>,
  path: string,
): Promise<GatewayRequest> {
  run.model.toolTurns = 1;
  run.model.readPath = path;
  const from = run.model.requests.length;
  await run.client.prompt(run.sessionId, `Look at ${path} in the workspace.`);
  await expect.poll(() => routeFollowUp(run.model, from), { timeout: 60_000 }).not.toBeUndefined();
  const followUp = routeFollowUp(run.model, from);
  if (followUp === undefined) throw new Error("fixture-route-follow-up-missing");
  return followUp;
}

function modelCapabilities(config: Record<string, unknown> | undefined): unknown {
  const provider = object(object(config?.providers)?.["keiko-runtime"]);
  return object(object(provider?.models)?.coding)?.capabilities;
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** The first request whose newest message is the user's prompt with the attachment. */
function promptRequest(gateway: Stub, text: string): Recorded | undefined {
  return gateway.requests.find((recorded) => JSON.stringify(recorded.body).includes(text));
}

/** Prompts with one inline attachment, as `opencodePromptInputs.ts` admits it, and waits. */
async function attachToPrompt(
  run: Run<GatewayStub>,
  text: string,
  file: {
    readonly bytes: Buffer;
    readonly mime: "image/png" | "application/pdf";
    readonly name: string;
  },
): Promise<Recorded> {
  await run.client.prompt(run.sessionId, text, undefined, undefined, {
    files: [{ uri: openCodeV2PromptFileData(file.bytes, file.mime), name: file.name }],
  });
  await expect.poll(() => promptRequest(run.model, text), { timeout: 60_000 }).not.toBeUndefined();
  const recorded = promptRequest(run.model, text);
  if (recorded === undefined) throw new Error("fixture-prompt-request-missing");
  return recorded;
}

describe("pinned native OpenCode media input", () => {
  const skip = BINARY === undefined || RESOURCE_ROOT === undefined;

  it.skipIf(skip)(
    "hands a read workspace image to a model that declares image input, once and byte for byte",
    async () => {
      await withRun(IMAGE_INPUT, startGateway, async (run) => {
        expect(modelCapabilities(run.config)).toEqual({
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        });
        const followUp = await readScripted(run, IMAGE_FILE);
        const images = mediaParts(followUp, "image_url");
        expect(images).toHaveLength(1);
        const url = object(images[0]?.part.image_url)?.url;
        expect(url).toBe(dataUrl("image/png", run.fixture.png));
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
      await withRun(TEXT_ONLY, startGateway, async (run) => {
        expect(modelCapabilities(run.config)).toEqual({
          tools: true,
          input: ["text"],
          output: ["text"],
        });
        const followUp = await readScripted(run, IMAGE_FILE);
        expect(mediaParts(followUp, "image_url")).toHaveLength(0);
        // The original runtime itself tells the model it cannot see the image, as standalone.
        expect(toolResultText(followUp)).toContain("does not support image input");
        expect(JSON.stringify(followUp.body)).not.toContain(run.fixture.png.toString("base64"));
        expect(JSON.stringify(run.model.requests)).not.toContain("image_url");
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "hands a read workspace PDF to a model that declares PDF input, once and byte for byte",
    async () => {
      await withRun(PDF_INPUT, startGateway, async (run) => {
        expect(modelCapabilities(run.config)).toEqual({
          tools: true,
          input: ["text", "pdf"],
          output: ["text"],
        });
        const followUp = await readScripted(run, PDF_FILE);
        const documents = mediaParts(followUp, "file");
        expect(documents).toHaveLength(1);
        expect(documents[0]?.role).toBe("user");
        const file = object(documents[0]?.part.file);
        expect(file?.file_data).toBe(dataUrl("application/pdf", run.fixture.pdf));
        // The production validator admits what the original runtime emitted, bytes unchanged.
        const admitted = parseFileContentPart(documents[0]?.part);
        if (admitted.kind !== "ok") throw new Error("expected the PDF part to be admitted");
        expect(admitted.part.file.file_data).toBe(file?.file_data);
        expect(mediaParts(followUp, "image_url")).toHaveLength(0);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: a model that declares text only receives no PDF and none of the document's bytes",
    async () => {
      await withRun(TEXT_ONLY, startGateway, async (run) => {
        const followUp = await readScripted(run, PDF_FILE);
        expect(mediaParts(followUp, "file")).toHaveLength(0);
        // The original runtime itself tells the model it cannot read the PDF, as standalone.
        expect(toolResultText(followUp)).toContain("does not support pdf input");
        expect(JSON.stringify(followUp.body)).not.toContain(run.fixture.pdf.toString("base64"));
      });
    },
    120_000,
  );

  // #3906 AC1: an image or PDF the human attached with `@` reaches the model as the runtime's own
  // user-message part, byte for byte.
  it.skipIf(skip)(
    "hands a prompt's attached image and PDF to a model that declares both, byte for byte",
    async () => {
      await withRun({ image: true, pdf: true }, startGateway, async (run) => {
        const image = await attachToPrompt(run, "Describe the attached screenshot.", {
          bytes: run.fixture.png,
          mime: "image/png",
          name: IMAGE_FILE,
        });
        expect(mediaParts(image, "image_url").map((entry) => entry.role)).toEqual(["user"]);
        expect(object(mediaParts(image, "image_url")[0]?.part.image_url)?.url).toBe(
          dataUrl("image/png", run.fixture.png),
        );

        const document = await attachToPrompt(run, "Summarize the attached brief.", {
          bytes: run.fixture.pdf,
          mime: "application/pdf",
          name: PDF_FILE,
        });
        const files = mediaParts(document, "file");
        expect(files.map((entry) => entry.role)).toContain("user");
        expect(files.map((entry) => object(entry.part.file)?.file_data)).toContain(
          dataUrl("application/pdf", run.fixture.pdf),
        );
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "the productive sidecar route admits the original runtime's image request and hands the gateway one image part",
    async () => {
      await withRun(IMAGE_INPUT, startProductiveGateway, async (run) => {
        const followUp = await readThroughRoute(run, IMAGE_FILE);
        expect(gatewayMediaParts(followUp)).toEqual([
          { role: "user", data: dataUrl("image/png", run.fixture.png) },
        ]);
        // The route answered every request the original runtime made with success.
        expect(run.model.statuses.length).toBeGreaterThanOrEqual(2);
        expect(run.model.statuses.every((status) => status === 200)).toBe(true);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "the productive sidecar route admits the original runtime's PDF request and hands the gateway one file part",
    async () => {
      await withRun(PDF_INPUT, startProductiveGateway, async (run) => {
        const followUp = await readThroughRoute(run, PDF_FILE);
        expect(gatewayMediaParts(followUp)).toEqual([
          { role: "user", data: dataUrl("application/pdf", run.fixture.pdf) },
        ]);
        expect(run.model.statuses.length).toBeGreaterThanOrEqual(2);
        expect(run.model.statuses.every((status) => status === 200)).toBe(true);
      });
    },
    120_000,
  );

  it.skipIf(skip)(
    "control: the productive sidecar route hands the gateway no media when the runtime declares text only",
    async () => {
      await withRun(TEXT_ONLY, startProductiveGateway, async (run) => {
        expect(gatewayMediaParts(await readThroughRoute(run, IMAGE_FILE))).toEqual([]);
        expect(gatewayMediaParts(await readThroughRoute(run, PDF_FILE))).toEqual([]);
        expect(run.model.statuses.every((status) => status === 200)).toBe(true);
      });
    },
    120_000,
  );
});
