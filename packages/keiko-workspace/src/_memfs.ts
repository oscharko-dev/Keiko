import {
  WorkspaceDescriptorReadError,
  type WorkspaceDescriptorReadCompleteness,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceDirEntry,
  type WorkspaceFileReader,
  type WorkspaceFs,
  type WorkspaceHardLinkPolicy,
  type WorkspaceStat,
} from "./fs.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Minimal in-memory WorkspaceFs over a flat path->content map. Directories are implied by
// path prefixes. Keys are relative POSIX paths under a single absolute root. No symlinks.

const FORWARD_SLASH_CODE = "/".codePointAt(0);

function canonicalPath(path: string): string {
  return resolve(path.replaceAll("\\", "/")).replaceAll("\\", "/");
}

function trimBoundarySlashes(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  let start = 0;
  while (start < normalized.length && normalized.codePointAt(start) === FORWARD_SLASH_CODE) {
    start += 1;
  }
  let end = normalized.length;
  while (end > start && normalized.codePointAt(end - 1) === FORWARD_SLASH_CODE) {
    end -= 1;
  }
  return normalized.slice(start, end);
}

function toAbs(root: string, rel: string): string {
  const canonicalRoot = canonicalPath(root);
  if (rel === root) return canonicalRoot;
  const relativePath = trimBoundarySlashes(rel);
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

function memoryFileStat(absolutePath: string, content: string): WorkspaceStat {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const timestampNs = BigInt(`0x${contentHash.slice(0, 15)}`).toString();
  return {
    size: Buffer.byteLength(content, "utf8"),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    hardLinkCount: 1,
    mtimeMs: Number(timestampNs) / 1_000_000,
    ctimeMs: Number(timestampNs) / 1_000_000,
    fileIdentity: `memfs:${canonicalPath(absolutePath)}:${contentHash}`,
    mtimeNs: timestampNs,
    ctimeNs: timestampNs,
  };
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
    .replace(/\uFFFD$/u, "");
}

// Shared bounded-descriptor-read core for both same-descriptor adapter methods below: locate the
// content and its snapshot, enforce the hard-link policy, then cap the bytes per `completeness`.
// `readFileUtf8WithinRootSameDescriptor` layers a root-containment check in front of this and
// `readFileUtf8SameDescriptor` layers an expected-stat match instead — the bounded-read/hard-link
// semantics themselves live here exactly once.

interface MemDescriptorSnapshot {
  readonly encoded: Uint8Array;
  readonly stat: WorkspaceStat;
}

function memDescriptorSnapshot(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
): MemDescriptorSnapshot {
  const encoded = encodedFile(files, key);
  if (encoded === undefined) throw new Error(`ENOENT: ${absolutePath}`);
  return { encoded, stat: memoryFileStat(absolutePath, files[key ?? ""] ?? "") };
}

function assertMemoryHardLinkPolicy(
  stat: WorkspaceStat,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
): void {
  if (hardLinkPolicy === "reject" && (stat.hardLinkCount ?? 1) > 1) {
    throw new WorkspaceDescriptorReadError("hard-link");
  }
}

function memBoundedDescriptorBytes(
  encoded: Uint8Array,
  maxBytes: number,
  completeness: WorkspaceDescriptorReadCompleteness,
): Uint8Array {
  const cap = Math.max(0, Math.floor(maxBytes));
  if (completeness === "complete" && encoded.length > cap) {
    throw new WorkspaceDescriptorReadError("too-large", encoded.length);
  }
  return encoded.subarray(0, Math.min(encoded.length, cap));
}

function memDescriptorUtf8Read(
  bytes: Uint8Array,
  stat: WorkspaceStat,
): WorkspaceDescriptorUtf8Read {
  return {
    rawText: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    sizeBytes: bytes.length,
    stat,
  };
}

// Mirrors fs.ts's `expectedDescriptorSnapshotMatches`, adapted to compare two already-realized
// `WorkspaceStat` snapshots instead of a caller-expected `WorkspaceStat` against a live
// `BigIntStats` — the in-memory port has no OS-level stat struct to re-derive from.
function sameKnownSnapshotValue(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined || left === right;
}

function expectedMemorySnapshotMatches(expected: WorkspaceStat, observed: WorkspaceStat): boolean {
  return [
    expected.isFile === observed.isFile,
    expected.isDirectory === observed.isDirectory,
    expected.isSymbolicLink === observed.isSymbolicLink,
    expected.size === observed.size,
    expected.fileIdentity !== undefined,
    expected.fileIdentity === observed.fileIdentity,
    sameKnownSnapshotValue(expected.hardLinkCount, observed.hardLinkCount),
    sameKnownSnapshotValue(
      expected.mtimeNs ?? expected.mtimeMs,
      expected.mtimeNs === undefined ? observed.mtimeMs : observed.mtimeNs,
    ),
    sameKnownSnapshotValue(
      expected.ctimeNs ?? expected.ctimeMs,
      expected.ctimeNs === undefined ? observed.ctimeMs : observed.ctimeNs,
    ),
  ].every(Boolean);
}

function memReadFileUtf8WithinRoot(
  root: string,
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  completeness: WorkspaceDescriptorReadCompleteness,
): WorkspaceDescriptorUtf8Read {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(absolutePath);
  if (!canonicalTarget.startsWith(`${canonicalRoot}/`)) {
    throw new WorkspaceDescriptorReadError("outside-root");
  }
  const { encoded, stat } = memDescriptorSnapshot(files, key, absolutePath);
  assertMemoryHardLinkPolicy(stat, hardLinkPolicy);
  const bytes = memBoundedDescriptorBytes(encoded, maxBytes, completeness);
  return memDescriptorUtf8Read(bytes, stat);
}

// Same bounded/hard-link semantics as `memReadFileUtf8WithinRoot` above, minus root-lineage
// containment: this is the descriptor lane detection consumes when it already holds a prior
// `WorkspaceStat` (`expected`) to reconfirm against, matching production's
// `readFileUtf8SameDescriptor` in fs.ts, which always requires a complete (non-prefix) read.
function memReadFileUtf8SameDescriptor(
  files: Readonly<Record<string, string>>,
  key: string | undefined,
  absolutePath: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
): WorkspaceDescriptorUtf8Read {
  const { encoded, stat } = memDescriptorSnapshot(files, key, absolutePath);
  assertMemoryHardLinkPolicy(stat, hardLinkPolicy);
  if (!expectedMemorySnapshotMatches(expected, stat)) {
    throw new WorkspaceDescriptorReadError("changed");
  }
  const bytes = memBoundedDescriptorBytes(encoded, maxBytes, "complete");
  return memDescriptorUtf8Read(bytes, stat);
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

function memContainedDescriptorReader(
  files: Readonly<Record<string, string>>,
  findKey: (absolutePath: string) => string | undefined,
): NonNullable<WorkspaceFs["readFileUtf8WithinRootSameDescriptor"]> {
  return (root, absolutePath, maxBytes, hardLinkPolicy, completeness) =>
    memReadFileUtf8WithinRoot(
      root,
      files,
      findKey(absolutePath),
      absolutePath,
      maxBytes,
      hardLinkPolicy,
      completeness,
    );
}

function memSameDescriptorReader(
  files: Readonly<Record<string, string>>,
  findKey: (absolutePath: string) => string | undefined,
): NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]> {
  return (absolutePath, maxBytes, hardLinkPolicy, expected) =>
    memReadFileUtf8SameDescriptor(
      files,
      findKey(absolutePath),
      absolutePath,
      maxBytes,
      hardLinkPolicy,
      expected,
    );
}

export function memFs(root: string, files: Readonly<Record<string, string>>): WorkspaceFs {
  const keyByAbsolutePath = new Map<string, string>();
  for (const key of Object.keys(files)) {
    const absolutePath = toAbs(root, key);
    if (!keyByAbsolutePath.has(absolutePath)) keyByAbsolutePath.set(absolutePath, key);
  }
  const findKey = (absolutePath: string): string | undefined =>
    keyByAbsolutePath.get(canonicalPath(absolutePath));
  const canonicalRoot = canonicalPath(root);
  return {
    readFileUtf8: (absolutePath: string): string => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return files[key] ?? "";
    },
    readFileUtf8WithinRootSameDescriptor: memContainedDescriptorReader(files, findKey),
    readFileUtf8SameDescriptor: memSameDescriptorReader(files, findKey),
    stat: (absolutePath: string): WorkspaceStat => {
      const key = findKey(absolutePath);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return memoryFileStat(absolutePath, files[key] ?? "");
    },
    readDir: (absolutePath: string, maxEntries?: number): readonly WorkspaceDirEntry[] => {
      const entries = childrenOf(root, files, absolutePath);
      return maxEntries === undefined ? entries : entries.slice(0, maxEntries);
    },
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
