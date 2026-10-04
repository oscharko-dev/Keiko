// Explicit inspection of existing language sources is a filename request, not a request for
// ecosystem version manifests. Keep planner routing and admitted lexical selection in agreement.
import { ECOSYSTEMS, workspaceLanguageForPath } from "./ecosystems.js";
import type { WorkspaceLanguage } from "./types.js";

const MAX_QUERY_CHARACTERS = 4096;
const INSPECTION_RE =
  /\b(?:inspect|investigate|examine|analyse|analyze|read|show|find|search|review|untersuche|untersuchen|analysiere|analysieren|lies|lese|zeige|durchsuche|pruefe|prüfe)\b/iu;
const SOURCE_FILE_PHRASE = String.raw`(?:source[\s_-]+files?|source[\s_-]*code|sources|quelldatei(?:en)?|quellcode)`;
const LANGUAGE_PATTERNS: readonly (readonly [WorkspaceLanguage, string])[] = [
  ["csharp", String.raw`c#|csharp|c[\s_-]+sharp`],
  ["typescript", String.raw`type[\s_-]?script`],
  ["javascript", String.raw`java[\s_-]?script`],
  ["java", "java"],
  ["python", "python"],
  ["rust", "rust"],
  ["go", "go"],
  ["kotlin", "kotlin"],
];
const SOURCE_INSPECTION_PATTERNS = LANGUAGE_PATTERNS.map(([language, name]) => ({
  language,
  pattern: new RegExp(
    String.raw`\b(?:${name})[\s_-]+${SOURCE_FILE_PHRASE}\b|\b${SOURCE_FILE_PHRASE}\s+(?:(?:in|of|written in|von|für)\s+)?(?:${name})(?=$|[^\p{L}\p{N}_])`,
    "iu",
  ),
}));
const REGISTERED_SOURCE_EXTENSIONS = [
  ...new Set(ECOSYSTEMS.flatMap((eco) => eco.sourceExtensions)),
];

export function requestedSourceInspectionExtensions(queryText: string): readonly string[] {
  if (queryText.length > MAX_QUERY_CHARACTERS || !INSPECTION_RE.test(queryText)) return [];
  const languages = new Set(
    SOURCE_INSPECTION_PATTERNS.filter(({ pattern }) => pattern.test(queryText)).map(
      ({ language }) => language,
    ),
  );
  return REGISTERED_SOURCE_EXTENSIONS.filter((extension) => {
    const language = workspaceLanguageForPath(`source.${extension}`);
    return language !== undefined && languages.has(language);
  });
}

export function sourceInspectionPathMatches(
  scopePath: string,
  extensions: readonly string[],
): boolean {
  const name = scopePath.slice(scopePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase());
}
