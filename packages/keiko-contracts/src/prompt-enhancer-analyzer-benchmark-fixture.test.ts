import { describe, expect, it } from "vitest";
import { analyzePrompt, detectPromptAnalyzerCueGroups } from "./prompt-enhancer-analyzer.js";
import {
  PROMPT_ANALYZER_BENCHMARK_REQUEST,
  PROMPT_ANALYZER_GUARDED_BENCHMARK_CASES,
} from "./prompt-enhancer-analyzer-benchmark-fixture.js";
import { PROMPT_ANALYSIS_MAX_SCAN_CHARS } from "./prompt-enhancer.js";

describe("prompt analyzer benchmark fixture", () => {
  it("reaches the complete production scan ceiling", () => {
    expect(analyzePrompt(PROMPT_ANALYZER_BENCHMARK_REQUEST).normalizedInputLength).toBe(
      PROMPT_ANALYSIS_MAX_SCAN_CHARS,
    );
  });

  it("contains no literal match from any production cue group", () => {
    expect(detectPromptAnalyzerCueGroups(PROMPT_ANALYZER_BENCHMARK_REQUEST.input.text)).toEqual([]);
  });

  it.each(PROMPT_ANALYZER_GUARDED_BENCHMARK_CASES)(
    "activates the $name guard at the production ceiling",
    ({ expectedMissingTopic, expectedTaskClass, request }) => {
      const analysis = analyzePrompt(request);
      expect(analysis.normalizedInputLength).toBe(PROMPT_ANALYSIS_MAX_SCAN_CHARS);
      expect(analysis.taskClass).toBe(expectedTaskClass);
      expect(analysis.missingContext.map(({ topic }) => topic)).toContain(expectedMissingTopic);
    },
  );

  it("derives task-class and domain diagnostics from their production rule sets", () => {
    expect(detectPromptAnalyzerCueGroups("Return a medical code snippet")).toEqual([
      "taskClass",
      "domain",
    ]);
  });
});
