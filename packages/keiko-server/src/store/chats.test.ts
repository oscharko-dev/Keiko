// ADR-0013 — chats CRUD scoped to a project; FK cascade behaviours.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryUiStore, UiStoreError, type UiStore } from "./index.js";

let tmp: string;
let proj: string;
let store: UiStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-chats-"));
  proj = join(tmp, "p");
  mkdirSync(proj);
  let t = 1;
  store = createInMemoryUiStore({ now: () => ++t });
  store.createProject(proj);
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createChat", () => {
  it("creates a chat scoped to the project", () => {
    const c = store.createChat(proj, "Hello", "example-chat-model", { branchLabel: "main" });
    expect(c.projectPath).toBe(proj);
    expect(c.title).toBe("Hello");
    expect(c.selectedModel).toBe("example-chat-model");
    expect(c.branchLabel).toBe("main");
    expect(c.status).toBeUndefined();
    expect(typeof c.id).toBe("string");
    expect(c.id.length).toBeGreaterThan(0);
  });

  it("rejects creating a chat for an unknown project", () => {
    expect(() => store.createChat(join(tmp, "nope"), "t", "m")).toThrow(UiStoreError);
  });

  it("rejects creating a chat for an unavailable project path", () => {
    rmSync(proj, { recursive: true, force: true });
    expect(() => store.createChat(proj, "t", "m")).toThrow(UiStoreError);
  });

  it("rejects an empty title", () => {
    expect(() => store.createChat(proj, "", "example-chat-model")).toThrow(UiStoreError);
  });

  it("rejects an empty selectedModel", () => {
    expect(() => store.createChat(proj, "t", "")).toThrow(UiStoreError);
  });

  it("rejects provider-shaped selectedModel values before persistence", () => {
    expect(() => store.createChat(proj, "t", "https://provider.example/model")).toThrow(
      UiStoreError,
    );
  });

  it("rejects JSON-shaped selectedModel values before persistence", () => {
    expect(() =>
      store.createChat(proj, "t", '{"provider":"azure","modelId":"example-chat-model"}'),
    ).toThrow(UiStoreError);
  });

  it("rejects secret-shaped selectedModel values before persistence", () => {
    expect(() => store.createChat(proj, "t", "secret-token")).toThrow(UiStoreError);
  });

  it("lists chats for the given project only", () => {
    const otherProj = join(tmp, "other");
    mkdirSync(otherProj);
    store.createProject(otherProj);
    store.createChat(proj, "A", "m1");
    store.createChat(proj, "B", "m1");
    store.createChat(otherProj, "C", "m1");
    expect(
      store
        .listChats(proj)
        .map((c) => c.title)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(store.listChats(otherProj).map((c) => c.title)).toEqual(["C"]);
  });
});

describe("updateChat", () => {
  it("updates fields and bumps updatedAt", () => {
    const c = store.createChat(proj, "t", "m");
    const u = store.updateChat(c.id, { title: "renamed", status: "closed" });
    expect(u.title).toBe("renamed");
    expect(u.status).toBe("closed");
    expect(u.updatedAt).toBeGreaterThan(c.updatedAt);
  });

  it("throws not_found for unknown id", () => {
    expect(() => store.updateChat("missing-id", { title: "x" })).toThrow(UiStoreError);
  });

  it("rejects invalid selectedModel patches", () => {
    const c = store.createChat(proj, "t", "m");
    expect(() =>
      store.updateChat(c.id, { selectedModel: '{"apiKey":"secret","modelId":"m"}' }),
    ).toThrow(UiStoreError);
  });
});

// Issue #184 — round-trip tests for the connectedScope wire round-trip through SQLite.
// Three-state semantics: undefined (omit) leaves the binding alone; null clears; a value writes.
describe("updateChat — connectedScope round-trip (#184)", () => {
  it("createChat leaves connectedScope undefined", () => {
    const c = store.createChat(proj, "t", "m");
    expect(c.connectedScope).toBeUndefined();
  });

  it("sets a connectedScope and round-trips it through SELECT", () => {
    const c = store.createChat(proj, "t", "m");
    const updated = store.updateChat(c.id, {
      connectedScope: {
        kind: "files",
        relativePaths: ["src/lib", "src/app/page.tsx"],
        connectedAtMs: 42,
      },
    });
    expect(updated.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/lib", "src/app/page.tsx"],
      connectedAtMs: 42,
    });
    const fetched = store.listChats(proj).find((x) => x.id === c.id);
    expect(fetched?.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/lib", "src/app/page.tsx"],
      connectedAtMs: 42,
    });
  });

  it("sets a repository-root connectedScope with empty relativePaths", () => {
    const c = store.createChat(proj, "t", "m");
    const updated = store.updateChat(c.id, {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 42 },
    });
    expect(updated.connectedScope).toEqual({
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 42,
    });
  });

  it("clears connectedScope when patched with null", () => {
    const c = store.createChat(proj, "t", "m");
    store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/a"], connectedAtMs: 1 },
    });
    const cleared = store.updateChat(c.id, { connectedScope: null });
    expect(cleared.connectedScope).toBeUndefined();
    const fetched = store.listChats(proj).find((x) => x.id === c.id);
    expect(fetched?.connectedScope).toBeUndefined();
  });

  it("leaves connectedScope untouched when the field is omitted from the patch", () => {
    const c = store.createChat(proj, "t", "m");
    store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/keep"], connectedAtMs: 7 },
    });
    const renamed = store.updateChat(c.id, { title: "renamed" });
    expect(renamed.title).toBe("renamed");
    expect(renamed.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/keep"],
      connectedAtMs: 7,
    });
  });

  it("supports replacement: a second scope patch overwrites the prior binding", () => {
    const c = store.createChat(proj, "t", "m");
    store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/a"], connectedAtMs: 1 },
    });
    const replaced = store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/b", "src/c"], connectedAtMs: 2 },
    });
    expect(replaced.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/b", "src/c"],
      connectedAtMs: 2,
    });
  });

  it("rejects an empty relativePaths array", () => {
    const c = store.createChat(proj, "t", "m");
    expect(() =>
      store.updateChat(c.id, {
        connectedScope: { kind: "files", relativePaths: [], connectedAtMs: 1 },
      }),
    ).toThrow(UiStoreError);
  });

  it("rejects a non-integer connectedAtMs", () => {
    const c = store.createChat(proj, "t", "m");
    expect(() =>
      store.updateChat(c.id, {
        connectedScope: { kind: "files", relativePaths: ["src/a"], connectedAtMs: 1.5 },
      }),
    ).toThrow(UiStoreError);
  });
});

describe("deleteChat", () => {
  it("deletes the chat and cascades to messages", () => {
    const c = store.createChat(proj, "t", "m");
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
    store.deleteChat(c.id);
    expect(store.listChats(proj)).toHaveLength(0);
    expect(store.listMessages(c.id)).toHaveLength(0);
  });

  it("throws not_found for unknown id", () => {
    expect(() => {
      store.deleteChat("missing");
    }).toThrow(UiStoreError);
  });
});
