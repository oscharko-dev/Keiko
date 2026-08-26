import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../../index.js";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { ServerLogEvent } from "../../observability/index.js";
import type { UiStore } from "../../store/index.js";
import {
  captureEditorLocalHistorySafely,
  reKeyEditorLocalHistorySafely,
  resolveEditorLocalHistoryRoot,
} from "./localHistoryCapture.js";
import {
  createEditorLocalHistoryStore,
  type EditorLocalHistoryStore,
} from "./localHistoryStore.js";

const VAULT_KEY = Buffer.alloc(32, 0x71).toString("base64");
let root: string;
let stateDir: string;
let store: UiStore;
let history: EditorLocalHistoryStore;

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

beforeEach(() => {
  root = tempDir("keiko-history-capture-root-");
  stateDir = tempDir("keiko-history-capture-state-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "checkpoint marker\n", "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
  history = createEditorLocalHistoryStore({
    stateDir,
    env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: VAULT_KEY },
  });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function deps(diagnostics: ServerDiagnosticRecord[]): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor({}),
    editorLocalHistoryStore: history,
    diagnostics: {
      record: (record: ServerDiagnosticRecord): void => {
        diagnostics.push(record);
      },
    },
  } as unknown as UiHandlerDeps;
}

function depsWithActivityLog(
  diagnostics: ServerDiagnosticRecord[],
  activity: ServerLogEvent[],
): UiHandlerDeps {
  return {
    ...deps(diagnostics),
    activityLog: {
      write: (event: ServerLogEvent): void => {
        activity.push(event);
      },
    },
  } as unknown as UiHandlerDeps;
}

describe("captureEditorLocalHistorySafely", () => {
  it("reports protected for ordinary content and captures it", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const result = captureEditorLocalHistorySafely({
      deps: deps(diagnostics),
      realRoot: root,
      relativePath: "src/app.ts",
      absolutePath: join(root, "src", "app.ts"),
      content: "checkpoint marker\n",
      origin: "user-save",
      nowMs: 1_000,
    });

    expect(result).toEqual({ status: "protected" });
    expect(diagnostics).toHaveLength(0);
    const identity = resolveEditorLocalHistoryRoot(deps(diagnostics), root);
    expect(history.list(identity, "src/app.ts", 1_001)).toHaveLength(1);
  });

  it("reports a suppressed status for secret-shaped content without vaulting it or leaving a phantom entry", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const secretValue = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const secretContent = `AWS_SECRET_ACCESS_KEY=${secretValue}\n`;

    const result = captureEditorLocalHistorySafely({
      deps: deps(diagnostics),
      realRoot: root,
      relativePath: "src/app.ts",
      absolutePath: join(root, "src", "app.ts"),
      content: secretContent,
      origin: "user-save",
      nowMs: 2_000,
    });

    expect(result).toMatchObject({ status: "suppressed", reason: "secret-detected" });
    expect(typeof (result as { correlationId?: unknown }).correlationId).toBe("string");

    // No phantom entry: the suppressed capture never reached the store's index or vault.
    const identity = resolveEditorLocalHistoryRoot(deps(diagnostics), root);
    expect(history.list(identity, "src/app.ts", 2_001)).toEqual([]);

    // The diagnostic is content-free: it carries a correlation id and a redacted code, never the
    // secret value or the file content.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      operation: "user-save",
      source: "editor.local-history.capture",
      code: "LOCAL_HISTORY_SECRET_CONTENT_SUPPRESSED",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secretValue);
    expect(JSON.stringify(diagnostics)).not.toContain(secretContent);
  });

  // ADR-0173 D5 / g12: a capture failure that happens inside a request must carry THAT request's
  // own correlation id, not a disconnected `local-history-<uuid>` mint, so an operator can join it
  // back to the rest of the request's trail. Before the fix, `correlationId` threading did not
  // exist on this function at all, so this assertion fails against the pre-fix signature (the
  // extra field was silently ignored and a fresh `local-history-` id was always minted instead).
  it("threads the caller's own correlation id into a capture failure instead of minting one", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const secretValue = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const secretContent = `AWS_SECRET_ACCESS_KEY=${secretValue}\n`;
    const requestCorrelationId = "req-abc12345";

    const result = captureEditorLocalHistorySafely({
      deps: deps(diagnostics),
      realRoot: root,
      relativePath: "src/app.ts",
      absolutePath: join(root, "src", "app.ts"),
      content: secretContent,
      origin: "user-save",
      nowMs: 3_000,
      correlationId: requestCorrelationId,
    });

    expect(result).toMatchObject({
      status: "suppressed",
      correlationId: requestCorrelationId,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.correlationId).toBe(requestCorrelationId);
  });
});

// #2906 review (comment 3863185711): the rename-driven reKey wrapper used to discard the store's
// rewritten-entry count entirely (never logged anywhere) and, on failure, emit its diagnostic under
// the real checkpoint-capture origin "user-save" -- indistinguishable from an ordinary user-save
// capture failure. Both fixed: every call now emits one body-free activity-log line (op,
// correlationId, outcome, rewrittenCount) and a failure additionally emits its diagnostic under a
// dedicated "editor.local-history.rekey" origin, never "user-save".
describe("reKeyEditorLocalHistorySafely", () => {
  it("emits a completed activity-log line carrying the correlation id, outcome, and rewritten count", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const activity: ServerLogEvent[] = [];
    captureEditorLocalHistorySafely({
      deps: deps(diagnostics),
      realRoot: root,
      relativePath: "src/app.ts",
      absolutePath: join(root, "src", "app.ts"),
      content: "checkpoint marker\n",
      origin: "user-save",
      nowMs: 1_000,
    });
    writeFileSync(join(root, "src", "renamed.ts"), "checkpoint marker\n", "utf8");

    const rewrittenCount = reKeyEditorLocalHistorySafely({
      deps: depsWithActivityLog(diagnostics, activity),
      realRoot: root,
      previousRelativePath: "src/app.ts",
      nextRelativePath: "src/renamed.ts",
      correlationId: "req-rekey-ok",
    });

    expect(rewrittenCount).toBe(1);
    expect(diagnostics).toHaveLength(0);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      category: "diagnostic",
      op: "editor.local-history.rekey.completed",
      correlationId: "req-rekey-ok",
      extra: { outcome: "succeeded", rewrittenCount: 1 },
    });
  });

  it("emits a failed activity-log line and a dedicated diagnostic origin, never the 'user-save' capture origin", () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const activity: ServerLogEvent[] = [];
    const unregisteredRoot = join(root, "not-a-registered-project-root");

    const rewrittenCount = reKeyEditorLocalHistorySafely({
      deps: depsWithActivityLog(diagnostics, activity),
      realRoot: unregisteredRoot,
      previousRelativePath: "src/app.ts",
      nextRelativePath: "src/renamed.ts",
      correlationId: "req-rekey-fail",
    });

    expect(rewrittenCount).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      operation: "editor.local-history.rekey",
      correlationId: "req-rekey-fail",
    });
    expect(diagnostics[0]?.operation).not.toBe("user-save");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      category: "diagnostic",
      op: "editor.local-history.rekey.failed",
      correlationId: "req-rekey-fail",
      extra: { outcome: "failed", rewrittenCount: 0 },
    });
    expect(typeof activity[0]?.errorKind).toBe("string");
  });
});
