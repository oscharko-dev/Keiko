import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as editor from "./index.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");

interface EditorManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

interface RootManifest {
  readonly overrides?: Record<string, string>;
}

function readManifest(): EditorManifest {
  return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as EditorManifest;
}

function readRootManifest(): RootManifest {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as RootManifest;
}

describe("@oscharko-dev/keiko-editor public API", () => {
  it("re-exports the package identity and language helpers", () => {
    expect(editor.KEIKO_EDITOR_PACKAGE).toBe("@oscharko-dev/keiko-editor");
    expect(typeof editor.isSupportedEditorLanguage).toBe("function");
    expect([...editor.SUPPORTED_EDITOR_LANGUAGES]).toEqual([
      "typescript",
      "javascript",
      "plaintext",
    ]);
  });

  it("exposes exactly the intended runtime export surface (#1191 + #1192 + #1193 + #1194 + #1195 + #1199 + #1200 + #1201)", () => {
    const expected = [
      // Package identity, language + workspace contract, geometry, file model, completion,
      // commands (#1191 + #1192).
      "EDITOR_COMMANDS",
      "KEIKO_EDITOR_PACKAGE",
      "SUPPORTED_EDITOR_LANGUAGES",
      "availableCommands",
      "comparePositions",
      "completionRequestSupersedes",
      "createFileModel",
      "editorFileModelReducer",
      "isCommandAvailable",
      "isDocumentDirty",
      "isEmptyRange",
      "isResponseCurrent",
      "isSupportedEditorLanguage",
      "mapPositionAfterEdit",
      "mapRangeAfterEdit",
      "rangeContainsPosition",
      "shouldDiscardResponse",
      // Monaco runtime: language inference, theme, workers, loader/capability (#1193).
      "MONACO_LANGUAGE_IDS",
      "inferMonacoLanguageId",
      "isMonacoLanguageId",
      "EDITOR_THEME_NAME",
      "EDITOR_THEME_VARIANTS",
      "buildKeikoEditorMonacoTheme",
      "registerKeikoEditorTheme",
      "createDomEditorTokenResolverDeps",
      "resolveEditorThemeTokens",
      "resolveEditorThemeTokensFromDom",
      "createMonacoEnvironment",
      "installMonacoEnvironment",
      "defaultMonacoWorkerFactories",
      "configureMonacoLoader",
      "describeEditorRuntimeError",
      "detectEditorRuntimeSupport",
      "editorRuntimeLoadFailure",
      "isMonacoLoaderConfigured",
      "probeEditorRuntime",
      // KeikoCodeEditor React component (#1194).
      "KeikoCodeEditor",
      // Save-lifecycle helpers a host uses to drive `saveStatus` (#1194).
      "saveStatusReducer",
      "detectSaveConflict",
      // Patch-preview adapter + KeikoDiffEditor React component (#1195).
      "buildPatchPreview",
      "DEFAULT_PATCH_PREVIEW_LIMITS",
      "KeikoDiffEditor",
      // Monaco completion-provider bridge (#1199).
      "createKeikoCompletionProvider",
      "registerKeikoCompletionProvider",
      "createEditorRequestId",
      "monacoTriggerToEditor",
      "monacoPositionToEditor",
      "editorKindToMonaco",
      "editorRangeToMonaco",
      "editorItemToMonacoSuggestion",
      "responseToCompletionList",
      "wordRangeAt",
      "DEFAULT_COMPLETION_TRIGGER_CHARACTERS",
      "DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES",
      "COMPLETION_ELIGIBLE_LANGUAGES",
      // Monaco inline-completion (ghost-text) bridge + content-free telemetry (#1200).
      "createKeikoInlineCompletionProvider",
      "registerKeikoInlineCompletionProvider",
      "monacoInlineTriggerToEditor",
      "editorInlineItemToMonaco",
      "responseToInlineCompletions",
      "endOfLifeReasonToEvent",
      "INLINE_COMPLETION_ELIGIBLE_LANGUAGES",
      "DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS",
      "DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES",
      "createInlineCompletionTelemetry",
      "inlineCompletionTelemetryReducer",
      "EMPTY_INLINE_COMPLETION_TELEMETRY",
      // Monaco diagnostics / hover / symbols / formatting bridges (#1201).
      "registerKeikoDiagnostics",
      "severityToMarker",
      "editorDiagnosticToMarker",
      "diagnosticsToMarkers",
      "defaultDiagnosticsScheduler",
      "DIAGNOSTICS_ELIGIBLE_LANGUAGES",
      "DEFAULT_DIAGNOSTICS_DEBOUNCE_MS",
      "DEFAULT_DIAGNOSTICS_OWNER",
      "createKeikoHoverProvider",
      "registerKeikoHoverProvider",
      "hoverResponseToMonaco",
      "toInertCodeFence",
      "HOVER_ELIGIBLE_LANGUAGES",
      "createKeikoDocumentSymbolProvider",
      "registerKeikoDocumentSymbolProvider",
      "editorSymbolKindToMonaco",
      "editorSymbolToMonaco",
      "symbolsToMonaco",
      "SYMBOLS_ELIGIBLE_LANGUAGES",
      "createKeikoFormattingProvider",
      "registerKeikoFormattingProvider",
      "editorTextEditToMonaco",
      "editsToMonaco",
      "monacoFormattingOptionsToEditor",
      "FORMATTING_ELIGIBLE_LANGUAGES",
      // Governed test-generation flow controllers (#1202).
      "buildTestGenerationContext",
      "buildTestGenerationRequest",
      "testGenerationMode",
      "IDLE_TEST_GENERATION_STATE",
      "describeTestGenerationStatus",
      "isTestGenerationBusy",
      "isTestGenerationPreviewing",
      "testGenerationReducer",
      "buildTestGenerationPreview",
      "TEST_GENERATION_REVIEW_ACTIONS",
      // VS Code-feeling UX: command actions + status bar (#1205).
      "MONACO_BUILTIN_ACTION_IDS",
      "EDITOR_COMMAND_KEYBINDINGS",
      "EDITOR_GENERATE_TESTS_ACTION_ID",
      "EDITOR_GENERATE_TESTS_ACTION_LABEL",
      "buildGenerateTestsKeybinding",
      "buildGenerateTestsActionDescriptor",
      "deriveEditorStatusBar",
      "editorLanguageLabel",
      "EditorStatusBar",
    ];
    expect(Object.keys(editor).sort()).toEqual([...expected].sort());
  });
});

describe("@oscharko-dev/keiko-editor dependency boundary (Issue #1191 acceptance criteria)", () => {
  it("does not depend on @oscharko-dev/keiko-ui in any dependency field", () => {
    const manifest = readManifest();
    for (const field of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
    ]) {
      expect(Object.keys(field ?? {})).not.toContain("@oscharko-dev/keiko-ui");
    }
  });

  it("treats React as a peer dependency, never a bundled runtime dependency", () => {
    const manifest = readManifest();
    for (const packageName of ["react", "react-dom"]) {
      expect(manifest.peerDependencies?.[packageName]).toBe("^18.3.1");
      expect(manifest.dependencies?.[packageName]).toBeUndefined();
      expect(manifest.devDependencies?.[packageName]).toBeUndefined();
    }
  });

  it("pins Monaco dependencies and the transitive loader override", () => {
    const manifest = readManifest();
    const rootManifest = readRootManifest();

    expect(manifest.dependencies?.["monaco-editor"]).toBe("0.55.1");
    expect(manifest.dependencies?.["@monaco-editor/react"]).toBe("4.7.0");
    expect(rootManifest.overrides?.["@monaco-editor/loader"]).toBe("1.7.0");
  });

  it("limits workspace dependencies to keiko-contracts (browser-tier allowlist, ADR-0042)", () => {
    const manifest = readManifest();
    const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@oscharko-dev/keiko-"),
    );
    expect(workspaceDeps).toEqual(["@oscharko-dev/keiko-contracts"]);
  });
});
