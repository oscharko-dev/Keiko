import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/**
 * One reader for the operator's registries in Keiko's state directory (the MCP server registry,
 * the native plugin registry): a file owned by the user Keiko runs as and writable by nobody else,
 * opened without following a link and checked on the open descriptor, so the bytes read are the
 * bytes of the file that was checked. A missing file is `undefined`; a file Keiko cannot trust is a
 * closed refusal, never a partial read.
 */
export const OWNER_PRIVATE_FILE_REFUSALS = [
  "not-regular-file",
  "not-owner-private",
  "too-large",
] as const;
export type OwnerPrivateFileRefusal = (typeof OWNER_PRIVATE_FILE_REFUSALS)[number];

/** A registry file Keiko refuses, with the closed reason; the message never quotes the file. */
export class OwnerPrivateFileRefused extends Error {
  public constructor(public readonly reason: OwnerPrivateFileRefusal) {
    super(`owner-private-file-${reason}`);
    this.name = "OwnerPrivateFileRefused";
  }
}

export function readOwnerPrivateFile(path: string, maxBytes: number): Buffer | undefined {
  const probe = lstatSync(path, { throwIfNoEntry: false });
  if (probe === undefined) return undefined;
  if (!probe.isFile()) throw new OwnerPrivateFileRefused("not-regular-file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readCheckedDescriptor(descriptor, maxBytes);
  } finally {
    closeSync(descriptor);
  }
}

function readCheckedDescriptor(descriptor: number, maxBytes: number): Buffer {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) throw new OwnerPrivateFileRefused("not-regular-file");
  const ownUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.uid !== ownUid || (stat.mode & 0o022) !== 0)
    throw new OwnerPrivateFileRefused("not-owner-private");
  if (stat.size > maxBytes) throw new OwnerPrivateFileRefused("too-large");
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}
