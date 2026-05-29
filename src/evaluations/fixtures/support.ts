// Fixture authoring helpers (ADR-0012 D3). A NormalizedResponse builder and a fenced-diff helper so
// each fixture module stays compact and declares only its intent (workspace files, transcript,
// oracle, dimensions). These are typed data builders — no node built-ins, no IO — so the modules are
// pure value modules that compile and ship (C1) without touching tsc on the intentionally buggy code
// embedded as STRINGS in workspaceFiles.

import type { NormalizedResponse } from "../../gateway/types.js";

// A NormalizedResponse carrying the given content. Token/latency/cost values are fixed so the folded
// usage totals (and thus the evidence manifest) are deterministic across runs.
export function scriptedResponse(content: string, modelId = "eval-model"): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "eval-req",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// Wraps a unified-diff body in a ```diff fence, the format both workflow parsers expect.
export function fencedDiff(diffBody: string): string {
  return ["```diff", diffBody.trimEnd(), "```"].join("\n");
}

// A minimal Node ESM package.json string with a vitest `test` script, so detectWorkspace identifies
// the project and the verification fallback finds a runnable `test` step.
export const FIXTURE_PACKAGE_JSON = JSON.stringify(
  {
    name: "keiko-eval-fixture",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "^4.1.7" },
  },
  null,
  2,
);

// A minimal tsconfig so unit-test convention detection produces a mirrored/sibling naming style.
export const FIXTURE_TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: { strict: true, module: "NodeNext", target: "ES2022" },
    include: ["src", "tests"],
  },
  null,
  2,
);
