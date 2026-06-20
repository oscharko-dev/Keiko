// Task-class evaluation fixtures (Epic #1307, Issue #1315). One representative draft per supported
// task class, covering all fifteen classes the taxonomy defines (the issue requires at least ten). Each
// draft carries strong lexical signals so the deterministic analyzer classifies it stably, and asserts
// the recommended profile, well-formed structure, and a clean safety posture. These data modules are
// pure values — no IO — and never carry credentials or content beyond the draft itself.

import type { PromptEnhancerEvalFixture } from "../types.js";

// Dimensions every task-class fixture exercises: the prompt is well-formed, complete, classified
// correctly, safe, and within its token budget.
const CORE = new Set([
  "clarity",
  "completeness",
  "task-success",
  "safety",
  "token-efficiency",
] as const);

export const factualQa: PromptEnhancerEvalFixture = {
  name: "task-factual-qa",
  category: "task-class",
  description: "A plain factual question with no retrieval need (the conservative default class).",
  request: { text: "What is the boiling point of water at sea level?" },
  dimensions: new Set([...CORE, "groundedness", "faithfulness"]),
  oracle: {
    expectedTaskClasses: ["factual-qa"],
    expectedProfiles: ["precise"],
    expectedGroundingRequired: false,
  },
};

export const research: PromptEnhancerEvalFixture = {
  name: "task-research",
  category: "task-class",
  description: "A comprehensive research request that mandates grounding.",
  request: {
    text: "Give me a comprehensive overview and literature review of the state of the art in solid-state battery research.",
  },
  dimensions: new Set([...CORE, "groundedness", "faithfulness"]),
  oracle: {
    expectedTaskClasses: ["research"],
    expectedProfiles: ["research"],
    expectedGroundingRequired: true,
  },
};

export const ragQuestionAnswering: PromptEnhancerEvalFixture = {
  name: "task-rag-qa",
  category: "task-class",
  description: "A question answered strictly from supplied/connected context.",
  request: {
    text: "Based on the provided document, what notice period does the contract require for termination?",
    hasConnectedContext: true,
    attachmentCount: 1,
  },
  dimensions: new Set([...CORE, "groundedness", "faithfulness"]),
  oracle: {
    expectedTaskClasses: ["rag-question-answering"],
    expectedGroundingRequired: true,
    expectedGroundingStrategies: ["supplied-context-only", "hybrid", "local-knowledge"],
  },
};

export const summarization: PromptEnhancerEvalFixture = {
  name: "task-summarization",
  category: "task-class",
  description: "A summarization request over supplied material.",
  request: {
    text: "Summarize the following quarterly report into the key points for an executive audience.",
  },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["summarization"] },
};

export const structuredExtraction: PromptEnhancerEvalFixture = {
  name: "task-structured-extraction",
  category: "task-class",
  description: "An extraction request into a structured (JSON) form.",
  request: {
    text: "Extract the fields invoice number, total, and due date into json from this invoice text.",
  },
  dimensions: new Set([...CORE, "format-adherence"]),
  oracle: {
    expectedTaskClasses: ["structured-extraction"],
    expectedOutputStructured: true,
    expectedOutputFormat: "json",
  },
};

export const dataAnalysis: PromptEnhancerEvalFixture = {
  name: "task-data-analysis",
  category: "task-class",
  description: "A statistical analysis request over a dataset.",
  request: {
    text: "Analyze this data and report the correlation between advertising spend and monthly revenue.",
  },
  dimensions: new Set([...CORE, "format-adherence"]),
  oracle: { expectedTaskClasses: ["data-analysis"], expectedProfiles: ["technical"] },
};

export const codeGeneration: PromptEnhancerEvalFixture = {
  name: "task-code-generation",
  category: "task-class",
  description: "A code-writing request.",
  request: { text: "Write a function that validates an email address and returns a boolean." },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["code-generation"], expectedProfiles: ["technical"] },
};

export const codeDebugging: PromptEnhancerEvalFixture = {
  name: "task-code-debugging",
  category: "task-class",
  description: "A debugging request driven by a failing stack trace.",
  request: {
    text: "Debug this stack trace and explain why does this fail when the list is empty.",
  },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["code-debugging"], expectedProfiles: ["technical"] },
};

export const codeArchitecture: PromptEnhancerEvalFixture = {
  name: "task-code-architecture",
  category: "task-class",
  description: "A system-design request.",
  request: {
    text: "Design the software architecture for a multi-tenant document collaboration service.",
  },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["code-architecture"], expectedProfiles: ["technical"] },
};

export const writingEditing: PromptEnhancerEvalFixture = {
  name: "task-writing-editing",
  category: "task-class",
  description: "A drafting/editing request that favours a lean profile.",
  request: { text: "Draft a short, polite email to reschedule a meeting and proofread it." },
  dimensions: new Set([...CORE]),
  oracle: { expectedTaskClasses: ["writing-editing"], expectedProfiles: ["fast"] },
};

export const creativeWriting: PromptEnhancerEvalFixture = {
  name: "task-creative-writing",
  category: "task-class",
  description: "A creative-writing request.",
  request: {
    text: "Write a short story about a lighthouse keeper who collects forgotten letters.",
  },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["creative-writing"], expectedProfiles: ["creative"] },
};

export const decisionSupport: PromptEnhancerEvalFixture = {
  name: "task-decision-support",
  category: "task-class",
  description: "A non-safety-critical decision-support request.",
  request: {
    text: "Should I use a monorepo or separate repositories for my team? Give the pros and cons.",
  },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["decision-support"], expectedProfiles: ["precise"] },
};

export const agenticToolUse: PromptEnhancerEvalFixture = {
  name: "task-agentic-tool-use",
  category: "task-class",
  description: "An agentic task that requires human-approval gating on side effects.",
  request: {
    text: "As an agent, use the tool to fetch the latest issues and automate triaging them step by step.",
  },
  dimensions: CORE,
  oracle: {
    expectedTaskClasses: ["agentic-tool-use"],
    expectedProfiles: ["agentic"],
    expectedSafetyDecisions: ["requires-human-review"],
    expectedVerificationStatuses: ["passed-with-review"],
  },
};

export const promptOptimization: PromptEnhancerEvalFixture = {
  name: "task-prompt-optimization",
  category: "task-class",
  description: "A meta-prompting request to improve an existing prompt.",
  request: { text: "Improve this prompt so it produces more reliable structured answers." },
  dimensions: CORE,
  oracle: { expectedTaskClasses: ["prompt-optimization"], expectedProfiles: ["technical"] },
};

export const safetyCritical: PromptEnhancerEvalFixture = {
  name: "task-safety-critical",
  category: "task-class",
  description: "Consequential advice in a safety-critical (medical) domain.",
  request: {
    text: "I was diagnosed with a disease. Should I change my medication dosage and treatment for these symptoms?",
  },
  dimensions: new Set([...CORE, "faithfulness"]),
  oracle: {
    expectedTaskClasses: ["safety-critical"],
    expectedProfiles: ["safety-critical"],
    // The validate stage requires a human-approval rule for critical-criticality prompts; the MVP
    // generator emits a professional-advice disclaimer rather than that rule, so the assessment
    // currently rejects (a fail-safe refusal). This is documented as a known limitation/follow-up in
    // the closure evidence; the eval pins the behaviour so a regression cannot silently change it.
    expectedSafetyDecisions: ["rejected"],
    expectedVerificationStatuses: ["failed"],
  },
};

export const TASK_CLASS_FIXTURES: readonly PromptEnhancerEvalFixture[] = [
  factualQa,
  research,
  ragQuestionAnswering,
  summarization,
  structuredExtraction,
  dataAnalysis,
  codeGeneration,
  codeDebugging,
  codeArchitecture,
  writingEditing,
  creativeWriting,
  decisionSupport,
  agenticToolUse,
  promptOptimization,
  safetyCritical,
];
