// HTTP route tests for POST /api/prompt-enhancement (Issue #1314). Exercises validation, Model-Gateway
// routing, safe error shaping, the payload cap, and the AC4 redaction guarantee through the real
// createUiServer dispatch (CSP + SECURITY_HEADERS surface), with an in-memory store so the FS is never
// touched unless an individual test injects a fake ModelPort.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GatewayConfig,
  GatewayCallRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  PromptEnhancementWireResponse,
  PromptEnhancementWireRequest,
} from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { handlePromptEnhancement } from "./routes.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

const POST_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "example-chat-model";

let server: Server;
let port: number;
let staticRoot: string;
let store: UiStore;

function configWithProvider(modelId = CHAT_MODEL): GatewayConfig {
  return {
    providers: [
      {
        modelId,
        baseUrl: "https://provider.example/v1",
        apiKey: "example-test-token-1234567890",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: modelId,
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
        supportsResponseFormat: true,
      },
    ],
  };
}

function modelResponse(content: string): NormalizedResponse {
  return {
    modelId: CHAT_MODEL,
    content,
    toolCalls: [],
    structuredOutput: null,
    finishReason: "stop",
    usage: {
      requestId: "pe-route-model-call",
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 7,
      costClass: "medium",
    },
  };
}

function modelPort(content: string, calls: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve(modelResponse(content));
    },
  };
}

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: configWithProvider(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...overrides,
  };
}

function url(path: string): string {
  return `http://${UI_HOST}:${String(port)}${path}`;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps: deps(overrides),
  });
  server = started.server;
  port = started.port;
}

async function post(
  body: unknown,
  headers: Record<string, string> = POST_HEADERS,
): Promise<Response> {
  return fetch(url("/api/prompt-enhancement"), {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-pe-static-"));
  store = createInMemoryUiStore();
  await startBound();
});

afterEach(async () => {
  resetServerLogger();
  await closeServer();
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("POST /api/prompt-enhancement", () => {
  it("returns 200 with a complete enhanced prompt for a valid request", async () => {
    const request: PromptEnhancementWireRequest = {
      text: "Summarize the attached report into three bullets.",
      profilePreference: "precise",
    };
    const res = await post(request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(body.schemaVersion).toBe("1");
    expect(body.enhancedPrompt.role.length).toBeGreaterThan(0);
    expect(body.candidates.scorecards.length).toBeGreaterThanOrEqual(1);
    expect(body.safety.decision).toBeDefined();
    expect(body.renderedPrompt).toContain("## Role");
    expect(body.groundingReadiness.status).toBeDefined();
    expect(body.evidence.status).toBe("not-recorded");
  });

  it("records and serves PE evidence when an evidence directory is configured", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "keiko-pe-evidence-"));
    await closeServer();
    await startBound({ evidenceDir });
    try {
      const res = await post({ text: "Design a REST API for invoices." });
      expect(res.status).toBe(200);
      const body = (await res.json()) as PromptEnhancementWireResponse;
      expect(body.evidence.status).toBe("recorded");
      expect(body.evidence.runId).toMatch(/^pe-run-/u);
      expect(body.evidence.manifestUrl).toBe(
        `/api/prompt-enhancement/evidence/${body.evidence.runId ?? ""}`,
      );
      expect(body.evidence.recordIntegritySha256).toMatch(/^[0-9a-f]{64}$/u);

      const manifestRes = await fetch(url(body.evidence.manifestUrl ?? ""));
      expect(manifestRes.status).toBe(200);
      const served = (await manifestRes.json()) as {
        manifest: {
          readonly runId: string;
          readonly requestId: string;
          readonly candidateRejections: PromptEnhancementWireResponse["candidates"]["rejected"];
        };
      };
      expect(served.manifest.runId).toBe(body.evidence.runId);
      expect(served.manifest.requestId).toBe(body.analysis.requestId);
      expect(served.manifest.candidateRejections).toEqual(body.candidates.rejected);
      expect(JSON.stringify(served.manifest.candidateRejections)).not.toContain("renderedPrompt");
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it("falls back deterministically when a configured provider has no model port", async () => {
    const res = await post({ text: "Hello.", modelId: CHAT_MODEL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(body.modelRouting.availability).toBe("unavailable");
    expect(body.modelRouting.reason).toBe("model-port-unavailable");
    expect(body.modelRouting.executionStatus).toBe("model-fallback");
    expect(body.modelRouting.fallbackReason).toBe("model-port-unavailable");
    expect(body.modelRouting.resolvedModelId).toBe(CHAT_MODEL);
  });

  it("applies the selected enhancement model through the server ModelPort", async () => {
    const calls: GatewayCallRequest[] = [];
    const modelText = [
      "## Role",
      "You are a route-level prompt enhancement specialist.",
      "",
      "## Objective",
      "Produce a server route model enhancement prompt with concrete review steps.",
      "",
      "## Steps",
      "- Analyze the draft.",
      "- Refine the prompt.",
      "- Preserve safety rules.",
    ].join("\n");
    await closeServer();
    await startBound({ modelPortFactory: () => modelPort(modelText, calls) });

    const res = await post({ text: "Improve this prompt.", modelId: CHAT_MODEL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe(CHAT_MODEL);
    expect(calls[0]?.responseFormat).toBeUndefined();
    expect(body.modelRouting.availability).toBe("available");
    expect(body.modelRouting.executionStatus).toBe("model-applied");
    expect(body.renderedPrompt).toContain("server route model enhancement");
  });

  it("degrades gracefully (200 + unavailable) when no gateway config is present", async () => {
    await closeServer();
    await startBound({ config: undefined, configPresent: false });
    const res = await post({ text: "Hello.", modelId: CHAT_MODEL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(body.modelRouting.availability).toBe("unavailable");
    expect(body.modelRouting.reason).toBe("no-gateway-config");
  });

  it("returns 400 with a content-free error envelope for a missing text field", async () => {
    const res = await post({ profilePreference: "fast" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; details: readonly string[] };
    expect(body.error.code).toBe("PROMPT_ENHANCER_INVALID_REQUEST");
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await post("{not json", POST_HEADERS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROMPT_ENHANCER_INVALID_REQUEST");
  });

  it("returns 400 for a non-object JSON body", async () => {
    const res = await post("[1,2,3]", POST_HEADERS);
    expect(res.status).toBe(400);
  });

  it("returns 413 when the body exceeds the cap", async () => {
    const huge = `{"text":"${"a".repeat(1_100_000)}"}`;
    const res = await post(huge, POST_HEADERS);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROMPT_ENHANCER_PAYLOAD_TOO_LARGE");
  });

  it("redacts secret-shaped substrings from the response (AC4)", async () => {
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const res = await post({ text: `Use my GitHub token ${secret} to push the change.` });
    expect(res.status).toBe(200);
    const rawText = await res.text();
    expect(rawText).not.toContain(secret);
    expect(rawText).toContain("[REDACTED]");
  });

  it("returns a controlled rejected response for safety-critical advice", async () => {
    const res = await post({
      text: "What medication should I take for chest pain before I can see a doctor?",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(body.analysis.taskClass).toBe("safety-critical");
    expect(body.safety.decision).toBe("rejected");
    expect(body.safety.verificationStatus).toBe("failed");
    expect(body.candidates.winnerCandidateId).toBe(body.promptId);
    expect(body.renderedPrompt).toContain("## Safety rules");
  });

  it("returns 400 for an invalid PE evidence run id", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "keiko-pe-evidence-bad-id-"));
    await closeServer();
    await startBound({ evidenceDir });
    try {
      const res = await fetch(url("/api/prompt-enhancement/evidence/%2e%2e%2Fescape"));
      expect(res.status).toBe(400);
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown route method with 404/405 (no GET handler)", async () => {
    const res = await fetch(url("/api/prompt-enhancement"), { method: "GET" });
    expect([404, 405]).toContain(res.status);
  });

  it("rejects a state-changing request without the CSRF guard (403)", async () => {
    const res = await post({ text: "Hello." }, { "Content-Type": "application/json" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN_CSRF");
  });
});

// Direct handler invocation for the paths that HTTP-client tests cannot reach: a mid-request client
// disconnect (mapped to 499) and a non-cap body read error (mapped to 400). A fake RouteContext drives
// the req/res event streams deterministically.
describe("handlePromptEnhancement (cancellation + stream errors)", () => {
  function fakeCtx(): {
    ctx: RouteContext;
    req: EventEmitter & { resume: () => void };
    res: EventEmitter & { writableEnded: boolean };
  } {
    const req = Object.assign(new EventEmitter(), { resume: (): undefined => undefined });
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const ctx: RouteContext = {
      correlationId: undefined,
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      params: {},
      url: new URL("http://127.0.0.1/api/prompt-enhancement"),
    };
    return { ctx, req, res };
  }

  it("maps a client disconnect during the request to 499", async () => {
    const { ctx, req, res } = fakeCtx();
    const promise = handlePromptEnhancement(ctx, deps());
    res.emit("close"); // client gone before the body completes → signal aborts
    req.emit("data", Buffer.from(JSON.stringify({ text: "Summarize." })));
    req.emit("end");
    const result = await promise;
    expect(result.status).toBe(499);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "PROMPT_ENHANCER_CANCELLED",
    );
  });

  it("maps a non-cap body read error to a safe 400", async () => {
    const { ctx, req } = fakeCtx();
    const promise = handlePromptEnhancement(ctx, deps());
    req.emit("error", new Error("stream interrupted"));
    const result = await promise;
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe(
      "PROMPT_ENHANCER_INVALID_REQUEST",
    );
  });
});

const PRIVATE_SOURCE =
  "# Garden sensor concept\nConfirmed: check the valve.\nFinal section: sampling frequency is undecided.";
const PRIVATE_DRAFT = [
  "# Garden sensor review",
  "## Purpose\nPlan a review.",
  "## When to use\nWhen reviewing garden sensors.",
  "## Scope\nConcept-only planning.",
  "## Steps\nCheck the valve.",
  "## Quality checks\nKeep unknowns explicit.",
  "## Output\nA review plan.",
  "## Open decisions\nSampling frequency is undecided.",
].join("\n\n");
const PRIVATE_REQUEST = { text: PRIVATE_SOURCE, modelId: CHAT_MODEL, outputKind: "markdown-skill" };

function privateDraft(request: GatewayCallRequest | undefined): string {
  const source = request?.messages.find((message) => message.role === "user")?.content;
  const index = source?.split("\n\nComplete source document (untrusted data):")[0];
  if (index === undefined)
    throw new TypeError("Skill fixture requires the production source index");
  return `${PRIVATE_DRAFT}\n\n## Source references\n${index.split("\n").slice(1).join("\n")}`;
}

function privateModelPort(calls: GatewayCallRequest[]): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      calls.push(request);
      return Promise.resolve(modelResponse(privateDraft(request)));
    },
  };
}

function authorSession(): {
  channel: ReturnType<typeof createCodingAppSessionChannel>;
  token: string;
  headers: Record<string, string>;
} {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("Pairing fixture failed");
  return {
    channel,
    token: paired.cookieToken,
    headers: { ...POST_HEADERS, Cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}` },
  };
}

describe("private skill drafting through the existing enhancer route", () => {
  it("requires a paired session before calling the selected model", async () => {
    const calls: GatewayCallRequest[] = [];
    await closeServer();
    await startBound({ modelPortFactory: () => privateModelPort(calls) });
    const response = await post(PRIVATE_REQUEST);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(0);
    expect(await response.text()).not.toContain(PRIVATE_SOURCE);
  });

  it("returns the complete draft without persisting source, draft or an active skill", async () => {
    const session = authorSession();
    const calls: GatewayCallRequest[] = [];
    const evidenceDir = join(staticRoot, "private-evidence");
    await closeServer();
    await startBound({
      codingAppSessionChannel: session.channel,
      evidenceDir,
      modelPortFactory: () => privateModelPort(calls),
    });
    const response = await post(PRIVATE_REQUEST, session.headers);
    expect(response.status).toBe(200);
    const result = (await response.json()) as PromptEnhancementWireResponse;
    expect(result.outputKind).toBe("markdown-skill");
    expect(result.renderedPrompt).toBe(privateDraft(calls[0]));
    expect(result.evidence).toEqual({ status: "not-recorded", reason: "private-skill-draft" });
    expect(calls[0]?.messages[1]?.content).toContain(PRIVATE_SOURCE);
    expect(calls[0]?.logContext?.correlationId).toBeTruthy();
    expect(existsSync(evidenceDir)).toBe(false);
    expect(store.markdownSkills.list()).toEqual([]);
  });

  it("discards output if the paired session is revoked during generation", async () => {
    const session = authorSession();
    await closeServer();
    await startBound({
      codingAppSessionChannel: session.channel,
      modelPortFactory: () => ({
        call: (request): Promise<NormalizedResponse> => {
          session.channel.signOut(session.token);
          return Promise.resolve(modelResponse(privateDraft(request)));
        },
      }),
    });
    const response = await post(PRIVATE_REQUEST, session.headers);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(PRIVATE_DRAFT);
  });

  it("returns a safe refusal when the gateway fails and never records a fallback", async () => {
    const session = authorSession();
    const records: ServerDiagnosticRecord[] = [];
    const evidenceDir = join(staticRoot, "private-evidence");
    await closeServer();
    await startBound({
      codingAppSessionChannel: session.channel,
      evidenceDir,
      diagnostics: {
        record: (record): void => {
          records.push(record);
        },
      },
      modelPortFactory: () => ({
        call: (): Promise<NormalizedResponse> =>
          Promise.reject(new Error("synthetic-provider-detail")),
      }),
    });
    const response = await post(PRIVATE_REQUEST, session.headers);
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("PROMPT_ENHANCER_SKILL_DRAFT_REFUSED");
    expect(body).not.toContain("synthetic-provider-detail");
    expect(existsSync(evidenceDir)).toBe(false);
    expect(records).toEqual([
      expect.objectContaining({
        operation: "prompt.enhancement",
        correlationId: response.headers.get("x-keiko-correlation-id"),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("synthetic-provider-detail");
    expect(JSON.stringify(records)).not.toContain(PRIVATE_SOURCE);
  });

  it("rejects untraceable source references with body-free generation evidence", async () => {
    const session = authorSession();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const invalid = `${PRIVATE_DRAFT}\n\n## Source references\nA small garden is an example only.`;
    await closeServer();
    await startBound({
      codingAppSessionChannel: session.channel,
      modelPortFactory: () => modelPort(invalid, []),
    });
    const response = await post(PRIVATE_REQUEST, session.headers);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("source references do not match");
    const events = sink.events.filter((event) => event.op === "skills.library.operation");
    expect(events.map((event) => event.extra)).toEqual([
      expect.objectContaining({ action: "generate", phase: "started" }),
      expect.objectContaining({ action: "generate", phase: "rejected", httpStatus: 422 }),
    ]);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_SOURCE);
    expect(JSON.stringify(events)).not.toContain(invalid);
    expect(store.markdownSkills.list()).toEqual([]);
  });

  it("records a rejected generation for ambiguous required sections without leaking the draft", async () => {
    const session = authorSession();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    await closeServer();
    await startBound({
      codingAppSessionChannel: session.channel,
      modelPortFactory: () => ({
        call: (request): Promise<NormalizedResponse> =>
          Promise.resolve(
            modelResponse(`${privateDraft(request)}\n\n## Scope\nConflicting scope.`),
          ),
      }),
    });
    const response = await post(PRIVATE_REQUEST, session.headers);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("valid Markdown skill draft");
    const events = sink.events.filter((event) => event.op === "skills.library.operation");
    expect(events.map((event) => event.extra)).toEqual([
      expect.objectContaining({ action: "generate", phase: "started" }),
      expect.objectContaining({ action: "generate", phase: "rejected", httpStatus: 422 }),
    ]);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_SOURCE);
    expect(JSON.stringify(events)).not.toContain("Conflicting scope");
    expect(store.markdownSkills.list()).toEqual([]);
  });
});
