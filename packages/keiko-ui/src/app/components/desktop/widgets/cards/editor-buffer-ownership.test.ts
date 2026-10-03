import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import type { EditorAgentSessionSnapshot } from "@/lib/types";
import {
  claimEditorBufferOwnership,
  persistEditorBufferOwnership,
  type EditorBufferOwnership,
} from "./editor-buffer-ownership";

const leases: EditorBufferOwnership[] = [];
const snapshot: EditorAgentSessionSnapshot = {
  schemaVersion: "1",
  sessionId: "buffer:window:root",
  windowId: "window",
  workspaceRoot: "/repo",
  activePaneId: "main",
  panes: [],
  dirtyFiles: ["a.ts"],
  activeFile: null,
  cursor: null,
  selection: null,
  diagnosticsSummary: null,
  textMode: "none",
  updatedAt: 1,
};
async function claim(): Promise<EditorBufferOwnership> {
  const owner = await claimEditorBufferOwnership(snapshot);
  leases.push(owner);
  return owner;
}
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
});

describe("durable passive buffer ownership", () => {
  it("isolates duplicate live tabs and reclaims a closed publisher without clearing its dirty paths", async () => {
    const first = await claim();
    persistEditorBufferOwnership(first, ["a.ts"]);
    const duplicate = await claim();
    expect(duplicate.sessionId).not.toBe(first.sessionId);
    expect(duplicate.capability).not.toBe(first.capability);
    persistEditorBufferOwnership(duplicate, ["b.ts"]);
    first.release();
    await waitFor(async () =>
      expect(
        (await navigator.locks.query()).held?.some((lock) => lock.name?.endsWith(first.key)),
      ).toBe(false),
    );
    const reopened = await claim();
    expect(reopened.sessionId).toBe(first.sessionId);
    expect(reopened.capability).toBe(first.capability);
    expect(reopened.dirtyFiles).toEqual(["a.ts"]);
    persistEditorBufferOwnership(reopened, []);
    expect(JSON.parse(window.localStorage.getItem(duplicate.key) ?? "null")).toEqual({
      sessionId: duplicate.sessionId,
      capability: duplicate.capability,
      dirtyFiles: ["b.ts"],
      updatedAt: 0,
    });
  });
  it.each([
    { capability: "invalid", dirtyFiles: ["a.ts"] },
    { capability: "a".repeat(43), dirtyFiles: ["../outside.ts"] },
    { capability: "a".repeat(43), dirtyFiles: [17] },
    { capability: "a".repeat(43), dirtyFiles: ["a.ts"], updatedAt: null },
  ])("refuses malformed durable ownership rather than replacing its guard", async (record) => {
    const key = "keiko.editor.buffer-safety.v1:" + snapshot.sessionId;
    window.localStorage.setItem(key, JSON.stringify(record));
    await expect(claim()).rejects.toThrow("Invalid buffer ownership");
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(record));
  });
});
