/**
 * Pure file-extension -> Monaco language-id inference for the Keiko Editor (Issue #1193).
 *
 * This is a SEPARATE concern from the workspace source-language contract in
 * `@oscharko-dev/keiko-contracts` (`WorkspaceLanguage`, today `typescript | javascript`). That
 * contract describes which buffers receive governed, server-backed language *intelligence*
 * (deterministic completion/diagnostics, TS/JS-only per ADR-0042 D4, #1198).
 *
 * In contrast, Monaco syntax highlighting / tokenisation is language-agnostic (blueprint §14): the
 * editor can colour many languages locally via Monaco's bundled grammars without any governed
 * intelligence path. This helper maps a file name or path to the Monaco language id used purely for
 * tokenisation/colouring; it has no model, retrieval, or completion authority.
 *
 * Returns {@link MONACO_PLAINTEXT_LANGUAGE_ID} for unknown, extension-less, or empty inputs so a
 * buffer is always renderable. Pure and node-safe: it touches no `window`, `Worker`, or `monaco`
 * runtime and is therefore fully unit-testable.
 *
 * Issue #1379 (ADR-0067 D2): the source-language universe (ids + extension matching) is now derived
 * from the single canonical {@link EDITOR_LANGUAGE_MODE_MAP} in `@oscharko-dev/keiko-contracts`, so
 * the browser and the server agree on "known languages" by construction. The editor-only `plaintext`
 * fallback id is appended here (it is intentionally absent from the registry, ADR-0067 D5). Observable
 * behaviour of `inferMonacoLanguageId` / `isMonacoLanguageId` / `fileExtension` is unchanged — the
 * contract table is seeded with exactly today's extension set (a parity test pins old == new).
 */

import {
  EDITOR_LANGUAGE_MODE_BY_EXTENSION,
  EDITOR_LANGUAGE_MODE_IDS,
} from "@oscharko-dev/keiko-contracts";

/**
 * A Monaco built-in language id the Keiko Editor can render (monaco-editor 0.55.1).
 *
 * Kept as an explicit literal union — identical to the pre-#1379 union — so consumers
 * (`EditorLanguageId`, `patch-preview.ts`) keep the narrow type. The runtime ids in
 * {@link MONACO_LANGUAGE_IDS} are derived from the contract and a parity test pins them against this
 * union, so the literal type and the derived values cannot silently drift.
 */
export type MonacoLanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "markdown"
  | "yaml"
  | "python"
  | "java"
  | "go"
  | "rust"
  | "sql"
  | "shell"
  | "plaintext";

/** The fallback language id for buffers with no recognised source language. */
export const MONACO_PLAINTEXT_LANGUAGE_ID: MonacoLanguageId = "plaintext";

/**
 * Monaco built-in language ids the Keiko Editor infers for local tokenisation. Derived from the
 * canonical {@link EDITOR_LANGUAGE_MODE_IDS} (the known source languages) plus the editor-only
 * `plaintext` render fallback (ADR-0067 D2/D5).
 */
export const MONACO_LANGUAGE_IDS: readonly MonacoLanguageId[] = [
  ...(EDITOR_LANGUAGE_MODE_IDS as readonly MonacoLanguageId[]),
  MONACO_PLAINTEXT_LANGUAGE_ID,
];

/**
 * File-extension (lower-case, without the leading dot) -> Monaco language id.
 *
 * Derived from the canonical {@link EDITOR_LANGUAGE_MODE_BY_EXTENSION} (ADR-0067 D2). TSX/JSX fold
 * onto the `typescript`/`javascript` ids exactly as before: monaco-editor 0.55.1 has no distinct
 * `tsx`/`jsx` language id — its TypeScript/JavaScript grammars tokenise JSX in `.tsx`/`.jsx` files —
 * so AC coverage of "TSX" and "JSX" means the extensions resolve, not that new ids exist.
 */
export const MONACO_LANGUAGE_BY_EXTENSION: Readonly<Record<string, MonacoLanguageId>> =
  EDITOR_LANGUAGE_MODE_BY_EXTENSION as Readonly<Record<string, MonacoLanguageId>>;

/**
 * Extract the final path segment (basename) from a POSIX or Windows path.
 *
 * `noUncheckedIndexedAccess` is on, so the split result is treated as possibly-undefined.
 */
function basename(pathOrName: string): string {
  const segments = pathOrName.split(/[/\\]/);
  return segments[segments.length - 1] ?? pathOrName;
}

/**
 * Lower-case extension (without the leading dot) of a file name, or `""` when there is none.
 *
 * A leading dot is treated as "no extension" (dotfiles such as `.gitignore` have no source language),
 * matching how editors classify them.
 */
export function fileExtension(pathOrName: string): string {
  const name = basename(pathOrName).trim();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Infer the Monaco language id for a file name or path.
 *
 * Falls back to {@link MONACO_PLAINTEXT_LANGUAGE_ID} for unknown extensions, extension-less names,
 * dotfiles, and empty input, so every buffer is renderable.
 */
export function inferMonacoLanguageId(pathOrName: string): MonacoLanguageId {
  const extension = fileExtension(pathOrName);
  if (extension === "") {
    return MONACO_PLAINTEXT_LANGUAGE_ID;
  }
  return MONACO_LANGUAGE_BY_EXTENSION[extension] ?? MONACO_PLAINTEXT_LANGUAGE_ID;
}

/** Type guard: does `value` name a Monaco language id the editor recognises? */
export function isMonacoLanguageId(value: string): value is MonacoLanguageId {
  return (MONACO_LANGUAGE_IDS as readonly string[]).includes(value);
}
