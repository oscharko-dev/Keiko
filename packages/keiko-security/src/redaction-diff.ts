import {
  parseUnifiedDiff,
  PatchParseError,
  type UnifiedDiffFileSource,
  type UnifiedDiffHunkSource,
  type UnifiedDiffSourceRange,
} from "@oscharko-dev/keiko-contracts/runtime/unified-diff";
import type {
  CodeRedactionProjection,
  ProjectionPorts,
  RedactionSpan,
  SourceRedactionLanguage,
} from "./redaction-code.js";
import { REDACTION_PLACEHOLDER, appendAll } from "./redaction-source-map.js";
import { maskedLiteralBody } from "./redaction-typescript.js";
import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

type Project = (
  text: string,
  language: SourceRedactionLanguage | undefined,
  ports: ProjectionPorts,
) => CodeRedactionProjection;

interface ImageLine extends UnifiedDiffSourceRange {
  readonly rawStart: number;
}
interface SourceImage {
  readonly text: string;
  readonly lines: readonly ImageLine[];
}

function sourceLanguage(path: string): SourceRedactionLanguage | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (/^(?:ts|tsx|mts|cts)$/u.test(extension)) return "typescript";
  if (/^(?:js|jsx|mjs|cjs)$/u.test(extension)) return "javascript";
  if (/^(?:json|jsonc)$/u.test(extension)) return "json";
  if (/^(?:yml|yaml)$/u.test(extension)) return "yaml";
  return extension === "java" ? "java" : undefined;
}

function adjacent(previous: UnifiedDiffHunkSource, next: UnifiedDiffHunkSource): boolean {
  return (
    previous.hunk.oldStart + previous.hunk.oldLines === next.hunk.oldStart &&
    previous.hunk.newStart + previous.hunk.newLines === next.hunk.newStart
  );
}

/** Only coordinate-contiguous hunks form one source image. Gaps never invent source bindings. */
function hunkGroups(file: UnifiedDiffFileSource): readonly (readonly UnifiedDiffHunkSource[])[] {
  const groups: UnifiedDiffHunkSource[][] = [];
  for (const hunk of file.hunks) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group !== undefined && previous !== undefined && adjacent(previous, hunk)) group.push(hunk);
    else groups.push([hunk]);
  }
  return groups;
}

function sourceImage(
  text: string,
  hunks: readonly UnifiedDiffHunkSource[],
  excluded: "+" | "-",
): SourceImage {
  const chunks: string[] = [];
  const lines: ImageLine[] = [];
  let size = 0;
  for (const hunk of hunks) {
    for (const [index, line] of hunk.lines.entries()) {
      if (line.marker === excluded || line.marker === "\\") continue;
      const following = hunk.lines[index + 1];
      let body = text.slice(line.start + 1, line.end);
      if (following?.marker === "\\" && canonicalAnnotation(text, following))
        body = body.replace(/\r?\n$/u, "");
      lines.push({ start: size, end: size + body.length, rawStart: line.start + 1 });
      chunks.push(body);
      size += body.length;
    }
  }
  return { text: chunks.join(""), lines };
}

function canonicalAnnotation(text: string, range: UnifiedDiffSourceRange): boolean {
  return text.slice(range.start, range.end).trimEnd() === String.raw`\ No newline at end of file`;
}

function firstImageLine(lines: readonly ImageLine[], offset: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lines[middle]?.end ?? Infinity) <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Split native replacements at physical lines; diff prefixes and other-image lines stay intact. */
function mapSpan(image: SourceImage, span: RedactionSpan): readonly RedactionSpan[] {
  const result: RedactionSpan[] = [];
  let replacementAt = 0;
  for (let at = firstImageLine(image.lines, span.start); at < image.lines.length; at += 1) {
    const line = image.lines[at];
    if (line === undefined || line.start >= span.end) break;
    const start = Math.max(line.start, span.start);
    const end = Math.min(line.end, span.end);
    const hasEnding = /[\r\n]$/u.test(image.text.slice(start, end));
    const remaining = span.replacement.slice(replacementAt);
    const ending = hasEnding ? /\r\n|\r|\n/u.exec(remaining) : null;
    const length = ending === null ? remaining.length : ending.index + ending[0].length;
    result.push({
      start: line.rawStart + start - line.start,
      end: line.rawStart + end - line.start,
      replacement: remaining.slice(0, length),
    });
    replacementAt += length;
  }
  return result;
}

function imageSpans(
  image: SourceImage,
  projection: CodeRedactionProjection,
  ports: ProjectionPorts,
): readonly RedactionSpan[] {
  const spans = [...projection.literals];
  let from = 0;
  for (const region of projection.regions) {
    if (region.start > from) addPlainSpan(image.text, from, region.start, ports, spans);
    from = Math.max(from, region.end);
  }
  addPlainSpan(image.text, from, image.text.length, ports, spans);
  return spans.flatMap((span) => mapSpan(image, span));
}

function addPlainSpan(
  text: string,
  start: number,
  end: number,
  ports: ProjectionPorts,
  spans: RedactionSpan[],
): void {
  const original = text.slice(start, end);
  const replacement = ports.redactPlain(original);
  if (replacement !== original) spans.push({ start, end, replacement });
}

function maskRange(text: string, range: UnifiedDiffSourceRange): RedactionSpan {
  return { ...range, replacement: maskedLiteralBody(text.slice(range.start, range.end)) };
}

function fileRegions(file: UnifiedDiffFileSource): readonly UnifiedDiffSourceRange[] {
  return [
    file.oldHeader,
    file.newHeader,
    ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]),
  ];
}

function projectFile(
  text: string,
  file: UnifiedDiffFileSource,
  ports: ProjectionPorts,
  project: Project,
): CodeRedactionProjection {
  const scoped = { ...ports, completeSource: true };
  const images = hunkGroups(file).flatMap((group) => [
    { image: sourceImage(text, group, "+"), path: file.oldPath, complete: true },
    { image: sourceImage(text, group, "-"), path: file.newPath, complete: true },
  ]);
  const contexts = file.hunks.map((hunk) => ({
    image: {
      text: text.slice(hunk.contextStart, hunk.header.end),
      lines: [{ start: 0, end: hunk.header.end - hunk.contextStart, rawStart: hunk.contextStart }],
    },
    path: undefined,
    complete: false,
  }));
  const sources = [...images, ...contexts];
  const inspect = (): CodeRedactionProjection[] =>
    sources.map(({ image, path, complete }) =>
      project(image.text, path === undefined ? undefined : sourceLanguage(path), {
        ...scoped,
        completeSource: complete,
      }),
    );
  const projections = inspect();
  const report = sumReports(projections);
  const floored = credentialFloorFile(text, file, images, report, ports);
  if (floored !== undefined) return floored;
  const literals: RedactionSpan[] = [];
  for (const [index, entry] of sources.entries()) {
    const projection = projections[index];
    if (projection !== undefined) appendAll(literals, imageSpans(entry.image, projection, scoped));
  }
  addMetadataSpans(text, file, ports, literals);
  if (report.syntaxRefusals + report.depthRefusals + report.sizeRefusals > 0)
    for (const hunk of file.hunks)
      for (const line of hunk.lines)
        if (line.marker !== "\\")
          literals.push(maskRange(text, { start: line.start + 1, end: line.end }));
  return { regions: fileRegions(file), literals, report };
}

/** The values of the private literals this projection scope has seen. Shared private literal keys
 * are `<kind>:<value>` (TypeScript, Java and YAML projections). */
export function privateLiteralTexts(ports: ProjectionPorts): readonly string[] {
  return [...(ports.privateLiteralValues ?? [])]
    .map((key) => key.slice(key.indexOf(":") + 1))
    .filter((value) => value.length > 0);
}

/**
 * #4114: a diff view whose file hunks fail only the syntax check keeps them readable under the
 * credential floor instead of masking every line. Each old/new image is floored as a whole, so a
 * private key spanning lines is still found, and mapped back line by line. Private literal values
 * found in other files of the same diff stay masked. Depth and size refusals, a floor that changes
 * the line count, and every caller without the port keep whole-file masking.
 */
function credentialFloorFile(
  text: string,
  file: UnifiedDiffFileSource,
  images: readonly { readonly image: SourceImage }[],
  report: CodeRedactionProjection["report"],
  ports: ProjectionPorts,
): CodeRedactionProjection | undefined {
  const floor = ports.unparsedDiffHunkFloor;
  if (floor === undefined || report.syntaxRefusals === 0) return undefined;
  if (report.depthRefusals + report.sizeRefusals > 0) return undefined;
  const values = privateLiteralTexts(ports);
  const masked = (value: string): string =>
    values.reduce(
      (current, secret) => current.split(secret).join(REDACTION_PLACEHOLDER),
      floor(value),
    );
  const literals: RedactionSpan[] = [];
  for (const { image } of images) {
    const spans = flooredImageSpans(image, masked);
    if (spans === undefined) return undefined;
    appendAll(literals, spans);
  }
  addMetadataSpans(text, file, ports, literals);
  ports.onUnparsedDiffHunkFloor?.();
  return { regions: fileRegions(file), literals, report };
}

function flooredImageSpans(
  image: SourceImage,
  floor: (text: string) => string,
): readonly RedactionSpan[] | undefined {
  if (image.lines.length === 0) return [];
  const original = image.lines.map((line) => image.text.slice(line.start, line.end));
  const floored = floor(image.text).split(/(?<=\n)/u);
  const physical = image.text.split(/(?<=\n)/u);
  const aligned =
    physical.length === original.length && physical.every((line, at) => line === original[at]);
  if (!aligned || floored.length !== original.length) return undefined;
  const spans: RedactionSpan[] = [];
  for (const [index, line] of image.lines.entries()) {
    const replacement = floored[index] ?? "";
    if (replacement !== original[index])
      spans.push({
        start: line.rawStart,
        end: line.rawStart + line.end - line.start,
        replacement,
      });
  }
  return spans;
}

function addMetadataSpans(
  text: string,
  file: UnifiedDiffFileSource,
  ports: ProjectionPorts,
  spans: RedactionSpan[],
): void {
  for (const header of [file.oldHeader, file.newHeader])
    addPlainSpan(text, header.start, header.end, ports, spans);
  for (const hunk of file.hunks) {
    for (const line of hunk.lines)
      if (line.marker === "\\" && !canonicalAnnotation(text, line))
        spans.push(maskRange(text, line));
  }
}

function sumReports(
  projections: readonly CodeRedactionProjection[],
): CodeRedactionProjection["report"] {
  return projections.reduce(
    (sum, item) => ({
      regions: sum.regions + item.report.regions,
      syntaxRefusals: sum.syntaxRefusals + item.report.syntaxRefusals,
      depthRefusals: sum.depthRefusals + item.report.depthRefusals,
      sizeRefusals: sum.sizeRefusals + item.report.sizeRefusals,
    }),
    { regions: 0, syntaxRefusals: 0, depthRefusals: 0, sizeRefusals: 0 },
  );
}

function acceptedFiles(text: string): readonly UnifiedDiffFileSource[] {
  let files: readonly UnifiedDiffFileSource[] = [];
  try {
    parseUnifiedDiff(text, (accepted) => {
      files = accepted;
    });
  } catch (error) {
    if (!(error instanceof PatchParseError)) throw error;
  }
  return files;
}

/** An orphan source prefix cannot absorb a later, fully accepted patch's source body. */
export function firstUnifiedDiffHeader(text: string): number {
  return acceptedFiles(text)[0]?.oldHeader.start ?? text.length;
}

/** The existing patch parser alone grants ownership. Incomplete/unsupported patches fail closed. */
export function projectUnifiedDiff(
  text: string,
  ports: ProjectionPorts,
  project: Project,
): CodeRedactionProjection {
  if (new TextEncoder().encode(text).byteLength > MAX_RECURSIVE_TEXT_FILE_BYTES)
    return refusedDiff(text, "size");
  try {
    const files = acceptedFiles(text);
    if (files.length === 0) return refusedDiff(text, "syntax");
    return projectWithSharedLiterals(text, files, ports, project);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return refusedDiff(text, "depth");
  }
}

/** Private literals found anywhere in the patch take one bounded second pass; only the final
 * pass reports its credential-floor files. */
function projectWithSharedLiterals(
  text: string,
  files: readonly UnifiedDiffFileSource[],
  ports: ProjectionPorts,
  project: Project,
): CodeRedactionProjection {
  const ownsScope = ports.privateLiteralValues === undefined;
  const privateLiteralValues = ports.privateLiteralValues ?? new Set<string>();
  let floored = 0;
  const scoped: ProjectionPorts = {
    ...ports,
    privateLiteralValues,
    onUnparsedDiffHunkFloor: () => {
      floored += 1;
    },
  };
  let projection = projectAcceptedFiles(text, files, scoped, project);
  if (ownsScope && privateLiteralValues.size > 0) {
    floored = 0;
    projection = projectAcceptedFiles(text, files, scoped, project);
  }
  for (let index = 0; index < floored; index += 1) ports.onUnparsedDiffHunkFloor?.();
  return projection;
}

function refusedDiff(text: string, reason: "size" | "syntax" | "depth"): CodeRedactionProjection {
  return {
    regions: [{ start: 0, end: text.length }],
    literals: [maskRange(text, { start: 0, end: text.length })],
    report: {
      regions: 1,
      syntaxRefusals: Number(reason === "syntax"),
      depthRefusals: Number(reason === "depth"),
      sizeRefusals: Number(reason === "size"),
    },
  };
}

function projectAcceptedFiles(
  text: string,
  files: readonly UnifiedDiffFileSource[],
  ports: ProjectionPorts,
  project: Project,
): CodeRedactionProjection {
  const projections = files.map((file) => projectFile(text, file, ports, project));
  const ranges = projections.flatMap((item) => item.regions).sort((a, b) => a.start - b.start);
  let from = 0;
  for (const range of [...ranges, { start: text.length, end: text.length }]) {
    if (range.start > from) {
      const child = projectUnownedText(text.slice(from, range.start), ports, project);
      projections.push({
        ...child,
        regions: child.regions.map((item) => ({ start: item.start + from, end: item.end + from })),
        literals: child.literals.map((item) => ({
          ...item,
          start: item.start + from,
          end: item.end + from,
        })),
      });
    }
    from = Math.max(from, range.end);
  }
  return {
    regions: projections.flatMap((item) => item.regions),
    literals: projections.flatMap((item) => item.literals),
    report: sumReports(projections),
  };
}

/** Ignored patch text has no metadata exemption. Native source owners run first; an unclassified
 * escaped literal or changed credential field cannot fall back to its raw spelling. */
function projectUnownedText(
  text: string,
  ports: ProjectionPorts,
  project: Project,
): CodeRedactionProjection {
  const child = project(text, undefined, { ...ports, inferUnifiedDiff: false });
  const regions = [...child.regions];
  const literals = [...child.literals];
  let refusals = 0;
  let from = 0;
  for (const range of [...child.regions, { start: text.length, end: text.length }]) {
    const part = text.slice(from, range.start);
    if (range.start > from && unsafeUnownedText(part, ports)) {
      const refused = { start: from, end: range.start };
      regions.push(refused);
      literals.push(maskRange(text, refused));
      refusals += 1;
    }
    from = Math.max(from, range.end);
  }
  regions.sort((a, b) => a.start - b.start);
  return {
    regions,
    literals,
    report: { ...child.report, syntaxRefusals: child.report.syntaxRefusals + refusals },
  };
}

function unsafeUnownedText(text: string, ports: ProjectionPorts): boolean {
  const unclassified = withoutGitPathHeaderLines(text, ports);
  return (
    (unclassified.includes("\\") && /["'`[{]/u.test(unclassified)) ||
    ports.redactPlain(text) !== text
  );
}

const GIT_PATH_HEADER = /^(?:(diff --git )|(?:rename|copy) (?:from|to) )/u;
// Git names a control byte by its letter and writes every other byte it quotes in octal.
const NAMED_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ['"', 0x22],
  ["\\", 0x5c],
]);
const NAMED_ESCAPE_BYTES: ReadonlySet<number> = new Set(NAMED_ESCAPES.values());

/** One escape of Git's `quote_c_style`, as its byte and length; undefined when Git never writes it. */
function canonicalEscape(content: string, at: number): readonly [number, number] | undefined {
  const named = NAMED_ESCAPES.get(content.charAt(at + 1));
  if (named !== undefined) return [named, 2];
  const octal = /^[0-3][0-7]{2}$/u.test(content.slice(at + 1, at + 4))
    ? Number.parseInt(content.slice(at + 1, at + 4), 8)
    : undefined;
  // Git writes octal only for a byte it has no letter for: a control byte or one at 0x7f and above.
  if (octal === undefined || (octal >= 0x20 && octal < 0x7f) || NAMED_ESCAPE_BYTES.has(octal))
    return undefined;
  return [octal, 4];
}

/**
 * Decodes a path in exactly the spelling Git writes: a plain printable ASCII character or any
 * non-ASCII character stays itself, and a quote, backslash, control byte or DEL is escaped as Git
 * escapes it. Any other spelling (an octal escape of a printable byte, a raw control character, an
 * unescaped quote, an unknown escape) is something Git never emits and is refused, so an escape
 * can never hide a value from the redactor. Undefined unless the result is valid UTF-8.
 */
function decodeCanonicalQuotedPath(token: string): string | undefined {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return undefined;
  const content = token.slice(1, -1);
  const bytes: number[] = [];
  let at = 0;
  while (at < content.length) {
    const step = canonicalStep(content, at);
    if (step === undefined) return undefined;
    bytes.push(...Array.from(step.bytes));
    at += step.length;
  }
  // Bytes that are not valid UTF-8 decode to U+FFFD; a path holding one has no reliable identity.
  const decoded = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  return decoded.includes("\uFFFD") ? undefined : decoded;
}

/** The bytes and source length of the character or escape at `at`; undefined for a spelling Git never writes. */
function canonicalStep(
  content: string,
  at: number,
): { readonly bytes: ArrayLike<number>; readonly length: number } | undefined {
  const character = String.fromCodePoint(content.codePointAt(at) ?? 0);
  if (character === "\\") {
    const escape = canonicalEscape(content, at);
    return escape === undefined ? undefined : { bytes: [escape[0]], length: escape[1] };
  }
  const code = character.codePointAt(0) ?? 0;
  if (character === '"' || code < 0x20 || code === 0x7f) return undefined;
  return { bytes: new TextEncoder().encode(character), length: character.length };
}

function closingQuote(text: string): number {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === '"') return at;
  }
  return -1;
}

/** The two path tokens of a `diff --git` line, or undefined unless there are exactly two. */
function splitDiffGitTokens(rest: string): readonly [string, string] | undefined {
  if (rest.startsWith('"')) {
    const close = closingQuote(rest);
    return close < 0 || rest[close + 1] !== " "
      ? undefined
      : [rest.slice(0, close + 1), rest.slice(close + 2)];
  }
  const quoted = rest.indexOf(' "');
  if (quoted >= 0) return [rest.slice(0, quoted), rest.slice(quoted + 1)];
  const plain = rest.lastIndexOf(" b/");
  return plain < 0 ? undefined : [rest.slice(0, plain), rest.slice(plain + 1)];
}

/** A quoted token in Git's own spelling, or a plain one that holds no quote and no escape. */
function decodedPathToken(token: string): string | undefined {
  if (token.startsWith('"')) return decodeCanonicalQuotedPath(token);
  return /["\\]/u.test(token) ? undefined : token;
}

/**
 * Whether one header line is a path record in Git's closed grammar: `diff --git` names exactly two
 * path tokens and `rename|copy from|to` exactly one, with no tail. Each decoded path also passes
 * the credential floor, because a value spelled in escapes is a value once decoded.
 */
function isCanonicalGitPathHeader(
  line: string,
  ports: Pick<ProjectionPorts, "redactPlain">,
): boolean {
  const match = GIT_PATH_HEADER.exec(line);
  if (match === null) return false;
  const rest = line.slice(match[0].length);
  const tokens = match[1] === undefined ? [rest] : splitDiffGitTokens(rest);
  if (tokens === undefined) return false;
  return tokens.every((token) => {
    const decoded = decodedPathToken(token);
    return decoded !== undefined && ports.redactPlain(decoded) === decoded;
  });
}

/**
 * The extended header lines that name paths carry the path as Git spelled it. Only a line in the
 * closed grammar above leaves the escaped-literal refusal; the credential floor still runs over
 * the whole text.
 */
function withoutGitPathHeaderLines(text: string, ports: ProjectionPorts): string {
  return text
    .split(/(?<=\n)/u)
    .filter(
      (line) => !isCanonicalGitPathHeader(line.endsWith("\n") ? line.slice(0, -1) : line, ports),
    )
    .join("");
}

/**
 * Path records are classified wherever they appear, in an owned header region, ahead of a file
 * header with no `diff --git` line, or in text no patch owns. A record that spells a quoted or
 * escaped path must be in Git's canonical spelling and its decoded path must pass the credential
 * floor; any other line is masked whole. A plain record, which holds no quote and no backslash, is
 * left to the ordinary floor.
 */
export function maskNonCanonicalGitPathRecords(
  text: string,
  ports: Pick<ProjectionPorts, "redactPlain">,
): string {
  if (!text.includes("rename ") && !text.includes("copy ") && !text.includes("diff --git ")) {
    return text;
  }
  return text
    .split(/(?<=\n)/u)
    .map((line) => {
      const body = line.endsWith("\n") ? line.slice(0, -1) : line;
      const suspect = GIT_PATH_HEADER.test(body) && /["\\]/u.test(body);
      if (!suspect || isCanonicalGitPathHeader(body, ports)) return line;
      return `${REDACTION_PLACEHOLDER}${line.slice(body.length)}`;
    })
    .join("");
}
