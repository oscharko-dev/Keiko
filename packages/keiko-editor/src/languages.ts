import type { WorkspaceLanguage } from "@oscharko-dev/keiko-contracts";

/**
 * Languages the Keiko Editor can render in v1.
 *
 * Aligned with the canonical workspace language contract (`WorkspaceLanguage`, today
 * `"typescript" | "javascript"`) so the editor never drifts from the rest of the platform on what a
 * source language is, plus `"plaintext"` for non-source buffers (logs, plain text, unknown types).
 * The first-class language stack is TypeScript/JavaScript per the editor architecture blueprint;
 * additional deterministic language stacks are a deferred, separate concern (#1213).
 *
 * `import type` keeps this a type-only edge to `@oscharko-dev/keiko-contracts`: the browser-tier
 * boundary (ADR-0042; ADR-0019 direction rule 8) permits type-only contract imports and forbids
 * value imports of Node-domain packages.
 */
export type EditorLanguageId = WorkspaceLanguage | "plaintext";

/** The concrete set of languages {@link isSupportedEditorLanguage} recognises. */
export const SUPPORTED_EDITOR_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
  "plaintext",
];

/**
 * Narrow an arbitrary string to an {@link EditorLanguageId}. Lets the host validate a
 * caller-provided language identifier before handing a buffer to the editor without duplicating the
 * supported-language list.
 */
export function isSupportedEditorLanguage(value: string): value is EditorLanguageId {
  return (SUPPORTED_EDITOR_LANGUAGES as readonly string[]).includes(value);
}
