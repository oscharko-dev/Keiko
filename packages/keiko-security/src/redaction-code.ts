import {
  projectYamlData,
  isYamlDocument,
  mayStartYaml,
  YamlSyntaxRefusal,
  yamlPrivacyPrefix,
  isPublicYamlScalar,
} from "./redaction-yaml.js";
import type { Document } from "yaml";
import {
  REDACTION_PLACEHOLDER,
  projectSourceText,
  type SourceTextEdit,
} from "./redaction-source-map.js";
import { privateKeyParserSource } from "./redaction-private-key.js";
import { projectJavaData, isJavaSource, JavaSyntaxRefusal } from "./redaction-java.js";
import {
  projectTypeScriptData,
  isJsonDocument,
  isJsonSourcePrefix,
  isTypeScriptSource,
  typeScriptPrefixLength,
  maskedLiteralBody,
  hasSourceDeclaration,
  TypeScriptSyntaxRefusal,
} from "./redaction-typescript.js";
import { markdownCodeRanges } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

export type SourceRedactionLanguage = "typescript" | "javascript" | "java" | "json" | "yaml";

export interface RedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface CodeRedactionProjection {
  readonly regions: readonly { readonly start: number; readonly end: number }[];
  readonly literals: readonly RedactionSpan[];
  readonly report: CodeRedactionReport;
}

export interface CodeRedactionReport {
  readonly regions: number;
  readonly depthRefusals: number;
  readonly sizeRefusals: number;
  readonly syntaxRefusals: number;
}

export interface ProjectionPorts {
  readonly sensitiveName: (name: string) => boolean;
  readonly mayContainSensitiveName: (text: string) => boolean;
  readonly redactPlain: (text: string) => string;
  readonly publicPrefix: (text: string) => boolean;
}

interface CodeRegion {
  readonly start: number;
  readonly end: number;
  readonly language: SourceRedactionLanguage | undefined;
  readonly fence: string;
  readonly quoteDepth: number;
  readonly closed: boolean;
  readonly yamlDocument?: Document;
  readonly refusal?: "syntax" | "depth";
}

interface InferredSourcePrefix {
  readonly language: SourceRedactionLanguage | undefined;
  readonly end: number;
  readonly refusal?: "syntax" | "depth";
  readonly yamlDocument?: Document;
}

function inferredRegion(prefix: InferredSourcePrefix, start: number): CodeRegion {
  return {
    start,
    end: start + prefix.end,
    language: prefix.language,
    fence: "",
    quoteDepth: 0,
    closed: true,
    ...(prefix.yamlDocument === undefined ? {} : { yamlDocument: prefix.yamlDocument }),
    ...(prefix.refusal === undefined ? {} : { refusal: prefix.refusal }),
  };
}

function fenceLanguage(value: string): SourceRedactionLanguage | undefined {
  if (/^(?:ts|tsx|typescript)$/iu.test(value)) return "typescript";
  if (/^(?:js|jsx|javascript|mjs|cjs)$/iu.test(value)) return "javascript";
  if (value.toLowerCase() === "json") return "json";
  if (/^(?:yaml|yml)$/iu.test(value)) return "yaml";
  return value.toLowerCase() === "java" ? "java" : undefined;
}

function closingFence(block: string, opening: string, depth: number): number | undefined {
  const start = block.lastIndexOf("\n") + 1;
  const raw = block.slice(start);
  const line = raw.slice(quotePrefix(raw, 0, depth)).trim();
  if (!/^(?:`{3,}|~{3,})$/u.test(line)) return undefined;
  return line.startsWith(opening.charAt(0)) && line.length >= opening.length ? start : undefined;
}

function fencedRegion(text: string, start: number, end: number): CodeRegion | undefined {
  const block = text.slice(start, end);
  const headerText = block + (text.charAt(end) === "\n" ? "\n" : "");
  const newline = headerText.indexOf("\n");
  if (newline < 0) return undefined;
  const header = /^\s*(`{3,}|~{3,})\s*([\w-]*)/u.exec(headerText.slice(0, newline));
  const language = fenceLanguage(header?.[2] ?? "");
  if (header === null) return undefined;
  const opening = header[1] ?? "";
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const prefix = text.slice(lineStart, start + header[0].indexOf(opening));
  const quoteDepth = prefix.match(/>/gu)?.length ?? 0;
  const closer = bodyClosingFence(block, opening, quoteDepth, newline);
  const bodyStart = start + newline + 1;
  return {
    start: bodyStart,
    end: Math.max(bodyStart, closer === undefined ? end : start + closer),
    language,
    fence: opening,
    quoteDepth,
    closed: closer !== undefined,
  };
}

function codeRegions(
  text: string,
  sourceLanguage: SourceRedactionLanguage | undefined,
  ports: ProjectionPorts,
  inferSourceLanguage = true,
): readonly CodeRegion[] {
  if (sourceLanguage === undefined && !inferSourceLanguage) return [];
  if (sourceLanguage === "json" && !/^\s*[[{"]/u.test(text))
    return codeRegions(text, undefined, ports, inferSourceLanguage);
  if (sourceLanguage !== undefined)
    return [
      {
        start: 0,
        end: text.length,
        language: sourceLanguage,
        fence: "",
        quoteDepth: 0,
        closed: true,
      },
    ];
  return inferredCodeRegions(text, ports);
}

function inferredCodeRegions(text: string, ports: ProjectionPorts): readonly CodeRegion[] {
  if (isSyntaxFreeProse(text)) return [];
  const withinSize = new TextEncoder().encode(text).byteLength <= MAX_RECURSIVE_TEXT_FILE_BYTES;
  const prefix = inferredPrefix(text, ports, withinSize);
  const result: CodeRegion[] = prefix?.language === undefined ? [] : [inferredRegion(prefix, 0)];
  let from = prefix?.end ?? 0;
  const offset = from;
  const ranges = markdownCodeRanges(text.slice(offset)).map((range) => ({
    start: range.start + offset,
    end: range.end + offset,
  }));
  for (const range of [...ranges, { start: text.length, end: text.length }]) {
    result.push(...standaloneRegions(text, from, range.start, ports, withinSize));
    const region = fencedRegion(text, range.start, range.end);
    if (region !== undefined) result.push(...inferredFenceRegions(text, region, ports));
    from = range.end;
  }
  return result.sort((a, b) => a.start - b.start);
}

export interface OpenCodeFence {
  readonly fence: string;
  readonly quoteDepth: number;
}
export interface CodePublicationPrefix {
  readonly end: number;
  readonly waiting?: OpenCodeFence;
}

/** Publication retains the complete opening line, including its quote context. */
export function completeCodePrefix(text: string, before: number): CodePublicationPrefix {
  let end = before;
  let waiting: OpenCodeFence | undefined;
  for (const range of markdownCodeRanges(text)) {
    const region = fencedRegion(text, range.start, range.end);
    if (region === undefined) continue;
    const containerEnded =
      region.quoteDepth > 0 && /\n[^\n]*\n/u.test(text.slice(range.end, before));
    if ((region.closed && before >= range.end) || containerEnded) continue;
    const opening = text.lastIndexOf("\n", range.start - 1) + 1;
    end = Math.min(end, opening);
    if (!region.closed && opening <= end) waiting = region;
  }
  return { end, ...(waiting === undefined ? {} : { waiting }) };
}

/** A wake-up hint only; every candidate is certified again by the shared Markdown parser. */
export function mayEndCodeFence(lines: string, waiting: OpenCodeFence): boolean {
  for (const original of lines.split("\n").slice(0, -1)) {
    let line = original;
    for (let depth = 0; depth < waiting.quoteDepth; depth += 1) {
      const prefix = /^ *> ?/u.exec(line)?.[0];
      if (prefix === undefined) return true;
      line = line.slice(prefix.length);
    }
    const token = /^(`{3,}|~{3,})\s*$/u.exec(line.trim())?.[1] ?? "";
    if (token.startsWith(waiting.fence.charAt(0)) && token.length >= waiting.fence.length)
      return true;
  }
  return false;
}

function quotePrefix(text: string, start: number, depth: number): number {
  let length = 0;
  for (let level = 0; level < depth; level += 1) {
    const prefix = /^ *> ?/u.exec(text.slice(start + length))?.[0];
    if (prefix === undefined) break;
    length += prefix.length;
  }
  return length;
}

function quotedSource(text: string, depth: number): ReturnType<typeof projectSourceText> {
  if (depth === 0) return { text, rawOffset: (offset): number => offset };
  const edits: SourceTextEdit[] = [];
  for (let start = 0; start < text.length;) {
    const length = quotePrefix(text, start, depth);
    if (length > 0) edits.push({ start, end: start + length, replacement: "" });
    const newline = text.indexOf("\n", start);
    start = newline < 0 ? text.length : newline + 1;
  }
  return projectSourceText(text, edits);
}

function quotedMask(text: string, depth: number, head: string): string {
  const chunks = [head];
  for (const match of text.matchAll(/\r\n|\r|\n/gu)) {
    const start = match.index + match[0].length;
    chunks.push(match[0], text.slice(start, start + quotePrefix(text, start, depth)));
  }
  return chunks.join("");
}

function javaProjection(text: string, ports: ProjectionPorts): readonly RedactionSpan[] {
  return projectJavaData(text, ports);
}

/** Syntax metadata never exempts literal data or the caller's unconditional secret patterns. */
export function projectCodeRedaction(
  text: string,
  sourceLanguage: SourceRedactionLanguage | undefined,
  ports: ProjectionPorts,
  inferSourceLanguage = true,
): CodeRedactionProjection {
  const parserSource = privateKeyParserSource(text);
  const regions = codeRegions(parserSource, sourceLanguage, ports, inferSourceLanguage);
  const literals: RedactionSpan[] = [];
  const report = { regions: regions.length, depthRefusals: 0, sizeRefusals: 0, syntaxRefusals: 0 };
  for (const region of regions) {
    const body = text.slice(region.start, region.end);
    const source = quotedSource(parserSource.slice(region.start, region.end), region.quoteDepth);
    const projection =
      region.refusal === undefined
        ? boundedProjection(
            source.text,
            region.language ?? "typescript",
            ports,
            report,
            region.yamlDocument,
          )
        : refusedProjection(source.text, report, region.refusal);
    literals.push(
      ...projection.map((span) => {
        const start = source.rawOffset(span.start);
        const end = source.rawOffset(span.end);
        return {
          start: start + region.start,
          end: end + region.start,
          replacement:
            region.quoteDepth > 0 && /[\r\n]/u.test(span.replacement)
              ? quotedMask(
                  body.slice(start, end),
                  region.quoteDepth,
                  span.replacement.replace(/\r\n|\r|\n/gu, ""),
                )
              : span.replacement,
        };
      }),
    );
  }
  return { regions, literals, report };
}

function boundedProjection(
  body: string,
  language: SourceRedactionLanguage,
  ports: ProjectionPorts,
  report: { depthRefusals: number; sizeRefusals: number; syntaxRefusals: number },
  yamlDocument?: Document,
): readonly RedactionSpan[] {
  if (new TextEncoder().encode(body).byteLength > MAX_RECURSIVE_TEXT_FILE_BYTES) {
    report.sizeRefusals += 1;
  } else {
    try {
      return languageProjection(body, language, ports, report, yamlDocument);
    } catch (error) {
      if (safeUnparsedJava(error, body, ports)) return [];
      if (error instanceof RangeError) report.depthRefusals += 1;
      else if (
        error instanceof JavaSyntaxRefusal ||
        error instanceof YamlSyntaxRefusal ||
        error instanceof TypeScriptSyntaxRefusal
      )
        report.syntaxRefusals += 1;
      else throw error;
    }
  }
  return [{ start: 0, end: body.length, replacement: maskedLiteralBody(body) }];
}

/** A malformed public fragment can remain searchable only when it has no literal, escape,
 * sensitive-name or strict-redaction candidate. All other failed Java parses remain closed. */
function safeUnparsedJava(error: unknown, body: string, ports: ProjectionPorts): boolean {
  return (
    error instanceof JavaSyntaxRefusal &&
    !/["'\\]/u.test(body) &&
    !ports.mayContainSensitiveName(body) &&
    ports.redactPlain(body) === body
  );
}

function languageProjection(
  body: string,
  language: SourceRedactionLanguage,
  ports: ProjectionPorts,
  report: { depthRefusals: number; syntaxRefusals: number },
  yamlDocument?: Document,
): readonly RedactionSpan[] {
  if (language === "json" && !isJsonSourcePrefix(body))
    return refusedProjection(body, report, "syntax");
  if (language === "java") return javaProjection(body, ports);
  if (language === "yaml") return projectYamlData(body, ports, yamlDocument);
  return projectTypeScriptData(body, ports, language === "json");
}

/** A cheap candidate check avoids loading a language SDK for ordinary diagnostics. */
export function mayStartStandaloneSource(text: string): boolean {
  const body = text.trimStart();
  if (body.slice(0, lineAfter(body, 0, body.length)).trimEnd() === REDACTION_PLACEHOLDER)
    return false;
  return (
    mayStartYaml(body) ||
    /^(?:\/[/*]|[{[@])/u.test(body) ||
    /^(?:export|import|declare|async|function|interface|type|const|let|var|class|enum|record|public|private|protected|abstract|final|static)\b/u.test(
      body,
    ) ||
    /^[A-Za-z_$][\w$<>[\].]*\s+[A-Za-z_$][\w$]*\s*[=(;]/u.test(body)
  );
}

function inferredLanguage(text: string): SourceRedactionLanguage | undefined {
  const document = inferredDocumentLanguage(text);
  if (document !== undefined) return document;
  if (isTypeScriptSource(text)) return "typescript";
  return isJavaSource(text) ? "java" : undefined;
}

function standaloneRegions(
  text: string,
  start: number,
  end: number,
  ports: ProjectionPorts,
  withinSize = false,
): readonly CodeRegion[] {
  const result: CodeRegion[] = [];
  for (let at = start; at < end;) {
    const leading = text.slice(at, end).search(/\S/u);
    if (leading < 0) break;
    at += leading;
    const body = text.slice(at, end);
    const code = inferredPrefix(body, ports, withinSize);
    if (code === undefined) {
      at = lineAfter(text, at, end);
      continue;
    }
    if (code.language !== undefined) result.push(inferredRegion(code, at));
    at += code.end;
  }
  return result;
}

function inferredPrefix(
  text: string,
  ports: ProjectionPorts,
  withinSize = false,
): InferredSourcePrefix | undefined {
  if (!mayStartStandaloneSource(text)) return undefined;
  if (sourceExceedsSize(text, withinSize)) return { language: "typescript", end: text.length };
  try {
    if (mayStartYaml(text)) return inferredYamlPrefix(text, ports);
    const language = inferredLanguage(text);
    if (language !== undefined) return { language, end: text.length };
    const end = typeScriptPrefixLength(text);
    if (end > 0) return { language: "typescript", end };
    return hasSourceDeclaration(text)
      ? { language: "typescript", end: text.length, refusal: "syntax" }
      : undefined;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { language: "typescript", end: text.length, refusal: "depth" };
  }
}

function sourceExceedsSize(text: string, withinSize: boolean): boolean {
  return !withinSize && new TextEncoder().encode(text).byteLength > MAX_RECURSIVE_TEXT_FILE_BYTES;
}

/** Candidate detection ignores canonical Markdown code ranges; completed fences stay whole. */
export function standaloneSourceStart(
  text: string,
  before: number,
  canReleaseYaml: (line: string) => boolean,
): number {
  const ranges = markdownCodeRanges(text);
  let cursor = 0;
  for (let start = 0; start < before;) {
    const range = ranges[cursor];
    if (range !== undefined && range.end <= start) {
      cursor += 1;
      continue;
    }
    if (range !== undefined && range.start <= start) {
      start = lineAfter(text, range.end, before);
      continue;
    }
    const rest = text.slice(start, before);
    const end = Math.min(before, lineAfter(text, start, before));
    if (retainSourceLine(rest, text.slice(start, end), canReleaseYaml)) return start;
    start = end;
  }
  return before;
}

function lineAfter(text: string, from: number, fallback: number): number {
  const newline = text.indexOf("\n", from);
  return newline < 0 ? fallback : newline + 1;
}

function inferredFenceRegions(
  text: string,
  region: CodeRegion,
  ports: ProjectionPorts,
): readonly CodeRegion[] {
  if (region.language !== undefined) return [region];
  const source = quotedSource(text.slice(region.start, region.end), region.quoteDepth);
  if (isSyntaxFreeProse(source.text)) return [];
  const withinSize =
    new TextEncoder().encode(source.text).byteLength <= MAX_RECURSIVE_TEXT_FILE_BYTES;
  return standaloneRegions(source.text, 0, source.text.length, ports, withinSize).map((child) => ({
    ...region,
    language: child.language,
    start: region.start + source.rawOffset(child.start),
    end: region.start + source.rawOffset(child.end),
    ...(child.yamlDocument === undefined ? {} : { yamlDocument: child.yamlDocument }),
    ...(child.refusal === undefined ? {} : { refusal: child.refusal }),
  }));
}

/** This linear check runs once per complete region, never on each remaining line suffix.
 * No assignment, literal, escape or declaration delimiter is present. Strict patterns still apply. */
function isSyntaxFreeProse(text: string): boolean {
  return /^[\p{L}\p{M}\s_.,!?;-]*$/u.test(text);
}

function inferredDocumentLanguage(text: string): "json" | "yaml" | undefined {
  if (isJsonDocument(text) || /^\s*\{\s*"/u.test(text)) return "json";
  return undefined;
}

function refusedProjection(
  body: string,
  report: { syntaxRefusals: number; depthRefusals: number },
  reason: "syntax" | "depth",
): readonly RedactionSpan[] {
  if (reason === "depth") report.depthRefusals += 1;
  else report.syntaxRefusals += 1;
  return [{ start: 0, end: body.length, replacement: maskedLiteralBody(body) }];
}

function inferredYamlPrefix(
  text: string,
  ports: ProjectionPorts,
):
  | {
      language: "yaml" | undefined;
      end: number;
      yamlDocument?: Document;
      refusal?: "syntax";
    }
  | undefined {
  const beforeCode = markdownCodeLineStart(text);
  if (
    beforeCode > 0 &&
    beforeCode < text.length &&
    isPublicYamlScalar(text.slice(0, beforeCode), ports)
  )
    return { language: undefined, end: beforeCode };
  const prefix = yamlPrivacyPrefix(text, mayStartStandaloneSource, ports.sensitiveName);
  if (prefix === undefined) return unparsedYamlPrefix(text);
  if (prefix.document !== undefined)
    return { language: "yaml", end: prefix.end, yamlDocument: prefix.document };
  if (isYamlDocument(text)) return { language: "yaml", end: text.length };
  if (prefix.syntaxRequired === true && !safeUnparsedText(text, ports))
    return { language: "yaml", end: text.length, refusal: "syntax" };
  return unparsedYamlPrefix(text);
}

function unparsedYamlPrefix(text: string): { language: undefined; end: number } | undefined {
  const end = plainYamlPrefixLength(text);
  return end > 0 ? { language: undefined, end } : undefined;
}

/** Unparsed plain fields retain strict text redaction; a later code candidate gets its own parser. */
function plainYamlPrefixLength(text: string): number {
  const before = markdownCodeLineStart(text);
  let start = Math.min(before, lineAfter(text, 0, before));
  while (start < before) {
    const end = Math.min(before, lineAfter(text, start, before));
    const line = text.slice(start, end);
    if (mayStartStandaloneSource(line) && !mayStartYaml(line)) return start;
    start = end;
  }
  return before;
}

function markdownCodeLineStart(text: string): number {
  const code = markdownCodeRanges(text)[0];
  return code === undefined ? text.length : text.lastIndexOf("\n", code.start - 1) + 1;
}

/** Rejected public text receives no code exemption; the ordinary redactor still owns it. */
function safeUnparsedText(text: string, ports: ProjectionPorts): boolean {
  return (
    !text.includes("\\") && !ports.mayContainSensitiveName(text) && ports.redactPlain(text) === text
  );
}

function bodyClosingFence(
  block: string,
  opening: string,
  depth: number,
  headerEnd: number,
): number | undefined {
  const closer = closingFence(block, opening, depth);
  return closer !== undefined && closer > headerEnd ? closer : undefined;
}

function retainSourceLine(
  rest: string,
  line: string,
  canReleaseYaml: (line: string) => boolean,
): boolean {
  return mayStartStandaloneSource(rest) && !(mayStartYaml(rest) && canReleaseYaml(line));
}
