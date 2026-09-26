import {
  GIT_CHANGE_SNAPSHOT_MAX_LINES_PER_HUNK,
  GIT_CHANGE_SNAPSHOT_MAX_HUNK_HEADER_CHARS,
  GIT_CHANGE_SNAPSHOT_MAX_LINE_CHARS,
  gitChangeSnapshotEntryIdentityFields,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import type {
  GitChangeSnapshotEntry,
  GitChangeSnapshotHunk,
  GitChangeSnapshotLimits,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  parseUnifiedDiffFileHeader,
  parseUnifiedHunks,
  splitUnifiedDiffSections,
} from "./gitDiffParser.js";
import type { ParsedUnifiedHunk } from "./gitDiffParser.js";
import { snapshotFileKey } from "./gitChangeSnapshotMetadata.js";
import type { SnapshotFileMetadata } from "./gitChangeSnapshotMetadata.js";
import { GitSnapshotReadError } from "./gitChangeSnapshotReader.js";

export interface GitSnapshotContentFile {
  readonly evidenceId: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly hunks: readonly ParsedUnifiedHunk[];
}

interface FilePatch {
  readonly hunks: readonly ParsedUnifiedHunk[];
  readonly omittedHunks: number;
  readonly truncated: boolean;
  readonly bytes: number;
}

function patchFor(
  lines: readonly string[],
  limits: GitChangeSnapshotLimits,
  truncated: boolean,
): FilePatch {
  const normalized = lines.map((line) =>
    line.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/u, "$1"),
  );
  const bytes = Buffer.byteLength(normalized.join("\n"));
  if (bytes > limits.maxPatchBytes)
    return { hunks: [], omittedHunks: 0, truncated: true, bytes: 0 };
  const parsed = parseUnifiedHunks(normalized, {
    maxHunks: limits.maxHunksPerFile,
    maxLinesPerHunk: GIT_CHANGE_SNAPSHOT_MAX_LINES_PER_HUNK,
    maxHeaderChars: GIT_CHANGE_SNAPSHOT_MAX_HUNK_HEADER_CHARS,
    maxLineChars: GIT_CHANGE_SNAPSHOT_MAX_LINE_CHARS,
  });
  return {
    hunks: parsed.hunks,
    omittedHunks: parsed.droppedHunks,
    truncated: truncated || parsed.fatal || (parsed.malformed && parsed.droppedHunks === 0),
    bytes: retainedPatchBytes(parsed.hunks),
  };
}

function retainedPatchBytes(hunks: readonly ParsedUnifiedHunk[]): number {
  return hunks.reduce(
    (sum, hunk) =>
      sum +
      Buffer.byteLength(
        [
          hunk.header,
          ...hunk.lines.map((line) => `${line.kind === "meta" ? "" : " "}${line.text}`),
        ].join("\n"),
      ),
    0,
  );
}

function hunkEvidence(hunk: ParsedUnifiedHunk): GitChangeSnapshotHunk {
  const { oldStart, oldCount, newStart, newCount, lines } = hunk;
  return {
    hunkDigest: sha256Hex(canonicalise({ oldStart, oldCount, newStart, newCount, lines })),
    oldStart,
    oldCount,
    newStart,
    newCount,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
  };
}

function entryIdentity(
  meta: SnapshotFileMetadata,
): Pick<
  GitChangeSnapshotEntry,
  "pathDigest" | "oldMode" | "newMode" | "oldObjectId" | "newObjectId"
> {
  return {
    pathDigest: sha256Hex(meta.path),
    oldMode: meta.oldMode,
    newMode: meta.newMode,
    oldObjectId: meta.oldObjectId,
    newObjectId: meta.newObjectId,
  };
}

function pairedFields(meta: SnapshotFileMetadata): {
  readonly oldPathDigest: string;
  readonly similarity: number;
} {
  if (meta.oldPath === undefined || meta.similarity === undefined)
    throw new GitSnapshotReadError("malformed-output");
  return { oldPathDigest: sha256Hex(meta.oldPath), similarity: meta.similarity };
}

function isSubmodule(meta: SnapshotFileMetadata): boolean {
  return meta.oldMode === "160000" || meta.newMode === "160000";
}
function isModeChange(meta: SnapshotFileMetadata): boolean {
  return meta.oldObjectId === meta.newObjectId && meta.oldMode !== meta.newMode;
}

function isPatchTruncated(meta: SnapshotFileMetadata, patch: FilePatch): boolean {
  return meta.oldObjectId !== meta.newObjectId && patch.truncated;
}

function entryFor(meta: SnapshotFileMetadata, patch: FilePatch): GitChangeSnapshotEntry {
  const base = {
    ...entryIdentity(meta),
    evidenceId: "",
    additions: meta.additions,
    deletions: meta.deletions,
    hunks: patch.hunks.map(hunkEvidence),
    omittedHunks: patch.omittedHunks,
    truncated: isPatchTruncated(meta, patch),
  };
  const contentless = {
    ...base,
    additions: 0,
    deletions: 0,
    hunks: [],
    omittedHunks: 0,
    truncated: false,
  };
  const paired = meta.change === "rename" || meta.change === "copy";
  if (isSubmodule(meta)) {
    return {
      ...contentless,
      kind: "submodule",
      change: meta.change,
      omission: "submodule",
      ...(paired ? pairedFields(meta) : {}),
    };
  }
  if (meta.binary)
    return {
      ...contentless,
      kind: "binary",
      change: meta.change,
      omission: "binary",
      ...(paired ? pairedFields(meta) : {}),
    };
  if (isModeChange(meta)) return { ...contentless, kind: "mode-change" };
  const textual = {
    ...base,
    ...(base.truncated || patch.omittedHunks > 0 ? { omission: "byte-cap" as const } : {}),
  };
  if (paired) return { ...textual, kind: meta.change, ...pairedFields(meta) };
  return { ...textual, kind: meta.change };
}

function patchMap(
  text: string,
  truncated: boolean,
  limits: GitChangeSnapshotLimits,
): ReadonlyMap<string, FilePatch> {
  const result = new Map<string, FilePatch>();
  const sections = splitUnifiedDiffSections(text);
  sections.forEach((lines, index) => {
    const header = parseUnifiedDiffFileHeader(lines);
    if (header === undefined) return;
    const key = snapshotFileKey(header.path, header.oldPath);
    if (result.has(key)) throw new GitSnapshotReadError("malformed-output");
    result.set(key, patchFor(lines, limits, truncated && index === sections.length - 1));
  });
  return result;
}

export function snapshotEntries(
  metadata: readonly SnapshotFileMetadata[],
  text: string,
  processTruncated: boolean,
  limits: GitChangeSnapshotLimits,
): {
  readonly entries: readonly GitChangeSnapshotEntry[];
  readonly files: readonly GitSnapshotContentFile[];
  readonly bytes: number;
} {
  const patches = patchMap(text, processTruncated, limits);
  const entries: GitChangeSnapshotEntry[] = [];
  const files: GitSnapshotContentFile[] = [];
  let bytes = 0;
  for (const meta of metadata.slice(0, limits.maxFiles)) {
    const patch = patches.get(snapshotFileKey(meta.path, meta.oldPath)) ?? {
      hunks: [],
      omittedHunks: 0,
      truncated: true,
      bytes: 0,
    };
    const entry = entryFor(meta, patch);
    verifyEntryLineStatistics(entry);
    const evidenceId = sha256Hex(canonicalise(gitChangeSnapshotEntryIdentityFields(entry)));
    entries.push({ ...entry, evidenceId });
    files.push({
      evidenceId,
      path: meta.path,
      ...(meta.oldPath === undefined ? {} : { oldPath: meta.oldPath }),
      hunks: entry.hunks.length > 0 ? patch.hunks : [],
    });
    bytes += patch.bytes;
  }
  return { entries, files, bytes };
}

function verifyEntryLineStatistics(entry: GitChangeSnapshotEntry): void {
  if (entry.truncated || entry.omittedHunks > 0) return;
  const additions = entry.hunks.reduce((sum, hunk) => sum + hunk.additions, 0);
  const deletions = entry.hunks.reduce((sum, hunk) => sum + hunk.deletions, 0);
  if (entry.additions !== additions || entry.deletions !== deletions)
    throw new GitSnapshotReadError("malformed-output");
}
