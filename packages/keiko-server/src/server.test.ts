import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";
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
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({
        windows: [
          { id: "files-1", type: "files", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
        ],
        connections: [{ id: "c-1", a: "files-1", b: "chat-1" }],
      }),
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text)).toMatchObject({ workspace: { revision: 1 } });

    const get = await fetchRaw("/api/workspace/state");
    expect(get.status).toBe(200);
    const body = JSON.parse(get.text) as {
      workspace: { revision: number; windows: unknown[]; connections: unknown[] };
    };
    expect(body.workspace.revision).toBe(1);
    expect(body.workspace.windows).toHaveLength(1);
    expect(body.workspace.connections).toEqual([{ id: "c-1", a: "files-1", b: "chat-1" }]);
  });

  it("rejects malformed workspace state payloads", async () => {
    const res = await fetchRawWithInit("/api/workspace/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({ windows: {}, connections: [] }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "invalid_request" } });
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
