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
          rawEvidence: '{"secret":"must-not-persist"}',
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

  it("preserves allowed non-secret config references in the browser-local snapshot", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "chat-1", type: "chat", cfg: { title: "Sprint triage" } }),
      win({ id: "files-1", type: "files", cfg: { root: "/Users/alice/work/keiko" } }),
      win({ id: "editor-1", type: "editor", cfg: { file: "packages/keiko-ui/src/index.ts" } }),
      win({ id: "editor-2", type: "editor", cfg: { file: "./.env.example" } }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-2026-06-07-001" } }),
    ]);

    expect(persisted.map((entry) => [entry.id, entry.cfg])).toEqual([
      ["chat-1", { title: "Sprint triage" }],
      ["files-1", { root: "/Users/alice/work/keiko" }],
      ["editor-1", { file: "packages/keiko-ui/src/index.ts" }],
      ["editor-2", { file: "./.env.example" }],
      ["review-1", { runId: "run-2026-06-07-001" }],
    ]);
  });

  it("preserves minimized window state in the browser-local snapshot", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "files-1", type: "files", cfg: { root: "/repo" }, minimized: true }),
    ]);

    expect(persisted).toEqual([
      win({ id: "files-1", type: "files", cfg: { root: "/repo" }, minimized: true }),
    ]);
    expect(parsePersistedWindows(JSON.stringify(persisted))).toEqual(persisted);
  });

  it("redacts or drops secret-shaped config values before browser-local persistence", () => {
    const openAiKey = `sk-${"a".repeat(24)}`;
    const gitHubToken = `ghp_${"A".repeat(36)}`;
    const slackToken = `xoxb-${"1".repeat(12)}-${"a".repeat(18)}`;
    const bearerToken = `Bearer ${"z".repeat(16)}`;
    const persisted = sanitizePersistedWindows([
      win({ id: "chat-1", type: "chat", cfg: { title: bearerToken } }),
      win({
        id: "files-1",
        type: "files",
        cfg: { root: "https://user:pass@example.test/repo.git" },
      }),
      win({ id: "editor-1", type: "editor", cfg: { file: "./.env" } }),
      win({ id: "review-1", type: "review", cfg: { runId: gitHubToken } }),
      win({ id: "review-2", type: "review", cfg: { runId: slackToken, rawEvidence: openAiKey } }),
    ]);

    expect(persisted.map((entry) => [entry.id, entry.cfg])).toEqual([
      ["chat-1", { title: "[REDACTED]" }],
      ["files-1", {}],
      ["editor-1", {}],
      ["review-1", {}],
      ["review-2", {}],
    ]);
    expect(JSON.stringify(persisted)).not.toContain(openAiKey);
    expect(JSON.stringify(persisted)).not.toContain(gitHubToken);
    expect(JSON.stringify(persisted)).not.toContain(slackToken);
    expect(JSON.stringify(persisted)).not.toContain(bearerToken);
  });

  it("scrubs secret-shaped config values during browser-local restore", () => {
    const raw = JSON.stringify([
      win({ id: "files-1", type: "files", cfg: { root: `token=${"t".repeat(20)}` } }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
    ]);

    expect(parsePersistedWindows(raw)).toEqual([
      win({ id: "files-1", type: "files", cfg: {} }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
    ]);
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

    expect(sanitizePersistedConnections(conns, wins)).toEqual([
      { id: "c-2", a: "review-1", b: "review-1" },
    ]);
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

    expect(parsePersistedConnections(raw, wins)).toEqual([
      { id: "c-1", a: "review-1", b: "files-1" },
    ]);
  });

  // Release 0.2.0 — bind-time snapshot fields must survive persistence so unbind-after-reload
  // still removes the source the edge actually bound (not whatever the window cfg says then).
  it("carries valid bind-time snapshot fields through sanitization", () => {
    const wins = [
      win({ id: "files-1", type: "files", cfg: { root: "/repo" } }),
      win({ id: "chat-1", type: "chat", cfg: {} }),
    ];
    const conns: Connection[] = [
      { id: "c-1", a: "files-1", b: "chat-1", boundRoot: "/data/docs" },
      {
        id: "c-2",
        a: "files-1",
        b: "chat-1",
        boundConnectorKind: "capsule",
        boundConnectorId: "cap-a",
      },
    ];
    expect(sanitizePersistedConnections(conns, wins)).toEqual(conns);
  });

  it("strips malformed snapshot fields instead of trusting the persisted blob", () => {
    const wins = [
      win({ id: "files-1", type: "files", cfg: { root: "/repo" } }),
      win({ id: "chat-1", type: "chat", cfg: {} }),
    ];
    const raw = JSON.stringify([
      // boundRoot wrong type; connector kind not in the union; connector id empty.
      { id: "c-1", a: "files-1", b: "chat-1", boundRoot: 42 },
      { id: "c-2", a: "files-1", b: "chat-1", boundConnectorKind: "weird", boundConnectorId: "x" },
      { id: "c-3", a: "files-1", b: "chat-1", boundConnectorKind: "capsule", boundConnectorId: "" },
    ]);
    expect(parsePersistedConnections(raw, wins)).toEqual([
      { id: "c-1", a: "files-1", b: "chat-1" },
      { id: "c-2", a: "files-1", b: "chat-1" },
      { id: "c-3", a: "files-1", b: "chat-1" },
    ]);
  });
});
