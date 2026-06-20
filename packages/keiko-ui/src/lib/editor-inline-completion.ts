// Maps the governed inline-completion wire response (Issue #1200) into the editor package's
// `EditorInlineCompletionResponse`. The host (keiko-ui) owns this seam: it calls the BFF
// (`requestEditorInlineCompletion`) and adapts the content-free wire shape to the editor's render
// contract, including per-item AI provenance and the response-level source rollup. The editor package
// itself stays free of any BFF or contracts-wire knowledge (ADR-0042 D5). Inline completion is
// model-only, so an item with incomplete model provenance is dropped rather than rendered ungoverned.

import type {
  EditorInlineCompletionItem,
  EditorInlineCompletionProvenance,
  EditorInlineCompletionResponse,
  EditorOutputProvenance,
  EditorPosition,
  EditorRange,
  EditorRequestIdentity,
} from "@oscharko-dev/keiko-editor";
import type { EditorInlineCompletionWireItem, EditorInlineCompletionWireResponse } from "./types";

const PROMPT_HASH_HEX = /^[0-9a-f]{64}$/u;

function emptyRangeAt(position: EditorPosition): EditorRange {
  return { start: position, end: position };
}

// Map the wire item's optional LanguageRange ({line, character}) to the editor's EditorRange
// ({line, column}); default to an empty range at the cursor (a pure insertion) when absent.
function itemRange(item: EditorInlineCompletionWireItem, position: EditorPosition): EditorRange {
  if (item.range === undefined) {
    return emptyRangeAt(position);
  }
  return {
    start: { line: item.range.start.line, column: item.range.start.character },
    end: { line: item.range.end.line, column: item.range.end.character },
  };
}

// Inline ghost text is always model-assisted; build content-free model provenance from the response
// rollup, or return null (drop the item) when the model identity/hash is missing or malformed.
function inlineItemProvenance(
  wire: EditorInlineCompletionWireResponse,
  nowMs: number,
): EditorOutputProvenance | null {
  const { modelId, gatewayPolicyVersion, promptHash } = wire.provenance;
  if (
    modelId === undefined ||
    modelId.length === 0 ||
    gatewayPolicyVersion === undefined ||
    gatewayPolicyVersion.length === 0 ||
    promptHash === undefined ||
    !PROMPT_HASH_HEX.test(promptHash)
  ) {
    return null;
  }
  return {
    origin: "ai-inline-completion",
    model: { modelId, gatewayPolicyVersion, promptHash, producedAt: nowMs },
  };
}

function mapItem(
  item: EditorInlineCompletionWireItem,
  wire: EditorInlineCompletionWireResponse,
  position: EditorPosition,
  nowMs: number,
): EditorInlineCompletionItem | null {
  const provenance = inlineItemProvenance(wire, nowMs);
  if (provenance === null) {
    return null;
  }
  return { insertText: item.insertText, range: itemRange(item, position), provenance };
}

function responseProvenance(
  wire: EditorInlineCompletionWireResponse,
): EditorInlineCompletionProvenance {
  return {
    sources: wire.provenance.sources,
    modelMode: wire.provenance.modelMode,
    ...(wire.provenance.degradeReason === undefined
      ? {}
      : { degradeReason: wire.provenance.degradeReason }),
  };
}

/** Adapt the BFF wire response into the editor inline-completion render contract. */
export function mapWireToEditorInlineCompletionResponse(
  request: EditorRequestIdentity,
  position: EditorPosition,
  wire: EditorInlineCompletionWireResponse,
  nowMs: number,
): EditorInlineCompletionResponse {
  return {
    request,
    items: wire.items
      .map((item) => mapItem(item, wire, position, nowMs))
      .filter((item): item is EditorInlineCompletionItem => item !== null),
    provenance: responseProvenance(wire),
  };
}
