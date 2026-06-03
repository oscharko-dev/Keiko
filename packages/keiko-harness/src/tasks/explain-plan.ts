// explain-plan: a read-only task. The harness must never enter tool-call, patch-proposal,
// or verification for this task type — enforced here by setting all `allows*` flags false.
// State path: intake -> planning -> context-selection -> model-call -> reporting -> completed.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type { ExplainPlanInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

const SYSTEM_PROMPT =
  "You are a senior engineer. Explain only the provided file excerpt and the user's question. " +
  "Do not infer APIs, constants, or behavior that are not present in the excerpt. If the excerpt " +
  "is missing or insufficient, say that explicitly. Do not propose code edits; this is a " +
  "read-only explanation task.";

function contextBlock(input: ExplainPlanInput): string {
  return input.context === undefined
    ? "\n\nFile excerpt: not available. State that limitation before answering."
    : `\n\nFile excerpt:\n${input.context}`;
}

export function buildExplainPlan(input: ExplainPlanInput): TaskPlan {
  const question =
    input.question === undefined
      ? `Explain how the file at ${input.filePath} works.`
      : `Regarding ${input.filePath}: ${input.question}`;
  const messages: readonly ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${question}${contextBlock(input)}` },
  ];
  return {
    allowsTools: false,
    allowsPatch: false,
    allowsVerification: false,
    targetFile: input.filePath,
    messages,
    rationale: `explain-plan over ${input.filePath} (read-only)`,
  };
}
