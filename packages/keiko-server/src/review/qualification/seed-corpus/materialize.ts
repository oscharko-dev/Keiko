// The plain file-tree materializer of the synthetic review seed corpus (Issue #4132): turns one side
// of a corpus case into files under a directory the caller owns. The writer is injected, so the
// qualification run that ships this corpus (Issue #4137) decides where and how files are written
// and logs that work under its own Activity Log operation; this module only validates and plans.

import { posix } from "node:path";

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

export interface ReviewSeedTreeEntry {
  readonly path: string;
  readonly content: string;
}

export interface ReviewSeedTreeWriter {
  readonly makeDirectory: (absolutePath: string) => Promise<void>;
  readonly writeFile: (absolutePath: string, content: string) => Promise<void>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function assertRelativePath(path: string): void {
  const segments = path.split("/");
  const safe = segments.every(
    (segment) => SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..",
  );
  if (!safe) throw new Error("review seed corpus: a fixture path must be a plain relative path");
}

/** The validated entries of one tree, in a stable path order. */
export function planReviewSeedTree(
  files: Readonly<Record<string, string>>,
): readonly ReviewSeedTreeEntry[] {
  const paths = Object.keys(files).sort(compareStrings);
  return paths.map((path) => {
    assertRelativePath(path);
    return { path, content: files[path] ?? "" };
  });
}

/** Writes one tree under `root` (a POSIX absolute path) and returns the written paths. */
export async function materializeReviewSeedTree(
  files: Readonly<Record<string, string>>,
  root: string,
  writer: ReviewSeedTreeWriter,
): Promise<readonly string[]> {
  if (!posix.isAbsolute(root)) throw new Error("review seed corpus: the root must be absolute");
  const written: string[] = [];
  for (const entry of planReviewSeedTree(files)) {
    const target = posix.join(root, entry.path);
    await writer.makeDirectory(posix.dirname(target));
    await writer.writeFile(target, entry.content);
    written.push(target);
  }
  return written;
}
