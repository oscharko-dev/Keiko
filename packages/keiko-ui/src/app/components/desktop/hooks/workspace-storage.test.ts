import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_STORAGE_CHANGED_EVENT,
  announceWorkspaceStorageChanged,
  isWorkspaceStorageChanged,
  workspaceStorageKey,
} from "./workspace-storage";

const SCOPE = "a".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace storage change", () => {
  it("recognises only the server's own store-change answer", async () => {
    const changed = new Response(
      JSON.stringify({ error: { code: "WORKSPACE_STORAGE_CHANGED", message: "x" } }),
      { status: 409 },
    );
    expect(await isWorkspaceStorageChanged(changed)).toBe(true);
  });

  it.each([
    [
      "a 409 from something else",
      new Response(JSON.stringify({ error: { code: "CONFLICT" } }), { status: 409 }),
    ],
    ["a 409 without a JSON body", new Response("<html>proxy</html>", { status: 409 })],
    ["a 409 with an empty body", new Response("", { status: 409 })],
    ["a 409 with a malformed error", new Response(JSON.stringify({ error: "x" }), { status: 409 })],
    [
      "another status carrying the code",
      new Response(JSON.stringify({ error: { code: "WORKSPACE_STORAGE_CHANGED" } }), {
        status: 412,
      }),
    ],
  ])("does not treat %s as a store change", async (_label, response) => {
    expect(await isWorkspaceStorageChanged(response)).toBe(false);
  });

  it("announces the store the refused request named", () => {
    const seen: unknown[] = [];
    const listener = (event: Event): void => {
      seen.push(event instanceof CustomEvent ? event.detail : "plain");
    };
    window.addEventListener(WORKSPACE_STORAGE_CHANGED_EVENT, listener);
    try {
      announceWorkspaceStorageChanged(SCOPE);
      announceWorkspaceStorageChanged(undefined);
    } finally {
      window.removeEventListener(WORKSPACE_STORAGE_CHANGED_EVENT, listener);
    }
    expect(seen).toEqual([SCOPE]);
  });

  it("keys saved layouts by their store", () => {
    expect(workspaceStorageKey("keiko.workspace.v4", SCOPE)).toBe(`keiko.workspace.v4:${SCOPE}`);
    expect(workspaceStorageKey("keiko.workspace.v4", undefined)).toBe("keiko.workspace.v4");
  });
});
