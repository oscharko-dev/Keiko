import type { SnapshotFileMetadata } from "./gitChangeSnapshotMetadata.js";
import {
  GitSnapshotReadError,
  readSnapshotGit,
  snapshotDiffArgs,
} from "./gitChangeSnapshotReader.js";
import type { GitSnapshotReader, SnapshotRevisions } from "./gitChangeSnapshotReader.js";
import { parseUnifiedDiffFileHeader, splitUnifiedDiffSections } from "./gitDiffParser.js";
import { snapshotFileKey } from "./gitChangeSnapshotMetadata.js";

const EMPTY_OBJECT = "0".repeat(40);
// Git's built-in binary heuristic: a NUL among the first 8000 bytes on either side.
const BINARY_PREFIX_BYTES = 8000;

async function binaryObject(
  reader: GitSnapshotReader,
  objectId: string,
  mode: string,
): Promise<boolean> {
  if (objectId === EMPTY_OBJECT || mode === "160000") return false;
  const result = await readSnapshotGit(
    reader,
    ["cat-file", "blob", objectId],
    BINARY_PREFIX_BYTES,
    true,
  );
  return result.stdout.includes("\0");
}

/** Compare object bytes rather than .git/info/attributes or repository-local diff driver config. */
export async function resolveSnapshotBinaryFiles(
  reader: GitSnapshotReader,
  metadata: readonly SnapshotFileMetadata[],
  maxFiles: number,
  revisions: SnapshotRevisions,
): Promise<readonly SnapshotFileMetadata[]> {
  const entries: SnapshotFileMetadata[] = [];
  let needsStatistics = false;
  for (const entry of metadata.slice(0, maxFiles)) {
    const oldBinary = await binaryObject(reader, entry.oldObjectId, entry.oldMode);
    const binary = oldBinary || (await binaryObject(reader, entry.newObjectId, entry.newMode));
    needsStatistics ||= entry.binary && !binary;
    entries.push({ ...entry, binary, ...(binary ? { additions: 0, deletions: 0 } : {}) });
  }
  const resolved = needsStatistics
    ? await repairLineStatistics(reader, revisions, entries)
    : entries;
  return [...resolved, ...metadata.slice(maxFiles)];
}

function sectionLineStatistics(lines: readonly string[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) additions += 1;
    else if (inHunk && line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

// Git's numstat preserves '-' for an attribute-forced binary even with --text. Recover exact
// statistics from a separately bounded textual lane; if it cannot finish, fail closed.
async function repairLineStatistics(
  reader: GitSnapshotReader,
  revisions: SnapshotRevisions,
  entries: readonly SnapshotFileMetadata[],
): Promise<readonly SnapshotFileMetadata[]> {
  const patch = await readSnapshotGit(
    reader,
    snapshotDiffArgs(revisions, ["--patch", "--unified=0"]),
  );
  const counts = new Map<string, { readonly additions: number; readonly deletions: number }>();
  for (const section of splitUnifiedDiffSections(patch.stdout)) {
    const header = parseUnifiedDiffFileHeader(section);
    if (header === undefined) throw new GitSnapshotReadError("malformed-output");
    counts.set(snapshotFileKey(header.path, header.oldPath), sectionLineStatistics(section));
  }
  return entries.map((entry) => {
    if (entry.binary) return entry;
    const stats = counts.get(snapshotFileKey(entry.path, entry.oldPath));
    if (stats === undefined) throw new GitSnapshotReadError("malformed-output");
    return { ...entry, ...stats };
  });
}
