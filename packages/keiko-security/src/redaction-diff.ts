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
import { REDACTION_PLACEHOLDER } from "./redaction-source-map.js";
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
    if (projection !== undefined) literals.push(...imageSpans(entry.image, projection, scoped));
  }
  addMetadataSpans(text, file, ports, literals);
  if (report.syntaxRefusals + report.depthRefusals + report.sizeRefusals > 0)
    for (const hunk of file.hunks)
      for (const line of hunk.lines)
        if (line.marker !== "\\")
          literals.push(maskRange(text, { start: line.start + 1, end: line.end }));
  return { regions: fileRegions(file), literals, report };
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
  // Shared private literal keys are `<kind>:<value>` (TypeScript, Java and YAML projections).
  const values = [...(ports.privateLiteralValues ?? [])]
    .map((key) => key.slice(key.indexOf(":") + 1))
    .filter((value) => value.length > 0);
  const masked = (value: string): string =>
    values.reduce(
      (current, secret) => current.split(secret).join(REDACTION_PLACEHOLDER),
      floor(value),
    );
  const literals: RedactionSpan[] = [];
  for (const { image } of images) {
    const spans = flooredImageSpans(image, masked);
    if (spans === undefined) return undefined;
    literals.push(...spans);
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
  return (text.includes("\\") && /["'`[{]/u.test(text)) || ports.redactPlain(text) !== text;
}
