// Output-format adherence fixtures (Epic #1307, Issue #1315). Exercises the format-adherence dimension
// across a structured table, a structured YAML config, and an unstructured prose answer, asserting the
// analyzer resolves the requested format and the generator pins controllability for structured outputs.

import type { PromptEnhancerEvalFixture } from "../types.js";

export const formatTable: PromptEnhancerEvalFixture = {
  name: "format-table",
  category: "format",
  description: "A request that mandates a structured table output.",
  request: { text: "Present a comparison of three caching strategies as a table." },
  dimensions: new Set(["format-adherence", "clarity"]),
  oracle: {
    expectedTaskClasses: ["factual-qa", "decision-support", "data-analysis"],
    expectedOutputStructured: true,
    expectedOutputFormat: "table",
  },
};

export const formatYaml: PromptEnhancerEvalFixture = {
  name: "format-yaml",
  category: "format",
  description: "A request that mandates a structured YAML output.",
  request: { text: "Produce the service deployment configuration in yaml." },
  dimensions: new Set(["format-adherence", "clarity"]),
  oracle: {
    expectedTaskClasses: ["factual-qa", "code-generation", "structured-extraction"],
    expectedOutputStructured: true,
    expectedOutputFormat: "yaml",
  },
};

export const formatProse: PromptEnhancerEvalFixture = {
  name: "format-prose",
  category: "format",
  description: "A request with no structured-format signal; output stays unstructured.",
  request: { text: "Explain in a paragraph how a hash map resolves collisions." },
  dimensions: new Set(["format-adherence", "clarity"]),
  oracle: {
    expectedTaskClasses: ["factual-qa"],
    expectedOutputStructured: false,
  },
};

export const FORMAT_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  formatTable,
  formatYaml,
  formatProse,
];
