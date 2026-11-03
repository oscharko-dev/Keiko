import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, createNodeUiStore } from "./index.js";
import type { UiStore } from "./types.js";

const stores: UiStore[] = [];
const directories: string[] = [];
function fixture(): { store: UiStore; first: string; second: string } {
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(process.cwd());
  return {
    store,
    first: store.createChat(project.path, "First", "model").id,
    second: store.createChat(project.path, "Second", "model").id,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("private chat drafts", () => {
  it("preserves a draft across reopening the private store without putting it in chat lists", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-draft-"));
    directories.push(directory);
    const path = join(directory, "ui.sqlite");
    const initial = createNodeUiStore(path);
    const project = initial.createProject(process.cwd());
    const chat = initial.createChat(project.path, "Draft", "model");
    initial.updateChatDraft(chat.id, { text: "Synthetic unsent thought", expectedRevision: 0 });
    initial.close();
    const reopened = createNodeUiStore(path);
    stores.push(reopened);
    expect(reopened.readChatDraft(chat.id)).toEqual({
      text: "Synthetic unsent thought",
      revision: 1,
    });
    expect(JSON.stringify(reopened.listChats(project.path))).not.toContain(
      "Synthetic unsent thought",
    );
  });

  it("isolates chats, rejects stale writes and keeps a clear tombstone", () => {
    const { store, first, second } = fixture();
    expect(store.readChatDraft(first)).toEqual({ text: "", revision: 0 });
    store.updateChatDraft(first, { text: "Only first", expectedRevision: 0 });
    expect(store.readChatDraft(second)).toEqual({ text: "", revision: 0 });
    expect(() => store.updateChatDraft(first, { text: "Stale", expectedRevision: 0 })).toThrow(
      /stale/u,
    );
    expect(store.updateChatDraft(first, { text: "", expectedRevision: 1 })).toEqual({
      text: "",
      revision: 2,
    });
    expect(() =>
      store.updateChatDraft(first, { text: "Resurrected", expectedRevision: 1 }),
    ).toThrow(/stale/u);
    store.deleteChat(first);
    expect(() => store.readChatDraft(first)).toThrow(/not found/u);
  });

  it("bounds both UTF-8 bytes and code units and validates revisions", () => {
    const { store, first } = fixture();
    expect(
      store.updateChatDraft(first, { text: "a".repeat(256_000), expectedRevision: 0 }).revision,
    ).toBe(1);
    for (const text of ["a".repeat(256_001), "😀".repeat(64_001)]) {
      expect(() => store.updateChatDraft(first, { text, expectedRevision: 1 })).toThrow(/limit/u);
    }
    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => store.updateChatDraft(first, { text: "", expectedRevision })).toThrow(
        /revision/u,
      );
    }
    expect(() => store.updateChatDraft("missing", { text: "", expectedRevision: 0 })).toThrow(
      /not found/u,
    );
  });
});
