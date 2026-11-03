/** An orphan END can identify a head-truncated key only after its material arrived. Retain the
 * earliest candidate since the preceding completed key, including malformed intervening prose.
 * This prevents progressive publication from releasing material that a later footer identifies. */
export function privateKeyBodyStart(text: string, before: number, minimum = 0): number {
  for (const line of text.slice(minimum, before).matchAll(/[^\r\n]+/gu)) {
    if (!/^[A-Za-z0-9+/=\t\v\f ]+$/u.test(line[0])) continue;
    if (/[A-Za-z0-9+/=]/u.test(line[0])) return minimum + line.index;
  }
  return before;
}
interface PrivateKeyRegion {
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

/** Boundary recognition is shared by unconditional masking and syntax-only projection. */
export function privateKeyRegions(text: string): readonly PrivateKeyRegion[] {
  const regions: PrivateKeyRegion[] = [];
  let copiedThrough = 0;
  let openBlockStart: number | undefined;
  for (const boundary of text.matchAll(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/gu)) {
    if (boundary[1] === "BEGIN" && openBlockStart === undefined) {
      openBlockStart = boundary.index;
    } else if (boundary[1] === "END") {
      const start = openBlockStart ?? privateKeyBodyStart(text, boundary.index, copiedThrough);
      const end = boundary.index + boundary[0].length;
      regions.push({ start, end, closed: true });
      copiedThrough = end;
      openBlockStart = undefined;
    }
  }
  if (openBlockStart !== undefined)
    regions.push({ start: openBlockStart, end: text.length, closed: false });
  return regions;
}

/** Completed standalone key blocks are opaque to a code parser. Preserve every UTF-16 offset
 * and line delimiter; unconditional masking still consumes the original bytes afterwards. */
export function privateKeyParserSource(text: string): string {
  const chunks: string[] = [];
  let from = 0;
  for (const region of privateKeyRegions(text)) {
    const lineStart = text.lastIndexOf("\n", region.start - 1) + 1;
    const newline = text.indexOf("\n", region.end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (
      !region.closed ||
      text.slice(lineStart, region.start).trim().length > 0 ||
      text.slice(region.end, lineEnd).trim().length > 0
    )
      continue;
    chunks.push(
      text.slice(from, region.start),
      text.slice(region.start, region.end).replace(/[^\r\n]/gu, (unit) => " ".repeat(unit.length)),
    );
    from = region.end;
  }
  return chunks.length === 0 ? text : chunks.join("") + text.slice(from);
}
