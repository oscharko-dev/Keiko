import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { selectConfiguredModel, type ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps } from "./deps.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { handleCodingSidecarGatewayProfile } from "./coding-sidecar-gateway.js";
import {
  awaitAnyInitializedConversationReadyChatModel,
  codingWorkbenchProbesSettledForTests,
  initializeConfiguredConversationReadiness,
  resetCodingWorkbenchContextWindowProbesForTests,
} from "./gateway-readiness.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import { handleCreateDesktopChat } from "./chat-handlers.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleModels } from "./read-handlers.js";
import { handleUpdateChat } from "./store-handlers.js";
import {
  configuredEmbeddingProviders,
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
  awaitDetachedCapsuleIndexing,
} from "./local-knowledge-handlers.js";

// Field twin of the customer's strict LiteLLM (2026-08 incident): chat completions answer
// normally, but the embeddings route rejects EVERY request carrying optional extras — the
// unconditional `encoding_format` or an array `input` — with an answered HTTP 400, exactly
// like the readiness cards showed ("Embedding endpoint could not be verified (http-error
// 400)"). The journey below is the exact customer path on a FRESH install: save credentials,
// open a chat immediately (no manual readiness click), create a Knowledge Pod, connect a
// folder, index it. It must reach vectors end to end over the REAL production deps and the
// REAL embedding transport — no adapter seam, no mocked fetch.

const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

interface FakeGatewayLog {
  embeddingBodies: Record<string, unknown>[];
  chatModels: string[];
  // Bodies of every /rerank request: a discovered reranker must be probed with the two-document
  // request readiness sends, and only then wired.
  rerankBodies?: Record<string, unknown>[];
}

interface StrictLiteLlmOptions {
  // Customer configuration shape: an OCR model sits FIRST in the list and — exactly like the
  // field dotsocr — declares NO `mode` in /model/info, so discovery metadata cannot exclude it
  // and it lands in the stored configuration as an assumed chat model.
  readonly unsuitableFirstChatModel?: boolean;
  // A second declared chat model, as the field gateway has several tool-capable ones.
  readonly secondChatModel?: boolean;
  // The customer's whole gateway: ~15 deployed models of every kind the proxy hosts, exactly as
  // /model/info lists them (see `fieldInventory`).
  readonly fullInventory?: boolean;
}

// Mutable per-test control: a model in this set answers chat completions with an EMPTY
// assistant text (the cold/unsuitable backend). Tests flip it AFTER setup to model "answered
// the setup smoke while warm, fails later" without brittle call counting.
interface StrictLiteLlmBehavior {
  readonly emptyChatModels: Set<string>;
  // The field multilingual-e5-large accepts at most 512 real tokens per input and the gateway
  // answers a longer one with HTTP 500 (customer report on 1.1.0). Undefined: no limit.
  readonly maxEmbeddingInputChars?: number;
  // Answers a forced tool call with the arguments the caller asked for, as a deployment with a
  // working tool parser does. Off by default: the historical twin returned empty arguments.
  readonly answersToolCalls?: boolean;
}

function requestedToolName(body: Record<string, unknown>): string | undefined {
  const toolChoice = body.tool_choice;
  if (typeof toolChoice !== "object" || toolChoice === null || Array.isArray(toolChoice)) {
    return undefined;
  }
  if (!("function" in toolChoice)) return undefined;
  const functionDefinition = toolChoice.function;
  if (
    typeof functionDefinition !== "object" ||
    functionDefinition === null ||
    Array.isArray(functionDefinition)
  ) {
    return undefined;
  }
  if (!("name" in functionDefinition)) return undefined;
  return typeof functionDefinition.name === "string" ? functionDefinition.name : undefined;
}

// The field inventory, in the order the customer's LiteLLM lists it: the OCR model FIRST and
// mode-less (a `hosted_vllm` deployment declares no mode, window or capabilities), the declared
// chat aliases behind it, then every non-chat engine the proxy hosts next to them.
function fieldInventory(): readonly Record<string, unknown>[] {
  const hostedVllm = (name: string): Record<string, unknown> => ({
    model_name: name,
    litellm_params: { model: `hosted_vllm/${name}` },
    model_info: { id: `${name}-deployment`, mode: null, max_input_tokens: null },
  });
  return [
    hostedVllm("dotsocr"),
    hostedVllm("hosted-vllm-llama"),
    hostedVllm("llama-guard-3"),
    { model_name: "gpt-4o", model_info: { mode: "chat", max_input_tokens: 128_000 } },
    { model_name: "qwen3-235b", model_info: { mode: "chat", max_input_tokens: 131_072 } },
    // A vLLM-native window declaration (`/v1/models` publishes max_model_len).
    { model_name: "vllm-native-chat", model_info: { mode: "chat", max_model_len: 32_768 } },
    // One alias, two deployments: the usable window is their intersection.
    { model_name: "multi-alias", model_info: { mode: "chat", max_input_tokens: 64_000 } },
    { model_name: "multi-alias", model_info: { mode: "chat", max_input_tokens: 32_000 } },
    // A wildcard route: declared chat, but no concrete model — the proxy refuses it.
    { model_name: "openai/*", model_info: { mode: "chat" } },
    // openai_like embedding: 1024 dimensions, 512 tokens per input.
    { model_name: "multilingual-e5-large", model_info: { mode: "embedding" } },
    { model_name: "bge-reranker-v2-m3", model_info: { mode: "rerank" } },
    { model_name: "whisper-1", model_info: { mode: "audio_transcription" } },
    { model_name: "tts-1", model_info: { mode: "audio_speech" } },
    { model_name: "dall-e-3", model_info: { mode: "image_generation" } },
    { model_name: "omni-moderation-latest", model_info: { mode: "moderation" } },
    { model_name: "vendor-special", model_info: { mode: "vendor-private-mode" } },
  ];
}

function answerModelInfo(res: ServerResponse, options: StrictLiteLlmOptions): void {
  if (options.fullInventory === true) {
    json(res, { data: fieldInventory() });
    return;
  }
  json(res, {
    data: [
      ...(options.unsuitableFirstChatModel === true ? [{ model_name: "dotsocr" }] : []),
      { model_name: "qwen-chat", model_info: { mode: "chat" } },
      ...(options.secondChatModel === true
        ? [{ model_name: "gemma-chat", model_info: { mode: "chat" } }]
        : []),
      { model_name: "multilingual-e5-large", model_info: { mode: "embedding" } },
    ],
  });
}

function answerChatCompletion(
  res: ServerResponse,
  raw: string,
  log: FakeGatewayLog,
  behavior: StrictLiteLlmBehavior,
): void {
  const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
  if (typeof body.model === "string") log.chatModels.push(body.model);
  if (typeof body.model === "string" && body.model.includes("*")) {
    // LiteLLM cannot route a wildcard alias to a concrete deployment.
    json(res, { error: { message: "Invalid model name passed in model=openai/*" } }, 400);
    return;
  }
  const empty = typeof body.model === "string" && behavior.emptyChatModels.has(body.model);
  const toolName = requestedToolName(body);
  // The long-context probe asks for its sentinel back; a real model that read the prompt returns it.
  const sentinel = raw.includes("KEIKO_LONG_CONTEXT_SENTINEL")
    ? "KEIKO_LONG_CONTEXT_SENTINEL"
    : "OK";
  json(res, {
    choices: [
      {
        message: {
          role: "assistant",
          content: empty ? "" : sentinel,
          ...(toolName === undefined
            ? {}
            : {
                tool_calls: [
                  {
                    function: {
                      name: toolName,
                      arguments: behavior.answersToolCalls === true ? '{"status":"ok"}' : "{}",
                    },
                  },
                ],
              }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
}

function answerEmbeddings(
  res: ServerResponse,
  raw: string,
  log: FakeGatewayLog,
  maxInputChars: number | undefined,
): void {
  const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
  log.embeddingBodies.push(body);
  if ("encoding_format" in body || Array.isArray(body.input)) {
    json(res, { error: { message: "unsupported request shape" } }, 400);
    return;
  }
  if (
    maxInputChars !== undefined &&
    typeof body.input === "string" &&
    body.input.length > maxInputChars
  ) {
    json(res, { error: { message: "internal error" } }, 500);
    return;
  }
  json(res, {
    data: [{ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1)) }],
    model: "multilingual-e5-large",
  });
}

// A working reranker: the document the query matches verbatim ranks first.
function answerRerank(res: ServerResponse, raw: string, log: FakeGatewayLog): void {
  const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
  log.rerankBodies?.push(body);
  const documents = Array.isArray(body.documents) ? (body.documents as unknown[]) : [];
  const best = Math.max(0, documents.indexOf(body.query));
  const order = [best, ...documents.map((_, index) => index).filter((index) => index !== best)];
  json(res, {
    results: order.map((index, rank) => ({ index, relevance_score: 1 - rank / 10 })),
  });
}

function startStrictLiteLlm(
  log: FakeGatewayLog,
  options: StrictLiteLlmOptions = {},
  behavior: StrictLiteLlmBehavior = { emptyChatModels: new Set() },
): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Decode once after ALL chunks arrived: a multi-byte umlaut straddling a chunk
      // boundary must not corrupt the JSON body.
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      if (url.endsWith("/model/info")) {
        answerModelInfo(res, options);
      } else if (url.endsWith("/chat/completions")) {
        answerChatCompletion(res, raw, log, behavior);
      } else if (url.endsWith("/embeddings")) {
        answerEmbeddings(res, raw, log, behavior.maxEmbeddingInputChars);
      } else if (url.endsWith("/rerank")) {
        answerRerank(res, raw, log);
      } else {
        json(res, { error: { message: `unknown route ${url}` } }, 404);
      }
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function ctx(
  method: string,
  body: Record<string, unknown>,
  params: Record<string, string> = {},
  path = "/api",
): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
  };
  return {
    correlationId: undefined,
    req,
    res: {
      destroyed: false,
      closed: false,
      writableEnded: false,
      once(): void {
        // deterministic stub
      },
      off(): void {
        // deterministic stub
      },
    } as unknown as ServerResponse,
    params,
    url: new URL(`http://127.0.0.1${path}`),
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FieldFixture {
  readonly deps: UiHandlerDeps;
  readonly projectDir: string;
  readonly tmp: string;
  readonly setupBody: Record<string, unknown>;
}

async function setUpFieldGateway(port: number, tmp: string): Promise<FieldFixture> {
  const projectDir = join(tmp, "repo");
  const evidenceDir = join(tmp, "evidence");
  mkdirSync(projectDir);
  mkdirSync(evidenceDir);
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir,
    uiDbPath: join(tmp, "keiko-ui.db"),
    env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
  });
  deps.store.createProject(projectDir, "repo");
  const setup = await handleGatewaySetup(
    ctx("POST", {
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      apiKey: "field-token",
    }),
    deps,
  );
  expect(setup.status).toBe(200);
  return { deps, projectDir, tmp, setupBody: setup.body as Record<string, unknown> };
}

function fieldTmpDir(): string {
  const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
  tempDirs.push(tmp);
  return tmp;
}

function probesSince(log: FakeGatewayLog, mark: number, modelId: string): number {
  return log.chatModels.slice(mark).filter((entry) => entry === modelId).length;
}

// Moves every stored forced tool-call proof to `checkedAt`, as wall-clock time would on disk.
function withToolCallingProofsAt(value: unknown, checkedAt: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withToolCallingProofsAt(item, checkedAt));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key === "toolCallingVerification" && typeof item === "object" && item !== null
        ? [key, { ...item, checkedAt }]
        : [key, withToolCallingProofsAt(item, checkedAt)],
    ),
  );
}

describe("strict LiteLLM field twin", () => {
  it("opens the first chat although an unsuitable OCR model sits first in the list", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const behavior: StrictLiteLlmBehavior = { emptyChatModels: new Set() };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true }, behavior);
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      // Customer field incident: with dotsocr first, the single-model on-demand check probed
      // ONLY the default, recorded not-ready, and every chat create failed until a suitable
      // model was probed manually. The customer state requires dotsocr to have SURVIVED setup
      // into the stored config (it answered the setup smoke while warm)…
      expect(deps.gatewayConfig?.current()?.providers.map((entry) => entry.modelId)).toContain(
        "dotsocr",
      );
      // …and to be COLD from here on.
      behavior.emptyChatModels.add("dotsocr");
      const mark = log.chatModels.length;
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Erster Chat" }),
        deps,
      );
      expect(chat.status).toBe(201);
      const body = chat.body as { readonly chat: { readonly selectedModel?: string } };
      expect(body.chat.selectedModel).toBe("qwen-chat");
      // The mode-declared preference sends the defaulted create straight to qwen-chat: the
      // cold OCR model is not even probed, so the first chat of the day no longer pays its
      // provider timeout.
      expect(probesSince(log, mark, "dotsocr")).toBe(0);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("never hands the defaulted create to a WARM OCR model while a declared chat model exists", async () => {
    // Finding of the 0.3.12 adversarial review: a warm dotsocr passes the minimal chat probe,
    // and a "first ready model wins" default then durably pinned every new chat to the OCR
    // engine. The conversation-default rank must prefer the mode-declared model even though
    // the OCR model would verify.
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true });
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Erster Chat" }),
        deps,
      );
      expect(chat.status).toBe(201);
      const body = chat.body as { readonly chat: { readonly selectedModel?: string } };
      expect(body.chat.selectedModel).toBe("qwen-chat");
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("keeps the defaulted create on the declared model even after the OCR model verified warm", async () => {
    // Review finding on the first cut: readiness preference across tiers let a VERIFIED
    // special-purpose model override an unprobed declared chat model. Warm dotsocr passes an
    // explicit-create probe first — the next defaulted create must still elect qwen-chat.
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true });
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      const explicit = await handleCreateDesktopChat(
        ctx("POST", {
          projectPath: fixture.projectDir,
          title: "OCR direkt",
          modelId: "dotsocr",
        }),
        deps,
      );
      // Credential verification already established that warm dotsocr can answer.
      expect(explicit.status).toBe(201);
      const defaulted = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Standard danach" }),
        deps,
      );
      expect(defaulted.status).toBe(201);
      const body = defaulted.body as { readonly chat: { readonly selectedModel?: string } };
      expect(body.chat.selectedModel).toBe("qwen-chat");
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("selects the initialized warm OCR fallback after configuration reload without chat probes", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const behavior: StrictLiteLlmBehavior = { emptyChatModels: new Set() };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true }, behavior);
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      // The declared chat model goes down AFTER setup; the OCR model stays warm. The walk must
      // still land a working conversation — the rank de-prioritizes dotsocr but never bans it.
      behavior.emptyChatModels.add("qwen-chat");
      deps.gatewayConfig?.set(deps.gatewayConfig.current(), true);
      initializeConfiguredConversationReadiness(deps, "corr-field-reload");
      await awaitAnyInitializedConversationReadyChatModel(deps, "qwen-chat", "corr-field-join");
      expect(deps.gatewayConfig?.verifiedCapability("qwen-chat")?.fields.conversationReady).toBe(
        false,
      );
      const mark = log.chatModels.length;
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Notbetrieb" }),
        deps,
      );
      expect(chat.status).toBe(201);
      const body = chat.body as { readonly chat: { readonly selectedModel?: string } };
      expect(body.chat.selectedModel).toBe("dotsocr");
      expect(log.chatModels).toHaveLength(mark);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("rejects an explicitly requested unready model without starting a probe or walking siblings", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const behavior: StrictLiteLlmBehavior = { emptyChatModels: new Set() };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true }, behavior);
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      behavior.emptyChatModels.add("dotsocr");
      deps.gatewayConfig?.set(deps.gatewayConfig.current(), true);
      initializeConfiguredConversationReadiness(deps, "corr-field-explicit-reload");
      await awaitAnyInitializedConversationReadyChatModel(
        deps,
        "qwen-chat",
        "corr-field-explicit-join",
      );
      expect(deps.gatewayConfig?.verifiedCapability("dotsocr")?.fields.conversationReady).toBe(
        false,
      );
      const mark = log.chatModels.length;
      // Explicit selection never falls back to the ready sibling and never initiates a probe.
      const chat = await handleCreateDesktopChat(
        ctx("POST", {
          projectPath: fixture.projectDir,
          title: "Explizit",
          modelId: "dotsocr",
        }),
        deps,
      );
      expect(chat.status).toBe(400);
      expect(probesSince(log, mark, "dotsocr")).toBe(0);
      expect(probesSince(log, mark, "qwen-chat")).toBe(0);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("carries the full fresh-install customer journey to indexed vectors", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(log);
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);
    const projectDir = join(tmp, "repo");
    const docsDir = join(tmp, "handbuch");
    const evidenceDir = join(tmp, "evidence");
    mkdirSync(projectDir);
    mkdirSync(docsDir);
    mkdirSync(evidenceDir);
    writeFileSync(
      join(docsDir, "index.html"),
      "<html><body><h1>Handbuch</h1><p>KFZ Kapitel eins.</p></body></html>",
      "utf8",
    );
    writeFileSync(
      join(docsDir, "kapitel-zwei.md"),
      "# Kapitel zwei\n\nVersicherung und Zahlungsverkehr.\n",
      "utf8",
    );

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      deps.store.createProject(projectDir, "repo");

      // 1. Save credentials — the only manual step the customer performs.
      const setup = await handleGatewaySetup(
        ctx("POST", {
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          apiKey: "field-token",
        }),
        deps,
      );
      expect(setup.status).toBe(200);

      // 2. Open a chat immediately using the credential check, with no additional probe.
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: projectDir, title: "Erster Chat" }),
        deps,
      );
      expect(chat.status).toBe(201);

      // 3. Knowledge Pod: create, connect the manual folder, index.
      const created = await handleCreateLocalKnowledgeCapsule(
        ctx("POST", { displayName: "Handbuch" }),
        deps,
      );
      expect(created.status).toBe(201);
      const capsuleId = (created.body as { capsule: { id: string } }).capsule.id;

      const connected = await handleConnectLocalKnowledgeCapsule(
        ctx(
          "POST",
          { scope: { kind: "folder", rootPath: docsDir, recursive: true } },
          { capsuleId },
        ),
        deps,
      );
      expect(connected.status).toBe(201);

      const indexed = await handleStartLocalKnowledgeCapsuleIndexing(
        ctx("POST", {}, { capsuleId }),
        deps,
      );
      // Detached indexing (2026-08): the route answers 202 the moment the job is admitted;
      // the journey awaits the run's terminal state explicitly, as the UI does via polling.
      expect(indexed.status).toBe(202);
      await awaitDetachedCapsuleIndexing(capsuleId);

      const detail = await handleGetLocalKnowledgeCapsule(ctx("GET", {}, { capsuleId }), deps);
      const body = detail.body as {
        readonly capsule: { readonly lifecycleState: string };
        readonly health: { readonly documentCount: number; readonly vectorCount: number };
        readonly indexingJobs: readonly { readonly status: string }[];
      };
      expect(body.capsule.lifecycleState).toBe("ready");
      expect(body.health.documentCount).toBeGreaterThan(0);
      expect(body.health.vectorCount).toBeGreaterThan(0);
      expect(body.indexingJobs.at(0)?.status).toBe("succeeded");

      // The strict gateway rejected every extras-carrying request; the ladder must have
      // landed on minimal scalar requests — and at least one 400 was actually answered.
      expect(log.embeddingBodies.some((entry) => "encoding_format" in entry)).toBe(true);
      // The batch-to-scalar degradation actually exercised the array rung: an array body was
      // attempted (and rejected), and minimal scalar bodies carried the run.
      expect(log.embeddingBodies.some((entry) => Array.isArray(entry.input))).toBe(true);
      expect(
        log.embeddingBodies.some(
          (entry) => !("encoding_format" in entry) && !Array.isArray(entry.input),
        ),
      ).toBe(true);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // Customer report on 1.1.0: URL and key were all the customer entered. The gateway declares no
  // token limits, so every chat model kept the 4,096 setup placeholder and the Coding Workbench
  // answered "context window too small (minimum 32,000)" for models that accept far more. What
  // Keiko can determine itself it must determine itself: opening the Workbench proves the window
  // and stores it, with no readiness click and no value copied by hand.
  it("proves and stores the context window itself when the Workbench profile is read", async () => {
    resetCodingWorkbenchContextWindowProbesForTests();
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(
      log,
      {},
      { emptyChatModels: new Set(), answersToolCalls: true },
    );
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      const setup = await handleGatewaySetup(
        ctx("POST", { baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "field-token" }),
        deps,
      );
      expect(setup.status).toBe(200);
      const storedWindow = (): number | undefined =>
        deps?.gatewayConfig
          ?.current()
          ?.capabilities?.find((capability) => capability.id === "qwen-chat")?.contextWindow;
      expect(storedWindow()).toBe(4_096);

      const events: ServerLogEvent[] = [];
      const observed: UiHandlerDeps = {
        ...deps,
        activityLog: { write: (event): void => void events.push(event) },
      };
      // ADR-0124 D5: a selected subscription source must never cause a paid gateway probe.
      const chatCallsBeforeSubscriptionRead = log.chatModels.length;
      const subscription = await handleCodingSidecarGatewayProfile(ctx("GET", {}), {
        ...deps,
        codingSidecarGatewayModelSourceResolver: () => "chatgpt-codex-subscription-profile",
      });
      expect(subscription.body).toMatchObject({ status: "unavailable" });
      expect(log.chatModels).toHaveLength(chatCallsBeforeSubscriptionRead);
      expect(storedWindow()).toBe(4_096);

      const profile = await handleCodingSidecarGatewayProfile(ctx("GET", {}), observed);

      expect(profile.body).toMatchObject({ status: "available", modelAlias: "qwen-chat" });
      expect(storedWindow()).toBe(32_000);
      // The raise is reconstructable from the log alone: the automatic run and what it proved.
      const completed = events.find(
        (event) => event.op === "gateway.readiness.automatic.completed",
      );
      expect(completed?.extra).toMatchObject({
        overallStatus: "ready",
        verifiedContextTokens: 32_000,
      });

      // A second read finds nothing left to prove and sends no further long-context request.
      const chatCallsAfterFirstRead = log.chatModels.length;
      await handleCodingSidecarGatewayProfile(ctx("GET", {}), deps);
      expect(log.chatModels).toHaveLength(chatCallsAfterFirstRead);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // The field gateway has six tool-capable models. Persisting one model's conclusion bumps the
  // configuration generation, and a run that started under the previous generation has its
  // conclusion discarded: probing them all at once stored the first and silently dropped the rest,
  // leaving every other model in the picker at 4,096 for the whole cooldown.
  it("proves the context window of every tool-capable model, not only the elected one", async () => {
    resetCodingWorkbenchContextWindowProbesForTests();
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(
      log,
      { secondChatModel: true },
      { emptyChatModels: new Set(), answersToolCalls: true },
    );
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      const setup = await handleGatewaySetup(
        ctx("POST", { baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "field-token" }),
        deps,
      );
      expect(setup.status).toBe(200);
      const windows = (): readonly (readonly [string, number])[] =>
        (deps?.gatewayConfig?.current()?.capabilities ?? [])
          .filter((capability) => capability.kind === "chat")
          .map((capability) => [capability.id, capability.contextWindow] as const);
      expect(windows()).toEqual([
        ["qwen-chat", 4_096],
        ["gemma-chat", 4_096],
      ]);

      const profile = await handleCodingSidecarGatewayProfile(ctx("GET", {}), deps);
      expect(profile.body).toMatchObject({ status: "available" });
      await codingWorkbenchProbesSettledForTests();

      expect(windows()).toEqual([
        ["qwen-chat", 32_000],
        ["gemma-chat", 32_000],
      ]);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // The forced tool-call proof expires after 24 h. A customer who connects the gateway today and
  // opens the Workbench tomorrow must not be sent to Settings to click a check: Keiko renews the
  // proof itself.
  it("renews an expired tool-calling proof itself when the Workbench profile is read", async () => {
    resetCodingWorkbenchContextWindowProbesForTests();
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(
      log,
      {},
      { emptyChatModels: new Set(), answersToolCalls: true },
    );
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      const setup = await handleGatewaySetup(
        ctx("POST", { baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "field-token" }),
        deps,
      );
      expect(setup.status).toBe(200);
      const holder = deps.gatewayConfig;
      const current = holder?.current();
      if (holder === undefined || current === undefined) throw new Error("expected a config");
      // Age the proof past its 24 h validity, as a day of wall-clock time would.
      holder.set(
        {
          ...current,
          capabilities: current.capabilities?.map((capability) =>
            capability.toolCallingVerification === undefined
              ? capability
              : {
                  ...capability,
                  toolCallingVerification: {
                    ...capability.toolCallingVerification,
                    checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString(),
                  },
                },
          ),
        },
        true,
      );

      const profile = await handleCodingSidecarGatewayProfile(ctx("GET", {}), deps);

      expect(profile.body).toMatchObject({ status: "available", modelAlias: "qwen-chat" });
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // 1.1.8 lab, a restart the day after setup: the loader stores an aged-out proof as
  // `toolCalling: false`, and the renewal above keyed on that flag, so after every restart the
  // Workbench read "no tool calling", probed nothing and stayed blocked until a manual check. Here
  // the day passes on disk and the process restarts, so the production loader builds the config.
  it("renews an expired tool-calling proof after a restart the day after setup", async () => {
    resetCodingWorkbenchContextWindowProbesForTests();
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(
      log,
      {},
      { emptyChatModels: new Set(), answersToolCalls: true },
    );
    const port = await listen(gateway);
    const tmp = fieldTmpDir();
    const options = {
      configPath: undefined,
      evidenceDir: tmp,
      uiDbPath: join(tmp, "keiko-ui.db"),
      env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
    };

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps(options);
      const setup = await handleGatewaySetup(
        ctx("POST", { baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "field-token" }),
        deps,
      );
      expect(setup.status).toBe(200);
      const storagePath = deps.gatewayConfig?.storagePath;
      if (storagePath === undefined) throw new Error("expected a stored config");
      const aged = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
      const stored: unknown = JSON.parse(readFileSync(storagePath, "utf8"));
      writeFileSync(storagePath, JSON.stringify(withToolCallingProofsAt(stored, aged)), "utf8");
      await deps.dispose?.();
      deps = buildUiHandlerDeps(options);
      const chatModel = (): ModelCapability | undefined =>
        deps?.gatewayConfig
          ?.current()
          ?.capabilities?.find((capability) => capability.id === "qwen-chat");
      // The loader still refuses tools on the aged proof; only a renewed proof may admit them.
      expect(chatModel()?.toolCalling).toBe(false);
      const mark = log.chatModels.length;
      const events: ServerLogEvent[] = [];
      const observed: UiHandlerDeps = {
        ...deps,
        activityLog: { write: (event): void => void events.push(event) },
      };

      const profile = await handleCodingSidecarGatewayProfile(ctx("GET", {}), observed);

      expect(profile.body).toMatchObject({ status: "available", modelAlias: "qwen-chat" });
      expect(probesSince(log, mark, "qwen-chat")).toBeGreaterThan(0);
      expect(chatModel()).toMatchObject({
        toolCalling: true,
        toolCallingVerification: { status: "verified" },
      });
      // The renewal is reconstructable from the log: the automatic run and its verdict.
      expect(events.map((event) => event.op)).toEqual(
        expect.arrayContaining([
          "gateway.readiness.automatic.started",
          "gateway.readiness.automatic.completed",
        ]),
      );
      expect(
        events.find((event) => event.op === "gateway.readiness.automatic.completed")?.extra,
      ).toMatchObject({ overallStatus: "ready" });
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // Customer report on 1.1.0: a single Word document sat at "0 of 36 vectors" for three minutes
  // and ended "embedding adapter returned http-error (HTTP 500)". Chunks are cut to 512 ESTIMATED
  // tokens; the field embedding model rejects an input over 512 REAL tokens, the gateway answers
  // that with 500, and the ladder failed the whole document on the first long chunk.
  it("indexes a dense document although the embedding model rejects long inputs", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(
      log,
      {},
      { emptyChatModels: new Set(), maxEmbeddingInputChars: 900 },
    );
    const port = await listen(gateway);
    const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
    tempDirs.push(tmp);
    const docsDir = join(tmp, "handbuch");
    mkdirSync(docsDir);
    const sentence =
      "Die Kraftfahrzeughaftpflichtversicherung reguliert Schadensersatzanspr\u00fcche im Zahlungsverkehr. ";
    writeFileSync(join(docsDir, "dicht.md"), `# Handbuch\n\n${sentence.repeat(120)}\n`, "utf8");

    let deps: UiHandlerDeps | undefined;
    try {
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: tmp,
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      const setup = await handleGatewaySetup(
        ctx("POST", { baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "field-token" }),
        deps,
      );
      expect(setup.status).toBe(200);
      const created = await handleCreateLocalKnowledgeCapsule(
        ctx("POST", { displayName: "Dicht" }),
        deps,
      );
      const capsuleId = (created.body as { capsule: { id: string } }).capsule.id;
      await handleConnectLocalKnowledgeCapsule(
        ctx(
          "POST",
          { scope: { kind: "folder", rootPath: docsDir, recursive: true } },
          { capsuleId },
        ),
        deps,
      );
      const indexed = await handleStartLocalKnowledgeCapsuleIndexing(
        ctx("POST", {}, { capsuleId }),
        deps,
      );
      expect(indexed.status).toBe(202);
      await awaitDetachedCapsuleIndexing(capsuleId);

      const detail = await handleGetLocalKnowledgeCapsule(ctx("GET", {}, { capsuleId }), deps);
      const body = detail.body as {
        readonly health: { readonly chunkCount: number; readonly vectorCount: number };
        readonly indexingJobs: readonly { readonly status: string }[];
      };
      // The premise: at least one chunk really was longer than the endpoint accepts.
      const scalarLengths = log.embeddingBodies
        .filter((entry) => typeof entry.input === "string")
        .map((entry) => (entry.input as string).length);
      expect(Math.max(...scalarLengths)).toBeGreaterThan(900);
      expect(body.indexingJobs.at(0)?.status).toBe("succeeded");
      expect(body.health.chunkCount).toBeGreaterThan(0);
      expect(body.health.vectorCount).toBe(body.health.chunkCount);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("answers the first pod question after a process restart without any manual probe", async () => {
    // 0.3.12 adversarial-review finding: readiness observations are process-local by design, so
    // after EVERY restart the grounded ask — the customer's primary journey — answered 400
    // "not ready" until an ungrounded send or a manual settings probe happened to record an
    // observation, and the models wire told the UI that no model was usable at all. This twin
    // restarts the server half-way: same stored config, same UI DB, fresh process state.
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const gateway = startStrictLiteLlm(log);
    const port = await listen(gateway);
    const tmp = fieldTmpDir();
    const docsDir = join(tmp, "handbuch");
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, tmp);
      deps = fixture.deps;
      mkdirSync(docsDir);
      writeFileSync(
        join(docsDir, "index.html"),
        "<html><body><h1>Handbuch</h1><p>KFZ Kapitel eins.</p></body></html>",
        "utf8",
      );
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Pod Chat" }),
        deps,
      );
      expect(chat.status).toBe(201);
      const chatId = (chat.body as { chat: { id: string } }).chat.id;
      const created = await handleCreateLocalKnowledgeCapsule(
        ctx("POST", { displayName: "Handbuch" }),
        deps,
      );
      const capsuleId = (created.body as { capsule: { id: string } }).capsule.id;
      const connected = await handleConnectLocalKnowledgeCapsule(
        ctx(
          "POST",
          { scope: { kind: "folder", rootPath: docsDir, recursive: true } },
          { capsuleId },
        ),
        deps,
      );
      expect(connected.status).toBe(201);
      const indexed = await handleStartLocalKnowledgeCapsuleIndexing(
        ctx("POST", {}, { capsuleId }),
        deps,
      );
      // Detached indexing (2026-08): the route answers 202 the moment the job is admitted;
      // the journey awaits the run's terminal state explicitly, as the UI does via polling.
      expect(indexed.status).toBe(202);
      await awaitDetachedCapsuleIndexing(capsuleId);
      const scoped = await handleUpdateChat(
        ctx(
          "PATCH",
          { localKnowledgeScope: { kind: "capsule", capsuleId, connectedAtMs: Date.now() } },
          {},
          `/api?id=${chatId}`,
        ),
        deps,
      );
      expect(scoped.status).toBe(200);

      // ── Restart: dispose and rebuild against the SAME storage. The new process holds the
      // stored gateway config but ZERO readiness observations.
      await deps.dispose?.();
      deps = buildUiHandlerDeps({
        configPath: undefined,
        evidenceDir: join(tmp, "evidence"),
        uiDbPath: join(tmp, "keiko-ui.db"),
        env: { ...VAULT_ENV, KEIKO_ALLOW_PRIVATE_EGRESS: "true" },
      });
      expect(deps.gatewayConfig?.present()).toBe(true);

      // Tri-state models wire: never-probed is UNKNOWN (field absent), not `false` — a hard
      // false emptied the UI's model picker after every restart until a manual probe + reload.
      const models = handleModels(ctx("GET", {}), deps);
      const listed = (models.body as { models: { id: string; conversationReady?: boolean }[] })
        .models;
      expect(listed.length).toBeGreaterThan(0);
      for (const model of listed) {
        expect("conversationReady" in model).toBe(false);
      }

      // First grounded ask of the day, no manual probe, no prior send: must answer.
      const asked = await handleGroundedAsk(
        ctx("POST", { chatId, content: "Was steht im Handbuch zu KFZ?" }),
        deps,
      );
      expect(asked.status).toBe(200);
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  // The customer runs a self-hosted LiteLLM with about fifteen deployed models. Discovery must
  // analyse every one of them and put it in the right place — for a gateway of this shape and for
  // the Azure one the developers use — through the REAL production deps and the REAL transports.
  describe("the customer's ~15-model LiteLLM inventory", () => {
    interface InventoryRun {
      readonly fixture: FieldFixture;
      readonly log: FakeGatewayLog;
    }

    async function withInventory(run: (inventory: InventoryRun) => Promise<void>): Promise<void> {
      const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [], rerankBodies: [] };
      const gateway = startStrictLiteLlm(log, { fullInventory: true });
      const port = await listen(gateway);
      let deps: UiHandlerDeps | undefined;
      try {
        const fixture = await setUpFieldGateway(port, fieldTmpDir());
        deps = fixture.deps;
        await run({ fixture, log });
      } finally {
        await deps?.dispose?.();
        await closeServer(gateway);
      }
    }

    function capabilityIds(deps: UiHandlerDeps, kind: ModelCapability["kind"]): readonly string[] {
      return (deps.gatewayConfig?.current()?.capabilities ?? [])
        .filter((capability) => capability.kind === kind)
        .map((capability) => capability.id);
    }

    it("puts every model in its lane", async () => {
      await withInventory(({ fixture }) => {
        const { deps, setupBody } = fixture;
        // Chat, in gateway order: the mode-less OCR/guard/hosted_vllm models stay candidates (the
        // gateway declared nothing that excludes them), the wildcard route the proxy refuses is
        // gone, and no engine of another kind leaked in.
        expect(capabilityIds(deps, "chat")).toEqual([
          "dotsocr",
          "hosted-vllm-llama",
          "llama-guard-3",
          "gpt-4o",
          "qwen3-235b",
          "vllm-native-chat",
          "multi-alias",
        ]);
        expect(capabilityIds(deps, "embedding")).toEqual(["multilingual-e5-large"]);
        expect([...capabilityIds(deps, "voice")].sort()).toEqual(["tts-1", "whisper-1"]);
        // What Keiko did not configure is REPORTED with the gateway's declared reason. The
        // reranker is not among them: it was probed and wired.
        expect(setupBody.unsupportedModels).toEqual([
          { id: "dall-e-3", reason: "image_generation" },
          { id: "omni-moderation-latest", reason: "moderation" },
          { id: "vendor-special", reason: "unrecognised-mode" },
        ]);
        // The proxy answered the wildcard with HTTP 400: dropped, never configured.
        expect(setupBody.droppedChatModelIds).toEqual(["openai/*"]);
        return Promise.resolve();
      });
    });

    it("declares the windows the gateway published, in every spelling", async () => {
      await withInventory(({ fixture }) => {
        const capabilities = fixture.deps.gatewayConfig?.current()?.capabilities ?? [];
        const windowOf = (id: string): number | undefined =>
          capabilities.find((capability) => capability.id === id)?.contextWindow;
        expect(windowOf("gpt-4o")).toBe(128_000);
        expect(windowOf("vllm-native-chat")).toBe(32_768);
        // Two deployments behind one alias: the smaller window is the safe one.
        expect(windowOf("multi-alias")).toBe(32_000);
        return Promise.resolve();
      });
    });

    it("wires the discovered reranker after the two-document probe", async () => {
      await withInventory(({ fixture, log }) => {
        const config = fixture.deps.gatewayConfig?.current();
        expect(config?.reranker).toMatchObject({ modelId: "bge-reranker-v2-m3" });
        expect(config?.reranker?.baseUrl).toBe(config?.providers[0]?.baseUrl);
        expect(log.rerankBodies).toHaveLength(1);
        expect(log.rerankBodies?.[0]).toMatchObject({
          model: "bge-reranker-v2-m3",
          query: "alpha readiness match",
          documents: ["alpha readiness match", "unrelated beta"],
          top_n: 1,
        });
        // It is a retrieval reranker, never a chat or embedding provider.
        const providerIds = config?.providers.map((provider) => provider.modelId) ?? [];
        expect(providerIds).not.toContain("bge-reranker-v2-m3");
        return Promise.resolve();
      });
    });

    it("never elects a mode-less special-purpose model as any default", async () => {
      await withInventory(async ({ fixture }) => {
        const { deps, projectDir } = fixture;
        const config = deps.gatewayConfig?.current();
        // dotsocr sits FIRST and answers warm; the first declared chat model still wins for the
        // chat picker AND for the background callers (commit drafts, PR descriptions, profiles).
        expect(selectConfiguredModel(config ?? { providers: [] }, { kind: "chat" })).toBe("gpt-4o");
        const chat = await handleCreateDesktopChat(
          ctx("POST", { projectPath: projectDir, title: "Erster Chat" }),
          deps,
        );
        expect(chat.status).toBe(201);
        const body = chat.body as { readonly chat: { readonly selectedModel?: string } };
        expect(body.chat.selectedModel).toBe("gpt-4o");
      });
    });

    it("binds new Knowledge Pods to the one embedding model the gateway hosts", async () => {
      await withInventory(async ({ fixture }) => {
        const { deps } = fixture;
        expect(
          configuredEmbeddingProviders(deps.gatewayConfig?.current()).map((p) => p.modelId),
        ).toEqual(["multilingual-e5-large"]);
        const created = await handleCreateLocalKnowledgeCapsule(
          ctx("POST", { displayName: "Handbuch" }),
          deps,
        );
        expect(created.status).toBe(201);
        const capsule = (
          created.body as {
            capsule: { embeddingModelIdentity: { modelId: string } };
          }
        ).capsule;
        expect(capsule.embeddingModelIdentity.modelId).toBe("multilingual-e5-large");
      });
    });
  });
});
