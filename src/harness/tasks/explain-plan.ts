// explain-plan: a read-only task. The harness must never enter tool-call, patch-proposal,
// or verification for this task type — enforced here by setting all `allows*` flags false.
// State path: intake -> planning -> context-selection -> model-call -> reporting -> completed.

import type { ChatMessage } from "../../gateway/types.js";
import type { ExplainPlanInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

const SYSTEM_PROMPT =
  "You are a senior engineer. Read the referenced file and explain how it works and " +
  "what an implementation plan for the user's question would look like. Do not propose " +
  "code edits; this is a read-only explanation task.";

export function buildExplainPlan(input: ExplainPlanInput): TaskPlan {
  const question =
    input.question === undefined
      ? `Explain how the file at ${input.filePath} works.`
      : `Regarding ${input.filePath}: ${input.question}`;
  const messages: readonly ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
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
