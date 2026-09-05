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

function repairedCounts(
  patch: { readonly stdout: string; readonly truncated: boolean },
): ReadonlyMap<string, { readonly additions: number; readonly deletions: number }> {
  const counts = new Map<string, { readonly additions: number; readonly deletions: number }>();
  const sections = splitUnifiedDiffSections(patch.stdout);
  sections.forEach((section, index) => {
    const header = parseUnifiedDiffFileHeader(section);
    if (header === undefined) {
      // A truncated read's trailing section can be cut mid-header — the same "last section may be
      // a truncation artifact" case gitChangeSnapshotEntries.ts's patchMap already treats as
      // expected, never a parser bug. Any other unparseable section is genuine malformed output.
      if (patch.truncated && index === sections.length - 1) return;
      throw new GitSnapshotReadError("malformed-output");
    }
    counts.set(snapshotFileKey(header.path, header.oldPath), sectionLineStatistics(section));
  });
  return counts;
}

// Git's numstat preserves '-' for an attribute-forced binary even with --text. Recover exact
// statistics from a separately bounded textual lane.
//
// Owner audit b2-14 — this lane used to re-read the WHOLE `--patch --unified=0` diff at the fixed
// SNAPSHOT_METADATA_BYTES (8 MB) non-truncating default, independent of the caller's own (possibly
// larger) `maxTotalBytes`: a comparison whose repair patch exceeded 8 MB threw "metadata-truncated"
// out of here unconditionally and failed the ENTIRE capture, even when the caller's own byte budget
// would have accepted it. Reading with `allowTruncation: true` instead lets an oversized repair
// patch degrade to a per-file fallback: a file whose section never arrived because the read was cut
// off keeps git's own attribute-forced binary classification (the exact value numstat already
// reported, and the one this function exists to override only when it CAN verify the correction)
// rather than crashing every other file in the same capture. A missing section on a COMPLETE
// (non-truncated) read stays a hard failure — that case is a real parser/data bug, not a byte cap.
async function repairLineStatistics(
  reader: GitSnapshotReader,
  revisions: SnapshotRevisions,
  entries: readonly SnapshotFileMetadata[],
): Promise<readonly SnapshotFileMetadata[]> {
  const patch = await readSnapshotGit(
    reader,
    snapshotDiffArgs(revisions, ["--patch", "--unified=0"]),
    undefined,
    true,
  );
  const counts = repairedCounts(patch);
  return entries.map((entry) => {
    if (entry.binary) return entry;
    const stats = counts.get(snapshotFileKey(entry.path, entry.oldPath));
    if (stats !== undefined) return { ...entry, ...stats };
    if (patch.truncated) return { ...entry, binary: true, additions: 0, deletions: 0 };
    throw new GitSnapshotReadError("malformed-output");
  });
}
