/**
 * Stable public identity of the browser-tier Keiko Editor package.
 *
 * Kept as a local literal (not re-derived from another package at runtime) so the editor package
 * has a runtime surface that resolves without building any sibling package — the package builds,
 * typechecks, and tests in isolation (Issue #1191 acceptance criteria). The package release version
 * is governed separately by `package.json` and the cross-package version-consistency gate.
 */
export const KEIKO_EDITOR_PACKAGE = "@oscharko-dev/keiko-editor" as const;
