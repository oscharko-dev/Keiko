import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildUiHandlerDeps } from "./deps.js";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext } from "./routes.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import { handleCreateDesktopChat } from "./chat-handlers.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleModels } from "./read-handlers.js";
import { handleUpdateChat } from "./store-handlers.js";
import {
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
}

interface StrictLiteLlmOptions {
  // Customer configuration shape: an OCR model sits FIRST in the list and — exactly like the
  // field dotsocr — declares NO `mode` in /model/info, so discovery metadata cannot exclude it
  // and it lands in the stored configuration as an assumed chat model.
  readonly unsuitableFirstChatModel?: boolean;
}

// Mutable per-test control: a model in this set answers chat completions with an EMPTY
// assistant text (the cold/unsuitable backend). Tests flip it AFTER setup to model "answered
// the setup smoke while warm, fails later" without brittle call counting.
interface StrictLiteLlmBehavior {
  readonly emptyChatModels: Set<string>;
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

function answerModelInfo(res: ServerResponse, options: StrictLiteLlmOptions): void {
  json(res, {
    data: [
      ...(options.unsuitableFirstChatModel === true ? [{ model_name: "dotsocr" }] : []),
      { model_name: "qwen-chat", model_info: { mode: "chat" } },
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
  const empty = typeof body.model === "string" && behavior.emptyChatModels.has(body.model);
  const toolName = requestedToolName(body);
  json(res, {
    choices: [
      {
        message: {
          role: "assistant",
          content: empty ? "" : "OK",
          ...(toolName === undefined
            ? {}
            : { tool_calls: [{ function: { name: toolName, arguments: "{}" } }] }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
}

function answerEmbeddings(res: ServerResponse, raw: string, log: FakeGatewayLog): void {
  const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
  log.embeddingBodies.push(body);
  if ("encoding_format" in body || Array.isArray(body.input)) {
    json(res, { error: { message: "unsupported request shape" } }, 400);
    return;
  }
  json(res, {
    data: [{ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1)) }],
    model: "multilingual-e5-large",
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
        answerEmbeddings(res, raw, log);
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
  return { deps, projectDir, tmp };
}

function fieldTmpDir(): string {
  const tmp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-field-")));
  tempDirs.push(tmp);
  return tmp;
}

function probesSince(log: FakeGatewayLog, mark: number, modelId: string): number {
  return log.chatModels.slice(mark).filter((entry) => entry === modelId).length;
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
      // Warm dotsocr answers the probe: the explicit create succeeds and VERIFIES it.
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

  it("walks to the warm OCR model when every declared chat model is down — preference, not a gate", async () => {
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
      const chat = await handleCreateDesktopChat(
        ctx("POST", { projectPath: fixture.projectDir, title: "Notbetrieb" }),
        deps,
      );
      expect(chat.status).toBe(201);
      const body = chat.body as { readonly chat: { readonly selectedModel?: string } };
      expect(body.chat.selectedModel).toBe("dotsocr");
    } finally {
      await deps?.dispose?.();
      await closeServer(gateway);
    }
  });

  it("probes ONLY the requested model for an explicit create — no sibling walk latency", async () => {
    const log: FakeGatewayLog = { embeddingBodies: [], chatModels: [] };
    const behavior: StrictLiteLlmBehavior = { emptyChatModels: new Set() };
    const gateway = startStrictLiteLlm(log, { unsuitableFirstChatModel: true }, behavior);
    const port = await listen(gateway);
    let deps: UiHandlerDeps | undefined;
    try {
      const fixture = await setUpFieldGateway(port, fieldTmpDir());
      deps = fixture.deps;
      behavior.emptyChatModels.add("dotsocr");
      behavior.emptyChatModels.add("qwen-chat");
      const mark = log.chatModels.length;
      // Explicitly requesting the cold OCR model: the admission validates THAT model alone, so
      // probing its siblings could never change the 400 — it would only add their probe
      // latency to an already-decided answer (0.3.12 adversarial-review finding).
      const chat = await handleCreateDesktopChat(
        ctx("POST", {
          projectPath: fixture.projectDir,
          title: "Explizit",
          modelId: "dotsocr",
        }),
        deps,
      );
      expect(chat.status).toBe(400);
      expect(probesSince(log, mark, "dotsocr")).toBeGreaterThan(0);
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

      // 2. Open a chat IMMEDIATELY — no manual readiness click. The on-demand probe must
      // verify the model inline instead of rejecting the fresh install.
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
});
