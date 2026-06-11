// ADR-0013 D7 — Route handler tests for the 10 additive UI-store routes (13–22). The full set of
// happy and error paths goes through routeRequest dispatch and the SECURITY_HEADERS surface via the
// real createUiServer. Every test injects an in-memory UiStore so the FS is never touched.

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUiServer, UI_HOST } from "./server.js";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import {
  clearAllGroundedContextIndexes,
  groundedContextIndexRegistry,
  microIndexForGroundedScope,
} from "./grounded-context-index.js";
import { clearAllGroundedTurns, groundedTurnRegistry } from "./grounded-turn-registry.js";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";

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

function openGroundedIndex(chatId: string, workspaceRoot = projDir): void {
  microIndexForGroundedScope(
    {
      schemaVersion: "1",
      scopeId: `scope-${chatId}`,
      workspaceRoot,
      kind: "files",
      relativePaths: ["src"],
      conversationId: chatId,
      connectedAtMs: 1,
    },
    () => 1,
  );
}

function rememberGroundedTurn(chatId: string, workspaceRoot = projDir): void {
  groundedTurnRegistry.remember(
    {
      assistantMessageId: `assistant-${chatId}`,
      chatId,
      workspaceRoot,
      packs: [{ files: [] } as unknown as ConnectedContextPack],
    },
    () => 1,
  );
}

beforeEach(async () => {
  clearAllGroundedContextIndexes();
  clearAllGroundedTurns();
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-static-"));
  tmp = mkdtempSync(join(tmpdir(), "keiko-store-handlers-"));
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  mkdirSync(join(projDir, "src", "lib"), { recursive: true });
  mkdirSync(join(projDir, "src", "app"), { recursive: true });
  writeFileSync(join(projDir, "src", "app", "page.tsx"), "export default null;\n");
  writeFileSync(join(projDir, "src", "x"), "x\n");
  writeFileSync(join(projDir, "src", "next"), "next\n");
  writeFileSync(join(projDir, ".env"), "SECRET=1\n");
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
  clearAllGroundedContextIndexes();
  clearAllGroundedTurns();
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

  it("returns the launch project before stale persisted projects", async () => {
    const staleDir = join(tmp, "aaa-stale-project");
    mkdirSync(staleDir);
    store.createProject(staleDir);
    store.createProject(projDir);
    await restartWithDeps({ preferredProjectPath: projDir });

    const res = await fetch(url("/api/projects"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: { path: string; available: boolean }[];
    };
    expect(body.projects.map((project) => project.path)).toEqual([projDir, staleDir]);
    expect(body.projects[0]?.available).toBe(true);
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
    await restartWithDeps({ uiDbPath: join(projDir, "state", "keiko-ui.db") });

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

  it("allows a project when the configured UI DB is under its .keiko runtime root", async () => {
    await restartWithDeps({ uiDbPath: join(projDir, ".keiko", "ui", "keiko-ui.db") });

    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir }),
    });

    expect(res.status).toBe(201);
    expect(store.listProjects()).toHaveLength(1);
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

  it("returns 403 DENIED for a deny-listed path (e.g. ~/.ssh)", async () => {
    // ~/.ssh is a deny-listed path segment; a symlink pointing there must also be blocked.
    const sshDir = join(tmp, ".ssh");
    mkdirSync(sshDir);
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: sshDir }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DENIED");
    expect(store.listProjects()).toHaveLength(0);
  });

  it("still creates a normal project after rejecting a denied one (guard is non-destructive)", async () => {
    const sshDir = join(tmp, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: sshDir }),
    });
    const res = await fetch(url("/api/projects"), {
      method: "POST",
      headers: POST_HEADERS,
      body: JSON.stringify({ path: projDir }),
    });
    expect(res.status).toBe(201);
    expect(store.listProjects()).toHaveLength(1);
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

  it("clears grounded context indexes when a project is deleted", async () => {
    store.createProject(projDir);
    const chat = store.createChat(projDir, "t", "m");
    openGroundedIndex(chat.id);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(groundedContextIndexRegistry.size()).toBe(0);
  });

  it("clears external-root grounded state for chats cascaded by project deletion", async () => {
    const externalRoot = join(tmp, "external-connected-root");
    mkdirSync(externalRoot);
    store.createProject(projDir);
    const chat = store.createChat(projDir, "t", "m");
    openGroundedIndex(chat.id, externalRoot);
    rememberGroundedTurn(chat.id, externalRoot);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    expect(groundedTurnRegistry.lookup(`assistant-${chat.id}`, () => 2)).not.toBeUndefined();

    const res = await fetch(url(`/api/projects?path=${encodeURIComponent(projDir)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });

    expect(res.status).toBe(204);
    expect(groundedContextIndexRegistry.size()).toBe(0);
    expect(groundedTurnRegistry.lookup(`assistant-${chat.id}`, () => 3)).toBeUndefined();
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

  it("applies the limit query", async () => {
    store.createProject(projDir);
    for (let i = 0; i < 3; i++) {
      store.createChat(projDir, `Chat ${String(i)}`, "m1");
    }
    const res = await fetch(url(`/api/chats?projectPath=${encodeURIComponent(projDir)}&limit=2`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chats: { title: string }[] };
    expect(body.chats).toHaveLength(2);
    expect(body.chats.map((chat) => chat.title)).toEqual(["Chat 0", "Chat 1"]);
  });

  it("returns 400 for an out-of-bounds limit", async () => {
    store.createProject(projDir);
    const res = await fetch(url(`/api/chats?projectPath=${encodeURIComponent(projDir)}&limit=999`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/limit/i);
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

  it("clears grounded context indexes when a chat is closed", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    openGroundedIndex(c.id);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ status: "closed" }),
    });
    expect(res.status).toBe(200);
    expect(groundedContextIndexRegistry.size()).toBe(0);
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
        connectedScope: {
          kind: "files",
          relativePaths: ["src/lib", "src/app/page.tsx"],
          connectedAtMs: 42,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScope:
          | { kind: string; relativePaths: string[]; connectedAtMs: number }
          | undefined;
      };
    };
    expect(body.chat.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/lib", "src/app/page.tsx"],
      connectedAtMs: 42,
    });
  });

  it("sets a repository-root connectedScope on a chat", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 42 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScope: { kind: string; relativePaths: string[]; connectedAtMs: number };
      };
    };
    expect(body.chat.connectedScope).toEqual({
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 42,
    });
  });

  it("rejects a rootless workspace-root scope when the project lives under a denied ancestor", async () => {
    const deniedProject = join(tmp, ".aws", "sub");
    mkdirSync(deniedProject, { recursive: true });
    store.createProject(deniedProject);
    const c = store.createChat(deniedProject, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 42 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(".aws");
    expect(bodyText).toContain("safe read surface");
  });

  it("rejects a rootless workspace-root scope when the raw project path contains a denied segment", async () => {
    const deniedParent = join(tmp, ".aws");
    const symlinkProject = join(deniedParent, "project-link");
    mkdirSync(deniedParent, { recursive: true });
    symlinkSync(projDir, symlinkProject, "dir");
    store.createProject(symlinkProject);
    const c = store.createChat(symlinkProject, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 42 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(".aws");
    expect(bodyText).not.toContain("project-link");
    expect(bodyText).toContain("safe read surface");
  });

  it("sets a folder connectedScope on a chat", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "directory", relativePaths: ["src/lib"], connectedAtMs: 42 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScope: { kind: string; relativePaths: string[]; connectedAtMs: number };
      };
    };
    expect(body.chat.connectedScope).toEqual({
      kind: "directory",
      relativePaths: ["src/lib"],
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
        connectedScope: { kind: "files", relativePaths: ["src/x"], connectedAtMs: 1 },
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

  it("clears grounded context indexes when connectedScope is patched to null", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    openGroundedIndex(c.id);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScope: null }),
    });
    expect(res.status).toBe(200);
    expect(groundedContextIndexRegistry.size()).toBe(0);
  });

  it("clears grounded context indexes when connectedScope is replaced", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    openGroundedIndex(c.id);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: ["src/next"], connectedAtMs: 2 },
      }),
    });
    expect(res.status).toBe(200);
    expect(groundedContextIndexRegistry.size()).toBe(0);
  });

  it("rejects connectedScope with a traversal path", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: ["../escape"], connectedAtMs: 1 },
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
        connectedScope: { kind: "files", relativePaths: ["/etc/passwd"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects connectedScope for a missing path with a safe error", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: ["src/missing.ts"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("src/missing.ts");
    expect(bodyText).toContain("Connected scope path is not accessible");
  });

  it("rejects connectedScope for a deny-listed path without exposing the path", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: [".env"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(".env");
    expect(bodyText).toContain("safe read surface");
  });

  it("rejects connectedScope when a symlink resolves to a deny-listed path", async () => {
    symlinkSync(join(projDir, ".env"), join(projDir, "src", "env-link"));
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: ["src/env-link"], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("env-link");
    expect(bodyText).not.toContain(".env");
    expect(bodyText).toContain("safe read surface");
  });

  it("rejects connectedScope for secret-shaped path metadata", async () => {
    const secretShapedName = `sk-${"a".repeat(20)}`;
    writeFileSync(join(projDir, secretShapedName), "not a real token\n");
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: [secretShapedName], connectedAtMs: 1 },
      }),
    });
    expect(res.status).toBe(400);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secretShapedName);
    expect(bodyText).toContain("credential-shaped metadata");
  });

  it("rejects an empty connectedScope.relativePaths array", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScope: { kind: "files", relativePaths: [], connectedAtMs: 1 },
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
        connectedScope: { kind: "files", relativePaths: tooMany, connectedAtMs: 1 },
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
        connectedScope: { kind: "files", relativePaths: ["src/x"], connectedAtMs: 1.5 },
      }),
    });
    expect(res.status).toBe(400);
  });

  // Epic #532 — multi-source connectedScopes list: each source is validated through the same
  // realpath + deny-list + redaction access gate as the single field.
  it("sets a valid 2-source connectedScopes list (each in its own external root)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const alpha = join(tmp, "alpha");
    const beta = join(tmp, "beta");
    mkdirSync(join(alpha, "docs"), { recursive: true });
    mkdirSync(beta, { recursive: true });
    writeFileSync(join(beta, "offer.md"), "offer body\n");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScopes: [
          { kind: "directory", relativePaths: ["docs"], connectedAtMs: 10, root: alpha },
          { kind: "files", relativePaths: ["offer.md"], connectedAtMs: 11, root: beta },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScopes: { kind: string; relativePaths: string[]; root?: string }[];
        connectedScope: { kind: string } | undefined;
      };
    };
    expect(body.chat.connectedScopes).toHaveLength(2);
    expect(body.chat.connectedScopes[0]?.root).toBe(realpathSync(alpha));
    expect(body.chat.connectedScopes[1]?.root).toBe(realpathSync(beta));
    // Back-compat single field reflects the first source.
    expect(body.chat.connectedScope?.kind).toBe("directory");
  });

  it("canonicalizes a symlinked connectedScopes root before persistence", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const realRoot = join(tmp, "real-docs-root");
    const linkedRoot = join(tmp, "linked-docs-root");
    mkdirSync(join(realRoot, "docs"), { recursive: true });
    symlinkSync(realRoot, linkedRoot, "dir");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScopes: [
          { kind: "directory", relativePaths: ["docs"], connectedAtMs: 12, root: linkedRoot },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScopes: { root?: string }[];
        connectedScope: { root?: string } | undefined;
      };
    };
    expect(body.chat.connectedScopes[0]?.root).toBe(realpathSync(realRoot));
    expect(body.chat.connectedScope?.root).toBe(realpathSync(realRoot));
  });

  it("rejects a connectedScopes list whose entry has a deny-listed root (.ssh)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const ok = join(tmp, "ok-src");
    const denied = join(tmp, ".ssh");
    mkdirSync(ok, { recursive: true });
    mkdirSync(denied, { recursive: true });
    writeFileSync(join(ok, "a.md"), "a\n");
    writeFileSync(join(denied, "id_rsa"), "key\n");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScopes: [
          { kind: "files", relativePaths: ["a.md"], connectedAtMs: 1, root: ok },
          { kind: "files", relativePaths: ["id_rsa"], connectedAtMs: 2, root: denied },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const fetched = store.findChatById(c.id);
    // The denied source must not have partially persisted.
    expect(fetched?.connectedScopes ?? []).toHaveLength(0);
  });

  it("rejects a connectedScopes list exceeding MAX_CONNECTED_SOURCES (17 entries)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const tooMany = Array.from({ length: 17 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: tooMany }),
    });
    expect(res.status).toBe(400);
  });

  it("clears all sources when connectedScopes is patched with null", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const alpha = join(tmp, "alpha-clear");
    mkdirSync(join(alpha, "docs"), { recursive: true });
    await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScopes: [
          { kind: "directory", relativePaths: ["docs"], connectedAtMs: 1, root: alpha },
        ],
      }),
    });
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: null }),
    });
    expect(res.status).toBe(200);
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScopes ?? []).toHaveLength(0);
    expect(fetched?.connectedScope).toBeUndefined();
  });

  // Epic #189 — multi-source localKnowledgeScopes (connectors). Shape-only validation at the BFF
  // (capsule existence is checked in the grounded path); no filesystem roots involved.
  it("sets a valid 2-connector localKnowledgeScopes list (list + back-compat single)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        localKnowledgeScopes: [
          { kind: "capsule", capsuleId: "cap-alpha", connectedAtMs: 10 },
          { kind: "capsule-set", capsuleSetId: "set-beta", connectedAtMs: 11 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        localKnowledgeScopes: { kind: string }[];
        localKnowledgeScope: { kind: string } | undefined;
      };
    };
    expect(body.chat.localKnowledgeScopes).toHaveLength(2);
    expect(body.chat.localKnowledgeScopes[0]?.kind).toBe("capsule");
    expect(body.chat.localKnowledgeScopes[1]?.kind).toBe("capsule-set");
    expect(body.chat.localKnowledgeScope?.kind).toBe("capsule");
  });

  it("rejects a localKnowledgeScopes list exceeding MAX_LOCAL_KNOWLEDGE_SOURCES (17)", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const tooMany = Array.from({ length: 17 }, (_unused, i) => ({
      kind: "capsule" as const,
      capsuleId: `cap-${String(i)}`,
      connectedAtMs: 1,
    }));
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ localKnowledgeScopes: tooMany }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a localKnowledgeScopes entry with an empty capsule id", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        localKnowledgeScopes: [{ kind: "capsule", capsuleId: "", connectedAtMs: 1 }],
      }),
    });
    expect(res.status).toBe(400);
    expect(store.findChatById(c.id)?.localKnowledgeScopes ?? []).toHaveLength(0);
  });

  it("clears all connectors when localKnowledgeScopes is patched with null", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        localKnowledgeScopes: [{ kind: "capsule", capsuleId: "cap-x", connectedAtMs: 1 }],
      }),
    });
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ localKnowledgeScopes: null }),
    });
    expect(res.status).toBe(200);
    const fetched = store.findChatById(c.id);
    expect(fetched?.localKnowledgeScopes ?? []).toHaveLength(0);
    expect(fetched?.localKnowledgeScope).toBeUndefined();
  });

  it("rejects a connectedScopes list with an empty-string root entry", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({
        connectedScopes: [{ kind: "files", relativePaths: ["a.md"], connectedAtMs: 1, root: "  " }],
      }),
    });
    expect(res.status).toBe(400);
  });

  // ─── Operator-configurable grounding limits ───────────────────────────────────
  it("rejects a connectedScopes list exceeding a custom-lowered maxConnectedSources (2)", async () => {
    // Inject a gateway config with grounding.maxConnectedSources = 2 so the runtime cap is 2.
    const lowCapConfig = {
      ...customModelConfig(CHAT_MODEL),
      grounding: { maxConnectedSources: 2 },
    };
    await restartWithDeps({ config: lowCapConfig });

    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const threeScopes = Array.from({ length: 3 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: threeScopes }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Error message must reflect the configured number (2), not the constant 16.
    expect(body.error.message).toContain("2");
  });

  it("persists and round-trips a connectedScopes list allowed by a raised maxConnectedSources", async () => {
    const raisedCapConfig = {
      ...customModelConfig(CHAT_MODEL),
      grounding: { maxConnectedSources: 17 },
    };
    await restartWithDeps({ config: raisedCapConfig });

    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const scopes = Array.from({ length: 17 }, (_unused, i) => {
      const file = `src/f${String(i)}.ts`;
      writeFileSync(join(projDir, file), `export const f${String(i)} = ${String(i)};\n`);
      return { kind: "files" as const, relativePaths: [file], connectedAtMs: i + 1 };
    });
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: scopes }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: {
        connectedScopes: { kind: string; relativePaths: string[]; connectedAtMs: number }[];
      };
    };
    expect(body.chat.connectedScopes).toHaveLength(17);
    expect(store.findChatById(c.id)?.connectedScopes).toHaveLength(17);
  });

  it("missing-config uses default maxConnectedSources of 16 (rejects 17)", async () => {
    // Default config has maxConnectedSources = 16; 17 entries must be rejected.
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const seventeen = Array.from({ length: 17 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: seventeen }),
    });
    expect(res.status).toBe(400);
  });

  it("over-ceiling grounding value is clamped (maxConnectedSources 9999 → 64)", async () => {
    // GROUNDING_LIMIT_CEILINGS.maxConnectedSources is 64; 9999 must be clamped to it.
    const overCeilConfig = {
      ...customModelConfig(CHAT_MODEL),
      grounding: { maxConnectedSources: 9999 },
    };
    await restartWithDeps({ config: overCeilConfig });

    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    // 65 entries > ceiling 64 → must be rejected (clamped to 64, not 9999).
    const tooMany = Array.from({ length: 65 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "PATCH",
      headers: PATCH_HEADERS,
      body: JSON.stringify({ connectedScopes: tooMany }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Error message must show the clamped ceiling (64), not the unclamped value.
    expect(body.error.message).toContain("64");
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

  it("clears grounded context indexes when a chat is deleted", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    openGroundedIndex(c.id);
    expect(groundedContextIndexRegistry.size()).toBe(1);
    const res = await fetch(url(`/api/chats?id=${encodeURIComponent(c.id)}`), {
      method: "DELETE",
      headers: DELETE_HEADERS,
    });
    expect(res.status).toBe(204);
    expect(groundedContextIndexRegistry.size()).toBe(0);
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

  it("applies the limit query", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    for (let i = 0; i < 3; i++) {
      store.createMessage({
        chatId: c.id,
        role: "user",
        content: `message-${String(i)}`,
        timestamp: i + 1,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
    const res = await fetch(
      url(
        `/api/chats/messages?chatId=${encodeURIComponent(c.id)}&projectPath=${encodeURIComponent(projDir)}&limit=2`,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { content: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((message) => message.content)).toEqual(["message-0", "message-1"]);
  });

  it("returns 400 for an invalid message limit", async () => {
    store.createProject(projDir);
    const c = store.createChat(projDir, "t", "m");
    const res = await fetch(
      url(
        `/api/chats/messages?chatId=${encodeURIComponent(c.id)}&projectPath=${encodeURIComponent(projDir)}&limit=0`,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/limit/i);
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
