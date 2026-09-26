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
import * as monaco from "monaco-editor/editor/editor.api.js";
// Register only the standalone editor UX features Keiko exposes in smoke coverage. Avoid
// Monaco's broad feature/language `register.all` entrypoints so rich language services stay out
// of the static export under ADR-0042 D3.6.
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/format/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/inlineCompletions/register.js";
import "monaco-editor/features/quickCommand/register.js";
import "monaco-editor/features/quickHelp/register.js";
import "monaco-editor/features/suggest/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
// Register language ids + Monarch grammars without importing Monaco's rich language-service
// contributions. Those contributions pull TS/JSON/CSS/HTML worker chunks into the static export;
// Keiko's governed language intelligence and formatting stay host/server-owned under ADR-0042 D3.6.
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/less/register.js";
import "monaco-editor/languages/definitions/html/register.js";
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

const optionalLanguageLoaders = {
  go: () => import("monaco-editor/languages/definitions/go/register.js"),
  java: () => import("monaco-editor/languages/definitions/java/register.js"),
  shell: () => import("monaco-editor/languages/definitions/shell/register.js"),
  sql: () => import("monaco-editor/languages/definitions/sql/register.js"),
} as const;

type OptionalMonacoLanguage = keyof typeof optionalLanguageLoaders;

const loadedOptionalLanguages = new Set<OptionalMonacoLanguage>();
const loadingOptionalLanguages = new Map<OptionalMonacoLanguage, Promise<void>>();

function optionalMonacoLanguage(languageId: string): OptionalMonacoLanguage | null {
  return languageId in optionalLanguageLoaders ? (languageId as OptionalMonacoLanguage) : null;
}

export function isMonacoLanguageReady(languageId: string): boolean {
  const optionalLanguage = optionalMonacoLanguage(languageId);
  return optionalLanguage === null || loadedOptionalLanguages.has(optionalLanguage);
}

export function ensureMonacoLanguage(languageId: string): Promise<void> {
  const optionalLanguage = optionalMonacoLanguage(languageId);
  if (optionalLanguage === null || loadedOptionalLanguages.has(optionalLanguage)) {
    return Promise.resolve();
  }
  const inflight = loadingOptionalLanguages.get(optionalLanguage);
  if (inflight !== undefined) {
    return inflight;
  }
  const promise = optionalLanguageLoaders[optionalLanguage]()
    .then(() => {
      loadedOptionalLanguages.add(optionalLanguage);
    })
    .finally(() => {
      loadingOptionalLanguages.delete(optionalLanguage);
    });
  loadingOptionalLanguages.set(optionalLanguage, promise);
  return promise;
}

export function areMonacoLanguagesReady(languageIds: readonly string[]): boolean {
  return languageIds.every(isMonacoLanguageReady);
}

export function ensureMonacoLanguages(languageIds: readonly string[]): Promise<void> {
  return Promise.all(languageIds.map((languageId) => ensureMonacoLanguage(languageId))).then(
    () => undefined,
  );
}

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
