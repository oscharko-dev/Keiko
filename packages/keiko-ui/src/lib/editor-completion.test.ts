import { describe, expect, it } from "vitest";
import type { EditorCompletionWireResponse } from "./types";
import { mapWireToEditorCompletionResponse } from "./editor-completion";

const REQUEST = { requestId: "r-1", streamId: "s-1", sequence: 3 };

function wire(overrides: Partial<EditorCompletionWireResponse> = {}): EditorCompletionWireResponse {
  return {
    schemaVersion: "1",
    items: [],
    isIncomplete: false,
    truncated: false,
    provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
    ...overrides,
  };
}

describe("mapWireToEditorCompletionResponse", () => {
  it("maps deterministic items to deterministic-completion provenance", () => {
    const response = mapWireToEditorCompletionResponse(
      REQUEST,
      wire({
        items: [
          {
            label: "alpha",
            kind: "field",
            insertText: "alpha",
            origin: "deterministic",
            detail: "number",
          },
        ],
      }),
      1_700_000_000_000,
    );
    expect(response.request).toBe(REQUEST);
    expect(response.items[0]).toEqual({
      label: "alpha",
      kind: "field",
      insertText: "alpha",
      detail: "number",
      provenance: { origin: "deterministic-completion" },
    });
  });

  it("maps model-assisted items to ai-completion provenance from the response rollup", () => {
    const response = mapWireToEditorCompletionResponse(
      REQUEST,
      wire({
        items: [{ label: "foo()", kind: "snippet", insertText: "foo()", origin: "model-assisted" }],
        provenance: {
          sources: ["deterministic-language-service", "model-assisted", "repository-context"],
          modelMode: "as-you-type",
          modelId: "fim-1",
          gatewayPolicyVersion: "editor-completion/1",
          promptHash: "a".repeat(64),
        },
      }),
      1_700_000_000_000,
    );
    expect(response.items[0]?.provenance).toEqual({
      origin: "ai-completion",
      model: {
        modelId: "fim-1",
        gatewayPolicyVersion: "editor-completion/1",
        promptHash: "a".repeat(64),
        producedAt: 1_700_000_000_000,
      },
    });
    expect(response.provenance.sources).toEqual([
      "deterministic-language-service",
      "model-assisted",
      "repository-context",
    ]);
    expect(response.provenance.modelMode).toBe("as-you-type");
  });

  it("maps the broader language-service item kinds onto the editor icon set", () => {
    const response = mapWireToEditorCompletionResponse(
      REQUEST,
      wire({
        items: [
          { label: "v", kind: "value", insertText: "v", origin: "deterministic" },
          { label: "e", kind: "enum", insertText: "e", origin: "deterministic" },
          { label: "s", kind: "struct", insertText: "s", origin: "deterministic" },
          { label: "t", kind: "typeParameter", insertText: "t", origin: "deterministic" },
          { label: "c", kind: "constant", insertText: "c", origin: "deterministic" },
        ],
      }),
      0,
    );
    expect(response.items.map((item) => item.kind)).toEqual([
      "variable",
      "interface",
      "class",
      "variable",
      "variable",
    ]);
  });

  it("carries the degrade reason and incomplete flag through", () => {
    const response = mapWireToEditorCompletionResponse(
      REQUEST,
      wire({
        isIncomplete: true,
        provenance: {
          sources: ["deterministic-language-service"],
          modelMode: "deterministic",
          degradeReason: "no-infilling-model",
        },
      }),
      0,
    );
    expect(response.isIncomplete).toBe(true);
    expect(response.provenance.degradeReason).toBe("no-infilling-model");
  });

  it("falls back to placeholder model identity when the rollup omits it", () => {
    const response = mapWireToEditorCompletionResponse(
      REQUEST,
      wire({
        items: [{ label: "x", kind: "text", insertText: "x", origin: "model-assisted" }],
        provenance: { sources: ["model-assisted"], modelMode: "manual" },
      }),
      5,
    );
    expect(response.items[0]?.provenance).toEqual({
      origin: "ai-completion",
      model: { modelId: "unknown", gatewayPolicyVersion: "unknown", promptHash: "", producedAt: 5 },
    });
  });
});
