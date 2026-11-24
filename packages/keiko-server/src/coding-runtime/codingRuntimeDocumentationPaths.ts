// Which changed files need no verification (#4491): a run whose every applied edit touched only
// documentation has nothing a build, a type check or a test could contradict, so it is not asked to
// run one. The rule is one closed function over a workspace-relative path; it never reads the file.
//
// A file is documentation by its extension, unless it lives under a directory that code or tests
// read. A `docs/` folder is deliberately NOT enough on its own: `docs/conf.py`,
// `docs/examples/Main.java` and a doc-site's build script are code that checks do cover. And a
// prose extension is not enough either: `src/test/resources/expected.txt` is a golden file a test
// compares against, and a prompt, template or skill `.md` is read by code, so a change to it can
// break a check. Two `.txt` shapes are build input, not prose, and stay code: a CMake list and a pip
// requirements or constraints file.

// Directories whose files code or tests read (source and test trees, fixtures and snapshots,
// runtime-loaded prompts, templates, skills, locale and data folders, mocks, and tool configuration
// folders). A path with any of these segments, in any letter case, is never documentation.
export const STRICT_CODE_READ_DIRECTORIES: ReadonlySet<string> = new Set([
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "__tests__",
  "fixtures",
  "mocks",
  "prompts",
  "resources",
  "skills",
  "snapshots",
  "spec",
  "specs",
  "templates",
  "test",
  "test-data",
  "testdata",
  "tests",
]);

// Broader directories: a conventional documentation file (below) stays documentation in them, since
// `src/foo/README.md` is a note about the code, not input to it. Folders such as `app`, `lib`,
// `assets`, `public` and `static` are deliberately absent: they hold plenty of plain documentation.
const BROAD_CODE_READ_DIRECTORIES: readonly string[] = [
  ".claude",
  ".github",
  "data",
  "i18n",
  "locales",
  "src",
];

export const CODE_READ_DIRECTORIES: ReadonlySet<string> = new Set([
  ...STRICT_CODE_READ_DIRECTORIES,
  ...BROAD_CODE_READ_DIRECTORIES,
]);

/**
 * Conventional documentation files, by name without the prose extension: documentation in any
 * directory except under a strict segment, where a file of that name is a golden file or fixture.
 */
export const CONVENTIONAL_DOCUMENTATION_STEMS: ReadonlySet<string> = new Set([
  "authors",
  "changelog",
  "changes",
  "code_of_conduct",
  "contributing",
  "history",
  "licence",
  "license",
  "notice",
  "readme",
  "security",
  "support",
]);

const DOCUMENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".adoc",
  ".asciidoc",
  ".markdown",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
]);

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function underDirectory(path: string, directories: ReadonlySet<string>): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .slice(0, -1)
    .some((segment) => directories.has(segment.toLowerCase()));
}

function isConventionalDocumentationName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return CONVENTIONAL_DOCUMENTATION_STEMS.has(name);
  return (
    DOCUMENTATION_EXTENSIONS.has(name.slice(dot)) &&
    CONVENTIONAL_DOCUMENTATION_STEMS.has(name.slice(0, dot))
  );
}

function isBuildInputText(name: string): boolean {
  return (
    name === "cmakelists.txt" || name.startsWith("requirements") || name.startsWith("constraints")
  );
}

/** Whether a workspace-relative path names a documentation file that no check covers. */
export function isDocumentationPath(path: string): boolean {
  if (underDirectory(path, STRICT_CODE_READ_DIRECTORIES)) return false;
  const name = basename(path);
  if (isConventionalDocumentationName(name)) return true;
  if (underDirectory(path, CODE_READ_DIRECTORIES)) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
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
