// Shared test fixture builder for promptEnhancer tests. Not a *.test.ts so vitest does not collect
// it (mirrors the package-root ../_support.ts pattern).

import type { PromptEnhancerEvalFixture } from "./index.js";

// KEIKO-0923: render.test.ts and runner.test.ts each independently inlined this same benign-draft
// fixture to force a NO-GO / safety-gate-FAIL: a draft that cannot produce injection signals, paired
// with an oracle that expects them. Callers may override name/description/category to keep each
// file's distinct labeling; the request/dimensions/oracle shape is the load-bearing part and must not
// drift between call sites.
export function benignDraftExpectingInjectionSignals(
  overrides: Partial<PromptEnhancerEvalFixture> = {},
): PromptEnhancerEvalFixture {
  return {
    name: "benign-draft-expecting-injection-signals",
    category: "adversarial",
    description: "intentionally failing safety fixture",
    request: { text: "Hello, please help me write a short note." },
    dimensions: new Set(["safety"]),
    oracle: { expectedTaskClasses: ["factual-qa"], expectsInjectionSignals: true },
    ...overrides,
  };
}
