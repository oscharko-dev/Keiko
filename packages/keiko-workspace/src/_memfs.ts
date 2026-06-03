import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "./fs.js";

// Minimal in-memory WorkspaceFs over a flat path->content map. Directories are implied by
// path prefixes. Keys are relative POSIX paths under a single absolute root. No symlinks.

function toAbs(root: string, rel: string): string {
  return rel === root ? root : `${root}/${rel}`.replace(/\/+/g, "/");
}

function childrenOf(
  root: string,
  files: Readonly<Record<string, string>>,
  dirAbs: string,
): readonly WorkspaceDirEntry[] {
  const prefix = dirAbs === root ? `${root}/` : `${dirAbs}/`;
  const fileNames = new Set<string>();
  const dirNames = new Set<string>();
  for (const key of Object.keys(files)) {
    const full = toAbs(root, key);
    if (!full.startsWith(prefix)) {
      continue;
    }
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      fileNames.add(rest);
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }
  return [
    ...[...dirNames].map((name) => entry(name, true)),
    ...[...fileNames].map((name) => entry(name, false)),
  ];
}

function entry(name: string, isDirectory: boolean): WorkspaceDirEntry {
  return { name, isDirectory, isFile: !isDirectory, isSymbolicLink: false };
}

export function memFs(root: string, files: Readonly<Record<string, string>>): WorkspaceFs {
  const findKey = (absolutePath: string): string | undefined =>
    Object.keys(files).find((key) => toAbs(root, key) === absolutePath);
  return {
    readFileUtf8: (absolutePath: string): string => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return files[key] ?? "";
    },
    stat: (absolutePath: string): WorkspaceStat => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return {
        size: Buffer.byteLength(files[key] ?? "", "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    },
    readDir: (absolutePath: string): readonly WorkspaceDirEntry[] =>
      childrenOf(root, files, absolutePath),
    realPath: (absolutePath: string): string => absolutePath,
    exists: (absolutePath: string): boolean =>
      findKey(absolutePath) !== undefined || absolutePath === root,
  };
}
