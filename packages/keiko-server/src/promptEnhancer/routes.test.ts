// HTTP route tests for POST /api/prompt-enhancement (Issue #1314). Exercises validation, Model-Gateway
// routing, safe error shaping, the payload cap, and the AC4 redaction guarantee through the real
// createUiServer dispatch (CSP + SECURITY_HEADERS surface), with an in-memory store so the FS is never
// touched and no model is ever dispatched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type {
  PromptEnhancementWireResponse,
  PromptEnhancementWireRequest,
} from "@oscharko-dev/keiko-contracts";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { handlePromptEnhancement } from "./routes.js";

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
      },
    ],
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

// Two-phase bind so the DNS-rebinding Host check (isAllowedHost) sees a request authority on the same
// port the server is configured with: discover a free port via an ephemeral bind, then recreate the
// server bound to that exact port. Mirrors store-handlers.test.ts.
async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(overrides),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
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
        manifest: { readonly runId: string; readonly requestId: string };
      };
      expect(served.manifest.runId).toBe(body.evidence.runId);
      expect(served.manifest.requestId).toBe(body.analysis.requestId);
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });

  it("resolves model routing as available for a configured provider", async () => {
    const res = await post({ text: "Hello.", modelId: CHAT_MODEL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromptEnhancementWireResponse;
    expect(body.modelRouting.availability).toBe("available");
    expect(body.modelRouting.resolvedModelId).toBe(CHAT_MODEL);
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
