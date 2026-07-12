// Shared Local Knowledge file-selection contract.
//
// The parser package and the UI both consume these extension groups: selecting a document in
// the native picker must expose precisely the formats the shipped parsers understand. The
// groups intentionally carry stable ids instead of display strings so every UI locale can name
// them naturally in the native dialog.

export const LOCAL_KNOWLEDGE_PDF_FILE_EXTENSIONS = Object.freeze(["pdf"] as const);
export const LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS = Object.freeze(["docx"] as const);
export const LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS = Object.freeze(["xlsx"] as const);

export const LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS = Object.freeze([
  ...LOCAL_KNOWLEDGE_PDF_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS,
] as const);

export const LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS = Object.freeze([
  "json",
  "jsonl",
  "ndjson",
] as const);

export const LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS = Object.freeze(["csv"] as const);
export const LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS = Object.freeze(["tsv", "tab"] as const);

export const LOCAL_KNOWLEDGE_STRUCTURED_DATA_FILE_EXTENSIONS = Object.freeze([
  ...LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
] as const);

export const LOCAL_KNOWLEDGE_TEXT_DOCUMENT_FILE_EXTENSIONS = Object.freeze([
  "txt",
  "log",
  "md",
  "markdown",
  "rst",
  "adoc",
  "asciidoc",
] as const);

export const LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS = Object.freeze([
  "html",
  "htm",
  "xhtml",
] as const);

export const LOCAL_KNOWLEDGE_SCRIPT_FILE_EXTENSIONS = Object.freeze([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
] as const);

export const LOCAL_KNOWLEDGE_SOURCE_CODE_FILE_EXTENSIONS = Object.freeze([
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
] as const);

export const LOCAL_KNOWLEDGE_CONFIGURATION_FILE_EXTENSIONS = Object.freeze([
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "sql",
  "graphql",
  "gql",
] as const);

export const LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS = Object.freeze([
  ...LOCAL_KNOWLEDGE_TEXT_DOCUMENT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_SCRIPT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_SOURCE_CODE_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_CONFIGURATION_FILE_EXTENSIONS,
] as const);

export type LocalKnowledgeFileFilterId =
  | "documents"
  | "structuredData"
  | "textDocuments"
  | "webDocuments"
  | "scripts"
  | "sourceCode"
  | "configuration";

export interface LocalKnowledgeFileFilterDefinition {
  readonly id: LocalKnowledgeFileFilterId;
  readonly extensions: readonly string[];
}

export const LOCAL_KNOWLEDGE_FILE_FILTERS: readonly LocalKnowledgeFileFilterDefinition[] =
  Object.freeze([
    Object.freeze({ id: "documents", extensions: LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS }),
    Object.freeze({
      id: "structuredData",
      extensions: LOCAL_KNOWLEDGE_STRUCTURED_DATA_FILE_EXTENSIONS,
    }),
    Object.freeze({
      id: "textDocuments",
      extensions: LOCAL_KNOWLEDGE_TEXT_DOCUMENT_FILE_EXTENSIONS,
    }),
    Object.freeze({ id: "webDocuments", extensions: LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS }),
    Object.freeze({ id: "scripts", extensions: LOCAL_KNOWLEDGE_SCRIPT_FILE_EXTENSIONS }),
    Object.freeze({ id: "sourceCode", extensions: LOCAL_KNOWLEDGE_SOURCE_CODE_FILE_EXTENSIONS }),
    Object.freeze({
      id: "configuration",
      extensions: LOCAL_KNOWLEDGE_CONFIGURATION_FILE_EXTENSIONS,
    }),
  ]);
