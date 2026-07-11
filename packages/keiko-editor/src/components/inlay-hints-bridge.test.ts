import { describe, expect, it } from "vitest";

import { createKeikoInlayHintsProvider } from "./inlay-hints-bridge.js";

const URI = { toString: (): string => "keiko-editor://current" };

describe("createKeikoInlayHintsProvider", () => {
  it("maps inferred parameter and type hints into Monaco's native renderer", async () => {
    const provider = createKeikoInlayHintsProvider({
      resolve: (query) =>
        Promise.resolve({
          request: query.request.request,
          hints: [
            { position: { line: 0, column: 7 }, label: "value:", kind: "parameter" },
            { position: { line: 1, column: 12 }, label: ": string", kind: "type" },
          ],
        }),
      isCurrentDocument: () => true,
      documentLanguage: "typescript",
      streamId: "inlay",
      newRequestId: () => "request",
    });
    const result = await provider.provideInlayHints(
      { getValue: () => "format('x');\nlet result = 'x';", uri: URI },
      { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 18 },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: (): void => undefined }),
      },
    );

    expect(result?.hints).toEqual([
      {
        label: "value:",
        position: { lineNumber: 1, column: 8 },
        kind: 2,
        paddingLeft: false,
        paddingRight: false,
      },
      {
        label: ": string",
        position: { lineNumber: 2, column: 13 },
        kind: 1,
        paddingLeft: false,
        paddingRight: false,
      },
    ]);
  });
});
