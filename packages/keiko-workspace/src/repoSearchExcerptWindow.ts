// Query anchors select a bounded view after the workspace owner has classified, decoded, and
// redacted the entire eligible file. Byte slicing never invents line breaks or source line numbers.

interface AnchoredByteWindow {
  readonly anchoredWindowApplied?: boolean | undefined;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

function firstAnchorIndex(content: string, anchors: readonly string[]): number | undefined {
  for (const anchor of anchors) {
    const pattern = anchor.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    const match = new RegExp(pattern, "iu").exec(content);
    if (match !== null) return match.index;
  }
  return undefined;
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
  if (maxBytes === 0) return undefined;
  const index = firstAnchorIndex(content, anchors);
  if (index === undefined) return undefined;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const anchorOffset = encoder.encode(content.slice(0, index)).length;
  if (anchorOffset < Math.floor(maxBytes / 2)) return undefined;
  const [start, end] = boundedUtf8Offsets(bytes, anchorOffset, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const before = decoder.decode(bytes.subarray(0, start));
  const excerpt = decoder.decode(bytes.subarray(start, end));
  const startLine = sourceStartLine + before.split("\n").length - 1;
  return {
    content: excerpt,
    startLine,
    endLine: startLine + excerpt.split("\n").length - 1,
  };
}

interface PositionedByteWindow {
  readonly start: number;
  readonly end: number;
  readonly excerpt: AnchoredByteWindow;
}

interface AnchorRange {
  readonly start: number;
  readonly end: number;
}

function matchedAnchorRanges(content: string, anchors: readonly string[]): readonly AnchorRange[] {
  const ranges = new Map<number, AnchorRange>();
  for (const anchor of anchors) {
    if (anchor.length === 0) continue;
    const pattern = anchor.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    const match = new RegExp(pattern, "iu").exec(content);
    if (match === null) continue;
    const end = Math.max(match.index + match[0].length, ranges.get(match.index)?.end ?? 0);
    ranges.set(match.index, { start: match.index, end });
  }
  return [...ranges.values()];
}

function positionedByteWindow(
  bytes: Uint8Array,
  offset: number,
  maxBytes: number,
  sourceStartLine: number,
): PositionedByteWindow {
  const [start, end] = boundedUtf8Offsets(bytes, offset, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const content = decoder.decode(bytes.subarray(start, end));
  const startLine =
    sourceStartLine + decoder.decode(bytes.subarray(0, start)).split("\n").length - 1;
  return {
    start,
    end,
    excerpt: {
      content,
      startLine,
      endLine: startLine + content.split("\n").length - 1,
      anchoredWindowApplied: start > 0,
    },
  };
}

// Disjoint anchors share one classified/decoded source. The caller owns both the existing
// per-window cap and total returned-byte budget; windows remain separate source fragments.
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
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const matches = matchedAnchorRanges(content, anchors);
  const windowCount = Math.min(limits.maxWindows, matches.length);
  if (windowCount === 0) return undefined;
  const sharedWindowBytes = Math.min(
    limits.maxBytes,
    Math.floor(limits.maxTotalBytes / windowCount),
  );
  const windows: PositionedByteWindow[] = [];
  let usedBytes = 0;
  for (const match of matches) {
    if (windows.length >= limits.maxWindows || usedBytes >= limits.maxTotalBytes) break;
    const offset = encoder.encode(content.slice(0, match.start)).length;
    const endOffset = encoder.encode(content.slice(0, match.end)).length;
    if (windows.some((window) => window.start <= offset && window.end >= endOffset)) continue;
    const maxBytes = Math.min(sharedWindowBytes, limits.maxTotalBytes - usedBytes);
    if (maxBytes <= 0) break;
    const window = positionedByteWindow(bytes, offset, maxBytes, sourceStartLine);
    windows.push(window);
    usedBytes += window.end - window.start;
  }
  return windows.length === 0 ? undefined : windows.map((window) => window.excerpt);
}
