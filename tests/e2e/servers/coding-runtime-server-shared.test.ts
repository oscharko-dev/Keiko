// KEIKO-0902 regression: nextScriptedTurn used to spin forever if a script emitted back-to-back
// `question` tool calls when `includeQuestion` was false — the outer Playwright deadline caught
// it, but with no diagnostic naming the invariant. The fix bounds the skip loop and throws with
// a named message. This test mocks `scriptedResponse` to always emit a `question` tool call, so
// the loop's own ceiling — not any script-mode branching — is what's exercised.
import { describe, expect, it, vi } from "vitest";

type SupportModule =
  typeof import("../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js");
vi.mock(
  "../../../packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.js",
  async (originalImport) => {
    const actual = await originalImport();
    return {
      ...(actual as SupportModule),
      scriptedResponse: (): {
        readonly text: string;
        readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
      } => ({
        text: "",
        toolCalls: [{ name: "question", input: {} }],
      }),
    };
  },
);

// Import AFTER the mock is registered so `scriptedResponse` resolves to the stub above.
const { nextScriptedTurn } = await import("./coding-runtime-server-shared.mjs");

type ScriptStateStub = Parameters<typeof nextScriptedTurn>[0];

describe("nextScriptedTurn question-skip ceiling (KEIKO-0902)", () => {
  it("throws a named error once the skip ceiling is exceeded", () => {
    const script = { calls: 0, mode: "productive" } as unknown as ScriptStateStub;
    expect(() => nextScriptedTurn(script, false, "")).toThrow(
      /nextScriptedTurn: scripted transcript exceeded question-skip bound/u,
    );
  });

  it("returns the response immediately when the caller allows question tool calls", () => {
    const script = { calls: 0, mode: "productive" } as unknown as ScriptStateStub;
    const response = nextScriptedTurn(script, true, "");
    expect(response.toolCalls[0]?.name).toBe("question");
  });
});
