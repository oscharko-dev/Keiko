import type { WorkspaceLanguage } from "@oscharko-dev/keiko-contracts";
import { MONACO_LANGUAGE_IDS, type MonacoLanguageId } from "./monaco/language-inference.js";

/**
 * Languages the Keiko Editor can render in v1.
 *
 * This is deliberately wider than the canonical workspace source-language contract
 * (`WorkspaceLanguage`, today `"typescript" | "javascript"`). The editor can render and label many
 * Monaco-tokenised formats locally, while governed language intelligence (completion, diagnostics,
 * hover, symbols, Keiko formatting) remains source-language-only in the host.
 *
 * `import type` keeps this a type-only edge to `@oscharko-dev/keiko-contracts`: the browser-tier
 * boundary (ADR-0042; ADR-0019 direction rule 8) permits type-only contract imports and forbids
 * value imports of Node-domain packages.
 */
export type EditorLanguageId = WorkspaceLanguage | MonacoLanguageId;

/** The concrete set of languages {@link isSupportedEditorLanguage} recognises. */
export const SUPPORTED_EDITOR_LANGUAGES: readonly EditorLanguageId[] = MONACO_LANGUAGE_IDS;

/**
 * Narrow an arbitrary string to an {@link EditorLanguageId}. Lets the host validate a
 * caller-provided language identifier before handing a buffer to the editor without duplicating the
 * supported-language list.
 */
export function isSupportedEditorLanguage(value: string): value is EditorLanguageId {
  return (SUPPORTED_EDITOR_LANGUAGES as readonly string[]).includes(value);
}
