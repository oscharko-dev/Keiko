// ADR-0013 — projects CRUD. AC3 (duplicate-path UPSERTs lastOpenedAt), AC4 (availability derived).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryUiStore,
  isProjectAvailable,
  UiStoreError,
  type UiStore,
} from "./index.js";

let tmp: string;
let projA: string;
let projB: string;
let store: UiStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-projects-"));
  projA = join(tmp, "a");
  projB = join(tmp, "b");
  mkdirSync(projA);
  mkdirSync(projB);
  let t = 1000;
  store = createInMemoryUiStore({ now: () => ++t });
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createProject", () => {
  it("normalizes the supplied path and stores absolute form", () => {
    const messy = `/${projA.slice(1).replace(/\//g, "//")}`;
    const p = store.createProject(messy);
    expect(p.path).toBe(projA);
    expect(p.name).toBe("a");
    expect(p.favorite).toBe(false);
    expect(typeof p.createdAt).toBe("number");
    expect(typeof p.lastOpenedAt).toBe("number");
  });

  it("uses an explicit name when supplied", () => {
    const p = store.createProject(projA, "Custom Name");
    expect(p.name).toBe("Custom Name");
  });

  it("duplicate path UPSERTs lastOpenedAt instead of inserting a second row (AC3)", () => {
    const p1 = store.createProject(projA);
    const p2 = store.createProject(projA);
    expect(p2.path).toBe(p1.path);
    expect(p2.lastOpenedAt).toBeGreaterThan(p1.lastOpenedAt);
    expect(p2.createdAt).toBe(p1.createdAt);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("repairs the display name when a duplicate path is re-added with an explicit name", () => {
    const p1 = store.createProject(projA);
    const p2 = store.createProject(projA, "Reconnected Project");
    expect(p2.path).toBe(p1.path);
    expect(p2.name).toBe("Reconnected Project");
    expect(p2.createdAt).toBe(p1.createdAt);
    expect(p2.lastOpenedAt).toBeGreaterThan(p1.lastOpenedAt);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("preserves an existing display name when a duplicate path is re-added without a name", () => {
    const p1 = store.createProject(projA, "Pinned Name");
    const p2 = store.createProject(projA);
    expect(p2.name).toBe("Pinned Name");
    expect(p2.createdAt).toBe(p1.createdAt);
    expect(p2.lastOpenedAt).toBeGreaterThan(p1.lastOpenedAt);
  });

  it("rejects an invalid path via UiStoreError", () => {
    expect(() => store.createProject("/tmp/has\0null")).toThrow(UiStoreError);
  });

  it("rejects a missing path at create time", () => {
    expect(() => store.createProject(join(tmp, "ghost"))).toThrow(UiStoreError);
  });

  it("rejects a path that is a regular file", () => {
    // create a file at a known path and assert createProject rejects it.
    const file = join(tmp, "file.txt");
    rmSync(file, { force: true });
    writeFileSync(file, "x");
    expect(() => store.createProject(file)).toThrow(UiStoreError);
  });
});

describe("listProjects + isProjectAvailable", () => {
  it("returns all projects (deterministic order)", () => {
    store.createProject(projA);
    store.createProject(projB);
    const list = store.listProjects();
    expect(list.map((p) => p.path).sort()).toEqual([projA, projB].sort());
  });

  it("derives availability — missing paths remain listed (AC4)", () => {
    store.createProject(projA);
    store.createProject(projB);
    rmSync(projB, { recursive: true });
    const list = store.listProjects();
    expect(list).toHaveLength(2);
    const byPath = Object.fromEntries(list.map((p) => [p.path, isProjectAvailable(p)]));
    expect(byPath[projA]).toBe(true);
    expect(byPath[projB]).toBe(false);
  });
});

describe("updateProject", () => {
  it("updates name and favorite", () => {
    store.createProject(projA);
    const updated = store.updateProject(projA, { name: "Renamed", favorite: true });
    expect(updated.name).toBe("Renamed");
    expect(updated.favorite).toBe(true);
  });

  it("touches lastOpenedAt to now() when patch is empty", () => {
    const created = store.createProject(projA);
    const updated = store.updateProject(projA, {});
    expect(updated.lastOpenedAt).toBeGreaterThan(created.lastOpenedAt);
  });

  it("throws not_found for an unknown path", () => {
    expect(() => store.updateProject(projA, { favorite: true })).toThrow(UiStoreError);
  });
});

describe("deleteProject", () => {
  it("removes the project", () => {
    store.createProject(projA);
    store.deleteProject(projA);
    expect(store.listProjects()).toHaveLength(0);
  });

  it("cascades to chats and messages", () => {
    store.createProject(projA);
    const chat = store.createChat(projA, "t", "example-chat-model");
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
    store.deleteProject(projA);
    expect(store.listChats(projA)).toHaveLength(0);
    expect(store.listMessages(chat.id)).toHaveLength(0);
  });

  it("throws not_found for an unknown path", () => {
    expect(() => {
      store.deleteProject(projA);
    }).toThrow(UiStoreError);
  });
});

describe("SQL injection — parameterized statements", () => {
  it("treats injection-shaped input as a literal value", () => {
    const malicious = "/tmp/abc'); DROP TABLE projects; --";
    expect(() => store.createProject(malicious)).toThrow(UiStoreError);
    // The store survives — listProjects still works.
    expect(() => store.listProjects()).not.toThrow();
    // And a normal create still succeeds.
    const p = store.createProject(projA);
    expect(p.path).toBe(projA);
  });
});
