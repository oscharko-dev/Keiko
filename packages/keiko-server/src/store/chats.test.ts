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

// Epic #177 audit: grounded-ask and chat PATCH paths used a project-scan + chat-scan helper
// that fired O(projects × chats) row fetches per request. `findChatById` is the single-row
// SELECT replacement; these tests pin its three semantic boundaries.
describe("findChatById (#177)", () => {
  it("returns the chat regardless of which project owns it", () => {
    const otherProj = join(tmp, "other");
    mkdirSync(otherProj);
    store.createProject(otherProj);
    const a = store.createChat(proj, "A", "m1");
    const c = store.createChat(otherProj, "C", "m1");
    expect(store.findChatById(a.id)?.title).toBe("A");
    expect(store.findChatById(c.id)?.title).toBe("C");
  });

  it("returns undefined for an unknown chat id without throwing", () => {
    expect(store.findChatById("does-not-exist")).toBeUndefined();
  });

  it("returns the same Chat shape as listChats (round-trip equality)", () => {
    const created = store.createChat(proj, "Round", "m1", { branchLabel: "feature" });
    const listed = store.listChats(proj).find((c) => c.id === created.id);
    const found = store.findChatById(created.id);
    expect(found).toEqual(listed);
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

  it("round-trips an external scope root through SELECT (#532)", () => {
    const c = store.createChat(proj, "t", "m");
    const externalRoot = "/Users/someone/Documents/quarterly-reports";
    const updated = store.updateChat(c.id, {
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 99,
        root: externalRoot,
      },
    });
    expect(updated.connectedScope?.root).toBe(externalRoot);
    const fetched = store.listChats(proj).find((x) => x.id === c.id);
    // The root must survive the JSON column encode/decode — a connected folder outside the chat's
    // project is otherwise silently lost and the grounded path falls back to the wrong root.
    expect(fetched?.connectedScope?.root).toBe(externalRoot);
  });

  it("leaves connectedScope.root undefined when not provided (#532)", () => {
    const c = store.createChat(proj, "t", "m");
    const updated = store.updateChat(c.id, {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
    });
    expect(updated.connectedScope?.root).toBeUndefined();
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

// Epic #532 — multi-source connectedScopes list round-trip through SQLite. A chat may bind N
// connected folders/files at once; the list is encoded as a JSON ARRAY in connected_scope_paths.
describe("updateChat — connectedScopes list round-trip (#532)", () => {
  it("sets two sources with distinct roots and round-trips both (list + back-compat single)", () => {
    const c = store.createChat(proj, "t", "m");
    const scopes = [
      {
        kind: "directory" as const,
        relativePaths: ["docs"],
        connectedAtMs: 10,
        root: "/srv/alpha",
      },
      {
        kind: "files" as const,
        relativePaths: ["a.md", "b.md"],
        connectedAtMs: 11,
        root: "/srv/beta",
      },
    ];
    const updated = store.updateChat(c.id, { connectedScopes: scopes });
    expect(updated.connectedScopes).toEqual(scopes);
    // Back-compat readers see the first source on the single field.
    expect(updated.connectedScope).toEqual(scopes[0]);
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScopes).toEqual(scopes);
    expect(fetched?.connectedScopes?.[0]?.root).toBe("/srv/alpha");
    expect(fetched?.connectedScopes?.[1]?.root).toBe("/srv/beta");
    expect(fetched?.connectedScope).toEqual(scopes[0]);
  });

  it("decodes a legacy single-object row as a 1-element connectedScopes list", () => {
    const c = store.createChat(proj, "t", "m");
    // Write via the single-field path (legacy encoding = one object, not an array).
    store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/a"], connectedAtMs: 5 },
    });
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScopes).toEqual([
      { kind: "files", relativePaths: ["src/a"], connectedAtMs: 5 },
    ]);
    expect(fetched?.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/a"],
      connectedAtMs: 5,
    });
  });

  it("clears the list when patched with connectedScopes: null", () => {
    const c = store.createChat(proj, "t", "m");
    store.updateChat(c.id, {
      connectedScopes: [{ kind: "files", relativePaths: ["src/a"], connectedAtMs: 1 }],
    });
    const cleared = store.updateChat(c.id, { connectedScopes: null });
    expect(cleared.connectedScopes ?? []).toHaveLength(0);
    expect(cleared.connectedScope).toBeUndefined();
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScopes ?? []).toHaveLength(0);
    expect(fetched?.connectedScope).toBeUndefined();
  });

  it("treats a single-element connectedScopes list identically to the legacy single field", () => {
    const c = store.createChat(proj, "t", "m");
    const one = { kind: "files" as const, relativePaths: ["src/x"], connectedAtMs: 3 };
    const viaList = store.updateChat(c.id, { connectedScopes: [one] });
    expect(viaList.connectedScope).toEqual(one);
    expect(viaList.connectedScopes).toEqual([one]);
  });

  it("rejects a list exceeding MAX_CONNECTED_SOURCES (17 entries)", () => {
    const c = store.createChat(proj, "t", "m");
    const tooMany = Array.from({ length: 17 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    expect(() => store.updateChat(c.id, { connectedScopes: tooMany })).toThrow(UiStoreError);
  });

  it("rejects a list whose entry has an invalid (absolute) relative path", () => {
    const c = store.createChat(proj, "t", "m");
    expect(() =>
      store.updateChat(c.id, {
        connectedScopes: [{ kind: "files", relativePaths: ["/etc/passwd"], connectedAtMs: 1 }],
      }),
    ).toThrow(UiStoreError);
  });

  it("accepts the maximum allowed list size (16 entries)", () => {
    const c = store.createChat(proj, "t", "m");
    const max = Array.from({ length: 16 }, (_unused, i) => ({
      kind: "files" as const,
      relativePaths: [`src/f${String(i)}`],
      connectedAtMs: 1,
    }));
    const updated = store.updateChat(c.id, { connectedScopes: max });
    expect(updated.connectedScopes).toHaveLength(16);
  });

  it("prefers connectedScopes over connectedScope when both are present in a patch", () => {
    const c = store.createChat(proj, "t", "m");
    const updated = store.updateChat(c.id, {
      connectedScope: { kind: "files", relativePaths: ["src/single"], connectedAtMs: 1 },
      connectedScopes: [{ kind: "files", relativePaths: ["src/list"], connectedAtMs: 2 }],
    });
    expect(updated.connectedScopes).toEqual([
      { kind: "files", relativePaths: ["src/list"], connectedAtMs: 2 },
    ]);
    expect(updated.connectedScope).toEqual({
      kind: "files",
      relativePaths: ["src/list"],
      connectedAtMs: 2,
    });
  });

  it("drops a scope whose persisted root is not absolute (L2 read-side tamper defense, #532)", () => {
    const c = store.createChat(proj, "t", "m");
    // The BFF validates root absoluteness on write; the store write layer does not. A directly
    // tampered DB row (or a caller that bypassed the BFF) could carry a relative root. The
    // read/decode layer must treat a non-absolute root as tampering and collapse the whole scope to
    // undefined rather than ground against an attacker-chosen relative location.
    const written = store.updateChat(c.id, {
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 9,
        root: "relative/evil",
      },
    });
    expect(written.connectedScope).toBeUndefined();
    expect(written.connectedScopes ?? []).toHaveLength(0);
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScope).toBeUndefined();
  });

  it("round-trips a scope whose persisted root IS absolute (L2 allows the valid shape, #532)", () => {
    const c = store.createChat(proj, "t", "m");
    const written = store.updateChat(c.id, {
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 9,
        root: "/srv/data/reports",
      },
    });
    expect(written.connectedScope?.root).toBe("/srv/data/reports");
    const fetched = store.findChatById(c.id);
    expect(fetched?.connectedScope?.root).toBe("/srv/data/reports");
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
