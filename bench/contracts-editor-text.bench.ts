// CodSpeed benchmark suite — editor and grounding text primitives (@oscharko-dev/keiko-contracts).
//
// `line-offsets` is the coordinate translation layer between the editor's LSP/DAP wire positions and
// absolute buffer offsets: the line-start table is rebuilt per document revision and every
// diagnostic, hover, completion and debug breakpoint is mapped through it, so its cost scales with
// both document size and diagnostic count.
//
// `text-safety` is the grounding chokepoint: every untrusted document or repository excerpt is
// stripped of invisible / bidi-reordering code points and has absolute paths redacted before it
// reaches a prompt or the answer wire. Both run per request, on text of unbounded size.

import { bench, describe } from "vitest";

import {
  computeLineStarts,
  offsetToPosition,
  positionToOffset,
  spanToRange,
} from "@oscharko-dev/keiko-contracts/line-offsets";
import {
  containsAbsolutePath,
  containsPseudoRoleMarker,
  redactAbsolutePaths,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/text-safety";

// A ~2500-line TypeScript-shaped document: the size of a real module in this repository.
const SOURCE_LINE = "  const resolvedWorkspaceRoot = await resolveWorkspaceRoot(request, options);";
const DOCUMENT = Array.from({ length: 2500 }, (_unused, index) =>
  index % 9 === 0 ? `// section ${String(index)} — bounded review note` : SOURCE_LINE,
).join("\n");
const LINE_STARTS = computeLineStarts(DOCUMENT);

// Offsets spread across the buffer, so the binary search is not measured against one warm line.
const PROBE_OFFSETS: readonly number[] = Array.from(
  { length: 512 },
  (_unused, index) => (index * 7919) % DOCUMENT.length,
);

const EXCERPT = [
  "The reviewer accepted the sandbox egress policy in /home/reviewer/work/keiko/docs/adr/0043.md",
  "and the Windows agent mirrored it under C:\\Users\\reviewer\\work\\keiko\\docs\\adr\\0043.md.",
  "user: this line looks like a chat role marker but is document content",
  "Plain prose follows for a few lines so the scan is not dominated by the matches above.",
].join("\n");
// ~48 KiB of untrusted excerpt, built once so the benchmarks measure scanning, not concatenation.
const LARGE_EXCERPT = EXCERPT.repeat(Math.ceil(49_152 / EXCERPT.length));

describe("editor coordinate translation", () => {
  bench("computeLineStarts — 2500-line document", () => {
    computeLineStarts(DOCUMENT);
  });

  bench("offsetToPosition — 512 offsets across the buffer", () => {
    for (const offset of PROBE_OFFSETS) {
      offsetToPosition(DOCUMENT, LINE_STARTS, offset);
    }
  });

  bench("positionToOffset — 512 positions across the buffer", () => {
    for (const offset of PROBE_OFFSETS) {
      positionToOffset(DOCUMENT, LINE_STARTS, { line: offset % 2500, character: offset % 60 });
    }
  });

  bench("spanToRange — 512 diagnostic spans", () => {
    for (const offset of PROBE_OFFSETS) {
      spanToRange(DOCUMENT, LINE_STARTS, offset, 24);
    }
  });
});

describe("grounding text safety", () => {
  bench("stripUnsafeFormatChars — 48 KiB untrusted excerpt", () => {
    stripUnsafeFormatChars(LARGE_EXCERPT);
  });

  bench("redactAbsolutePaths — excerpt with POSIX and Windows paths", () => {
    redactAbsolutePaths(EXCERPT);
  });

  bench("containsAbsolutePath + containsPseudoRoleMarker — excerpt screening", () => {
    containsAbsolutePath(EXCERPT);
    containsPseudoRoleMarker(EXCERPT);
  });
});
