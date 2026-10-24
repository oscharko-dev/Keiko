// Exact private MJS helper names used by the stylesheet evidence tests.
declare module "*read-stylesheet.mjs" {
 export function readStylesheet(file: string, root?: string): string;
}
declare module "*design-evidence-sources.mjs" {
 export function designEvidenceSourceHashes(root: string): readonly { readonly path: string; readonly sha256: string }[];
}
