// Issue #154 — conversation error redaction at the BFF boundary.
//
// These tests pin AC #2 + AC #4 of #154: gateway credentials and provider base URLs MUST NOT
// appear in conversation error envelopes returned to the browser. The chat-handlers boundary
// runs redact() over every GatewayError / UiStoreError message before it reaches errorBody(),
// using deps.redactionSecrets (the resolved gateway literals: apiKey, baseUrl, env values) so
// non-standard credential shapes are still scrubbed even when GatewayError's own construction-
// time scrub does not know about them.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  AuthenticationError,
  ProviderError,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

const POST_JSON_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const CHAT_MODEL = "example-chat-model";

// Credential shapes that should NEVER appear in a wire-bound error message.
const FAKE_BEARER_TOKEN = ["sk-", "test-1234567890ABCDEFGH"].join("");
const FAKE_GITHUB_TOKEN = ["ghp_", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("");
const FAKE_AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const FAKE_PROVIDER_BASE_URL = "https://provider.example/v1";
const FAKE_CONFIG_API_KEY = "test-config-secret-value-1234567890";

let server: Server;
let port: number;
let staticRoot: string;
let tmp: string;
let projectDir: string;
let store: UiStore;

function chatConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: CHAT_MODEL,
        baseUrl: FAKE_PROVIDER_BASE_URL,
        apiKey: FAKE_CONFIG_API_KEY,
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: CHAT_MODEL,
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

// A ModelPort that throws a GatewayError on every call. The error message is intentionally
// rich with credential-shaped substrings so the redaction boundary has real work to do.
function failingModel(error: Error): ModelPort {
  return {
    call(): Promise<NormalizedResponse> {
      return Promise.reject(error);
    },
  };
}

function deps(modelError: Error, overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  const config = chatConfig();
  const env = { KEIKO_FAKE_TOKEN: FAKE_BEARER_TOKEN };
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => failingModel(modelError),
    // Mirror the production wiring in deps.ts: redactionSecrets carries the resolved gateway
    // literals so the boundary scrub also catches the configured apiKey + baseUrl, not just the
    // pattern-matched credential shapes.
    redactionSecrets: [FAKE_CONFIG_API_KEY, FAKE_PROVIDER_BASE_URL],
    store,
    ...overrides,
  };
}

function base(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

async function restartWithDeps(handlerDeps: UiHandlerDeps): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps,
  });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-conv-audit-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-conv-audit-"));
  projectDir = join(tmp, "repo");
  mkdirSync(projectDir);
  store = createInMemoryUiStore();
  store.createProject(projectDir, "repo");
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

interface WireErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string };
}

async function createChat(): Promise<string> {
  const res = await fetch(`${base()}/api/desktop/chats`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({ projectPath: projectDir, modelId: CHAT_MODEL }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { readonly chat: { readonly id: string } };
  return body.chat.id;
}

async function sendAndCaptureError(modelError: Error): Promise<WireErrorEnvelope> {
  await restartWithDeps(deps(modelError));
  const chatId = await createChat();
  await restartWithDeps(deps(modelError));
  const res = await fetch(`${base()}/api/desktop/chat`, {
    method: "POST",
    headers: POST_JSON_HEADERS,
    body: JSON.stringify({
      chatId,
      projectPath: projectDir,
      content: "hello",
      modelId: CHAT_MODEL,
    }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  return (await res.json()) as WireErrorEnvelope;
}

describe("conversation audit redaction (#154)", () => {
  it("redacts a Bearer token echoed back by the gateway from the wire error message", async () => {
    // ProviderError carries an upstream message that, in the wild, can echo Authorization headers
    // or provider-side error bodies. The boundary must scrub it before the browser sees it.
    const envelope = await sendAndCaptureError(
      new ProviderError(`upstream call failed with Bearer ${FAKE_BEARER_TOKEN}`, 502),
    );
    expect(envelope.error.message).not.toContain(FAKE_BEARER_TOKEN);
    expect(envelope.error.message).toContain("[REDACTED]");
  });

  it("redacts the provider base URL when it appears in a gateway error message", async () => {
    // ProviderError messages often reference the upstream URL. The configured baseUrl is in
    // deps.redactionSecrets, so the boundary scrub replaces it with [REDACTED] even though the
    // URL is not a pattern-matched credential shape.
    const envelope = await sendAndCaptureError(
      new ProviderError(`POST ${FAKE_PROVIDER_BASE_URL}/chat/completions returned 500`, 502),
    );
    expect(envelope.error.message).not.toContain(FAKE_PROVIDER_BASE_URL);
  });

  it("redacts third-party credential shapes (sk-, ghp_, AKIA) at the boundary", async () => {
    // AuthenticationError commonly carries 401 body text. Each well-known credential shape
    // must be scrubbed regardless of where in the message it appears.
    const envelope = await sendAndCaptureError(
      new AuthenticationError(
        `denied: sk-${FAKE_BEARER_TOKEN.slice(3)} ${FAKE_GITHUB_TOKEN} ${FAKE_AWS_KEY}`,
      ),
    );
    expect(envelope.error.message).not.toContain(FAKE_GITHUB_TOKEN);
    expect(envelope.error.message).not.toContain(FAKE_AWS_KEY);
    expect(envelope.error.message).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });

  it("returns a wire error envelope with code+message only — no provider/credential surface", async () => {
    // AC #2 + AC #4: the wire envelope must carry only { code, message } and the message must be
    // free of credential shapes and the configured provider base URL.
    const envelope = await sendAndCaptureError(
      new ProviderError(
        `denied at ${FAKE_PROVIDER_BASE_URL}; Authorization: Bearer ${FAKE_BEARER_TOKEN}`,
        502,
      ),
    );
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "message"]);
    expect(envelope.error.code.length).toBeGreaterThan(0);
    expect(envelope.error.message).not.toContain(FAKE_BEARER_TOKEN);
    expect(envelope.error.message).not.toContain(FAKE_PROVIDER_BASE_URL);
    expect(envelope.error.message).not.toContain(FAKE_CONFIG_API_KEY);
  });
});
