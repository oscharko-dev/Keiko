import { Buffer } from "node:buffer";
import { resolveHostExecutable } from "./host-executable.mjs";

// Read a source set in one Git process. --batch frames blobs by byte length, so source text may
// contain arbitrary newlines (including strings that resemble the next object's header).
export function readGitSourceContent(commit, paths, root, execute) {
  const objects = paths.map((path) => `${commit}:${path}`);
  if (objects.some((object) => /[\r\n\0]/u.test(object))) {
    throw new TypeError("Git source object names must be single-line values");
  }
  if (objects.length === 0) return [];
  const output = execute(resolveHostExecutable("git"), ["cat-file", "--batch"], {
    cwd: root,
    input: `${objects.join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!Buffer.isBuffer(output)) throw new TypeError("Git source output must be bytes");
  let offset = 0;
  const files = paths.map((path) => {
    const headerEnd = output.indexOf(10, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^[a-f0-9]{40,64} blob (\d+)$/u.exec(header);
    if (headerEnd < offset || match === null) throw new TypeError("Git source blob is missing");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + Number(match[1]);
    if (!Number.isSafeInteger(contentEnd) || output[contentEnd] !== 10) {
      throw new TypeError("Git source blob is truncated");
    }
    offset = contentEnd + 1;
    // UTF-8 decoding replaces distinct malformed bytes with the same character. Base64 keeps
    // every Git byte (including invalid UTF-8 and BOMs) distinct in the canonical digest input.
    return { path, contentBase64: output.subarray(contentStart, contentEnd).toString("base64") };
  });
  if (offset !== output.length) throw new TypeError("Git source output contains extra bytes");
  return files;
}
