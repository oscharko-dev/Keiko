// The one letter-case rule for workspace path matchers (#4436): `.gitignore` rules, Coding search
// include/exclude globs, path-discovery globs and Knowledge Pod scope globs all ask this module
// whether `SCAN.PDF` and `scan.pdf` name the same path.
//
// NTFS is case-insensitive and Git for Windows defaults to `core.ignorecase=true`, so the platform
// default is case-insensitive on Windows and case-sensitive elsewhere. A repository's explicit
// `core.ignorecase` wins on every platform, because that is the setting Git itself applies to the
// same `.gitignore`. The always-on deny list stays case-insensitive everywhere (ignore.ts) and is
// not governed by this rule: a case-only spelling must never bypass it.

import type { WorkspaceInfo, WorkspacePathCase } from "./types.js";

/** The platform default when a repository does not state `core.ignorecase`. */
export function platformPathCase(platform: NodeJS.Platform = process.platform): WorkspacePathCase {
  return platform === "win32" ? "case-insensitive" : "case-sensitive";
}

/** A repository's explicit `core.ignorecase`, or the platform default when it states none. */
export function pathCaseFromGitIgnoreCase(
  ignoreCase: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): WorkspacePathCase {
  if (ignoreCase === undefined) return platformPathCase(platform);
  return ignoreCase ? "case-insensitive" : "case-sensitive";
}

/** The rule a workspace's matchers apply: its recorded repository rule, else the platform's. */
export function workspacePathCase(
  workspace: Pick<WorkspaceInfo, "pathCase"> | undefined,
  platform: NodeJS.Platform = process.platform,
): WorkspacePathCase {
  return workspace?.pathCase ?? platformPathCase(platform);
}

export function isCaseInsensitivePathCase(pathCase: WorkspacePathCase): boolean {
  return pathCase === "case-insensitive";
}

/** The `caseSensitive` argument a workspace path glob compiles with under `pathCase`. */
export function pathGlobCaseSensitive(pathCase: WorkspacePathCase): boolean {
  return !isCaseInsensitivePathCase(pathCase);
}

/**
 * The comparison key of a literal path under `pathCase`. Case-insensitive keys use JavaScript's
 * locale-independent `toLowerCase`, the same folding the deny list uses.
 */
export function pathCaseKey(path: string, pathCase: WorkspacePathCase): string {
  return isCaseInsensitivePathCase(pathCase) ? path.toLowerCase() : path;
}

const GIT_TRUE: ReadonlySet<string> = new Set(["true", "yes", "on", "1"]);
const GIT_FALSE: ReadonlySet<string> = new Set(["false", "no", "off", "0", ""]);
const SECTION_HEADER = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/u;
const KEY_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/u;

function stripValueComment(raw: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index);
    if (char === "\\") {
      out += raw.charAt(index + 1);
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      out += char;
    }
  }
  return out.trim();
}

function gitBoolean(value: string | undefined): boolean | undefined {
  // A key without `=` is Git's shorthand for true.
  if (value === undefined) return true;
  const normalized = stripValueComment(value).toLowerCase();
  if (GIT_TRUE.has(normalized)) return true;
  if (GIT_FALSE.has(normalized)) return false;
  return undefined;
}

interface GitConfigCursor {
  inCore: boolean;
  ignoreCase: boolean | undefined;
}

// Consumes a leading section header and returns the rest of the line (Git allows a key there).
function consumeSectionHeader(cursor: GitConfigCursor, line: string): string {
  const header = SECTION_HEADER.exec(line);
  if (header === null) return line;
  // Section names are case-insensitive; `[core "x"]` is a subsection and is not `[core]`.
  cursor.inCore = (header[1] ?? "").toLowerCase() === "core" && header[2] === undefined;
  return line.slice(header[0].length).trim();
}

function isCommentOrBlank(line: string): boolean {
  return line.length === 0 || line.startsWith("#") || line.startsWith(";");
}

function applyConfigLine(cursor: GitConfigCursor, rawLine: string): void {
  const line = consumeSectionHeader(cursor, rawLine.trim());
  if (!cursor.inCore || isCommentOrBlank(line)) return;
  const key = KEY_LINE.exec(line);
  if (key?.[1]?.toLowerCase() !== "ignorecase") return;
  const value = gitBoolean(key[2]);
  // Git rejects an unparsable boolean; an unparsable value states nothing, so the platform
  // default stays in force instead of a guess.
  if (value !== undefined) cursor.ignoreCase = value;
}

/**
 * `core.ignorecase` from the text of a repository's Git config, or `undefined` when the text does
 * not state it. The last assignment wins, as in Git. `include` directives are not followed: only
 * the repository's own config file is read. Pure: the text is never retained or logged.
 */
export function parseGitCoreIgnoreCase(configText: string): boolean | undefined {
  const cursor: GitConfigCursor = { inCore: false, ignoreCase: undefined };
  for (const line of configText.split(/\r?\n/u)) applyConfigLine(cursor, line);
  return cursor.ignoreCase;
}
