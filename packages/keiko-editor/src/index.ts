/**
 * `@oscharko-dev/keiko-editor` — public API.
 *
 * Browser-tier editor surface. Intentionally minimal in v1 (Issue #1191): the package's identity,
 * the supported-language contract, and the typed host-integration port surface. No Monaco runtime,
 * no `keiko-ui` dependency, no Node-domain value imports — see ADR-0042 and the package README.
 */
export { KEIKO_EDITOR_PACKAGE } from "./version.js";
export { SUPPORTED_EDITOR_LANGUAGES, isSupportedEditorLanguage } from "./languages.js";
export type { EditorLanguageId } from "./languages.js";
export type { EditorBuffer, EditorHostPort } from "./host-port.js";
