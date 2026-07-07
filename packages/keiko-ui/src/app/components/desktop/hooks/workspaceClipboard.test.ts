import { describe, expect, it } from "vitest";
import type { AppWindow } from "../windows/types";
import {
  buildWorkspaceClipboardPayload,
  duplicateWorkspaceClipboardWindows,
} from "./workspaceClipboard";

const viewport = { x: 0, y: 0, w: 800, h: 600 };

function win(type: AppWindow["type"], cfg: AppWindow["cfg"] = {}, id = `${type}-1`): AppWindow {
  return { id, type, x: 40, y: 50, w: 200, h: 140, z: 1, cfg, max: false, zoom: 1 };
}

describe("workspace clipboard duplication (Issue #2059)", () => {
  it("copies selected eligible window descriptors and strips unsafe config fields", () => {
    const payload = buildWorkspaceClipboardPayload(
      [
        win("files", {
          resolvedRoot: "/repo",
          apiToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        }),
        { ...win("chat", { title: "Hidden" }, "chat-1"), minimized: true },
      ],
      ["files-1", "chat-1"],
    );

    expect(payload).not.toBeNull();
    const duplicated = duplicateWorkspaceClipboardWindows({
      wins: [],
      payload: payload ?? "",
      viewport,
      zStart: 10,
      nowMs: 1_000,
      pasteOffsetPx: 32,
    });

    expect(duplicated?.pastedWindowIds).toHaveLength(1);
    expect(duplicated?.wins[0]).toMatchObject({
      id: expect.stringMatching(/^files-copy-/u),
      type: "files",
      x: 72,
      y: 82,
      cfg: { resolvedRoot: "/repo" },
    });
    expect(duplicated?.wins[0]?.cfg["apiToken"]).toBeUndefined();
  });

  it("pastes duplicated windows with fresh ids, offset geometry, and raised z-order", () => {
    const source = [
      { ...win("files", { resolvedRoot: "/repo" }, "files-1"), x: 40, y: 50, z: 2 },
      { ...win("editor", { root: "/repo", file: "README.md" }, "editor-1"), x: 280, y: 90, z: 3 },
    ];
    const payload = buildWorkspaceClipboardPayload(source, ["files-1", "editor-1"]);
    const duplicated = duplicateWorkspaceClipboardWindows({
      wins: source,
      payload: payload ?? "",
      viewport,
      zStart: 20,
      nowMs: 2_000,
      pasteOffsetPx: 32,
    });

    expect(duplicated).not.toBeNull();
    expect(duplicated?.wins).toHaveLength(4);
    expect(duplicated?.pastedWindowIds).toHaveLength(2);
    expect(duplicated?.pastedWindowIds).not.toContain("files-1");
    expect(duplicated?.wins[2]).toMatchObject({ type: "files", x: 72, y: 82, z: 21 });
    expect(duplicated?.wins[3]).toMatchObject({ type: "editor", x: 312, y: 122, z: 22 });
    expect(duplicated?.nextZ).toBe(22);
  });

  it("returns no payload for empty, stale, minimized, or maximized selections", () => {
    const wins = [
      { ...win("files", {}, "files-1"), minimized: true },
      { ...win("editor", {}, "editor-1"), max: true },
    ];

    expect(buildWorkspaceClipboardPayload(wins, [])).toBeNull();
    expect(buildWorkspaceClipboardPayload(wins, ["missing"])).toBeNull();
    expect(buildWorkspaceClipboardPayload(wins, ["files-1", "editor-1"])).toBeNull();
  });

  it("fails closed for malformed, foreign, or secret-bearing payloads", () => {
    const secretPayload = JSON.stringify({
      kind: "keiko.workspace.windows",
      version: 1,
      windows: [
        {
          type: "files",
          x: 0,
          y: 0,
          w: 200,
          h: 140,
          cfg: { apiToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        },
      ],
    });

    expect(
      duplicateWorkspaceClipboardWindows({
        wins: [],
        payload: "not-json",
        viewport,
        zStart: 0,
        nowMs: 1,
        pasteOffsetPx: 32,
      }),
    ).toBeNull();
    expect(
      duplicateWorkspaceClipboardWindows({
        wins: [],
        payload: JSON.stringify({ kind: "foreign", version: 1, windows: [] }),
        viewport,
        zStart: 0,
        nowMs: 1,
        pasteOffsetPx: 32,
      }),
    ).toBeNull();
    expect(
      duplicateWorkspaceClipboardWindows({
        wins: [],
        payload: secretPayload,
        viewport,
        zStart: 0,
        nowMs: 1,
        pasteOffsetPx: 32,
      }),
    ).toBeNull();
  });

  it("keeps pasted window title bars inside the workspace recovery bounds", () => {
    const source = [{ ...win("files", {}, "files-1"), x: 760, y: 580, w: 200, h: 140 }];
    const payload = buildWorkspaceClipboardPayload(source, ["files-1"]);
    const duplicated = duplicateWorkspaceClipboardWindows({
      wins: source,
      payload: payload ?? "",
      viewport,
      zStart: 5,
      nowMs: 3_000,
      pasteOffsetPx: 128,
    });

    expect(duplicated?.wins[1]).toMatchObject({ x: 680, y: 562 });
  });
});
