// Editor built-in capability registry (Issue #1380, Epic #1491, ADR-0068 D1/D6). This is the single,
// authoritative, frozen const table describing, per known source language, the **browser** built-in
// editor capabilities: whether Monaco tokenises/colours it locally, whether bracket matching applies,
// and — crucially — *how* its "Format Document" command is served in the browser.
//
// It sits BESIDE the source-language mode map (`editor-language-mode-map.ts`, ADR-0067 D1), not inside
// it (ADR-0068 D2): the mode map is the SERVER-SHARED source-language universe; browser formatting
// reachability and Monaco syntax/bracket semantics are an editor-tier concern the server has no
// business consuming. Folding `documentFormatting` into the mode map would invite a future server
// consumer to misread it as *server* formatting capability — the exact "server can format yaml, the
// browser can't" confusion this registry exists to end. The two leaves are kept coherent by test
// (ADR-0068 D6), not by a runtime import coupling.
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus pure functions only. No
// filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages. `plaintext` is deliberately ABSENT (ADR-0067 D5): it is the editor's render fallback for
// unknown/unsupported buffers, never a known source language, and has no built-in formatter.

// How a language's "Format Document" is served in the browser:
//  - "monaco-builtin":         Reserved for a future ADR-approved browser formatter that does not
//                              ship extra Monaco language workers.
//  - "keiko-language-service": the Keiko formatting bridge (#1201) calls the deterministic server
//                              language service; no Monaco TS worker is loaded for ts/js.
//  - "none":                   no in-browser document formatter is reachable for this language. The
//                              server may format some of these, but that is out of this issue's
//                              explicit-browser-command scope (ADR-0068 D9).
export type EditorBuiltinFormattingSource = "monaco-builtin" | "keiko-language-service" | "none";

// One source language's browser built-in capabilities. `languageId` is a canonical
// `EDITOR_LANGUAGE_MODE_IDS` id (coherence pinned by test, ADR-0068 D6). `syntaxHighlighting` and
// `bracketMatching` are `true` for every entry: Monaco tokenises every registered language via its
// bundled grammars, and bracket-pair colourisation / matching is configured globally
// (editor-options.ts), so it applies to every tokenised language.
export interface EditorBuiltinCapability {
  readonly languageId: string;
  readonly syntaxHighlighting: boolean;
  readonly bracketMatching: boolean;
  readonly documentFormatting: EditorBuiltinFormattingSource;
}

// The canonical table, covering exactly the 15 `EDITOR_LANGUAGE_MODE_IDS` languages. The
// `documentFormatting` split: ts/js → the Keiko language-service bridge; every other language →
// "none" (no reachable browser formatter) because ADR-0042 D3.6 keeps rich Monaco language workers
// out of the release artifact. `as const` makes every entry deeply readonly at compile time; each
// entry and the outer array are `Object.freeze`d below so the registry is deeply immutable at runtime
// too — no consumer holding a reference can mutate it.
const RAW_EDITOR_BUILTIN_CAPABILITIES = [
  {
    languageId: "typescript",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "keiko-language-service",
  },
  {
    languageId: "javascript",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "keiko-language-service",
  },
  {
    languageId: "json",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "css",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "scss",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "less",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "html",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "markdown",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "yaml",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "python",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "java",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "go",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "rust",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "sql",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
  {
    languageId: "shell",
    syntaxHighlighting: true,
    bracketMatching: true,
    documentFormatting: "none",
  },
] as const satisfies readonly EditorBuiltinCapability[];

export const EDITOR_BUILTIN_CAPABILITIES: readonly EditorBuiltinCapability[] = Object.freeze(
  RAW_EDITOR_BUILTIN_CAPABILITIES.map((capability) => Object.freeze({ ...capability })),
);

// languageId -> capability, derived from the table. Frozen. Every registry id appears here.
export const EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE: Readonly<
  Record<string, EditorBuiltinCapability>
> = Object.freeze(
  EDITOR_BUILTIN_CAPABILITIES.reduce<Record<string, EditorBuiltinCapability>>(
    (accumulator, capability) => {
      accumulator[capability.languageId] = capability;
      return accumulator;
    },
    {},
  ),
);

// The built-in capability for a language id, or `null` when the id is not a known source language.
export function editorBuiltinCapability(languageId: string): EditorBuiltinCapability | null {
  return EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE[languageId] ?? null;
}

// How a language's "Format Document" is served in the browser. Unknown ids are `"none"`: an
// unsupported buffer has no reachable in-browser formatter, matching the mode map's safe-degrade.
export function editorBuiltinDocumentFormatting(languageId: string): EditorBuiltinFormattingSource {
  return editorBuiltinCapability(languageId)?.documentFormatting ?? "none";
}

// True when *some* in-browser document formatter is reachable for the language (Monaco-builtin or the
// Keiko language-service bridge); false for unknown ids and for the `"none"` set.
export function isBuiltinFormattingAvailable(languageId: string): boolean {
  return editorBuiltinDocumentFormatting(languageId) !== "none";
}
