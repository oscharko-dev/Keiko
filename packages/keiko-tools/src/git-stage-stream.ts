import { createHash } from "node:crypto";
import {
  streamGitStageFile,
  type GitStageLargeFile,
  type GitStageReadOptions,
} from "@oscharko-dev/keiko-workspace/internal/git-index";

// Streaming counterparts of the in-memory byte helpers, for a regular file too large to be held
// whole. Each one reads through `streamGitStageFile` (no-follow, descriptor-validated, identity
// checked before and after), so memory holds one chunk and a file that changes while it is read
// fails closed as `git-stage-file-changed`.

const CR = 0x0d;
const LF = 0x0a;

function blobAlgorithm(hashLength: number): "sha1" | "sha256" {
  return hashLength === 64 ? "sha256" : "sha1";
}

/** The SHA-256 of the file's bytes, as the stage candidate digest records every file. */
export async function sha256OfLargeFile(
  root: string,
  file: GitStageLargeFile,
  options: GitStageReadOptions,
): Promise<string> {
  const hash = createHash("sha256");
  await streamGitStageFile(root, file, options, (chunk) => {
    hash.update(chunk);
  });
  return hash.digest("hex");
}

/**
 * The blob id Git computes for the file's raw bytes (`git hash-object --no-filters`), plus whether
 * the bytes hold a NUL (Git's own binary signal). Matches `gitBlobObjectId` of the same bytes.
 */
export async function blobIdOfLargeFile(
  root: string,
  file: GitStageLargeFile,
  hashLength: number,
  options: GitStageReadOptions,
): Promise<{ readonly objectId: string; readonly hasNul: boolean }> {
  const hash = createHash(blobAlgorithm(hashLength)).update(`blob ${String(file.size)}\0`);
  let hasNul = false;
  await streamGitStageFile(root, file, options, (chunk) => {
    hash.update(chunk);
    hasNul ||= chunk.includes(0);
  });
  return { objectId: hash.digest("hex"), hasNul };
}

/**
 * The blob id of the file's LF form (every CRLF line break reduced to LF) when every line break is
 * CRLF and no other CR occurs, otherwise `undefined`. It is the streaming form of the in-memory
 * `allLineBreaksCrlf` + `withoutCrlf` pair the exact staging uses to prove that Git's checkout
 * reverses a conversion byte for byte.
 */
export async function lfFormBlobIdOfLargeFile(
  root: string,
  file: GitStageLargeFile,
  hashLength: number,
  options: GitStageReadOptions,
): Promise<string | undefined> {
  const breaks = await countCrlfBreaks(root, file, options);
  if (breaks === undefined) return undefined;
  const hash = createHash(blobAlgorithm(hashLength)).update(`blob ${String(file.size - breaks)}\0`);
  await streamGitStageFile(root, file, options, (chunk) => {
    // Every CR is followed by an LF (checked above), so dropping each CR drops exactly the CRLF CRs.
    hash.update(chunk.filter((byte) => byte !== CR));
  });
  return hash.digest("hex");
}

// The number of line breaks when every one is CRLF and no other CR occurs and there is at least one.
async function countCrlfBreaks(
  root: string,
  file: GitStageLargeFile,
  options: GitStageReadOptions,
): Promise<number | undefined> {
  const state = { breaks: 0, previousCr: false, uniform: true };
  await streamGitStageFile(root, file, options, (chunk) => {
    for (const byte of chunk) {
      if (state.previousCr && byte !== LF) state.uniform = false;
      if (byte === LF) {
        if (!state.previousCr) state.uniform = false;
        state.breaks += 1;
      }
      state.previousCr = byte === CR;
    }
  });
  return state.uniform && !state.previousCr && state.breaks > 0 ? state.breaks : undefined;
}
