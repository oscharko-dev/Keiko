import type { WorkspaceDirEntry, WorkspaceFileReader, WorkspaceFs, WorkspaceStat } from "./fs.js";
import { resolve } from "node:path";

// Minimal in-memory WorkspaceFs over a flat path->content map. Directories are implied by
// path prefixes. Keys are relative POSIX paths under a single absolute root. No symlinks.

function canonicalPath(path: string): string {
  return resolve(path.replaceAll("\\", "/")).replaceAll("\\", "/");
}

function toAbs(root: string, rel: string): string {
  const canonicalRoot = canonicalPath(root);
  if (rel === root) return canonicalRoot;
  const relativePath = rel.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  return canonicalRoot.endsWith("/")
    ? `${canonicalRoot}${relativePath}`
    : `${canonicalRoot}/${relativePath}`;
}

function childrenOf(
  root: string,
  files: Readonly<Record<string, string>>,
  dirAbs: string,
): readonly WorkspaceDirEntry[] {
  const canonicalRoot = canonicalPath(root);
  const canonicalDir = canonicalPath(dirAbs);
  const prefix = canonicalDir === canonicalRoot ? `${canonicalRoot}/` : `${canonicalDir}/`;
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

function encodedFile(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
): Uint8Array | undefined {
  if (key === undefined) {
    return undefined;
  }
  return new TextEncoder().encode(files[key] ?? "");
}

function memReadFileBytes(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const cap = Math.max(0, Math.floor(maxBytes));
  const encoded = encodedFile(files, key);
  if (encoded === undefined) {
    return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
  }
  return Promise.resolve(encoded.subarray(0, Math.min(encoded.length, cap)));
}

function memReadFileUtf8Prefix(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
  maxBytes: number,
): string {
  const cap = Math.max(0, Math.floor(maxBytes));
  const encoded = encodedFile(files, key);
  if (encoded === undefined) {
    throw new Error(`ENOENT: ${absolutePath}`);
  }
  return new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(0, Math.min(encoded.length, cap)))
    .replace(/�+$/u, "");
}

function memReadFileRange(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
  startByte: number,
  length: number,
): Promise<Uint8Array> {
  const start = Math.max(0, Math.floor(startByte));
  const cap = Math.max(0, Math.floor(length));
  const encoded = encodedFile(files, key);
  if (encoded === undefined) {
    return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
  }
  return Promise.resolve(encoded.subarray(start, Math.min(encoded.length, start + cap)));
}

function memOpenFileReader(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
): Promise<WorkspaceFileReader> {
  if (key === undefined) {
    return Promise.reject(new Error(`ENOENT: ${absolutePath}`));
  }
  let closed = false;
  return Promise.resolve({
    readRange: (startByte: number, length: number): Promise<Uint8Array> => {
      if (closed) {
        return Promise.reject(new Error(`EBADF: ${absolutePath}`));
      }
      return memReadFileRange(files, key, absolutePath, startByte, length);
    },
    close: (): Promise<void> => {
      closed = true;
      return Promise.resolve();
    },
  });
}

export function memFs(root: string, files: Readonly<Record<string, string>>): WorkspaceFs {
  const findKey = (absolutePath: string): string | undefined =>
    Object.keys(files).find((key) => toAbs(root, key) === canonicalPath(absolutePath));
  const canonicalRoot = canonicalPath(root);
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
      findKey(absolutePath) !== undefined || canonicalPath(absolutePath) === canonicalRoot,
    readFileBytes: (absolutePath: string, maxBytes: number): Promise<Uint8Array> => {
      return memReadFileBytes(files, findKey(absolutePath), absolutePath, maxBytes);
    },
    readFileUtf8Prefix: (absolutePath: string, maxBytes: number): string =>
      memReadFileUtf8Prefix(files, findKey(absolutePath), absolutePath, maxBytes),
    readFileRange: (
      absolutePath: string,
      startByte: number,
      length: number,
    ): Promise<Uint8Array> => {
      return memReadFileRange(files, findKey(absolutePath), absolutePath, startByte, length);
    },
    openFileReader: (absolutePath: string): Promise<WorkspaceFileReader> =>
      memOpenFileReader(files, findKey(absolutePath), absolutePath),
  };
}
