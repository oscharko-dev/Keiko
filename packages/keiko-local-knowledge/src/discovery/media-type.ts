// Pure extension/media-type lookup table (Issue #194). The discovery layer must give the
// parser registry a `(extension, mediaType)` hint without sniffing the bytes. This table
// covers the formats supported by the shipped adapters; unknown extensions fall through to
// the unsupported sentinel, which then sniffs magic bytes.
//
// The mapping is intentionally NOT exhaustive — it's the minimal set that lets the parser
// registry route correctly. Adding a new entry is a one-line change.

const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  // text-like
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  rst: "text/x-rst",
  log: "text/plain",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  py: "text/x-python",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  yaml: "text/yaml",
  yml: "text/yaml",
  // json
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  // csv / tsv
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  // html
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  // unsupported binaries (the unsupported adapter still classifies these explicitly)
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
});

export function extensionOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  const basename = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    return "";
  }
  return basename.slice(dot + 1).toLowerCase();
}

export function mediaTypeFor(extension: string): string {
  return MEDIA_TYPES[extension] ?? "";
}

export function basenameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}
