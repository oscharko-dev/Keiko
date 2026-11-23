// Which changed files need no verification (#4491): a run whose every applied edit touched only
// documentation has nothing a build, a type check or a test could contradict, so it is not asked to
// run one. The rule is one closed function over a workspace-relative path; it never reads the file.
//
// A file is documentation by its extension alone. A `docs/` folder is deliberately NOT enough:
// `docs/conf.py`, `docs/examples/Main.java` and a doc-site's build script are code that checks do
// cover, and treating a whole folder as prose would let a code change in it skip its check. A prose
// file stays prose wherever it lives. Two `.txt` shapes are build input, not prose, and stay code:
// a CMake list and a pip requirements or constraints file.

const DOCUMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".adoc",
  ".asciidoc",
  ".markdown",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
]);

// Conventional prose files that carry no extension at all.
const DOCUMENTATION_BASENAMES: ReadonlySet<string> = new Set([
  "authors",
  "changelog",
  "contributing",
  "license",
  "notice",
  "readme",
]);

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isBuildInputText(name: string): boolean {
  return (
    name === "cmakelists.txt" || name.startsWith("requirements") || name.startsWith("constraints")
  );
}

/** Whether a workspace-relative path names a documentation file that no check covers. */
export function isDocumentationPath(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DOCUMENTATION_BASENAMES.has(name);
  if (name.endsWith(".txt") && isBuildInputText(name)) return false;
  return DOCUMENTATION_EXTENSIONS.has(name.slice(dot));
}

/**
 * Whether an applied edit needs a check after it. An edit that names no path (an outcome the edit
 * port did not describe) is treated as code: absent evidence never relaxes the requirement.
 */
export function editNeedsVerification(changedPaths: readonly string[] | undefined): boolean {
  return changedPaths === undefined || changedPaths.length === 0
    ? true
    : changedPaths.some((path) => !isDocumentationPath(path));
}
