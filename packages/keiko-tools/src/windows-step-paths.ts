// #4492 (ADR-0043 D21): the pure Windows path rules a confined step shares: whether a path lies
// inside a folder, and a search path with one folder first. No file system access happens here.

import { win32 } from "node:path";

/** Whether `path` is `root` or lies inside it, comparing by Windows rules (case-insensitive). */
export function windowsPathContains(root: string, path: string): boolean {
  const relative = win32.relative(root, path);
  return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
}

// One search-path entry as Windows reads it for a comparison: quotes dropped, separators unified,
// no trailing separator, no case.
function comparableEntry(entry: string): string {
  let value = entry.trim().replaceAll('"', "").replaceAll("/", "\\").toLowerCase();
  while (value.length > 1 && value.endsWith("\\")) value = value.slice(0, -1);
  return value;
}

/**
 * `searchPath` with `directory` first and every other entry kept in its order: an entry that already
 * names `directory` (quoted, with a trailing separator or in another case) is dropped so the
 * folder appears once, and an empty entry (a stray or trailing `;`) is dropped, as an empty entry
 * would otherwise name the working directory. A relative entry stays exactly as written.
 */
export function prependWindowsSearchPath(searchPath: string, directory: string): string {
  const own = comparableEntry(directory);
  const kept = searchPath
    .split(";")
    .filter((entry) => entry.trim() !== "" && comparableEntry(entry) !== own);
  return [directory, ...kept].join(";");
}
