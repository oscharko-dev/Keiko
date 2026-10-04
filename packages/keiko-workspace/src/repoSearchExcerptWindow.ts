import { RepoSearchInvalidRangeError } from "./errors.js";

// Query anchors select a bounded view after the workspace owner has classified, decoded, and
// redacted the entire eligible file. Byte slicing never invents line breaks or source line numbers.

interface AnchoredByteWindow {
  readonly anchoredWindowApplied?: boolean | undefined;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

// This is the existing planner/literal request envelope, not a source traversal limit.
const MAX_EXCERPT_ANCHOR_CHARACTERS = 4096;

export function validateExcerptAnchors(anchors: readonly string[]): readonly string[] {
  if (!Array.isArray(anchors)) throw new RepoSearchInvalidRangeError("invalid excerpt anchors");
  const unique = new Set<string>();
  let characters = 0;
  for (const anchor of anchors) {
    if (typeof anchor !== "string" || anchor.length === 0)
      throw new RepoSearchInvalidRangeError("invalid excerpt anchors");
    if (unique.has(anchor)) continue;
    characters += anchor.length + (unique.size === 0 ? 0 : 1);
    if (characters > MAX_EXCERPT_ANCHOR_CHARACTERS)
      throw new RepoSearchInvalidRangeError("excerpt anchors too long");
    unique.add(anchor);
  }
  return [...unique];
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function boundedUtf8Offsets(
  bytes: Uint8Array,
  anchorOffset: number,
  maxBytes: number,
): readonly [number, number] {
  let start = Math.max(0, anchorOffset - Math.floor(maxBytes / 3));
  start = Math.min(start, Math.max(0, bytes.length - maxBytes));
  while (isContinuationByte(bytes[start])) start += 1;
  let end = Math.min(bytes.length, start + maxBytes);
  while (end > start && isContinuationByte(bytes[end])) end -= 1;
  return [start, end];
}

export function anchoredExcerptByteWindow(
  content: string,
  anchors: readonly string[],
  maxBytes: number,
  sourceStartLine: number,
): AnchoredByteWindow | undefined {
  const window = anchoredExcerptByteWindows(
    content,
    anchors,
    { maxBytes, maxWindows: 1, maxTotalBytes: maxBytes },
    sourceStartLine,
  )?.[0];
  return window?.anchoredWindowApplied === true ? window : undefined;
}

interface AnchorRange {
  readonly start: number;
  readonly end: number;
  readonly priority: number;
}

interface ByteWindow {
  readonly start: number;
  readonly end: number;
}

function matchedAnchorRanges(content: string, anchors: readonly string[]): readonly AnchorRange[] {
  const ranges = new Map<number, AnchorRange>();
  for (const [priority, anchor] of anchors.entries()) {
    const pattern = anchor.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    const match = new RegExp(pattern, "iu").exec(content);
    if (match === null) continue;
    const previous = ranges.get(match.index);
    ranges.set(match.index, {
      start: match.index,
      end: Math.max(match.index + match[0].length, previous?.end ?? 0),
      priority: previous?.priority ?? priority,
    });
  }
  return [...ranges.values()];
}

function utf8CharacterBytes(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code > 0xffff) return 4;
  if (code > 0x7ff) return 3;
  return code > 0x7f ? 2 : 1;
}

function anchorByteRanges(content: string, ranges: readonly AnchorRange[]): readonly AnchorRange[] {
  const positions = [...new Set(ranges.flatMap((range) => [range.start, range.end]))].sort(
    (a, b) => a - b,
  );
  const offsets = new Map<number, number>();
  let position = 0;
  let characters = 0;
  let bytes = 0;
  for (const character of content) {
    while (position < positions.length && (positions[position] ?? Infinity) <= characters) {
      offsets.set(positions[position] ?? 0, bytes);
      position += 1;
    }
    if (position === positions.length) break;
    characters += character.length;
    bytes += utf8CharacterBytes(character);
  }
  while (position < positions.length) {
    offsets.set(positions[position] ?? 0, bytes);
    position += 1;
  }
  return ranges.map((range) => ({
    ...range,
    start: offsets.get(range.start) ?? 0,
    end: offsets.get(range.end) ?? 0,
  }));
}

function clusterAnchorRanges(
  ranges: readonly AnchorRange[],
  maxBytes: number,
): readonly AnchorRange[] {
  const clusters: AnchorRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.priority - b.priority)) {
    const previous = clusters.at(-1);
    if (previous !== undefined && range.end - previous.start <= maxBytes) {
      clusters[clusters.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
        priority: Math.min(previous.priority, range.priority),
      };
    } else clusters.push(range);
  }
  return clusters;
}

function anchorWindowGrants(
  ranges: readonly AnchorRange[],
  maxBytes: number,
  totalBytes: number,
): readonly number[] {
  const required = ranges.map((range) => Math.min(maxBytes, range.end - range.start));
  const minimum = required.reduce((sum, bytes) => sum + bytes, 0);
  const share = Math.min(maxBytes, Math.floor(totalBytes / ranges.length));
  if (minimum > totalBytes || required.every((bytes) => bytes <= share))
    return ranges.map(() => share);
  let remaining = totalBytes - minimum;
  return required.map((bytes, index) => {
    const extra = Math.min(maxBytes - bytes, Math.ceil(remaining / (required.length - index)));
    remaining -= extra;
    return bytes + extra;
  });
}

function boundedAnchorWindow(
  bytes: Uint8Array,
  range: AnchorRange,
  grant: number,
  left: number,
  right: number,
): ByteWindow {
  const [preferred] = boundedUtf8Offsets(bytes, range.start, grant);
  const contextBytes = Math.max(0, grant - (range.end - range.start));
  const afterAnchors = Math.floor((contextBytes * 2) / 3);
  const coversAnchors = range.end - range.start <= grant;
  let start = Math.max(left, preferred, coversAnchors ? range.end + afterAnchors - grant : 0);
  start = Math.max(left, Math.min(start, right - grant));
  while (isContinuationByte(bytes[start])) start += 1;
  let end = Math.min(right, start + grant);
  while (end > start && isContinuationByte(bytes[end])) end -= 1;
  return { start, end };
}

function anchorByteWindows(
  bytes: Uint8Array,
  ranges: readonly AnchorRange[],
  grants: readonly number[],
): readonly ByteWindow[] {
  const assigned = ranges.map((range, index) => ({ range, grant: grants[index] ?? 0 }));
  assigned.sort((a, b) => a.range.start - b.range.start);
  return assigned.flatMap(({ range, grant }, index) => {
    if (grant === 0) return [];
    const previous = assigned[index - 1]?.range;
    const next = assigned[index + 1]?.range;
    const left = previous === undefined ? 0 : Math.floor((previous.end + range.start) / 2);
    const right = next === undefined ? bytes.length : Math.floor((range.end + next.start) / 2);
    const window = boundedAnchorWindow(bytes, range, grant, left, right);
    return window.start < window.end ? [window] : [];
  });
}

function projectByteWindows(
  bytes: Uint8Array,
  windows: readonly ByteWindow[],
  sourceStartLine: number,
): readonly AnchoredByteWindow[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = sourceStartLine;
  let position = 0;
  return windows.map((window) => {
    for (; position < window.start; position += 1) if (bytes[position] === 10) line += 1;
    const content = decoder.decode(bytes.subarray(window.start, window.end));
    return {
      content,
      startLine: line,
      endLine: line + content.split("\n").length - 1,
      anchoredWindowApplied: window.start > 0,
    };
  });
}

// Windows share one classified/decoded source and disjoint byte regions. Nearby anchors count
// once before allocating the caller's byte budget; output remains in actual source order.
export function anchoredExcerptByteWindows(
  content: string,
  anchors: readonly string[],
  limits: {
    readonly maxBytes: number;
    readonly maxWindows: number;
    readonly maxTotalBytes: number;
  },
  sourceStartLine: number,
): readonly AnchoredByteWindow[] | undefined {
  const unique = validateExcerptAnchors(anchors);
  const maxBytes = Math.min(limits.maxBytes, limits.maxTotalBytes);
  if (maxBytes <= 0 || unique.length === 0 || limits.maxWindows <= 0) return undefined;
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= maxBytes)
    return [
      {
        content,
        startLine: sourceStartLine,
        endLine: sourceStartLine + content.split("\n").length - 1,
        anchoredWindowApplied: false,
      },
    ];
  const ranges = anchorByteRanges(content, matchedAnchorRanges(content, unique));
  const selected = [...clusterAnchorRanges(ranges, maxBytes)]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, limits.maxWindows);
  const grants = anchorWindowGrants(selected, maxBytes, limits.maxTotalBytes);
  const windows = anchorByteWindows(bytes, selected, grants);
  return windows.length === 0 ? undefined : projectByteWindows(bytes, windows, sourceStartLine);
}
