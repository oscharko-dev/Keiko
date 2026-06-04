// NUL-byte heuristic for distinguishing text from binary file content (Epic #177, Issue #179).
// Real text files in UTF-8 or UTF-16-without-BOM do not contain 0x00 bytes; PNG, JPEG, ELF, EXE,
// PDF, and similar formats embed NULs in their first kilobyte. Same heuristic git uses when
// deciding whether to display a diff or "Binary files differ". Pure synchronous scan — no IO.

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
