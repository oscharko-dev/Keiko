import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** One read's size: a payload of any admitted size is hashed in this much memory (#4492). */
export const FILE_SHA256_CHUNK_BYTES = 1024 * 1024;

/**
 * The SHA-256 of a file's bytes, read in fixed chunks. A portable payload file may be up to 1 GiB
 * (the Windows OpenCode executable is 278 MB), so no digest reader buffers a whole file.
 */
export function sha256FileSync(path: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(FILE_SHA256_CHUNK_BYTES);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}
