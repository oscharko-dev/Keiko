import { describe, expect, it } from "vitest";
import type { AppWindow, Connection } from "../windows/types";
import {
  parsePersistedConnections,
  parsePersistedWindows,
  sanitizePersistedConnections,
  sanitizePersistedWindows,
} from "./workspace-persistence";

function win(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 10,
    y: 20,
    w: 320,
    h: 240,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

describe("workspace-persistence", () => {
  it("does not persist transient window types into the durable local snapshot", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "browser-1", type: "browser", cfg: { url: "https://example.test" } }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(["review-1"]);
  });

  it("persists evidence-reference windows as declared references only", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "review-1",
        type: "review",
        cfg: {
          runId: "run-123",
          rawEvidence: "{\"secret\":\"must-not-persist\"}",
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({ runId: "run-123" });
  });

  it("drops server-owned durable.config payloads from the browser-local snapshot", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "settings",
        type: "settings",
        cfg: {
          wallpaper: "aurora",
          apiKey: "must-not-persist-here",
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({});
  });

  it("rejects malformed or unsupported persisted window records on restore", () => {
    const raw = JSON.stringify([
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
      { id: "browser-1", type: "browser", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
      { id: "bad-1", type: "not-a-window-type", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
      { id: "bad-2", type: "review", x: "oops", y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
    ]);

    expect(parsePersistedWindows(raw)).toEqual([
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
    ]);
  });

  it("drops stale persisted connections whose endpoints were removed by boundary enforcement", () => {
    const wins = sanitizePersistedWindows([
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
      win({ id: "browser-1", type: "browser", cfg: { url: "https://example.test" } }),
    ]);
    const conns: Connection[] = [
      { id: "c-1", a: "review-1", b: "browser-1" },
      { id: "c-2", a: "review-1", b: "review-1" },
    ];

    expect(sanitizePersistedConnections(conns, wins)).toEqual([{ id: "c-2", a: "review-1", b: "review-1" }]);
  });

  it("restores only connections that still point at supported persisted windows", () => {
    const wins = [
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
      win({ id: "files-1", type: "files", cfg: { root: "/repo" } }),
    ];
    const raw = JSON.stringify([
      { id: "c-1", a: "review-1", b: "files-1" },
      { id: "c-2", a: "review-1", b: "missing-1" },
      { id: "c-3", a: "files-1", b: 42 },
    ]);

    expect(parsePersistedConnections(raw, wins)).toEqual([{ id: "c-1", a: "review-1", b: "files-1" }]);
  });
});
