// KEIKO-0902 regression: nextScriptedTurn used to spin forever if a script emitted back-to-back
// `question` tool calls when `includeQuestion` was false — the outer Playwright deadline caught
// it, but with no diagnostic naming the invariant. The fix bounds the skip loop and throws with
// a named message. This test mocks `scriptedResponse` to always emit a `question` tool call, so
// the loop's own ceiling — not any script-mode branching — is what's exercised.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { gatewayObserver, nextScriptedTurn } = await import("./coding-runtime-server-shared.mjs");

type ScriptStateStub = Parameters<typeof nextScriptedTurn>[0];
type GatewayRequestStub = Parameters<NonNullable<ReturnType<typeof gatewayObserver>>>[0];

const DIGESTS = {
  catalogRevision: "a".repeat(64),
  projectionDigest: "b".repeat(64),
  handlerSetDigest: "c".repeat(64),
};

afterEach(() => {
  delete process.env.KEIKO_2483_GATEWAY_OBSERVATION_PATH;
});

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

  it("retains the cancellable hold after an emitted verification", () => {
    const script = {
      calls: 6,
      mode: "productive",
      holdAfterVerification: true,
      verificationIssued: true,
    } as unknown as ScriptStateStub;
    const response = nextScriptedTurn(script, false, "");
    expect(response.toolCalls[0]?.name).toBe("question");
  });

  it("retains one stable body-free production catalog binding across gateway requests", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-gateway-binding-"));
    const outputPath = join(root, "gateway.json");
    process.env.KEIKO_2483_GATEWAY_OBSERVATION_PATH = outputPath;
    const observe = gatewayObserver();
    if (observe === undefined) throw new Error("Expected gateway observer");
    const request = {
      maxOutputTokens: 4096,
      toolCatalog: {
        offered: {
          binding: {
            ...DIGESTS,
            profile: { id: "opencode", version: 1 },
          },
        },
      },
    } as GatewayRequestStub;
    try {
      observe(request);
      observe(request);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
        requestCount: 2,
        catalogBindingRequestCount: 2,
        catalogBinding: { ...DIGESTS, profile: { id: "opencode", version: 1 } },
        contentFieldsRecorded: false,
      });
      expect(() => {
        observe({
          ...request,
          toolCatalog: {
            ...request.toolCatalog,
            offered: {
              ...request.toolCatalog?.offered,
              binding: {
                ...request.toolCatalog?.offered.binding,
                handlerSetDigest: "d".repeat(64),
              },
            },
          },
        } as GatewayRequestStub);
      }).toThrow("catalog binding changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
