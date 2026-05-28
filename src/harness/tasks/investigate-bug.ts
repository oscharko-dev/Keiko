// investigate-bug: the model may request tool calls to inspect the repo before proposing
// a fix patch. The harness may reach tool-call, patch-proposal, and verification, but NEVER
// applies the patch. State path:
// intake -> planning -> context-selection -> model-call [-> tool-call]* -> patch-proposal
//        -> verification -> reporting -> completed.

import type { ChatMessage } from "../../gateway/types.js";
import type { InvestigateBugInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

const SYSTEM_PROMPT =
  "You are a senior engineer investigating a defect. Use the available read-only tools to " +
  "gather evidence, then propose a minimal fix as a unified diff. Output only the diff once " +
  "you have enough evidence.";

const UNSPECIFIED_TARGET = "<unspecified>";

function userMessage(input: InvestigateBugInput): string {
  const files =
    input.filePaths === undefined || input.filePaths.length === 0
      ? ""
      : `\n\nSuspected files: ${input.filePaths.join(", ")}`;
  const context = input.context === undefined ? "" : `\n\nContext: ${input.context}`;
  return `Investigate this bug: ${input.description}${files}${context}`;
}

export function buildInvestigateBug(input: InvestigateBugInput): TaskPlan {
  const target = input.filePaths?.[0] ?? UNSPECIFIED_TARGET;
  const messages: readonly ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage(input) },
  ];
  return {
    allowsTools: true,
    allowsPatch: true,
    allowsVerification: true,
    targetFile: target,
    messages,
    rationale: `investigate-bug: ${input.description.slice(0, 40)}`,
  };
}
