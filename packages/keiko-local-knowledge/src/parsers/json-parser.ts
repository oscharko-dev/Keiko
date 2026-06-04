// JSON parser adapter (Epic #189, Issue #266). Pure: bytes -> ParserResult.
//
// Emits one ParsedUnit { kind: "json-path", jsonPointer } per LEAF value (string / number /
// boolean / null / empty array / empty object). Pointers follow RFC 6901 — keys are encoded
// with `~0` for `~` and `~1` for `/`. Object keys with the same name are NOT deduplicated;
// callers see one unit per traversal step so duplicate keys (which `JSON.parse` itself
// resolves by last-wins) collapse the same way they do in the parsed object.
//
// Character offsets: every leaf is emitted with a whole-document span [0, text.length) because
// `JSON.parse` discards positions and we have not yet wired a per-leaf re-scanner. The
// JSON Pointer (not the character span) is what downstream layers (#195 chunker, #196 indexer)
// use for citation. Precise per-leaf offsets are deferred to a follow-up issue.

import {
  decodeUtf8,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import type { ParserAdapter, ParserOptions, ParserSelectionInput } from "./types.js";

const PARSER_ID = "json";
const PARSER_VERSION = "1";

const JSON_EXTENSIONS: ReadonlySet<string> = new Set(["json", "jsonl", "ndjson"]);

function isJson(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (JSON_EXTENSIONS.has(ext)) return true;
  const media = input.mediaType.toLowerCase();
  return media === "application/json" || media === "application/ld+json";
}

function encodePointerSegment(key: string): string {
  // RFC 6901: `~` -> `~0`, `/` -> `~1`. Order matters: replace `~` first.
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function joinPointer(parent: string, segment: string): string {
  return `${parent}/${segment}`;
}

interface ScanContext {
  readonly text: string;
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
  readonly units: ParsedUnit[];
  readonly diagnostics: ParserDiagnostic[];
  stopped: boolean;
}

function pushLeaf(ctx: ScanContext, pointer: string, start: number, end: number): void {
  const limit = shouldStop(ctx.startedAt, ctx.options, ctx.units.length);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    ctx.diagnostics.push(diagnostic(limit.code, limit.message, ctx.input.documentId, "info"));
    ctx.stopped = true;
    return;
  }
  ctx.units.push({
    kind: "json-path",
    documentId: ctx.input.documentId,
    jsonPointer: pointer,
    characterStart: start,
    characterEnd: end,
  });
}

function isLeaf(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (t === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return true;
}

function descendArray(ctx: ScanContext, value: readonly unknown[], pointer: string): void {
  for (let i = 0; i < value.length; i += 1) {
    if (ctx.stopped) return;
    walk(ctx, value[i], joinPointer(pointer, String(i)));
  }
}

function descendObject(ctx: ScanContext, value: Record<string, unknown>, pointer: string): void {
  for (const key of Object.keys(value)) {
    if (ctx.stopped) return;
    walk(ctx, value[key], joinPointer(pointer, encodePointerSegment(key)));
  }
}

function walk(ctx: ScanContext, value: unknown, pointer: string): void {
  if (ctx.stopped) return;
  if (isLeaf(value)) {
    // Character offsets are approximated as [0, text.length) for the root leaf and 0/0 for
    // nested leaves — #195's chunker uses the JSON Pointer, not the character span, for
    // citation, and #196 stores the raw text in the document body anyway. Honest "we did not
    // re-scan" is preferable to inventing fake offsets.
    pushLeaf(ctx, pointer, 0, ctx.text.length);
    return;
  }
  if (Array.isArray(value)) {
    descendArray(ctx, value, pointer);
    return;
  }
  descendObject(ctx, value as Record<string, unknown>, pointer);
}

function parseJsonValue(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "JSON parse error" };
  }
}

export const jsonParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isJson(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(jsonParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const decoded = decodeUtf8(input.bytes);
    const parsed = parseJsonValue(decoded.text);
    if (!parsed.ok) {
      return emptyResult(jsonParser.capability, input.documentId, options, [
        diagnostic(
          "MALFORMED_INPUT",
          `JSON parse failed: ${parsed.error}`,
          input.documentId,
          "error",
        ),
      ]);
    }
    const ctx: ScanContext = {
      text: decoded.text,
      input,
      options,
      startedAt: options.now(),
      units: [],
      diagnostics: [],
      stopped: false,
    };
    walk(ctx, parsed.value, "");
    return emptyResult(
      jsonParser.capability,
      input.documentId,
      options,
      ctx.diagnostics,
      ctx.units,
    );
  },
});
