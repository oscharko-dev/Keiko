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
function matchOpeningFence(line: string): OpenFence | undefined {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(stripFenceIndent(line));
  if (!match) return undefined;
  const [, run, infoString] = match as [string, string, string];
  const char = run.charAt(0) as "`" | "~";
  if (char === "`" && infoString.includes("`")) return undefined;
  return { char, length: run.length };
}

// A fence closes only on a line (after up to 3 leading spaces) consisting solely of a run of the
// SAME delimiter character, at least as long as the opening run, followed by nothing but trailing
// whitespace. Anything else — including a shorter or different-character run, or trailing text —
// is ordinary fenced content, not a close.
function isClosingFence(line: string, open: OpenFence): boolean {
  // `open.char` is always "`" or "~", neither a regex metacharacter, so no escaping is needed.
  const match = new RegExp(`^(${open.char}+)([ \\t]*)$`).exec(stripFenceIndent(line));
  if (!match) return false;
  const [, run] = match as [string, string, string];
  return run.length >= open.length;
}

// #3384 B5-7: a maintainer's own fenced-code-block quote of the marker syntax (e.g. a README-style
// example of the exact START/END comments) must never be mistaken for the real managed region — it
// is documentation, not a boundary this parser owns. Tracks CommonMark fence state line by line
// (matching the opening delimiter's character and length against every candidate close, so a
// shorter or different-character inner fence never closes an outer one) and returns every byte
// offset that falls strictly between an opening and closing fence delimiter line. An unterminated
// fence runs to the end of the body.
function fencedOffsets(body: string): ReadonlySet<number> {
  const fenced = new Set<number>();
  let offset = 0;
  let open: OpenFence | undefined;
  for (const line of body.split("\n")) {
    if (open === undefined) {
      open = matchOpeningFence(line);
    } else if (isClosingFence(line, open)) {
      open = undefined;
    } else {
      for (let i = 0; i <= line.length; i += 1) fenced.add(offset + i);
    }
    offset += line.length + 1;
  }
  return fenced;
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

function split(body: string): { prefix: string; region: string; suffix: string } | undefined {
  if (!containsPrDescriptionMarker(body)) return undefined;
  const fenced = bodyHasFence(body) ? fencedOffsets(body) : undefined;
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
/** Exact slices retain CRLF, BOM and every human-authored outside byte. No trim or normalization. */
export function reconcilePrDescriptionRegion(
  body: string,
  replacement: string,
): PrDescriptionRegionParts {
  const managed = split(replacement);
  if (managed?.prefix !== "" || managed.suffix !== "")
    throw new TypeError("Replacement must contain only the managed region");
  const previous = split(body);
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
