import { describe, expect, it } from "vitest";
import { shouldRenderConnectionBadge, type ResolvedConn } from "./ConnectionsLayer";
import type { AppWindow } from "./types";

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
