// Maps the governed completion-gateway wire response (Issue #1199) into the editor package's
// `EditorCompletionResponse`. The host (keiko-ui) owns this seam: it calls the BFF (`requestEditorCompletion`)
// and adapts the content-free wire shape to the editor's render contract, including per-item
// provenance (deterministic vs. model-assisted) and the response-level source rollup (AC7). The
// editor package itself stays free of any BFF or contracts-wire knowledge (ADR-0042 D5).

import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorCompletionResponse,
  EditorOutputProvenance,
  EditorRequestIdentity,
} from "@oscharko-dev/keiko-editor";
import type { LanguageCompletionItemKind } from "@oscharko-dev/keiko-contracts";
import type { EditorCompletionWireItem, EditorCompletionWireResponse } from "./types";

// The language-service item-kind set is broader than the editor's icon set; map the extra kinds onto
// the nearest editor kind so every item still renders a sensible icon.
const KIND_MAP: Readonly<Record<LanguageCompletionItemKind, EditorCompletionItemKind>> = {
  text: "text",
  method: "method",
  function: "function",
  constructor: "constructor",
  field: "field",
  variable: "variable",
  class: "class",
  interface: "interface",
  module: "module",
  property: "property",
  value: "variable",
  enum: "interface",
  keyword: "keyword",
  snippet: "snippet",
  constant: "variable",
  struct: "class",
  typeParameter: "variable",
};

function itemProvenance(
  wire: EditorCompletionWireResponse,
  origin: EditorCompletionWireItem["origin"],
  nowMs: number,
): EditorOutputProvenance {
  if (origin === "deterministic") {
    return { origin: "deterministic-completion" };
  }
  return {
    origin: "ai-completion",
    model: {
      modelId: wire.provenance.modelId ?? "unknown",
      gatewayPolicyVersion: wire.provenance.gatewayPolicyVersion ?? "unknown",
      promptHash: wire.provenance.promptHash ?? "",
      producedAt: nowMs,
    },
  };
}

function mapItem(
  item: EditorCompletionWireItem,
  wire: EditorCompletionWireResponse,
  nowMs: number,
): EditorCompletionItem {
  return {
    label: item.label,
    kind: KIND_MAP[item.kind],
    insertText: item.insertText,
    provenance: itemProvenance(wire, item.origin, nowMs),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
  };
}

/** Adapt the BFF wire response into the editor render contract for a given request identity. */
export function mapWireToEditorCompletionResponse(
  request: EditorRequestIdentity,
  wire: EditorCompletionWireResponse,
  nowMs: number,
): EditorCompletionResponse {
  return {
    request,
    items: wire.items.map((item) => mapItem(item, wire, nowMs)),
    isIncomplete: wire.isIncomplete,
    provenance: {
      sources: wire.provenance.sources,
      modelMode: wire.provenance.modelMode,
      ...(wire.provenance.degradeReason === undefined
        ? {}
        : { degradeReason: wire.provenance.degradeReason }),
    },
  };
}
