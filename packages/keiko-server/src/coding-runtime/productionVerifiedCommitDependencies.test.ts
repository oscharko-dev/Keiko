import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditorAgentSessionSnapshot, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { createNodeEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { editorAgentRegistry } from "../editor/agentSessionRegistry.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { CodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import {
  createProductionVerifiedCommitDependencies,
  verifiedCommitBuffersClean,
  type VerifiedCommitCompositionDeps,
} from "./productionVerifiedCommitDependencies.js";

function workspaceInfo(workspaceRoot: string): WorkspaceInfo {
  return {
    root: workspaceRoot,
    selectedRoot: workspaceRoot,
    name: "fixture",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const noopSnapshots: Pick<
  CodingRuntimeSnapshotStore,
  "get" | "recordVerifiedCommit" | "getLastSuccessfulVerifiedCommit"
> = {
  get: () => undefined,
  recordVerifiedCommit: () => {
    throw new Error("not exercised by this test");
  },
  getLastSuccessfulVerifiedCommit: () => undefined,
};

let root: string;
let scratch: string;
let deps: VerifiedCommitCompositionDeps;
let events: ServerLogEvent[];

function dirtySnapshot(workspaceRoot: string): EditorAgentSessionSnapshot {
  return {
    schemaVersion: "1",
    sessionId: "session-buffer",
    windowId: "window-buffer",
    workspaceRoot,
    activePaneId: "pane-buffer",
    panes: [{ paneId: "pane-buffer", openFiles: ["code.ts"], activeFile: "code.ts" }],
    dirtyFiles: ["code.ts"],
    activeFile: "code.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "keiko-commit-buffers-")));
  root = join(scratch, "repo");
  mkdirSync(root);
  const store = createInMemoryUiStore();
  store.createProject(root, "fixture");
  events = [];
  deps = {
    env: {},
    store,
    evidenceStore: createNodeEvidenceStore(join(root, "evidence")),
    redactor: (value): unknown => value,
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
  editorAgentRegistry.reset();
});

afterEach(() => {
  editorAgentRegistry.reset();
  rmSync(scratch, { recursive: true, force: true });
});

describe("production verified commit dependencies", () => {
  it("cannot enable durable commits without the real snapshot store", () => {
    expect(createProductionVerifiedCommitDependencies(deps, undefined)).toBeUndefined();
  });

  it("refuses unsaved editor state even after the browser bridge disconnected", () => {
    editorAgentRegistry.registerSnapshot(dirtySnapshot(root));
    expect(editorAgentRegistry.hasLiveBridge("session-buffer")).toBe(false);
    expect(verifiedCommitBuffersClean(deps, root, "run-1")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      op: "git.delivery.buffers.checked",
      correlationId: "run-1",
      level: "warn",
      extra: { state: "blocked", editorSessionCount: 1, dirtySessionCount: 1 },
    });
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain("code.ts");
  });

  it("admits clean buffers and proven unrelated dirty roots, then notices a newly dirty target", () => {
    expect(verifiedCommitBuffersClean(deps, root, "run-2")).toBe(true);
    const other = join(scratch, "other");
    mkdirSync(other);
    deps.store.createProject(other, "other");
    editorAgentRegistry.registerSnapshot(dirtySnapshot(other));
    expect(verifiedCommitBuffersClean(deps, root, "run-2")).toBe(true);
    editorAgentRegistry.registerSnapshot({ ...dirtySnapshot(root), sessionId: "session-target" });
    expect(verifiedCommitBuffersClean(deps, root, "run-2")).toBe(false);
  });

  it("carries closed message-policy violation codes through the real production composition (#3390)", async () => {
    const composed = createProductionVerifiedCommitDependencies(deps, noopSnapshots);
    expect(composed).toBeDefined();
    const result = await composed?.messageAllowed(
      "not a conventional commit message",
      workspaceInfo(root),
    );
    expect(result).toStrictEqual({
      ok: false,
      violations: ["missing-conventional-prefix"],
    });
  });

  it("still resolves ok:true through the real production composition for a compliant message", async () => {
    const composed = createProductionVerifiedCommitDependencies(deps, noopSnapshots);
    const result = await composed?.messageAllowed("feat: add widget (#1)", workspaceInfo(root));
    expect(result).toStrictEqual({ ok: true });
  });

  it("refuses dirty buffers in a nested workspace because it overlaps the target tree", () => {
    const nested = join(root, "nested");
    mkdirSync(nested);
    deps.store.createProject(nested, "nested");
    editorAgentRegistry.registerSnapshot(dirtySnapshot(nested));
    expect(verifiedCommitBuffersClean(deps, root, "run-nested")).toBe(false);
  });

  it("does not treat aliases or unproven dirty roots as unrelated", () => {
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    editorAgentRegistry.registerSnapshot(dirtySnapshot(alias));
    expect(verifiedCommitBuffersClean(deps, root, "run-3")).toBe(false);
    editorAgentRegistry.registerSnapshot({
      ...dirtySnapshot(join(root, "missing")),
      sessionId: "session-missing",
    });
    expect(verifiedCommitBuffersClean(deps, root, "run-3")).toBe(false);
  });
});
