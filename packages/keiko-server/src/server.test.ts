import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GatewayConfig,
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { buildCspHeader } from "./csp.js";
import { resetWorkspaceStateForTests } from "./workspace-state-handlers.js";

let server: Server;
let staticRoot: string;
let port: number;

async function listen(): Promise<number> {
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  return (server.address() as AddressInfo).port;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

async function fetchRaw(path: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl()}${path}`);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function fetchRawWithInit(path: string, init: RequestInit): Promise<RawResponse> {
  const response = await fetch(`${baseUrl()}${path}`, init);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

// Low-level request that can forge the `Host` header (undici/fetch forbids overriding it), needed
// to exercise the DNS-rebinding defense.
async function rawRequestWithHost(
  path: string,
  hostHeader: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolveResult, reject) => {
    const req = request(
      { host: UI_HOST, port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolveResult({ status: res.statusCode ?? 0, text: body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function rawRequest(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  return new Promise((resolveResult, reject) => {
    const req = request({ host: UI_HOST, port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolveResult({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

beforeEach(async () => {
  resetWorkspaceStateForTests();
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-ui-static-"));
  await writeFile(join(staticRoot, "index.html"), "<html><body>home</body></html>", "utf8");
  await writeFile(join(staticRoot, "launch.html"), "<html><body>launch</body></html>", "utf8");
  await mkdir(join(staticRoot, "_next"), { recursive: true });
  await writeFile(join(staticRoot, "_next", "app.js"), "console.log(1)", "utf8");
  // Bind on an ephemeral port first, then rebuild the server with that port so the Host/Origin
  // allow-check validates against the actual listening port.
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  port = await listen();
  await closeServer();
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
  resetWorkspaceStateForTests();
});

describe("GET /api/health", () => {
  it("returns ok with the version and no-store cache control", async () => {
    const res = await fetchRaw("/api/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ status: "ok", version: SDK_VERSION });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET/PUT /api/workspace/state", () => {
  it("stores a bounded workspace snapshot for another browser to read", async () => {
    const put = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({
        windows: [
          { id: "files-1", type: "files", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
        ],
        connections: [{ id: "c-1", a: "files-1", b: "chat-1" }],
      }),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("etag")).toBe('"workspace-state-1"');
    expect(JSON.parse(put.text)).toMatchObject({ workspace: { revision: 1 } });

    const get = await fetchRaw("/api/workspace/state");
    expect(get.status).toBe(200);
    const etag = get.headers.get("etag");
    expect(etag).toBe('"workspace-state-1"');
    const body = JSON.parse(get.text) as {
      workspace: { revision: number; windows: unknown[]; connections: unknown[] };
    };
    expect(body.workspace.revision).toBe(1);
    expect(body.workspace.windows).toHaveLength(1);
    expect(body.workspace.connections).toEqual([{ id: "c-1", a: "files-1", b: "chat-1" }]);

    const notModified = await fetchRawWithInit("/api/workspace/state", {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.text).toBe("");
  });

  it("rejects malformed workspace state payloads", async () => {
    const res = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({ windows: {}, connections: [] }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("requires If-Match and rejects stale workspace writes without mutating", async () => {
    const first = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({
        windows: [
          { id: "files-1", type: "files", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
        ],
        connections: [],
      }),
    });
    expect(first.status).toBe(200);

    const missing = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({ windows: [], connections: [] }),
    });
    expect(missing.status).toBe(428);
    expect(JSON.parse(missing.text)).toMatchObject({
      error: { code: "PRECONDITION_REQUIRED" },
    });

    const stale = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({ windows: [], connections: [] }),
    });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe('"workspace-state-1"');
    expect(JSON.parse(stale.text)).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });

    const get = await fetchRaw("/api/workspace/state");
    const body = JSON.parse(get.text) as { workspace: { revision: number; windows: unknown[] } };
    expect(body.workspace.revision).toBe(1);
    expect(body.workspace.windows).toHaveLength(1);
  });

  it("keeps the same revision for identical workspace PUT payloads", async () => {
    const payload = {
      windows: [
        { id: "files-1", type: "files", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
      ],
      connections: [],
    };
    const first = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const second = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-1"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.text)).toMatchObject({ workspace: { revision: 1 } });
    expect(second.headers.get("etag")).toBe('"workspace-state-1"');
  });

  it("gzips large JSON API responses when requested", async () => {
    const windows = Array.from({ length: 64 }, (_, index) => ({
      id: `files-${String(index)}`,
      type: "files",
      x: index,
      y: index,
      w: 320,
      h: 240,
      z: index,
      cfg: { label: "workspace-window".repeat(8) },
      max: false,
    }));
    const put = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"workspace-state-0"',
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({ windows, connections: [] }),
    });
    expect(put.status).toBe(200);

    const res = await rawRequest("/api/workspace/state", { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.vary).toBe("Accept-Encoding");
    const body = JSON.parse(gunzipSync(res.body).toString("utf8")) as {
      workspace: { windows: unknown[] };
    };
    expect(body.workspace.windows).toHaveLength(64);
  });
});

describe("security headers", () => {
  it("sets the CSP and hardening headers on every response", async () => {
    const res = await fetchRaw("/api/health");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
  });

  it("refreshes the CSP header from the provider between requests", async () => {
    let csp = buildCspHeader(["'sha256-before'"]);
    await closeServer();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      cspProvider: () => csp,
      cspCacheTtlMs: 0,
      port,
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    const before = await fetchRaw("/");
    expect(before.headers.get("content-security-policy")).toContain("'sha256-before'");

    csp = buildCspHeader(["'sha256-after'"]);
    const after = await fetchRaw("/");
    const header = after.headers.get("content-security-policy") ?? "";
    expect(header).toContain("'sha256-after'");
    expect(header).not.toContain("'sha256-before'");
  });
});

describe("Permissions-Policy microphone scoping (Issue #495)", () => {
  function voiceConfig(): UiHandlerDeps["config"] {
    return {
      providers: [
        {
          modelId: "keiko-stt",
          baseUrl: "https://keiko-stt.invalid",
          apiKey: "voice-secret-token-1234567890",
          timeoutMs: 1000,
          maxRetries: 2,
          retryBaseDelayMs: 10,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
      capabilities: [
        {
          id: "keiko-stt",
          kind: "voice",
          contextWindow: 0,
          maxOutputTokens: 0,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          supportsSpeechInput: true,
          voiceProviderLocality: "azure-foundry",
          workflowEligible: false,
          costClass: "low",
          latencyClass: "fast",
          throughputHint: "stt fixture",
          preferredUseCases: ["Dictation"],
          knownLimitations: [],
        },
      ],
    };
  }

  function depsWith(
    config: UiHandlerDeps["config"],
    env: Record<string, string> = {},
  ): UiHandlerDeps {
    return {
      config,
      configPresent: config !== undefined,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env,
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store: createInMemoryUiStore(),
    };
  }

  async function permissionsPolicyFor(handlerDeps: UiHandlerDeps): Promise<string> {
    await closeServer();
    server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
    const response = await fetchRaw("/");
    return response.headers.get("permissions-policy") ?? "";
  }

  it("emits microphone=(self) when a speech-to-text voice provider is configured", async () => {
    expect(await permissionsPolicyFor(depsWith(voiceConfig()))).toContain("microphone=(self)");
  });

  it("keeps microphone=() when voice is disabled by policy, even with a provider", async () => {
    const policy = await permissionsPolicyFor(
      depsWith(voiceConfig(), { KEIKO_VOICE_DISABLED: "1" }),
    );
    expect(policy).toContain("microphone=()");
    expect(policy).not.toContain("microphone=(self)");
  });

  it("keeps microphone=() in a no-voice deployment", async () => {
    expect(await permissionsPolicyFor(depsWith(undefined))).toContain("microphone=()");
  });
});

describe("DNS-rebinding defense", () => {
  it("rejects a forged non-loopback Host", async () => {
    const res = await rawRequestWithHost("/api/health", "evil.example.com");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "FORBIDDEN_HOST" } });
  });

  it("accepts the genuine loopback Host", async () => {
    const res = await rawRequestWithHost("/api/health", `${UI_HOST}:${String(port)}`);
    expect(res.status).toBe(200);
  });
});

describe("static serving", () => {
  it("serves the index for the root path", async () => {
    const res = await fetchRaw("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("home");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves a nested asset with the correct content type", async () => {
    const res = await fetchRaw("/_next/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to index.html for an unknown client route (SPA)", async () => {
    const res = await fetchRaw("/some/client/route");
    expect(res.status).toBe(200);
    expect(res.text).toContain("home");
  });

  it("serves exported static route HTML for deep links before SPA fallback", async () => {
    const res = await fetchRaw("/launch");
    expect(res.status).toBe(200);
    expect(res.text).toContain("launch");
    expect(res.text).not.toContain("home");
  });

  it("does not serve files outside the static root", async () => {
    const res = await fetchRaw("/../../../../etc/hosts");
    // Traversal is refused and the SPA index is served instead; the secret file never leaks.
    expect(res.text).not.toContain("localhost");
    expect(res.text).toContain("home");
  });
});

describe("unknown API routes", () => {
  it("returns 404 for an unknown API path", async () => {
    const res = await fetchRaw("/api/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 405 for a known path with the wrong method", async () => {
    const response = await fetch(`${baseUrl()}/api/health`, { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
  });

  it("returns 404 for an unknown run on the events route", async () => {
    const res = await fetchRaw("/api/runs/run-1/events");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("serves the read endpoints from the default 3-arg server (no handler deps)", async () => {
    const res = await fetchRaw("/api/models");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { models: unknown[] };
    expect(body.models).toEqual([]);
  });

  it("rejects state-changing API requests without JSON content type", async () => {
    const response = await fetch(`${baseUrl()}/api/runs`, { method: "POST", body: "x" });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });

  it("rejects state-changing API requests without the CSRF header", async () => {
    const response = await fetch(`${baseUrl()}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {}, modelId: "m" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN_CSRF" } });
  });

  it("rejects POST /api/editor/language without the CSRF header (#1198)", async () => {
    const response = await fetch(`${baseUrl()}/api/editor/language`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "diagnostics",
        root: "/tmp/x",
        document: { path: "a.ts", languageId: "typescript", text: "const x = 1;\n" },
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN_CSRF" } });
  });

  it("allows POST /api/coding-sidecar/gateway/chat/completions without X-Keiko-CSRF when JSON is used", async () => {
    const store = createInMemoryUiStore();
    const handlerDeps: UiHandlerDeps = {
      config: {
        providers: [
          {
            modelId: "azure-coding-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "provider-secret",
            apiKeyHeaderName: "api-key",
            endpointStyle: "azure-openai-deployment",
            apiVersion: "2024-06-01",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [
          {
            id: "azure-coding-model",
            kind: "chat",
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: true,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "coding-sidecar",
            preferredUseCases: ["Coding"],
            knownLimitations: [],
          },
        ],
      } satisfies GatewayConfig,
      configPresent: true,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      codingSidecarGatewayChatFactory: (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          expect(request.messages).toEqual([{ role: "user", content: "continue" }]);
          return Promise.resolve({
            modelId,
            content: "assistant-content",
            finishReason: "stop",
            toolCalls: [],
            structuredOutput: null,
            usage: {
              requestId: "req-1",
              promptTokens: 12,
              completionTokens: 8,
              latencyMs: 1,
              costClass: "medium",
            },
          });
        };
      },
      store,
    };
    await closeServer();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps,
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    try {
      const response = await fetch(`${baseUrl()}/api/coding-sidecar/gateway/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "continue" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: "azure-coding-model",
        choices: [{ message: { role: "assistant", content: "assistant-content" } }],
      });
    } finally {
      store.close();
    }
  });

  it("returns an opaque sidecar failure without top-level raw-error diagnostics", async () => {
    const hostilePath = "/Users/customer/private-repo/secret-tool";
    const hostileMessage = `tool call '${hostilePath}' has non-JSON arguments`;
    const records: ServerDiagnosticRecord[] = [];
    const store = createInMemoryUiStore();
    const handlerDeps: UiHandlerDeps = {
      config: {
        providers: [
          {
            modelId: "azure-coding-model",
            baseUrl: "https://provider.example/v1",
            apiKey: "provider-secret",
            apiKeyHeaderName: "api-key",
            endpointStyle: "azure-openai-deployment",
            apiVersion: "2024-06-01",
            timeoutMs: 30_000,
            maxRetries: 3,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
        capabilities: [
          {
            id: "azure-coding-model",
            kind: "chat",
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: true,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "coding-sidecar",
            preferredUseCases: ["Coding"],
            knownLimitations: [],
          },
        ],
      } satisfies GatewayConfig,
      configPresent: true,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      diagnostics: { record: (record) => records.push(record) },
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      codingSidecarGatewayChatFactory: () => {
        return async (): Promise<NormalizedResponse> => Promise.reject(new Error(hostileMessage));
      },
      codingWorkbenchEvidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      store,
    };
    await closeServer();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps,
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    try {
      const response = await fetch(`${baseUrl()}/api/coding-sidecar/gateway/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "continue" }],
        }),
      });
      const responseText = await response.text();
      const headerBlob = Array.from(response.headers.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");

      expect(response.status).toBe(503);
      expect(JSON.parse(responseText)).toEqual({
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      });
      expect(responseText).not.toContain(hostileMessage);
      expect(responseText).not.toContain(hostilePath);
      expect(headerBlob).not.toContain(hostileMessage);
      expect(headerBlob).not.toContain(hostilePath);

      expect(records).toHaveLength(1);
      expect(records).toEqual([
        expect.objectContaining({
          source: "coding-sidecar-gateway.chat",
          errorClass: "CodingSidecarGatewayFailure",
          message: "sidecar-gateway-failed",
        }),
      ]);
      expect(records.some((record) => record.source === "server.top-level-catch")).toBe(false);
      const diagnosticsJson = JSON.stringify(records);
      expect(diagnosticsJson).not.toContain(hostileMessage);
      expect(diagnosticsJson).not.toContain(hostilePath);
    } finally {
      store.close();
    }
  });

  it("serves POST /api/editor/language through the live BFF dispatch path (#1198)", async () => {
    const workspaceRoot = join(staticRoot, "workspace");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const store = createInMemoryUiStore();
    store.createProject(workspaceRoot, "fixture");
    const handlerDeps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
      editorLanguageRouteOptions: { now: () => 0 },
    };
    await closeServer();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps,
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));

    try {
      const response = await fetch(`${baseUrl()}/api/editor/language`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify({
          operation: "completion",
          root: workspaceRoot,
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "const value = { alpha: 1 };\nvalue.\n",
          },
          position: { line: 1, character: 6 },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result?: { items?: { label: string }[] } };
      expect(body.result?.items?.map((item) => item.label)).toContain("alpha");
    } finally {
      store.close();
    }
  });
});

describe("CSRF guard — PATCH/DELETE methods (M1)", () => {
  it("rejects PATCH /api/projects without X-Keiko-CSRF: 1 (returns 403 FORBIDDEN_CSRF)", async () => {
    const response = await fetch(`${baseUrl()}/api/projects?path=${encodeURIComponent("/tmp/x")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN_CSRF" } });
  });

  it("rejects DELETE /api/chats without X-Keiko-CSRF: 1 (returns 403 FORBIDDEN_CSRF)", async () => {
    const response = await fetch(`${baseUrl()}/api/chats?id=some-id`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN_CSRF" } });
  });

  it("rejects PATCH /api/projects without Content-Type: application/json (returns 415)", async () => {
    const response = await fetch(`${baseUrl()}/api/projects?path=${encodeURIComponent("/tmp/x")}`, {
      method: "PATCH",
      headers: { "X-Keiko-CSRF": "1" },
      body: "x",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });
});

// GEN-TEST-MISSING-008 + RB-6 (GEN-OBS-DIAGNOSTICS-901, CORRELATION-103/402) — pins the top-level
// catch (server.ts): opaque-but-safe 500 AND correlation-id + redacted-cause enrichment. The
// correlation-id/diagnostic assertions EXTEND (do not replace) the original opacity invariant, exactly
// as the Step 09 seam comment mandated. Reverting the catch to a bare `.catch(() => {})` (dropping the
// id or the diagnostic) flips these red — this is the regression gate for RB-6.
describe("top-level route-error catch (GEN-TEST-MISSING-008, RB-6)", () => {
  const SECRET_MARKER = "boom-secret-DO-NOT-LEAK";

  // Builds deps whose GET /api/projects read seam (handleListProjects → store.listProjects)
  // throws a plain, non-UiStoreError Error. That throw escapes the desktop error mapping,
  // propagates through dispatchApi + handle unhandled, and lands in the top-level `.catch`
  // in createUiServer — the exact code path under test. A capturing diagnostics sink lets the
  // RB-6 assertions prove the cause is retained server-side (never surfaced to the browser).
  function throwingDeps(diagnostics?: UiHandlerDeps["diagnostics"]): UiHandlerDeps {
    const store = createInMemoryUiStore();
    return {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      ...(diagnostics === undefined ? {} : { diagnostics }),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store: {
        ...store,
        listProjects: (): never => {
          throw new Error(SECRET_MARKER);
        },
      },
    };
  }

  async function startWithThrowingDeps(diagnostics?: UiHandlerDeps["diagnostics"]): Promise<void> {
    await closeServer();
    server = createUiServer({
      staticRoot,
      csp: buildCspHeader([]),
      port,
      handlerDeps: throwingDeps(diagnostics),
    });
    await new Promise<void>((res) => server.listen(port, UI_HOST, res));
  }

  it("returns an opaque 500 carrying a correlation id, without leaking the thrown error", async () => {
    await startWithThrowingDeps();

    // rawRequest resolves only on the response 'end' event, so a passing await here also proves
    // the socket completed (no hang) after the top-level catch ran writeJson + res.end.
    const res = await rawRequest("/api/projects");
    const bodyText = res.body.toString("utf8");
    const parsed = JSON.parse(bodyText) as {
      error: { code: string; message: string; correlationId?: string };
    };

    // (1) status is exactly 500, opaque code + message unchanged …
    expect(res.status).toBe(500);
    expect(parsed.error.code).toBe("INTERNAL");
    expect(parsed.error.message).toBe("An unexpected error occurred.");

    // (2) RB-6: the body now carries a well-formed correlation id, echoed on the response header,
    // and the two agree — so a user-reported failure maps to exactly one server-side record.
    expect(parsed.error.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    const headerId = res.headers["x-keiko-correlation-id"];
    expect(headerId).toBe(parsed.error.correlationId);

    // (3) the secret marker must not leak anywhere in the body …
    expect(bodyText).not.toContain(SECRET_MARKER);
    // … nor in any response header (name or value). Serialize the full header set to be exhaustive.
    const headerBlob = Object.entries(res.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(",") : value}`)
      .join("\n");
    expect(headerBlob).not.toContain(SECRET_MARKER);

    // (4) the response completed cleanly (Content-Length present, socket not left open).
    expect(res.headers["content-length"]).toBeDefined();
  });

  it("routes the redacted cause to the operator diagnostic sink, keyed by the correlation id", async () => {
    // RB-6 (GEN-OBS-DIAGNOSTICS-901): the cause is no longer discarded. Capture the sink and prove
    // the record carries the correlation id, the error class, and the cause message — server-side
    // only (the assertion in the previous test proves it never reaches the browser).
    const records: ServerDiagnosticRecord[] = [];
    await startWithThrowingDeps({ record: (r) => records.push(r) });

    const res = await rawRequest("/api/projects");
    const parsed = JSON.parse(res.body.toString("utf8")) as {
      error: { correlationId?: string };
    };

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.correlationId).toBe(parsed.error.correlationId);
    expect(record?.source).toBe("server.top-level-catch");
    expect(record?.operation).toBe("GET /api/projects");
    expect(record?.errorClass).toBe("Error");
    // The cause IS captured for the operator (redactor here knows no secrets, so it passes through);
    // this is the whole point of RB-6 — the previously-dropped cause is now diagnosable.
    expect(record?.message).toContain(SECRET_MARKER);
    expect(typeof record?.timestamp).toBe("string");
  });

  it("honours a well-formed client-supplied correlation id (UI → server continuity)", async () => {
    // RB-6 (GEN-OBS-CORRELATION-601): a UI-supplied id on X-Keiko-Correlation-Id is reused, so a
    // failure is traceable from the browser through the server with a single id.
    await startWithThrowingDeps();
    const clientId = "ui-req-0123456789abcdef";
    const res = await rawRequest("/api/projects", { "x-keiko-correlation-id": clientId });
    const parsed = JSON.parse(res.body.toString("utf8")) as {
      error: { correlationId?: string };
    };
    expect(res.headers["x-keiko-correlation-id"]).toBe(clientId);
    expect(parsed.error.correlationId).toBe(clientId);
  });

  it("rejects a malformed client-supplied correlation id and mints a fresh one", async () => {
    // A client cannot inject a header value or bloat the diagnostic log: a bad id is replaced.
    await startWithThrowingDeps();
    const res = await rawRequest("/api/projects", {
      "x-keiko-correlation-id": "bad id with spaces\tand-tabs",
    });
    const parsed = JSON.parse(res.body.toString("utf8")) as {
      error: { correlationId?: string };
    };
    expect(parsed.error.correlationId).not.toBe("bad id with spaces\tand-tabs");
    expect(parsed.error.correlationId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it("stays alive and keeps serving requests after a handler throw (no process crash)", async () => {
    await startWithThrowingDeps();

    // First request trips the throwing seam …
    const first = await rawRequest("/api/projects");
    expect(first.status).toBe(500);

    // … and a second, unrelated request on the same server still succeeds, proving the catch
    // isolated the failure (an unhandled rejection would have taken the process/server down).
    const health = await fetchRaw("/api/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ status: "ok" });
  });

  // NOTE: A mid-stream throw (a throw AFTER headers are sent, exercising the `else { res.end(); }`
  // branch) is intentionally NOT wired here. The existing helpers offer no seam to inject a throw
  // into an in-flight streaming response — the streaming handlers own and terminate their sockets
  // internally rather than re-throwing past `dispatchApi`'s STREAMING short-circuit to the top-level
  // catch — so a mid-stream case cannot be constructed without adding a production test hook, which
  // is out of scope for this test-only change. The headers-not-sent branch above is fully covered.
});
