import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type {
  CodingContextPack,
  EditorTestGenerationWireRequest,
  EditorTestGenerationWireTarget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import {
  defaultTestGenerationRunner,
  type TestGenerationRunnerArgs,
} from "./testGenerationRunner.js";

// Partial mock: override only generateUnitTests so other consumers of the workflows barrel (e.g. the
// descriptor used by keiko-evaluations, loaded transitively via the server) keep their real exports.
vi.mock("@oscharko-dev/keiko-workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-workflows")>();
  return { ...actual, generateUnitTests: vi.fn() };
});
const { generateUnitTests } = await import("@oscharko-dev/keiko-workflows");
const mockGenerate = vi.mocked(generateUnitTests);

const CREATE_DIFF = [
  "--- /dev/null",
  "+++ b/src/a.test.ts",
  "@@ -0,0 +1,1 @@",
  "+it('adds', () => {});",
  "",
].join("\n");

const TARGET: EditorTestGenerationWireTarget = {
  kind: "file",
  document: { path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" },
};

const EMPTY_PACK: CodingContextPack = {
  schemaVersion: "1",
  purpose: "test-generation",
  excerpts: [],
  usedBytes: 0,
  budgetBytes: 0,
  droppedForBudget: 0,
  omissions: [],
};

function config(): GatewayConfig {
  return {
    providers: [{ modelId: "model-x", baseUrl: "http://localhost", apiKey: "k" }],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  } as unknown as GatewayConfig;
}

function deps(input: { config?: GatewayConfig; modelPort?: boolean } = {}): UiHandlerDeps {
  return {
    env: {},
    modelPortFactory: () =>
      input.modelPort === false ? undefined : { call: () => Promise.reject(new Error("unused")) },
    ...(input.config === undefined ? {} : { config: input.config }),
  } as unknown as UiHandlerDeps;
}

function args(overrides: Partial<TestGenerationRunnerArgs> = {}): TestGenerationRunnerArgs {
  const request: EditorTestGenerationWireRequest = {
    schemaVersion: "1",
    root: "/ws",
    target: TARGET,
    contextBudgetBytes: 1_024,
  };
  return {
    request,
    deps: deps({ config: config() }),
    realRoot: "/ws",
    signal: new AbortController().signal,
    nowMs: 1_000,
    contextPack: EMPTY_PACK,
    ...overrides,
  };
}

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("defaultTestGenerationRunner", () => {
  it("returns undefined when no gateway model is configured", async () => {
    expect(await defaultTestGenerationRunner(args({ deps: deps() }))).toBeUndefined();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns undefined when no model port can be built", async () => {
    const result = await defaultTestGenerationRunner(
      args({ deps: deps({ config: config(), modelPort: false }) }),
    );
    expect(result).toBeUndefined();
  });

  it("reuses the workflow in dry-run and surfaces a reviewable candidate", async () => {
    mockGenerate.mockResolvedValue({ proposedDiff: CREATE_DIFF } as never);
    const result = await defaultTestGenerationRunner(args());
    // Reuse: dry-run (apply false) is forwarded to the existing workflow with a resolved model port.
    expect(mockGenerate.mock.calls[0]?.[0]).toMatchObject({
      apply: false,
      workspaceRoot: "/ws",
      modelId: "model-x",
    });
    // The resolved model port is forwarded as the workflow's model dependency.
    expect(mockGenerate.mock.calls[0]?.[1]).toHaveProperty("model");
    expect(result?.patch.files[0]?.changeKind).toBe("added");
    expect(result?.provenance.modelId).toBe("model-x");
    expect(result?.funnel.candidatesGenerated).toBe(1);
    expect(result?.funnel.executionEnabled).toBe(false);
  });

  it("returns undefined when the workflow proposes no diff or an unparseable diff", async () => {
    mockGenerate.mockResolvedValue({ proposedDiff: undefined } as never);
    expect(await defaultTestGenerationRunner(args())).toBeUndefined();
    mockGenerate.mockResolvedValue({ proposedDiff: "garbage" } as never);
    expect(await defaultTestGenerationRunner(args())).toBeUndefined();
  });
});
