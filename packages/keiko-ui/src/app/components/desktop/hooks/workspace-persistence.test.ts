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
  it("drops transient windows and preserves PDF preview as a safe shell only", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "browser-1", type: "browser", cfg: { url: "https://example.test" } }),
      win({
        id: "pdf-preview-1",
        type: "pdfCitationPreview",
        cfg: {
          documentLabel: "Policy wording.pdf",
          currentPage: 7,
          pageNumber: 7,
          anchorQuality: "page-only",
          zoomMode: "manual",
          zoomValue: 1.44,
          rotation: 91,
          sessionHandle: "preview-session-must-not-persist",
          sourcePath: "/Users/alice/customer/policy.pdf",
          pdfBytes: "JVBERi0xLjQK",
        },
      }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-123" } }),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(["pdf-preview-1", "review-1"]);
    expect(persisted[0]?.cfg).toEqual({
      documentLabel: "Policy wording.pdf",
      currentPage: 7,
      pageNumber: 7,
      anchorQuality: "page-only",
      zoomMode: "manual",
      zoomValue: 1.4,
      rotation: 90,
    });
    expect(JSON.stringify(persisted)).not.toContain("preview-session-must-not-persist");
    expect(JSON.stringify(persisted)).not.toContain("/Users/alice");
    expect(JSON.stringify(persisted)).not.toContain("JVBERi0xLjQK");
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
      win({
        id: "editor-1",
        type: "editor",
        cfg: {
          file: "packages/keiko-ui/src/index.ts",
          openFiles: ["packages/keiko-ui/src/index.ts", "package.json"],
        },
      }),
      win({ id: "editor-2", type: "editor", cfg: { file: "./.env.example" } }),
      win({ id: "review-1", type: "review", cfg: { runId: "run-2026-06-07-001" } }),
    ]);

    expect(persisted.map((entry) => [entry.id, entry.cfg])).toEqual([
      ["chat-1", { title: "Sprint triage" }],
      ["files-1", { root: "/Users/alice/work/keiko" }],
      [
        "editor-1",
        {
          file: "packages/keiko-ui/src/index.ts",
          openFiles: ["packages/keiko-ui/src/index.ts", "package.json"],
        },
      ],
      ["editor-2", { file: "./.env.example" }],
      ["review-1", { runId: "run-2026-06-07-001" }],
    ]);
  });

  it("preserves sanitized editor split layout state in the browser-local snapshot", () => {
    const layoutJson = JSON.stringify({
      version: 1,
      panes: [
        { id: "pane-1", file: "src/app.ts", openFiles: ["src/app.ts", "package.json"] },
        { id: "pane-2", file: "README.md", openFiles: ["README.md", "./.env"] },
      ],
      activePaneId: "pane-2",
      direction: "column",
      splitRatio: 82,
      sidebarWidth: 999,
      sidebarCollapsed: true,
    });

    const persisted = sanitizePersistedWindows([
      win({
        id: "editor-1",
        type: "editor",
        cfg: { root: "/repo", file: "README.md", layoutJson },
      }),
    ]);

    const savedLayout = JSON.parse(String(persisted[0]?.cfg.layoutJson));
    expect(savedLayout).toEqual(
      expect.objectContaining({
        activePaneId: "pane-2",
        direction: "column",
        splitRatio: 75,
        sidebarWidth: 440,
        sidebarCollapsed: true,
      }),
    );
    expect(savedLayout.panes).toEqual([
      { id: "pane-1", file: "src/app.ts", openFiles: ["src/app.ts", "package.json"] },
      { id: "pane-2", file: "README.md", openFiles: ["README.md"] },
    ]);
  });

  it("sanitizes editor layout v2 active files through the same secret/path filter as open files", () => {
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: `token=${"t".repeat(20)}`,
      activePaneId: "pane-env",
      tree: {
        type: "split",
        id: "root",
        direction: "row",
        ratio: 50,
        first: { type: "pane", paneId: "pane-env" },
        second: {
          type: "split",
          id: "right",
          direction: "column",
          ratio: 50,
          first: { type: "pane", paneId: "pane-token" },
          second: { type: "pane", paneId: "pane-traversal" },
        },
      },
      panes: {
        "pane-env": {
          id: "pane-env",
          activeFile: ".env",
          openFiles: ["src/app.ts", ".env"],
          tabOrder: [".env", "src/app.ts"],
        },
        "pane-token": {
          id: "pane-token",
          activeFile: `token=${"z".repeat(20)}`,
          openFiles: ["docs/readme.md"],
          tabOrder: [`token=${"z".repeat(20)}`, "docs/readme.md"],
        },
        "pane-traversal": {
          id: "pane-traversal",
          activeFile: "../.ssh",
          openFiles: ["src/safe.ts"],
          tabOrder: ["../.ssh", "src/safe.ts"],
        },
      },
    });

    const persisted = sanitizePersistedWindows([
      win({
        id: "editor-1",
        type: "editor",
        cfg: { root: "/repo", file: "src/app.ts", layoutJson },
      }),
    ]);

    const savedLayout = JSON.parse(String(persisted[0]?.cfg.layoutJson));
    expect(savedLayout.root).toBe("");
    expect(savedLayout.panes["pane-env"]).toEqual(
      expect.objectContaining({ activeFile: "src/app.ts", openFiles: ["src/app.ts"] }),
    );
    expect(savedLayout.panes["pane-token"]).toEqual(
      expect.objectContaining({ activeFile: "docs/readme.md", openFiles: ["docs/readme.md"] }),
    );
    expect(savedLayout.panes["pane-traversal"]).toEqual(
      expect.objectContaining({ activeFile: "src/safe.ts", openFiles: ["src/safe.ts"] }),
    );
    expect(JSON.stringify(savedLayout)).not.toContain(".env");
    expect(JSON.stringify(savedLayout)).not.toContain("token=");
    expect(JSON.stringify(savedLayout)).not.toContain("../.ssh");
  });

  it("migrates legacy scoped Figma windows to repeatable Figma View cards", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "figma-1",
        type: "figma",
        cfg: {
          snapshotRunId: "fs-abc-123",
          selectedScreenIdsJson: JSON.stringify(["3:1466"]),
          selectedScreenName: "Bedarfsermittlung",
          irJson: '{"must":"not persist"}',
          imageBytes: "iVBORw0KGgo=",
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe("figmaView");
    expect(persisted[0]?.cfg).toEqual({
      snapshotRunId: "fs-abc-123",
      selectedScreenIdsJson: JSON.stringify(["3:1466"]),
      selectedScreenName: "Bedarfsermittlung",
    });
    expect(JSON.stringify(persisted)).not.toContain("must");
    expect(JSON.stringify(persisted)).not.toContain("iVBORw0KGgo");
  });

  it("normalizes persisted Figma Snapshot managers to a singleton", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "figma-old", type: "figma", z: 1, cfg: { snapshotRunId: "fs-old" } }),
      win({ id: "figma-current", type: "figma", z: 5, cfg: { snapshotRunId: "fs-current" } }),
      win({ id: "chat-1", type: "chat", cfg: { title: "Design review" } }),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(["figma-current", "chat-1"]);
    expect(persisted[0]?.cfg).toEqual({ snapshotRunId: "fs-current" });
  });

  it("normalizes every persisted singleton window by registry ownership", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "quality-old", type: "quality", z: 2, cfg: { stale: "old" } }),
      win({ id: "quality-current", type: "quality", z: 6, cfg: { fresh: "current" } }),
      win({ id: "chat-a", type: "chat", z: 1, cfg: { title: "A" } }),
      win({ id: "chat-b", type: "chat", z: 3, cfg: { title: "B" } }),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(["quality-current", "chat-b"]);
    expect(persisted.find((entry) => entry.type === "chat")?.cfg).toEqual({ title: "B" });
  });

  it("preserves standalone Figma JSON references without persisting raw JSON payloads", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "figma-json-1",
        type: "figmaJson",
        cfg: {
          snapshotRunId: "fs-abc-123",
          screenId: "3:1466",
          selectedScreenIdsJson: JSON.stringify(["3:1466"]),
          selectedScreenName: "Bedarfsermittlung",
          irJson: '{"must":"not persist"}',
          rawJson: '{"must":"not persist"}',
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({
      snapshotRunId: "fs-abc-123",
      screenId: "3:1466",
      selectedScreenIdsJson: JSON.stringify(["3:1466"]),
      selectedScreenName: "Bedarfsermittlung",
    });
    expect(JSON.stringify(persisted)).not.toContain("must");
  });

  it("preserves standalone Figma image references without persisting raw image data or external URLs", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "figma-image-1",
        type: "figmaImage",
        cfg: {
          snapshotRunId: "fs-abc-123",
          screenId: "3:1466",
          selectedScreenName: "Bedarfsermittlung",
          imageSrc: "/api/figma/snapshots/fs-abc-123/screens/0/image",
          rawPngBase64: "iVBORw0KGgo=",
          externalImage: "https://example.invalid/screen.png",
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({
      snapshotRunId: "fs-abc-123",
      screenId: "3:1466",
      selectedScreenName: "Bedarfsermittlung",
      imageSrc: "/api/figma/snapshots/fs-abc-123/screens/0/image",
    });
    expect(JSON.stringify(persisted)).not.toContain("iVBORw0KGgo");
    expect(JSON.stringify(persisted)).not.toContain("example.invalid");
  });

  it("drops unsafe Figma image preview routes before browser-local persistence", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "figma-image-1",
        type: "figmaImage",
        cfg: {
          snapshotRunId: "fs-abc-123",
          screenId: "3:1466",
          selectedScreenName: "Bedarfsermittlung",
          imageSrc: "https://example.invalid/screen.png",
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({
      snapshotRunId: "fs-abc-123",
      screenId: "3:1466",
      selectedScreenName: "Bedarfsermittlung",
    });
  });

  it("drops malformed scoped Figma references before browser-local persistence", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "figma-1",
        type: "figma",
        cfg: {
          snapshotRunId: "fs-abc-123",
          selectedScreenIdsJson: JSON.stringify(["screen 1"]),
          selectedScreenName: `token=${"t".repeat(20)}`,
        },
      }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.cfg).toEqual({ snapshotRunId: "fs-abc-123" });
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
      win({
        id: "editor-1",
        type: "editor",
        cfg: { file: "./.env", openFiles: ["./.env", "src/app.ts"] },
      }),
      win({ id: "review-1", type: "review", cfg: { runId: gitHubToken } }),
      win({ id: "review-2", type: "review", cfg: { runId: slackToken, rawEvidence: openAiKey } }),
    ]);

    expect(persisted.map((entry) => [entry.id, entry.cfg])).toEqual([
      ["chat-1", { title: "[REDACTED]" }],
      ["files-1", {}],
      ["editor-1", { openFiles: ["src/app.ts"] }],
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

  it("clamps persisted window content zoom on restore", () => {
    const raw = JSON.stringify([
      win({ id: "files-low", type: "files", zoom: 0.01 }),
      win({ id: "files-high", type: "files", zoom: 99 }),
    ]);

    expect((parsePersistedWindows(raw) ?? []).map((entry) => [entry.id, entry.zoom])).toEqual([
      ["files-low", 0.5],
      ["files-high", 2],
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

  it("omits raw path bind snapshots from browser-local connection persistence", () => {
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
    expect(sanitizePersistedConnections(conns, wins)).toEqual([
      { id: "c-1", a: "files-1", b: "chat-1", boundScopeElided: true },
      {
        id: "c-2",
        a: "files-1",
        b: "chat-1",
        boundConnectorKind: "capsule",
        boundConnectorId: "cap-a",
      },
    ]);
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

  it("clamps hostile geometry magnitudes instead of trusting persisted numbers", () => {
    // Finite but absurd values passed the old Number.isFinite-only checks and
    // reached layout math; a z beyond safe-integer precision even froze focus
    // ordering (zc.current + 1 === zc.current at 1e18).
    const persisted = sanitizePersistedWindows([
      win({ id: "files-1", type: "files", x: -1e300, y: 5e15, w: 1e15, h: -400, z: 1e18 }),
    ]);
    expect(persisted).toHaveLength(1);
    const clamped = persisted[0]!;
    expect(clamped.x).toBe(-1_000_000);
    expect(clamped.y).toBe(1_000_000);
    expect(clamped.w).toBe(32_768);
    expect(clamped.h).toBe(1);
    expect(clamped.z).toBe(1_000_000_000);
  });

  it("clamps restored prev geometry with the same bounds", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "files-1", type: "files", prev: { x: 9e9, y: -9e9, w: 0, h: 1e9 } }),
    ]);
    expect(persisted[0]?.prev).toEqual({ x: 1_000_000, y: -1_000_000, w: 1, h: 32_768 });
  });

  it("bounds window and connection counts to the server snapshot caps", () => {
    // Mirrors the server's MAX_WORKSPACE_WINDOWS/MAX_WORKSPACE_CONNECTIONS: the
    // localStorage parse path otherwise accepted unbounded arrays the server
    // would reject, leaving local state permanently divergent.
    const many = Array.from({ length: 150 }, (_, i) =>
      win({ id: `files-${String(i)}`, type: "files" }),
    );
    const persisted = sanitizePersistedWindows(many);
    expect(persisted).toHaveLength(128);

    const endpoints = [win({ id: "files-1", type: "files" }), win({ id: "chat-1", type: "chat" })];
    const conns: Connection[] = Array.from({ length: 600 }, (_, i) => ({
      id: `c-${String(i)}`,
      a: "files-1",
      b: "chat-1",
    }));
    expect(sanitizePersistedConnections(conns, endpoints)).toHaveLength(512);
  });

  it("rejects over-length generic text cfg values (reject, not truncate)", () => {
    const longPath = `src/${"a".repeat(3000)}.ts`;
    const okPath = "src/components/app.ts";
    const persisted = sanitizePersistedWindows([
      win({ id: "files-1", type: "files", cfg: { activeFilePath: longPath, root: okPath } }),
    ]);
    expect(persisted[0]?.cfg).toEqual({ root: okPath });
  });

  it("fails closed on absurdly deep editor split trees", () => {
    const pane = { id: "p1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] };
    const deepLayout = (depth: number): string => {
      let node: unknown = { type: "pane", paneId: "p1" };
      for (let i = 0; i < depth; i += 1) {
        node = {
          type: "split",
          id: `s${String(i)}`,
          direction: "row",
          ratio: 50,
          first: node,
          second: { type: "pane", paneId: "p1" },
        };
      }
      return JSON.stringify({
        schemaVersion: 2,
        activePaneId: "p1",
        tree: node,
        panes: { p1: pane },
      });
    };

    const shallow = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { layoutJson: deepLayout(8) } }),
    ]);
    expect(shallow[0]?.cfg["layoutJson"]).toBeDefined();

    const hostile = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { layoutJson: deepLayout(64) } }),
    ]);
    expect(hostile[0]?.cfg["layoutJson"]).toBeUndefined();
  });
});
