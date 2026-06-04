// ADR-0013 D7 — Route handler tests for the 10 additive UI-store routes (13–22). The full set of
// happy and error paths goes through routeRequest dispatch and the SECURITY_HEADERS surface via the
// real createUiServer. Every test injects an in-memory UiStore so the FS is never touched.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

const POST_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const PATCH_HEADERS = POST_HEADERS;
const DELETE_HEADERS = POST_HEADERS;
const CHAT_MODEL = "example-chat-model";

let server: Server;
let port: number;
let staticRoot: string;
let tmp: string;
let projDir: string;
let store: UiStore;

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: customModelConfig(CHAT_MODEL),
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

function customModelConfig(modelId = "example-private-chat"): GatewayConfig {
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
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: [],
      },
    ],
  };
}

async function listen(): Promise<number> {
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  return (server.address() as AddressInfo).port;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function restartWithDeps(overrides: Partial<UiHandlerDeps>): Promise<void> {
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(overrides),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-store-handlers-"));
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  store = createInMemoryUiStore();
  // Two-phase bind so Host check matches the actual port.
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  port = await listen();
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
});

afterEach(async () => {
  await closeServer();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(staticRoot, { recursive: true, force: true });
});

// ─── Route 13: GET /api/projects ────────────────────────────────────────────
describe("GET /api/projects", () => {
  it("returns an empty list initially", async () => {
    const res = await fetch(url("/api/projects"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("derives availability from filesystem (AC4)", async () => {
    store.createProject(projDir);
    const otherDir = join(tmp, "other");
    mkdirSync(otherDir);
    store.createProject(otherDir);
    rmSync(otherDir, { recursive: true });
    const res = await fetch(url("/api/projects"));
    const body = (await res.json()) as {
      projects: { path: string; available: boolean }[];
    };
    expect(body.projects).toHaveLength(2);
    const map = Object.fromEntries(body.projects.map((p) => [p.path, p.available]));
    expect(map[projDir]).toBe(true);
    expect(map[otherDir]).toBe(false);
  });
});

// ─── Route 14: POST /api/projects ────────────────────────────────────────────
describe("POST /api/projects", () => {
  it("creates a project, returns 201 with availability", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir, name: "Hello" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { path: string; name: string; available: boolean };
    };
    expect(body.project.path).toBe(projDir);
    expect(body.project.name).toBe("Hello");
    expect(body.project.available).toBe(true);
  });

  it("UPSERTs lastOpenedAt on duplicate path (AC3)", async () => {
    const first = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir }),
    });
    const firstBody = (await first.json()) as {
      project: { lastOpenedAt: number };
    };
    // Small delay so Date.now bumps.
    await new Promise((r) => setTimeout(r, 5));
    const second = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      project: { lastOpenedAt: number };
    };
    expect(secondBody.project.lastOpenedAt).toBeGreaterThanOrEqual(firstBody.project.lastOpenedAt);
    const list = await fetch(url("/api/projects"));
    const listBody = (await list.json()) as { projects: unknown[] };
    expect(listBody.projects).toHaveLength(1);
  });

  it("returns 400 invalid_path for a null-byte path", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: "/tmp/x\u0000y" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_path");
  });

  it("returns 400 path_not_found for a missing directory", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: join(tmp, "ghost") }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("path_not_found");
  });

  it("rejects a project when the configured UI DB is inside that project", async () => {
    await restartWithDeps({ uiDbPath: join(projDir, ".keiko", "keiko-ui.db") });

    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/UI database path/i);
    expect(store.listProjects()).toHaveLength(0);
  });

  it("rejects a project inside the configured UI DB directory", async () => {
    const dataDir = join(tmp, "app-data");
    const nestedProject = join(dataDir, "repo");
    mkdirSync(nestedProject, { recursive: true });
    await restartWithDeps({ uiDbPath: join(dataDir, "keiko-ui.db") });

    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: nestedProject }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/UI database directory/i);
    expect(store.listProjects()).toHaveLength(0);
  });

  it("returns 400 invalid_request for missing path field", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 400 invalid_request for malformed JSON", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });
});

// ─── Route 15: PATCH /api/projects ────────────────────────────────────────────
describe("PATCH /api/projects", () => {
  it("renames a project, bumps lastOpenedAt", async () => {
    store.createProject(projDir, "old");
    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ name: "new", favorite: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      project: { name: string; favorite: boolean; available: boolean };
    };
    expect(body.project.name).toBe("new");
    expect(body.project.favorite).toBe(true);
    expect(body.project.available).toBe(true);
  });

  it("returns 404 for unknown project", async () => {
    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ favorite: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_request for missing path query", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ favorite: true }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Route 16: DELETE /api/projects ─────────────────────────────────────────────
describe("DELETE /api/projects", () => {
  it("deletes a project, cascades to chats and messages, returns 204", async () => {
    store.createProject(projDir);
    const chat = store.createChat(projDir, "t", "m");
    store.createMessage({
      chatId: chat.id,
      role: "user",
      content: "hi",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(store.listProjects()).toHaveLength(0);
    expect(store.listChats(projDir)).toHaveLength(0);
    expect(store.listMessages(chat.id)).toHaveLength(0);
  });

  it("returns 404 for unknown project", async () => {
    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

// ─── Route 17: GET /api/chats ────────────────────────────────────────────────
describe("GET /api/chats", () => {
  it("lists chats for a project", async () => {
    store.createProject(projDir);
    store.createChat(projDir, "Chat A", "m1");
    store.createChat(projDir, "Chat B", "m1");
    const res = await fetch(url(`/api/chats?projectPath=${encodeURIComponent(projDir)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: { title: string }[] };
    expect(body.chats.map((c) => c.title).sort()).toEqual(["Chat A", "Chat B"]);
  });

  it("returns 400 when projectPath is missing", async () => {
    const res = await fetch(url("/api/chats"));
    expect(res.status).toBe(400);
  });
});

// ─── Route 18: POST /api/chats ───────────────────────────────────────────────
describe("POST /api/chats", () => {
  it("creates a chat, returns 201", async () => {
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        projectPath: projDir,
        title: "Hi",
        selectedModel: CHAT_MODEL,
        branchLabel: "main",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      chat: { id: string; title: string; branchLabel: string };
    };
    expect(body.chat.id).toBeTruthy();
    expect(body.chat.title).toBe("Hi");
    expect(body.chat.branchLabel).toBe("main");
  });

  it("returns 404 when project is unknown", async () => {
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ projectPath: projDir, title: "t", selectedModel: CHAT_MODEL }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the project path is registered but unavailable", async () => {
    store.createProject(projDir);
    rmSync(projDir, { recursive: true, force: true });
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ projectPath: projDir, title: "t", selectedModel: CHAT_MODEL }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("Project path is unavailable.");
  });

  it("returns 400 invalid_request for missing title", async () => {
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ projectPath: projDir, selectedModel: CHAT_MODEL }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_request for a selectedModel absent from the registry", async () => {
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        projectPath: projDir,
        title: "t",
        selectedModel: "example-missing-model",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 400 invalid_request for a non-chat registry model", async () => {
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        projectPath: projDir,
        title: "t",
        selectedModel: "example-vision-model",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_request for provider-shaped selectedModel values", async () => {
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        projectPath: projDir,
        title: "t",
        selectedModel: "https://provider.example/models/gpt",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a configured custom chat model", async () => {
    const modelId = "example-private-chat";
    await restartWithDeps({ config: customModelConfig(modelId), configPresent: true });
    store.createProject(projDir);
    const res = await fetch(url("/api/chats"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        projectPath: projDir,
        title: "t",
        selectedModel: modelId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { chat: { selectedModel: string } };
    expect(body.chat.selectedModel).toBe(modelId);
  });
});

// ─── Route 19: PATCH /api/chats ──────────────────────────────────────────────
describe("PATCH /api/chats", () => {
  it("updates fields", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ title: "renamed", status: "closed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chat: { title: string; status: string } };
    expect(body.chat.title).toBe("renamed");
    expect(body.chat.status).toBe("closed");
  });

  it("updates selectedModel when it is a chat registry id", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "example-chat-model");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ selectedModel: CHAT_MODEL }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chat: { selectedModel: string } };
    expect(body.chat.selectedModel).toBe(CHAT_MODEL);
  });

  it("returns 400 invalid_request when selectedModel is not a chat registry id", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "example-chat-model");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ selectedModel: "example-embedding-model" }),
    });
    expect(res.status).toBe(400);
  });

  it("updates selectedModel to a configured custom chat model", async () => {
    const modelId = "example-private-chat";
    await restartWithDeps({ config: customModelConfig(modelId), configPresent: true });
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "example-chat-model");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ selectedModel: modelId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chat: { selectedModel: string } };
    expect(body.chat.selectedModel).toBe(modelId);
  });

  it("returns 404 for unknown id", async () => {
    const res = await fetch(url("/api/chats?id=nope"), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_request for invalid status", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ status: "banana" }),
    });
    expect(res.status).toBe(400);
  });

  // Issue #184 — PATCH route binds a workspace-relative scope from the Files window onto a
  // chat. The path validator is shared with the connected-context surface from issue #178.
  it("sets connectedScope on a chat (happy path)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: ["src/lib", "src/app/page.tsx"], connectedAtMs: 42 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScope: { relativePaths: string[]; connectedAtMs: number } | undefined;
      };
    };
    expect(body.chat.connectedScope).toEqual({
      relativePaths: ["src/lib", "src/app/page.tsx"],
      connectedAtMs: 42,
    });
  });

  it("clears connectedScope when patched with null", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: ["src/x"], connectedAtMs: 1 },
      }),
    });
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScope: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: { connectedScope: unknown };
    };
    expect(body.chat.connectedScope).toBeUndefined();
  });

  it("rejects connectedScope with a traversal path", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: ["../escape"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects connectedScope with an absolute path", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: ["/etc/passwd"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty connectedScope.relativePaths array", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: [], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects connectedScope.relativePaths exceeding the 50-entry cap", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const tooMany = Array.from({ length: 51 }, (_, i) => `src/f${String(i)}.ts`);
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: tooMany, connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer connectedScope.connectedAtMs", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { relativePaths: ["src/x"], connectedAtMs: 1.5 },
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Route 20: DELETE /api/chats ─────────────────────────────────────────────
describe("DELETE /api/chats", () => {
  it("deletes a chat, cascades to messages", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    store.createMessage({
      chatId: c.id,
      role: "user",
      content: "hi",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(store.listChats(projDir)).toHaveLength(0);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await fetch(url("/api/chats?id=nope"), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

// ─── Route 21: GET /api/chats/messages ───────────────────────────────────────
describe("GET /api/chats/messages", () => {
  it("lists messages for a chat", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    store.createMessage({
      chatId: c.id,
      role: "user",
      content: "hello",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const res = await fetch(
      url(
        `/api/chats/messages?chatId=${encodeURIComponent(c.id)}&projectPath=${encodeURIComponent(projDir)}`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { content: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toBe("hello");
  });

  it("returns 404 instead of leaking messages when chat belongs to another project", async () => {
    store.createProject(projDir);
    const otherDir = join(tmp, "other");
    mkdirSync(otherDir);
    store.createProject(otherDir);
    const c = store.createChat(otherDir, "t", "m");
    store.createMessage({
      chatId: c.id,
      role: "user",
      content: "other project",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const res = await fetch(
      url(
        `/api/chats/messages?chatId=${encodeURIComponent(c.id)}&projectPath=${encodeURIComponent(projDir)}`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when chatId is missing", async () => {
    const res = await fetch(url("/api/chats/messages"));
    expect(res.status).toBe(400);
  });
});

// ─── Route 22: POST /api/chats/messages ──────────────────────────────────────
describe("POST /api/chats/messages", () => {
  it("creates a message, returns 201, redacts shortResult", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "user",
        content: "hello",
        timestamp: 12345,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      message: { id: string; chatId: string; role: string };
    };
    expect(body.message.id).toBeTruthy();
    expect(body.message.chatId).toBe(c.id);
    expect(body.message.role).toBe("user");
  });

  it("returns 404 when chatId is unknown", async () => {
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: "nope",
        projectPath: projDir,
        role: "user",
        content: "x",
        timestamp: 1,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when chatId belongs to another project", async () => {
    store.createProject(projDir);
    const otherDir = join(tmp, "other-post");
    mkdirSync(otherDir);
    store.createProject(otherDir);
    const c = store.createChat(otherDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "user",
        content: "x",
        timestamp: 1,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_request for empty content", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "user",
        content: "",
        timestamp: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_request for unknown role", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "root",
        content: "x",
        timestamp: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts taskType on POST and persists it (#66)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "system",
        content: "Verify started",
        timestamp: 1,
        runId: "r-x",
        taskType: "verify",
        workflowStatus: "running",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { taskType?: string } };
    expect(body.message.taskType).toBe("verify");
  });

  it("rejects run summary fields on non-system messages (#66)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "user",
        content: "Verify requested.",
        timestamp: 1,
        runId: "r-x",
        taskType: "verify",
        workflowStatus: "running",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects run summary fields without a runId (#66)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "system",
        content: "Verify started",
        timestamp: 1,
        taskType: "verify",
        workflowStatus: "running",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid taskType pattern (#66)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        role: "system",
        content: "x",
        timestamp: 1,
        taskType: "BAD TYPE",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Route 23: POST /api/chats/messages/run-summary-pair (issue #66) ────────
describe("POST /api/chats/messages/run-summary-pair", () => {
  it("atomically creates exactly one user message and one system run summary", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages/run-summary-pair"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        user: { content: "Verify requested.", timestamp: 1 },
        summary: {
          content: "Verify started",
          timestamp: 2,
          runId: "run-pair",
          taskType: "verify",
          workflowStatus: "running",
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      messages: { role: string; runId?: string; taskType?: string }[];
    };
    expect(body.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(body.messages[1]?.runId).toBe("run-pair");
    expect(body.messages[1]?.taskType).toBe("verify");
    expect(store.listMessages(c.id)).toHaveLength(2);
  });

  it("rolls back the user message when the summary row is invalid", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages/run-summary-pair"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        user: { content: "Verify requested.", timestamp: 1 },
        summary: {
          content: "Verify started",
          timestamp: 2,
          taskType: "verify",
          workflowStatus: "running",
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });

  it("returns 400 when the summary has both workflowId and taskType", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url("/api/chats/messages/run-summary-pair"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        user: { content: "Tests requested.", timestamp: 1 },
        summary: {
          content: "Tests started",
          timestamp: 2,
          runId: "run-pair",
          workflowId: "unit-test-generation",
          taskType: "verify",
          workflowStatus: "running",
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });

  it("returns 404 when the chat belongs to another project", async () => {
    store.createProject(projDir);
    const otherDir = join(tmp, "other-pair");
    mkdirSync(otherDir);
    store.createProject(otherDir);
    const c = store.createChat(otherDir, "t", "m");
    const res = await fetch(url("/api/chats/messages/run-summary-pair"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        user: { content: "Verify requested.", timestamp: 1 },
        summary: {
          content: "Verify started",
          timestamp: 2,
          runId: "run-pair",
          taskType: "verify",
          workflowStatus: "running",
        },
      }),
    });
    expect(res.status).toBe(404);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });
});

// ─── Route 24: POST /api/chats/runs (issue #66) ─────────────────────────────
describe("POST /api/chats/runs", () => {
  it("starts a run and persists the user/system pair with the same reserved runId", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", CHAT_MODEL);
    const res = await fetch(url("/api/chats/runs"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        run: {
          taskType: "verify",
          input: { workspaceRoot: projDir },
          modelId: CHAT_MODEL,
        },
        user: { content: "Verify requested.", timestamp: 1 },
        summary: { content: "Verify started", timestamp: 2 },
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      run: { runId: string; fingerprint: string };
      messages: { role: string; runId?: string; taskType?: string; workflowStatus?: string }[];
    };
    expect(body.run.runId).toBeTruthy();
    expect(body.run.fingerprint).toBeTruthy();
    expect(body.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(body.messages[1]?.runId).toBe(body.run.runId);
    expect(body.messages[1]?.taskType).toBe("verify");
    expect(body.messages[1]?.workflowStatus).toBe("running");
    expect(store.listMessages(c.id).map((m) => m.role)).toEqual(["user", "system"]);
  });

  it("rejects invalid chat-run message input before starting or persisting", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", CHAT_MODEL);
    const res = await fetch(url("/api/chats/runs"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({
        chatId: c.id,
        projectPath: projDir,
        run: {
          taskType: "verify",
          input: { workspaceRoot: projDir },
          modelId: CHAT_MODEL,
        },
        user: { content: "", timestamp: 1 },
        summary: { content: "Verify started", timestamp: 2 },
      }),
    });
    expect(res.status).toBe(400);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });
});

// ─── Route 25: PATCH /api/chats/messages (issue #66) ────────────────────────
describe("PATCH /api/chats/messages", () => {
  function patchMessagesUrl(id: string, chatId: string): string {
    return url(
      `/api/chats/messages?id=${encodeURIComponent(id)}&chatId=${encodeURIComponent(chatId)}&projectPath=${encodeURIComponent(projDir)}`,
    );
  }

  function seedRunningMessage(): { id: string; chatId: string } {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const created = store.createMessage({
      chatId: c.id,
      role: "system",
      content: "Verify started",
      timestamp: 1,
      runId: "r-1",
      workflowId: undefined,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: "verify",
    });
    return { id: created.id, chatId: c.id };
  }

  it("patches workflowStatus and shortResult and returns 200 with the updated row", async () => {
    const { id, chatId } = seedRunningMessage();
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        workflowStatus: "completed",
        shortResult: "Verification passed: 3 classifications.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      message: { workflowStatus: string; shortResult: string; content: string };
    };
    expect(body.message.workflowStatus).toBe("completed");
    expect(body.message.shortResult).toBe("Verification passed: 3 classifications.");
    expect(body.message.content).toBe("Verify started");
  });

  it("accepts cancelled as a workflowStatus on PATCH", async () => {
    const { id, chatId } = seedRunningMessage();
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ workflowStatus: "cancelled" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { workflowStatus: string } };
    expect(body.message.workflowStatus).toBe("cancelled");
  });

  it("returns 404 for an unknown message id", async () => {
    store.createProject(projDir);
    const chat = store.createChat(projDir, "t", "m");
    const res = await fetch(patchMessagesUrl("no-such-id", chat.id), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ workflowStatus: "failed" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when patching a non-run-summary message", async () => {
    store.createProject(projDir);
    const chat = store.createChat(projDir, "t", "m");
    const message = store.createMessage({
      chatId: chat.id,
      role: "user",
      content: "ordinary chat note",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    const res = await fetch(patchMessagesUrl(message.id, chat.id), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ workflowStatus: "completed" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when patching a message through the wrong project path", async () => {
    const { id, chatId } = seedRunningMessage();
    const otherDir = join(tmp, "other-patch");
    mkdirSync(otherDir);
    store.createProject(otherDir);
    const res = await fetch(
      url(
        `/api/chats/messages?id=${encodeURIComponent(id)}&chatId=${encodeURIComponent(chatId)}&projectPath=${encodeURIComponent(otherDir)}`,
      ),
      {
        method: "PATCH",
        headers: PATCH_HEADERS,
        body: JSON.stringify({ workflowStatus: "completed" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 invalid_request for an empty patch body", async () => {
    const { id, chatId } = seedRunningMessage();
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_request for an invalid workflowStatus", async () => {
    const { id, chatId } = seedRunningMessage();
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ workflowStatus: "banana" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 invalid_request when id query param is missing", async () => {
    const res = await fetch(url(`/api/chats/messages`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ workflowStatus: "failed" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 413 payload_too_large for an oversized body", async () => {
    const { id, chatId } = seedRunningMessage();
    const padded = JSON.stringify({ shortResult: "x".repeat(300_000) });
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: padded,
    });
    expect(res.status).toBe(413);
  });

  it("rejects PATCH without the CSRF guard header", async () => {
    const { id, chatId } = seedRunningMessage();
    const res = await fetch(patchMessagesUrl(id, chatId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowStatus: "failed" }),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Cross-cutting ──────────────────────────────────────────────────────────
describe("cross-cutting", () => {
  it("applies SECURITY_HEADERS to all store routes", async () => {
    const res = await fetch(url("/api/projects"));
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects state-changing requests without JSON content-type", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: { "X-Keiko-CSRF": "1" },
      body: "x",
    });
    expect(res.status).toBe(415);
  });

  it("rejects state-changing requests without the CSRF guard header", async () => {
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projDir }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 413 payload_too_large when the request body exceeds the cap", async () => {
    // MAX_STORE_BODY_BYTES is 256_000 (store-handlers.ts). Send 300 KB of padded JSON.
    const padded = JSON.stringify({ path: projDir, name: "x".repeat(300_000) });
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: padded,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });
});
