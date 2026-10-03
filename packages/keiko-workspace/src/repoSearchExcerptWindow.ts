// Query anchors select a bounded view after the workspace owner has classified, decoded, and
// redacted the entire eligible file. Byte slicing never invents line breaks or source line numbers.

interface AnchoredByteWindow {
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
