import { describe, expect, it } from "vitest";
import { analyzePrompt } from "./prompt-enhancer-analyzer.js";
import { PROMPT_ANALYZER_BENCHMARK_REQUEST } from "./prompt-enhancer-analyzer-benchmark-fixture.js";
import { PROMPT_ANALYSIS_MAX_SCAN_CHARS } from "./prompt-enhancer.js";

describe("prompt analyzer benchmark fixture", () => {
  it("reaches the complete production scan ceiling", () => {
    expect(analyzePrompt(PROMPT_ANALYZER_BENCHMARK_REQUEST).normalizedInputLength).toBe(
      PROMPT_ANALYSIS_MAX_SCAN_CHARS,
    );
  });
});
