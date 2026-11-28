import { createHash } from "node:crypto";
import {
  streamGitStageFile,
  type GitStageLargeFile,
  type GitStageReadOptions,
} from "@oscharko-dev/keiko-workspace/internal/git-index";

// Streaming counterparts of the in-memory byte helpers, for a regular file too large to be held
// whole. Each one reads through `streamGitStageFile` (no-follow, descriptor-validated, identity
// checked before and after, cancellable between chunks), so memory holds one chunk and a file that
// changes while it is read fails closed as `git-stage-file-changed`.

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

/** What one pass over a large file's bytes establishes. */
export interface LargeFileAnalysis {
  // The blob id Git computes for the raw bytes (`hash-object --no-filters`).
  readonly objectId: string;
  // Whether the bytes hold a NUL (Git's own binary signal).
  readonly hasNul: boolean;
  // The number of line breaks when every one is CRLF, no other CR occurs and there is at least one;
  // otherwise `undefined`. It is the streaming form of the in-memory `allLineBreaksCrlf`.
  readonly crlfBreaks: number | undefined;
  // Whether a line feed without a carriage return before it occurs, and whether a carriage return
  // without a line feed after it occurs: the two shapes a CRLF checkout would change or leave alone.
  readonly loneLf: boolean;
  readonly loneCr: boolean;
}

/**
 * One streamed pass: the raw blob id, the NUL probe and the CRLF shape. The id doubles as the
 * independent check of what Git itself read by path: a Git object id that differs from the id of
 * the bytes this validated descriptor delivers means the file Git read was not this file.
 */
export async function analyzeLargeFile(
  root: string,
  file: GitStageLargeFile,
  hashLength: number,
  options: GitStageReadOptions,
): Promise<LargeFileAnalysis> {
  const hash = createHash(blobAlgorithm(hashLength)).update(`blob ${String(file.size)}\0`);
  const state = {
    hasNul: false,
    breaks: 0,
    previousCr: false,
    uniform: true,
    loneLf: false,
    loneCr: false,
  };
  await streamGitStageFile(root, file, options, (chunk) => {
    hash.update(chunk);
    state.hasNul ||= chunk.includes(0);
    for (const byte of chunk) {
      if (state.previousCr && byte !== LF) {
        state.uniform = false;
        state.loneCr = true;
      }
      if (byte === LF) {
        if (!state.previousCr) {
          state.uniform = false;
          state.loneLf = true;
        }
        state.breaks += 1;
      }
      state.previousCr = byte === CR;
    }
  });
  const crlf = state.uniform && !state.previousCr && state.breaks > 0;
  return {
    objectId: hash.digest("hex"),
    hasNul: state.hasNul,
    crlfBreaks: crlf ? state.breaks : undefined,
    loneLf: state.loneLf,
    loneCr: state.loneCr || state.previousCr,
  };
}

/**
 * The raw blob id and the NUL probe of a large file (the status comparison and a diff side). Neither
 * needs the line-ending shape, so this pass only hashes and probes: the byte-by-byte CRLF walk of
 * `analyzeLargeFile` belongs to the staging paths that need a conversion proof.
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
 * The blob id of the file's LF form (every CRLF line break reduced to LF), for a file whose line
 * breaks are all CRLF (`crlfBreaks`, from `analyzeLargeFile`). It is the streaming form of the
 * in-memory `withoutCrlf` the exact staging uses to prove that Git's checkout reverses a conversion
 * byte for byte.
 */
export async function lfFormBlobIdOfLargeFile(
  root: string,
  file: GitStageLargeFile,
  hashLength: number,
  crlfBreaks: number,
  options: GitStageReadOptions,
): Promise<string> {
  const hash = createHash(blobAlgorithm(hashLength)).update(
    `blob ${String(file.size - crlfBreaks)}\0`,
  );
  await streamGitStageFile(root, file, options, (chunk) => {
    // Every CR is followed by an LF (`crlfBreaks` is only set then), so dropping each CR drops
    // exactly the CRLF CRs.
    hash.update(chunk.filter((byte) => byte !== CR));
  });
  return hash.digest("hex");
}
