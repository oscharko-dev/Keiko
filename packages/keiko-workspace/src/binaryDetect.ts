// NUL-byte heuristic for distinguishing text from binary file content (Epic #177, Issue #179).
// Real UTF-8 text and most legacy single-byte encodings do not contain NUL bytes. UTF-16 IS
// classified as binary by this heuristic, which is acceptable for the repo-search facade: the
// workspace package treats source files as UTF-8 throughout (the `readFileUtf8` boundary). A
// UTF-16-encoded source file would already be decoded with replacement characters and is not a
// supported input shape. PNG, JPEG, ELF, EXE, PDF, and similar formats also embed NULs in their
// first kilobyte. Same heuristic git uses when deciding whether to display a diff or "Binary
// files differ". Pure synchronous scan — no IO.

export interface BinaryProbeOptions {
  readonly maxProbeBytes: number;
}

export const DEFAULT_BINARY_PROBE: BinaryProbeOptions = {
  maxProbeBytes: 512,
} as const;

export function looksBinary(bytes: Uint8Array, options?: BinaryProbeOptions): boolean {
  const limit = Math.min(
    bytes.length,
    options?.maxProbeBytes ?? DEFAULT_BINARY_PROBE.maxProbeBytes,
  );
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
