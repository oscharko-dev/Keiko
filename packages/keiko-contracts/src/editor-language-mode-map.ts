// Canonical editor language mode map (Issue #1379, Epic #1491, ADR-0067 D1). This is the single,
// authoritative, frozen const table describing the known SOURCE-LANGUAGE universe shared by the
// browser editor tier (`keiko-editor`) and the server language service (`keiko-server`). It answers
// the issue's "language id", "file-extension matching", and "syntax support" dimensions with data,
// not with code scattered across packages.
//
// It enumerates exactly the source languages the product knows. `plaintext` is deliberately EXCLUDED
// (ADR-0067 D5): it is the editor's render fallback for unknown/unsupported buffers, not a known
// source language the registry advertises. "known" (AC2) is exactly this id set; everything else
// degrades to plain text without governed intelligence (AC3) — the two sets are disjoint by design.
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus pure functions only. No
// filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages. The small basename/extension helper is re-implemented locally rather than imported from
// `keiko-editor` so this module stays a strict, browser-importable leaf.

// One source language the editor and server agree on. `fileExtensions` are lower-case and carry no
// leading dot; `syntaxHighlighting` is true for every entry because the editor can locally tokenise
// and colour each language via Monaco's bundled grammars.
export interface EditorLanguageMode {
  readonly languageId: string;
  readonly fileExtensions: readonly string[];
  readonly syntaxHighlighting: boolean;
}

// The canonical table. Extensions match `keiko-editor`'s historic `MONACO_LANGUAGE_BY_EXTENSION`
// keys exactly (including the TSX -> typescript / JSX -> javascript fold) so the editor's inference
// behaviour is unchanged when it derives from this table (ADR-0067 D2). `as const` makes every entry
// and extension list deeply readonly at compile time; the entries, their `fileExtensions` arrays, and
// the outer array are each `Object.freeze`d so the shared universe is deeply immutable at runtime too
// — no consumer holding a reference to an entry can mutate it.
const RAW_EDITOR_LANGUAGE_MODES = [
  {
    languageId: "typescript",
    fileExtensions: ["ts", "mts", "cts", "tsx"],
    syntaxHighlighting: true,
  },
  {
    languageId: "javascript",
    fileExtensions: ["js", "mjs", "cjs", "jsx"],
    syntaxHighlighting: true,
  },
  { languageId: "json", fileExtensions: ["json", "jsonc"], syntaxHighlighting: true },
  { languageId: "css", fileExtensions: ["css"], syntaxHighlighting: true },
  { languageId: "scss", fileExtensions: ["scss"], syntaxHighlighting: true },
  { languageId: "less", fileExtensions: ["less"], syntaxHighlighting: true },
  { languageId: "html", fileExtensions: ["html", "htm"], syntaxHighlighting: true },
  { languageId: "markdown", fileExtensions: ["md", "markdown"], syntaxHighlighting: true },
  { languageId: "yaml", fileExtensions: ["yaml", "yml"], syntaxHighlighting: true },
  { languageId: "python", fileExtensions: ["py", "pyi"], syntaxHighlighting: true },
  { languageId: "java", fileExtensions: ["java"], syntaxHighlighting: true },
  { languageId: "go", fileExtensions: ["go"], syntaxHighlighting: true },
  { languageId: "rust", fileExtensions: ["rs"], syntaxHighlighting: true },
  { languageId: "sql", fileExtensions: ["sql"], syntaxHighlighting: true },
  { languageId: "shell", fileExtensions: ["sh", "bash", "zsh"], syntaxHighlighting: true },
] as const;

export const EDITOR_LANGUAGE_MODE_MAP: readonly EditorLanguageMode[] = Object.freeze(
  RAW_EDITOR_LANGUAGE_MODES.map((mode) =>
    Object.freeze({ ...mode, fileExtensions: Object.freeze([...mode.fileExtensions]) }),
  ),
);

// The canonical language ids, derived from the map. Frozen.
export const EDITOR_LANGUAGE_MODE_IDS: readonly string[] = Object.freeze(
  EDITOR_LANGUAGE_MODE_MAP.map((mode) => mode.languageId),
);

// Extension -> languageId, derived from the map. Frozen. Every extension in the map appears here.
export const EDITOR_LANGUAGE_MODE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze(
  EDITOR_LANGUAGE_MODE_MAP.reduce<Record<string, string>>((accumulator, mode) => {
    for (const extension of mode.fileExtensions) {
      accumulator[extension] = mode.languageId;
    }
    return accumulator;
  }, {}),
);

// Final path segment (basename) from a POSIX or Windows path. Pure, allocation-light.
function modeMapBasename(pathOrName: string): string {
  const segments = pathOrName.split(/[/\\]/u);
  return segments[segments.length - 1] ?? pathOrName;
}

// Lower-case extension (without the leading dot) of a file name, or "" when there is none. A leading
// dot is treated as "no extension" (dotfiles such as `.gitignore` have no source language). Mirrors
// `keiko-editor`'s `fileExtension` rules exactly so the two tiers agree on extension matching.
function modeMapExtension(pathOrName: string): string {
  const name = modeMapBasename(pathOrName).trim();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

// Infer the canonical source-language id for a file name or path, or `null` when the buffer is not a
// known source language (unknown extension, dotfile, extension-less name, or empty input). `null` is
// the AC3 safe-degrade signal: such buffers render as plain text with no governed intelligence.
export function inferEditorLanguageModeId(pathOrName: string): string | null {
  const extension = modeMapExtension(pathOrName);
  if (extension === "") {
    return null;
  }
  return EDITOR_LANGUAGE_MODE_BY_EXTENSION[extension] ?? null;
}

// Runtime membership check: is `value` one of the canonical mode-map language ids? This is a plain
// boolean predicate, not a narrowing type guard — the mode ids are `string` (the contract names no
// concrete language literal type), so a `value is …` annotation would narrow nothing and mislead
// callers.
export function isEditorLanguageModeId(value: string): boolean {
  return EDITOR_LANGUAGE_MODE_IDS.includes(value);
}
