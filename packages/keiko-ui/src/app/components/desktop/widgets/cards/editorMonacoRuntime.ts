"use client";

/**
 * Browser-only Keiko Editor Monaco runtime bootstrap for the keiko-ui host (Issue #1196).
 *
 * Runs the no-CDN loader + worker-environment recipe from the `@oscharko-dev/keiko-editor` README
 * exactly once per browser session, before the first editor mounts. This is the ONLY keiko-ui module
 * that value-imports `monaco-editor` and `@monaco-editor/react`'s loader, so it is reached solely
 * from the dynamically-imported, client-only {@link import("./EditorSurface.js")} (next/dynamic
 * `ssr: false`) — never during the Next static-export prerender, where importing `monaco-editor`
 * (which imports `.css`) would crash the build.
 *
 * The Keiko Monaco theme is intentionally NOT registered here: `KeikoCodeEditor` registers it itself
 * on mount from the live DOM design tokens and reports a non-fatal failure through `onRuntimeError`
 * (see the editor package's `on-mount.ts`). This module only installs the worker strategy and points
 * the loader at the locally installed Monaco — the no-CDN invariant (ADR-0042 D3).
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  configureMonacoLoader,
  createMonacoEnvironment,
  defaultMonacoWorkerFactories,
  detectEditorRuntimeSupport,
  installMonacoEnvironment,
  probeEditorRuntime,
  type EditorRuntimeStatus,
  type MonacoGlobalScope,
} from "@oscharko-dev/keiko-editor";

let runtimeConfigured = false;

const GOVERNED_LANGUAGE_SERVICE_MODE = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
} satisfies monaco.typescript.ModeConfiguration;

function disableBuiltInLanguageServices(monacoNamespace: typeof monaco): void {
  monacoNamespace.typescript.typescriptDefaults.setModeConfiguration(
    GOVERNED_LANGUAGE_SERVICE_MODE,
  );
  monacoNamespace.typescript.javascriptDefaults.setModeConfiguration(
    GOVERNED_LANGUAGE_SERVICE_MODE,
  );
}

/**
 * Ensure the local, no-CDN Monaco runtime is installed and report whether the browser can run it.
 *
 * Idempotent: the worker environment and the loader are configured at most once per session. When
 * Web Workers or the `URL` API are unavailable the runtime is left unconfigured and an unsupported
 * status is returned, so the caller renders the editor's controlled load-error state instead of
 * attempting a mount that would fail. There is deliberately no CDN fallback.
 */
export function ensureMonacoRuntime(): EditorRuntimeStatus {
  const status = detectEditorRuntimeSupport(probeEditorRuntime(self));
  if (!status.supported) {
    return status;
  }
  if (!runtimeConfigured) {
    // `self` is the browser global scope; narrow it to the worker-host shape the editor expects
    // (exactOptionalPropertyTypes makes the DOM `MonacoEnvironment?` slot incompatible otherwise).
    installMonacoEnvironment(
      self as unknown as MonacoGlobalScope,
      createMonacoEnvironment(defaultMonacoWorkerFactories),
    );
    configureMonacoLoader(loader, monaco);
    disableBuiltInLanguageServices(monaco);
    runtimeConfigured = true;
  }
  return status;
}
