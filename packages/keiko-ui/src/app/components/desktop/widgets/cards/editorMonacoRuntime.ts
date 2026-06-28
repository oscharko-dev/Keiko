"use client";

/**
 * Browser-only Keiko Editor Monaco runtime bootstrap for the keiko-ui host (Issue #1196).
 *
 * Runs the no-CDN loader + worker-environment recipe from the `@oscharko-dev/keiko-editor` README
 * exactly once per browser session, before the first editor mounts. This is the ONLY keiko-ui module
 * that value-imports Monaco and `@monaco-editor/react`'s loader, so it is reached solely from the
 * dynamically-imported, client-only {@link import("./EditorSurface.js")} (next/dynamic `ssr: false`)
 * — never during the Next static-export prerender, where importing Monaco CSS would crash the build.
 *
 * The Keiko Monaco theme is intentionally NOT registered here: `KeikoCodeEditor` registers it itself
 * on mount from the live DOM design tokens and reports a non-fatal failure through `onRuntimeError`
 * (see the editor package's `on-mount.ts`). This module only installs the worker strategy and points
 * the loader at the locally installed Monaco — the no-CDN invariant (ADR-0042 D3).
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
// Register the language id + Monarch grammar for css/scss/less/html so they tokenize and Monaco's
// bundled `language/{css,html}` workers can attach their document formatter on `onLanguage` (ADR-0068
// D5). The rich-worker contributions below only call `onLanguage(...)`; without these basic-languages
// contributions the language is never registered, so it neither tokenizes nor gets a formatter.
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
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

function registerJsonLanguageId(monacoNamespace: typeof monaco): void {
  if (monacoNamespace.languages.getLanguages().some((language) => language.id === "json")) {
    return;
  }
  monacoNamespace.languages.register({
    id: "json",
    extensions: [".json", ".jsonc"],
    aliases: ["JSON", "json"],
    mimetypes: ["application/json", "application/jsonc"],
  });
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
    registerJsonLanguageId(monaco);
    runtimeConfigured = true;
  }
  return status;
}
