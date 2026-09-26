import { createHash } from "node:crypto";

export interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
}

const ENTRY = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([^\0]+)$/u;
const TREE_ENTRY = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u;

export function parseGitIndexEntries(output: string, tree: boolean): readonly IndexEntry[] {
  if (output === "") return [];
  if (output.includes("\uFFFD") || output.includes("[REDACTED"))
    throw new TypeError("git-index-identity-redacted");
  if (!output.endsWith("\0")) throw new TypeError("git-index-identity-incomplete");
  const entries = output
    .slice(0, -1)
    .split("\0")
    .map((line): IndexEntry => {
      const match = (tree ? TREE_ENTRY : ENTRY).exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new TypeError("git-index-identity-invalid");
      }
      return { mode: match[1], objectId: match[2], path: match[3] };
    });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new TypeError("git-index-identity-duplicate");
  }
  return entries;
}

/** One canonical full-index identity, shared by the live index and immutable tree readers. */
export function gitIndexTreeDigest(output: string, tree = false): string {
  return gitIndexEntriesDigest(parseGitIndexEntries(output, tree));
}
export function gitIndexEntriesDigest(entries: readonly IndexEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["keiko-git-index-v1", entries]))
    .digest("hex");
}

export function gitCommitMessageDigest(message: string): string {
  return createHash("sha256")
    .update(message.endsWith("\n") ? message : `${message}\n`)
    .digest("hex");
}

export function gitBlobObjectId(bytes: Uint8Array, hashLength: number): string {
  return createHash(hashLength === 64 ? "sha256" : "sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}
