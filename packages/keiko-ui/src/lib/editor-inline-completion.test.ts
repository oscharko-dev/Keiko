import { describe, expect, it } from "vitest";
import type { EditorInlineCompletionWireResponse } from "./types";
import { mapWireToEditorInlineCompletionResponse } from "./editor-inline-completion";

const REQUEST = { requestId: "r-1", streamId: "s-1", sequence: 3 };
const POSITION = { line: 1, column: 9 };
const MODEL_PROVENANCE = {
  modelId: "fim-1",
  gatewayPolicyVersion: "editor-inline-completion/1",
  promptHash: "a".repeat(64),
};

function wire(
  overrides: Partial<EditorInlineCompletionWireResponse> = {},
): EditorInlineCompletionWireResponse {
  return {
    schemaVersion: "1",
    items: [],
    provenance: { sources: [], modelMode: "deterministic" },
    ...overrides,
  };
}

describe("mapWireToEditorInlineCompletionResponse", () => {
  it("maps a ghost-text item to ai-inline-completion provenance with an empty range at the cursor", () => {
    const response = mapWireToEditorInlineCompletionResponse(
      REQUEST,
      POSITION,
      wire({
        items: [{ insertText: "a + b;" }],
        provenance: {
          sources: ["model-assisted", "repository-context"],
          modelMode: "as-you-type",
          ...MODEL_PROVENANCE,
        },
      }),
      1_700_000_000_000,
    );
    expect(response.request).toBe(REQUEST);
    expect(response.items[0]).toEqual({
      insertText: "a + b;",
      range: { start: POSITION, end: POSITION },
      provenance: {
        origin: "ai-inline-completion",
        model: { ...MODEL_PROVENANCE, producedAt: 1_700_000_000_000 },
      },
    });
    expect(response.provenance?.sources).toEqual(["model-assisted", "repository-context"]);
    expect(response.provenance?.modelMode).toBe("as-you-type");
  });

  it("maps an explicit wire range (character -> column)", () => {
    const response = mapWireToEditorInlineCompletionResponse(
      REQUEST,
      POSITION,
      wire({
        items: [
          {
            insertText: "x",
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
          },
        ],
        provenance: { sources: ["model-assisted"], modelMode: "manual", ...MODEL_PROVENANCE },
      }),
      0,
    );
    expect(response.items[0]?.range).toEqual({
      start: { line: 0, column: 2 },
      end: { line: 0, column: 5 },
    });
  });

  it("drops items when the model provenance is missing or malformed", () => {
    const missing = mapWireToEditorInlineCompletionResponse(
      REQUEST,
      POSITION,
      wire({
        items: [{ insertText: "x" }],
        provenance: { sources: ["model-assisted"], modelMode: "manual" },
      }),
      0,
    );
    expect(missing.items).toEqual([]);

    const badHash = mapWireToEditorInlineCompletionResponse(
      REQUEST,
      POSITION,
      wire({
        items: [{ insertText: "x" }],
        provenance: {
          sources: ["model-assisted"],
          modelMode: "manual",
          modelId: "fim-1",
          gatewayPolicyVersion: "editor-inline-completion/1",
          promptHash: "nope",
        },
      }),
      0,
    );
    expect(badHash.items).toEqual([]);
  });

  it("carries the degrade reason and yields no items on a deterministic degrade", () => {
    const response = mapWireToEditorInlineCompletionResponse(
      REQUEST,
      POSITION,
      wire({
        items: [],
        provenance: {
          sources: [],
          modelMode: "deterministic",
          degradeReason: "no-infilling-model",
        },
      }),
      0,
    );
    expect(response.items).toEqual([]);
    expect(response.provenance?.degradeReason).toBe("no-infilling-model");
  });
});
