import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../../index.js";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import type { UiHandlerDeps } from "../../deps.js";
import type { UiStore } from "../../store/index.js";
import {
  captureEditorLocalHistorySafely,
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
});
