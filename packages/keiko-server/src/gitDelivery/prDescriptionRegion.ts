import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  containsPrDescriptionMarker,
  PR_DESCRIPTION_REGION_START as START,
  PR_DESCRIPTION_REGION_END as END,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-region";
import { hasIssueClosingDirective } from "@oscharko-dev/keiko-contracts/runtime/issue-closing-directive";

export interface PrDescriptionRegionParts {
  readonly prefix: string;
  readonly suffix: string;
  readonly finalBody: string;
  readonly outsideRegionDigest: string;
}
interface OpenFence {
  readonly char: "`" | "~";
  readonly length: number;
}
interface FenceAnalysis {
  readonly offsets: ReadonlySet<number>;
  readonly unterminated: boolean;
}

// CommonMark/GFM fence delimiters allow up to 3 leading spaces before the fence run.
// https://github.github.com/gfm/#fenced-code-blocks
function stripFenceIndent(line: string): string {
  let i = 0;
  while (i < 3 && line.charAt(i) === " ") i += 1;
  return line.slice(i);
}

// A fence opens on a line with (after up to 3 leading spaces) a run of >=3 identical backticks or
// tildes, optionally followed by an info string. A backtick fence's info string may not itself
// contain a backtick (that would be ambiguous with the fence run); a tilde fence has no such
// restriction.
function fenceRun(line: string): OpenFence | undefined {
  const char = line.charAt(0);
  if (char !== "`" && char !== "~") return undefined;
  let length = 1;
  while (line.charAt(length) === char) length += 1;
  return { char, length };
}

function matchOpeningFence(line: string): OpenFence | undefined {
  const stripped = stripFenceIndent(line);
  const run = fenceRun(stripped);
  if (run === undefined || run.length < 3) return undefined;
  if (run.char === "`" && stripped.slice(run.length).includes("`")) return undefined;
  return run;
}

// Count the delimiter once, then inspect only the suffix. Adjacent greedy expressions can
// backtrack on hostile long fence lines; CommonMark allows only spaces/tabs after a close.
function isClosingFence(line: string, open: OpenFence): boolean {
  const stripped = stripFenceIndent(line);
  const run = fenceRun(stripped);
  return (
    run?.char === open.char &&
    run.length >= open.length &&
    /^[ \t]*$/u.test(stripped.slice(run.length))
  );
}

// #3384 B5-7: a maintainer's own fenced-code-block quote of the marker syntax (e.g. a README-style
// example of the exact START/END comments) must never be mistaken for the real managed region — it
// is documentation, not a boundary this parser owns. Tracks CommonMark fence state line by line
// (matching the opening delimiter's character and length against every candidate close, so a
// shorter or different-character inner fence never closes an outer one) and returns every byte
// offset that falls strictly between an opening and closing fence delimiter line. An unterminated
// fence runs to the end of the body.
function analyseFences(body: string): FenceAnalysis {
  const fenced = new Set<number>();
  let offset = 0;
  let open: OpenFence | undefined;
  for (const line of body.split("\n")) {
    // A CRLF body still splits on "\n" alone, leaving a trailing "\r" as part of `line`. That "\r"
    // is line-terminator noise, not fence content, so match against it stripped while still
    // advancing `offset` by the original (untouched) line length.
    const logical = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (open === undefined) {
      open = matchOpeningFence(logical);
    } else if (isClosingFence(logical, open)) {
      open = undefined;
    } else {
      for (let i = 0; i <= line.length; i += 1) fenced.add(offset + i);
    }
    offset += line.length + 1;
  }
  return { offsets: fenced, unterminated: open !== undefined };
}

function bodyHasFence(body: string): boolean {
  return body.includes("```") || body.includes("~~~");
}

// Finds the first occurrence of `marker` that does NOT fall inside a fenced span, skipping any
// fenced occurrence (a documentation example) to find a genuine, later real marker instead of
// bailing out entirely. Returns -1 when every occurrence is fenced.
function firstUnfencedIndex(body: string, marker: string, fenced: ReadonlySet<number>): number {
  let from = 0;
  for (;;) {
    const index = body.indexOf(marker, from);
    if (index < 0) return -1;
    if (!fenced.has(index)) return index;
    from = index + 1;
  }
}

// Locates the real (non-fenced) START/END pair, when one exists. Only gates on fence membership
// when a fence delimiter is actually present, so the common unfenced body pays no extra cost.
// Returns undefined when every marker occurrence in a fenced body is inside a fence — pure
// documentation, no managed region at all — so `split` never mistakes it for a malformed one.
function findMarkerBounds(
  body: string,
  fenced: ReadonlySet<number> | undefined,
): { start: number; end: number } | undefined {
  const start =
    fenced === undefined ? body.indexOf(START) : firstUnfencedIndex(body, START, fenced);
  const end = fenced === undefined ? body.indexOf(END) : firstUnfencedIndex(body, END, fenced);
  if (start < 0 && end < 0 && fenced !== undefined) return undefined;
  return { start, end };
}

// Same fence-aware interpretation as `findMarkerBounds`: a byte range that falls entirely inside a
// fenced span (e.g. a maintainer's documentation example) must never trip the duplicate/nested
// check just because the plain marker regex still matches inside a fence. `rangeStart` is this
// slice's offset in the original body, so it can be checked against the body-wide `fenced` set.
function containsUnfencedMarker(
  slice: string,
  rangeStart: number,
  fenced: ReadonlySet<number> | undefined,
): boolean {
  if (fenced === undefined) return containsPrDescriptionMarker(slice);
  const chars: string[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    if (!fenced.has(rangeStart + i)) chars.push(slice.charAt(i));
  }
  return containsPrDescriptionMarker(chars.join(""));
}

function split(
  body: string,
  analysis?: FenceAnalysis,
): { prefix: string; region: string; suffix: string } | undefined {
  if (!containsPrDescriptionMarker(body)) return undefined;
  const fenced = analysis?.offsets;
  const bounds = findMarkerBounds(body, fenced);
  if (bounds === undefined) return undefined;
  const { start, end } = bounds;
  if (start < 0 || end < start) throw new TypeError("Malformed PR description region");
  const prefix = body.slice(0, start);
  const region = body.slice(start + START.length, end);
  const suffix = body.slice(end + END.length);
  const isDuplicate =
    containsUnfencedMarker(prefix, 0, fenced) ||
    containsUnfencedMarker(region, start + START.length, fenced) ||
    containsUnfencedMarker(suffix, end + END.length, fenced);
  if (isDuplicate) throw new TypeError("Duplicate or nested PR description region");
  if (hasIssueClosingDirective(region))
    throw new TypeError("Closing directive inside replaceable PR description region");
  return { prefix, region, suffix };
}

function existingRegion(body: string): ReturnType<typeof split> {
  const analysis = bodyHasFence(body) ? analyseFences(body) : undefined;
  const previous = split(body, analysis);
  if (previous === undefined && analysis?.unterminated === true) {
    throw new TypeError("Unterminated fenced code block prevents safe PR description insertion");
  }
  return previous;
}
/** Exact slices retain CRLF, BOM and every human-authored outside byte. No trim or normalization. */
export function reconcilePrDescriptionRegion(
  body: string,
  replacement: string,
): PrDescriptionRegionParts {
  const managed = split(replacement);
  if (managed?.prefix !== "" || managed.suffix !== "")
    throw new TypeError("Replacement must contain only the managed region");
  const previous = existingRegion(body);
  const prefix = previous?.prefix ?? body;
  const suffix = previous?.suffix ?? "";
  const separator = previous === undefined && body !== "" ? "\n\n" : "";
  return {
    prefix,
    suffix,
    finalBody: prefix + separator + replacement + suffix,
    outsideRegionDigest: sha256Hex(canonicalise({ prefix: prefix + separator, suffix })),
  };
}
