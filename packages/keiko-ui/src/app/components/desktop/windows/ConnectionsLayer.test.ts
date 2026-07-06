import { describe, expect, it } from "vitest";
import {
  resolveConnections,
  resolveConnectionsCached,
  shouldRenderConnectionBadge,
  type ResolvedConn,
} from "./ConnectionsLayer";
import type { AppWindow, Connection } from "./types";

function appWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 0,
    y: 0,
    w: 320,
    h: 260,
    z: 1,
    cfg: {},
    max: false,
    ...patch,
  };
}

function resolvedConn(patch: Partial<ResolvedConn> = {}): ResolvedConn {
  return {
    c: { id: "conn-1", a: "files-1", b: "chat-1" },
    d: "M0,0 C0,0 0,0 0,0",
    mid: { x: 250, y: 120 },
    label: "uses docs/",
    dataChannel: true,
    ...patch,
  };
}

describe("shouldRenderConnectionBadge", () => {
  it("hides the relationship hint when it would overlap either connected window", () => {
    const files = appWindow({ id: "files-1", type: "files", x: 0, y: 0, w: 220, h: 240 });
    const chat = appWindow({ id: "chat-1", type: "chat", x: 280, y: 0, w: 220, h: 240 });

    expect(shouldRenderConnectionBadge(resolvedConn(), [files, chat])).toBe(false);
  });

  it("keeps the relationship hint visible when the connected windows leave enough gap", () => {
    const files = appWindow({ id: "files-1", type: "files", x: 0, y: 0, w: 180, h: 240 });
    const chat = appWindow({ id: "chat-1", type: "chat", x: 430, y: 0, w: 180, h: 240 });

    expect(
      shouldRenderConnectionBadge(resolvedConn({ mid: { x: 305, y: 120 } }), [files, chat]),
    ).toBe(true);
  });
});

describe("resolveConnectionsCached (GEN-PERF-WORKSPACE-006)", () => {
  const conn = (id: string, a: string, b: string): Connection => ({ id, a, b });

  it("preserves ResolvedConn identity for edges whose endpoints did not change", () => {
    const cache: Parameters<typeof resolveConnectionsCached>[0] = new Map();
    const files = appWindow({ id: "files-1", type: "files" });
    const chat = appWindow({ id: "chat-1", type: "chat", x: 500 });
    const agents = appWindow({ id: "agents-1", type: "agents", y: 500 });
    const conns = [conn("c-1", "files-1", "chat-1"), conn("c-2", "agents-1", "chat-1")];

    const first = resolveConnectionsCached(cache, [files, chat, agents], conns);
    // A drag frame: only files-1 gets a new object (same values elsewhere).
    const movedFiles = { ...files, x: 40, y: 12 };
    const second = resolveConnectionsCached(cache, [movedFiles, chat, agents], conns);

    expect(second[0]).not.toBe(first[0]); // touched edge re-resolved
    expect(second[1]).toBe(first[1]); // untouched edge keeps identity
    expect(second[0]?.d).not.toBe(first[0]?.d);
  });

  it("re-resolves when the Connection object itself changes", () => {
    const cache: Parameters<typeof resolveConnectionsCached>[0] = new Map();
    const files = appWindow({ id: "files-1", type: "files" });
    const chat = appWindow({ id: "chat-1", type: "chat", x: 500 });
    const c1 = conn("c-1", "files-1", "chat-1");

    const first = resolveConnectionsCached(cache, [files, chat], [c1]);
    const second = resolveConnectionsCached(cache, [files, chat], [{ ...c1 }]);
    expect(second[0]).not.toBe(first[0]);
  });

  it("matches the uncached resolve and sweeps removed connections", () => {
    const cache: Parameters<typeof resolveConnectionsCached>[0] = new Map();
    const files = appWindow({ id: "files-1", type: "files" });
    const chat = appWindow({ id: "chat-1", type: "chat", x: 500 });
    const agents = appWindow({ id: "agents-1", type: "agents", y: 500 });
    const wins = [files, chat, agents];
    const conns = [
      conn("c-1", "files-1", "chat-1"),
      conn("c-2", "agents-1", "chat-1"),
      conn("c-orphan", "gone-1", "chat-1"),
    ];

    expect(resolveConnectionsCached(cache, wins, conns)).toEqual(resolveConnections(wins, conns));
    expect(cache.size).toBe(2); // orphan never cached

    const pruned = [conn("c-2", "agents-1", "chat-1")];
    resolveConnectionsCached(cache, wins, pruned);
    expect(cache.size).toBe(1); // c-1 swept once its connection is gone
  });
});
