import { afterEach, describe, expect, it, vi } from "vitest";
import { reportEditorInlineCompletionTelemetry, requestEditorInlineCompletion } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestEditorInlineCompletion (Issue #1200)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the overlay + cursor to the inline-completion route with the CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [{ insertText: "a + b;" }],
        provenance: {
          sources: ["model-assisted"],
          modelMode: "as-you-type",
          modelId: "fim-1",
          gatewayPolicyVersion: "editor-inline-completion/1",
          promptHash: "a".repeat(64),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestEditorInlineCompletion({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "function add(a, b) {\n  return \n}\n",
      position: { line: 1, character: 9 },
      triggerKind: "automatic",
      contextBudgetBytes: 8_192,
      maxOutputTokens: 64,
    });

    expect(response.items[0]?.insertText).toBe("a + b;");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/inline-completion",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          schemaVersion: "1",
          root: "/repo",
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "function add(a, b) {\n  return \n}\n",
          },
          position: { line: 1, character: 9 },
          triggerKind: "automatic",
          contextBudgetBytes: 8_192,
          maxOutputTokens: 64,
        }),
      }),
    );
  });

  it("forwards an abort signal for superseded-request cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [],
        provenance: { sources: [], modelMode: "deterministic" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestEditorInlineCompletion(
      {
        root: "/repo",
        path: "src/a.ts",
        languageId: "typescript",
        text: "x",
        position: { line: 0, character: 1 },
        triggerKind: "explicit",
        contextBudgetBytes: 8_192,
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/inline-completion",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("reportEditorInlineCompletionTelemetry (Issue #1200)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts content-free counts to the telemetry route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await reportEditorInlineCompletionTelemetry({
      root: "/repo",
      offered: 3,
      shown: 3,
      accepted: 1,
      rejected: 1,
      ignored: 1,
      partiallyAccepted: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/inline-completion/telemetry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "1",
          root: "/repo",
          offered: 3,
          shown: 3,
          accepted: 1,
          rejected: 1,
          ignored: 1,
          partiallyAccepted: 0,
        }),
      }),
    );
  });
});
