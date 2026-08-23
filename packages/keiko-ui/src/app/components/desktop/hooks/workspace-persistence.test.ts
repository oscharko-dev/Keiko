import { describe, expect, it } from "vitest";
import type { AppWindow, Connection } from "../windows/types";
import {
  MAX_PERSISTED_CONNECTION_SCAN,
  parsePersistedConnections,
  parsePersistedWindows,
  sanitizePersistedConnections,
  sanitizePersistedWorkspace,
  sanitizePersistedWindows,
} from "./workspace-persistence";
import {
  EDITOR_SIDEBAR_MIN_WIDTH,
  EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
} from "../editorSidebarSizing";
import { subText } from "../windows/connectionUtils";

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

// A hostile persisted window record whose `type` is an own property of Object.prototype
// rather than a real WindowType. Deliberately untyped (`unknown`, not AppWindow) — this is
// exactly the shape localStorage hands back after `JSON.parse`, and it must NOT type-check
// as a real AppWindow so the test exercises the same "trust nothing" boundary production
// code runs through. `cfg` is omitted unless the caller supplies one, matching the two
// distinct hostile shapes F1 (no cfg) and F1b (cfg present) target.
function hostileWindow(type: string, extra: Record<string, unknown> = {}): unknown {
  return { id: `evil-${type}`, type, x: 0, y: 0, w: 100, h: 100, z: 2, max: false, ...extra };
}

describe("workspace-persistence", () => {
  it("retains only the closed Coding Workbench Git binding marker", () => {
    const retained = sanitizePersistedWindows([
      win({
        id: "git-1",
        type: "governedGit",
        cfg: {
          projectPath: "/repo",
          rootBinding: "coding-repository",
          ignoredBinding: "another-root",
        },
      }),
    ]);
    const rejected = sanitizePersistedWindows([
      win({
        id: "git-2",
        type: "governedGit",
        cfg: { projectPath: "/other", rootBinding: "another-root" },
      }),
    ]);

    expect(retained[0]?.cfg).toEqual({
      projectPath: "/repo",
      rootBinding: "coding-repository",
    });
    expect(rejected[0]?.cfg).toEqual({ projectPath: "/other" });
  });

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

  // 0.3.0 release audit — the chat window's "still untitled" state is a structural cfg marker, not
  // a comparison against display copy. A marker that the persistence allowlist drops would be
  // silently reconstructed from the title text on the next reload, which is exactly the
  // locale-dependent behaviour it replaced, so the round trip is pinned here.
  it("persists the structural untitled-chat marker across a reload", () => {
    // Only the front-most chat window survives the snapshot, so each state is sanitized on its own.
    const untitled = sanitizePersistedWindows([
      win({
        id: "chat-untitled",
        type: "chat",
        cfg: { title: "Neuer Chat", titleIsDefault: true },
      }),
    ]);
    const named = sanitizePersistedWindows([
      win({
        id: "chat-named",
        type: "chat",
        cfg: { title: "Sprint triage", titleIsDefault: false },
      }),
    ]);

    expect(untitled[0]?.cfg).toEqual({ title: "Neuer Chat", titleIsDefault: true });
    expect(named[0]?.cfg).toEqual({ title: "Sprint triage", titleIsDefault: false });
    expect(subText("chat", untitled[0]?.cfg)).toBeNull();
    expect(subText("chat", named[0]?.cfg)).toBe("Sprint triage");
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
      sidebarWidth: Number.MAX_SAFE_INTEGER,
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
        sidebarWidth: EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
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

  it("preserves the legal empty final editor pane and its presentation state", () => {
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      tree: { type: "pane", paneId: "pane-1" },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "",
          openFiles: [],
          tabOrder: [],
        },
      },
      sidebarWidth: 372,
      sidebarCollapsed: true,
      outlinePanelVisible: false,
    });

    const persisted = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { root: "/repo", layoutJson } }),
    ]);
    const savedLayout = JSON.parse(String(persisted[0]?.cfg.layoutJson));

    expect(savedLayout).toEqual(
      expect.objectContaining({
        sidebarWidth: 372,
        sidebarCollapsed: true,
        outlinePanelVisible: false,
      }),
    );
    expect(savedLayout.panes["pane-1"]).toEqual({
      id: "pane-1",
      activeFile: "",
      openFiles: [],
      tabOrder: [],
    });
  });

  it("clamps a persisted empty editor pane to the shared narrow sidebar bound", () => {
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      tree: { type: "pane", paneId: "pane-1" },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "",
          openFiles: [],
          tabOrder: [],
        },
      },
      sidebarWidth: -1_000,
    });

    const persisted = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { root: "/repo", layoutJson } }),
    ]);
    const savedLayout = JSON.parse(String(persisted[0]?.cfg.layoutJson));

    expect(savedLayout.sidebarWidth).toBe(EDITOR_SIDEBAR_MIN_WIDTH);
    expect(savedLayout.panes["pane-1"].openFiles).toEqual([]);
  });

  it("rejects a persisted split that tries to retain an empty sibling pane", () => {
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo",
      activePaneId: "pane-1",
      tree: {
        type: "split",
        id: "split-1",
        direction: "row",
        ratio: 50,
        first: { type: "pane", paneId: "pane-1" },
        second: { type: "pane", paneId: "pane-2" },
      },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/app.ts",
          openFiles: ["src/app.ts"],
          tabOrder: ["src/app.ts"],
        },
        "pane-2": {
          id: "pane-2",
          activeFile: "",
          openFiles: [],
          tabOrder: [],
        },
      },
      sidebarWidth: 372,
    });

    const persisted = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { root: "/repo", layoutJson } }),
    ]);

    expect(persisted[0]?.cfg.layoutJson).toBeUndefined();
  });

  it("persists bounded per-root editor layouts through one sanitized scalar cfg field", () => {
    const layoutJson = JSON.stringify({
      schemaVersion: 2,
      root: "/repo-a",
      activePaneId: "pane-1",
      tree: { type: "pane", paneId: "pane-1" },
      panes: {
        "pane-1": {
          id: "pane-1",
          activeFile: "src/app.ts",
          openFiles: ["src/app.ts", "../secret"],
          tabOrder: ["src/app.ts", "../secret"],
        },
      },
      sidebarWidth: 260,
      sidebarCollapsed: false,
    });
    const rootSessionsJson = JSON.stringify({
      schemaVersion: 1,
      sessions: [{ rootRef: "root-a", root: "/repo-a", layoutJson }],
    });

    const persisted = sanitizePersistedWindows([
      win({ id: "editor-1", type: "editor", cfg: { rootSessionsJson } }),
    ]);

    const envelope = JSON.parse(String(persisted[0]?.cfg.rootSessionsJson));
    const savedLayout = JSON.parse(String(envelope.sessions[0].layoutJson));
    expect(savedLayout.panes["pane-1"].openFiles).toEqual(["src/app.ts"]);
    expect(JSON.stringify(envelope)).not.toContain("../secret");
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

  it("normalizes persisted singleton windows while preserving distinct chats", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "quality-old", type: "quality", z: 2, cfg: { stale: "old" } }),
      win({ id: "quality-current", type: "quality", z: 6, cfg: { fresh: "current" } }),
      win({
        id: "chat-a",
        type: "chat",
        z: 1,
        cfg: { chatId: "A", memoryEnabled: false, projectPath: "/repo-a", title: "A" },
      }),
      win({ id: "chat-b", type: "chat", z: 3, cfg: { chatId: "B", title: "B" } }),
    ]);

    expect(persisted.map((entry) => entry.id)).toEqual(["quality-current", "chat-a", "chat-b"]);
    expect(persisted.filter((entry) => entry.type === "chat").map((entry) => entry.cfg)).toEqual([
      { chatId: "A", memoryEnabled: false, projectPath: "/repo-a", title: "A" },
      { chatId: "B", title: "B" },
    ]);
  });

  it("keeps only the frontmost window when persisted physical ids collide", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "duplicate", type: "chat", z: 2, cfg: { chatId: "A", title: "A" } }),
      win({ id: "duplicate", type: "chat", z: 6, cfg: { chatId: "B", title: "B" } }),
      win({ id: "chat-c", type: "chat", z: 4, cfg: { chatId: "C", title: "C" } }),
    ]);

    expect(persisted.map((entry) => [entry.id, entry.cfg["chatId"]])).toEqual([
      ["duplicate", "B"],
      ["chat-c", "C"],
    ]);
  });

  it("never persists a private editor-handoff project path", () => {
    const persisted = sanitizePersistedWindows([
      win({
        id: "chat-private-handoff",
        type: "chat",
        cfg: {
          chatId: "private-chat",
          projectPath: "/Users/customer/private-repository",
          projectPathPrivacy: "omit",
          title: "Private handoff",
        },
      }),
    ]);

    expect(persisted[0]?.cfg).toEqual({
      chatId: "private-chat",
      projectPathPrivacy: "omit",
      title: "Private handoff",
    });
    expect(JSON.stringify(persisted)).not.toContain("/Users/customer/private-repository");
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

  it("rejects opaque-reference and figma-screen-id values containing a supplementary-plane character", () => {
    // "😀" (U+1F600) is 2 UTF-16 code units. isAllowedReferenceChar()/the figma
    // screen-id char check iterate with `for (const char of value)` (one Unicode code
    // point per step) and read it via codePointAt(0); the emoji must still fall
    // outside every allowed ASCII range and be rejected, exactly as the pre-rename
    // charCodeAt(0) comparison did.
    const persisted = sanitizePersistedWindows([
      win({ id: "review-1", type: "review", cfg: { runId: "run-😀-123" } }),
      win({
        id: "figma-json-1",
        type: "figmaJson",
        cfg: { snapshotRunId: "fs-abc-123", screenId: "screen-😀-1" },
      }),
    ]);

    expect(persisted.find((entry) => entry.id === "review-1")?.cfg).toEqual({});
    expect(persisted.find((entry) => entry.id === "figma-json-1")?.cfg).toEqual({
      snapshotRunId: "fs-abc-123",
    });
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

  it("keeps only the frontmost persisted window for each bound chat identity", () => {
    const persisted = sanitizePersistedWindows([
      win({ id: "chat-old", type: "chat", z: 2, cfg: { chatId: "chat-a" } }),
      win({ id: "chat-other", type: "chat", z: 4, cfg: { chatId: "chat-b" } }),
      win({ id: "chat-front", type: "chat", z: 8, cfg: { chatId: "chat-a" } }),
    ]);

    expect(persisted.map((window) => window.id)).toEqual(["chat-other", "chat-front"]);
  });

  it("fills the capacity with unique windows after duplicate persisted identities", () => {
    const duplicates = Array.from({ length: 128 }, (_, index) =>
      win({
        id: `chat-copy-${String(index)}`,
        type: "chat",
        z: index + 1,
        cfg: { chatId: "chat-shared" },
      }),
    );
    const unique = Array.from({ length: 127 }, (_, index) =>
      win({ id: `files-${String(index)}`, type: "files", z: 200 + index }),
    );

    const persisted = sanitizePersistedWindows([...duplicates, ...unique]);

    expect(persisted).toHaveLength(128);
    expect(persisted.map((window) => window.id)).toContain("chat-copy-127");
    expect(persisted.map((window) => window.id)).toContain("files-126");
  });

  it("remaps and deduplicates edges when duplicate restored chats collapse", () => {
    const snapshot = sanitizePersistedWorkspace(
      [
        win({ id: "files-1", type: "files" }),
        win({ id: "chat-old", type: "chat", z: 2, cfg: { chatId: "chat-shared" } }),
        win({ id: "chat-front", type: "chat", z: 8, cfg: { chatId: "chat-shared" } }),
      ],
      [
        {
          id: "connection-old",
          a: "files-1",
          b: "chat-old",
          boundChatWindowId: "chat-old",
        },
        {
          id: "connection-front",
          a: "files-1",
          b: "chat-front",
          boundChatWindowId: "chat-front",
        },
      ],
    );

    expect(snapshot.wins.map((window) => window.id)).toEqual(["files-1", "chat-front"]);
    expect(snapshot.conns).toEqual([
      {
        id: "connection-old",
        a: "files-1",
        b: "chat-front",
        boundChatWindowId: "chat-front",
      },
    ]);
  });

  it("preserves distinct connection records when no endpoint was remapped", () => {
    const snapshot = sanitizePersistedWorkspace(
      [win({ id: "files-1", type: "files" }), win({ id: "chat-1", type: "chat" })],
      [
        { id: "scope-edge", a: "files-1", b: "chat-1", boundScopeElided: true },
        {
          id: "connector-edge",
          a: "chat-1",
          b: "files-1",
          boundConnectorKind: "capsule",
          boundConnectorId: "capsule-1",
        },
      ],
    );

    expect(snapshot.conns.map((connection) => connection.id)).toEqual([
      "scope-edge",
      "connector-edge",
    ]);
  });

  it.each(["scope-first", "connector-first"] as const)(
    "preserves distinct remapped semantic connections in %s order",
    (order) => {
      const scopeEdge: Connection = {
        id: "scope-edge",
        a: "files-1",
        b: "chat-old",
        boundChatWindowId: "chat-old",
        boundScopeElided: true,
      };
      const connectorEdge: Connection = {
        id: "connector-edge",
        a: "files-1",
        b: "chat-front",
        boundChatWindowId: "chat-front",
        boundConnectorKind: "capsule",
        boundConnectorId: "capsule-1",
      };
      const connections =
        order === "scope-first" ? [scopeEdge, connectorEdge] : [connectorEdge, scopeEdge];
      const snapshot = sanitizePersistedWorkspace(
        [
          win({ id: "files-1", type: "files" }),
          win({ id: "chat-old", type: "chat", z: 1, cfg: { chatId: "shared-chat" } }),
          win({ id: "chat-front", type: "chat", z: 2, cfg: { chatId: "shared-chat" } }),
        ],
        connections,
      );

      expect(snapshot.conns.map((connection) => connection.id)).toEqual(
        connections.map((connection) => connection.id),
      );
      expect(snapshot.conns.every((connection) => connection.b === "chat-front")).toBe(true);
    },
  );

  it("bounds hostile duplicate window scans before later entries reach hydration", () => {
    const duplicates = Array.from({ length: 4_096 }, (_, index) =>
      win({
        id: `duplicate-${String(index)}`,
        type: "chat",
        z: index + 1,
        cfg: { chatId: "same-chat" },
      }),
    );
    const persisted = sanitizePersistedWindows([
      ...duplicates,
      win({ id: "beyond-hostile-scan", type: "files" }),
    ]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).not.toBe("beyond-hostile-scan");
  });

  it("keeps only the first valid connection for a duplicate connection id", () => {
    const wins = [win({ id: "files-1", type: "files" }), win({ id: "chat-1", type: "chat" })];
    expect(
      sanitizePersistedConnections(
        [
          { id: "duplicate-id", a: "files-1", b: "chat-1" },
          { id: "duplicate-id", a: "chat-1", b: "files-1" },
        ],
        wins,
      ),
    ).toEqual([{ id: "duplicate-id", a: "files-1", b: "chat-1" }]);
  });

  it("discards non-object persisted connection records without throwing", () => {
    const wins = [win({ id: "files-1", type: "files" }), win({ id: "chat-1", type: "chat" })];

    expect(sanitizePersistedConnections([null], wins)).toEqual([]);
  });

  it("bounds hostile invalid connection scans and reports the limit", () => {
    const wins = [win({ id: "files-1", type: "files" }), win({ id: "chat-1", type: "chat" })];
    let limitReports = 0;

    expect(
      sanitizePersistedConnections(
        Array.from({ length: MAX_PERSISTED_CONNECTION_SCAN + 1 }, () => null),
        wins,
        (): void => {
          limitReports += 1;
        },
      ),
    ).toEqual([]);
    expect(limitReports).toBe(1);
  });

  it("prevents rejected duplicate IDs from marking an endpoint pair as collapsed", () => {
    const snapshot = sanitizePersistedWorkspace(
      [
        win({ id: "files-1", type: "files" }),
        win({ id: "chat-old", type: "chat", z: 1, cfg: { chatId: "shared-chat" } }),
        win({ id: "chat-front", type: "chat", z: 2, cfg: { chatId: "shared-chat" } }),
      ],
      [
        { id: "kept-id", a: "files-1", b: "chat-front" },
        { id: "kept-id", a: "files-1", b: "chat-old" },
        { id: "distinct-id", a: "files-1", b: "chat-front" },
      ],
    );

    expect(snapshot.conns.map((connection) => connection.id)).toEqual(["kept-id", "distinct-id"]);
  });

  it("flattens progressive duplicate-window aliases onto the final survivor", () => {
    const snapshot = sanitizePersistedWorkspace(
      [
        win({ id: "files-1", type: "files" }),
        win({ id: "chat-back", type: "chat", z: 1, cfg: { chatId: "shared-chat" } }),
        win({ id: "chat-middle", type: "chat", z: 2, cfg: { chatId: "shared-chat" } }),
        win({ id: "chat-front", type: "chat", z: 3, cfg: { chatId: "shared-chat" } }),
      ],
      [{ id: "edge", a: "files-1", b: "chat-back", boundChatWindowId: "chat-back" }],
    );

    expect(snapshot.conns).toEqual([
      {
        id: "edge",
        a: "files-1",
        b: "chat-front",
        boundChatWindowId: "chat-front",
      },
    ]);
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

  // F1/F1b — hasWindowType used `value in WIN_TYPES` rather than Object.hasOwn. The `in`
  // operator also matches inherited Object.prototype properties, so a persisted window
  // record whose type is "toString", "constructor", or "__proto__" was treated as a real,
  // known WindowType.
  describe("rejects hostile persisted window types that collide with Object.prototype", () => {
    const HOSTILE_TYPES = ["toString", "constructor", "__proto__"] as const;

    it.each(HOSTILE_TYPES)(
      "does not admit a corrupted window whose type is the inherited property %s",
      (hostileType) => {
        // No `cfg` at all: sanitizeCfgForPersistence short-circuits on a non-record cfg,
        // so this hostile record survives sanitizeWindow (pre-fix) with type still set to
        // the Object.prototype member — a corrupted window that later explodes wherever
        // WIN_TYPES[type]/WIN_META[type] is dereferenced during render (WindowFrame's
        // selectBody runs OUTSIDE WindowBodyBoundary's coverage), white-screening the
        // entire desktop rather than just the one window.
        const raw = [win({ id: "good-1", type: "chat" }), hostileWindow(hostileType)];
        const persisted = sanitizePersistedWindows(raw as unknown as AppWindow[]);
        expect(persisted.map((entry) => entry.id)).toEqual(["good-1"]);
      },
    );

    it.each(HOSTILE_TYPES)(
      "does not throw when the hostile record of type %s also carries a cfg object (F1b)",
      (hostileType) => {
        // With `cfg` present, pre-fix sanitizeCfgForPersistence spreads
        // `INTERNAL_CFG_KEYS[type]`/`WIN_TYPES[type].config` — both inherited,
        // non-nullish, non-iterable Object.prototype members for these type strings — into
        // an array literal, which throws synchronously. That throw escapes the
        // `sanitizePersistedWindows` loop uncaught.
        const raw = [
          win({ id: "good-1", type: "chat", cfg: { title: "Sprint triage" } }),
          hostileWindow(hostileType, { cfg: {} }),
        ];
        expect(() => sanitizePersistedWindows(raw as unknown as AppWindow[])).not.toThrow();
      },
    );

    it.each(HOSTILE_TYPES)(
      "preserves the rest of a persisted snapshot instead of losing it whole (F1b, type %s)",
      (hostileType) => {
        // parsePersistedWindows wraps sanitizePersistedWindows in a try/catch, so pre-fix
        // the uncaught throw above is swallowed there and the WHOLE snapshot is silently
        // discarded (parsePersistedWindows returns null) — a data-loss failure mode with no
        // crash and no message, taking every OTHER valid window down with the hostile one.
        const raw = JSON.stringify([
          win({ id: "good-1", type: "chat", cfg: { title: "Sprint triage" } }),
          hostileWindow(hostileType, { cfg: {} }),
        ]);
        const parsed = parsePersistedWindows(raw);
        expect(parsed).not.toBeNull();
        expect(parsed?.map((entry) => entry.id)).toEqual(["good-1"]);
      },
    );
  });
});
