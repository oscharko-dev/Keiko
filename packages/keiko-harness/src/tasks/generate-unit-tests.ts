// generate-unit-tests: proposes a test patch for a target file. The harness may reach
// patch-proposal and verification, but NEVER applies the patch (dry-run by default).
// Tool use is not part of this task path. State path:
// intake -> planning -> context-selection -> model-call -> patch-proposal -> verification
//        -> reporting -> completed (verification may loop back to model-call).

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type { GenerateUnitTestsInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

const SYSTEM_PROMPT =
  "You are a senior engineer writing rigorous unit tests. Produce a unified diff that " +
  "adds tests for the target. Cover edge cases (null, empty, boundary, error paths). " +
  "Output only the diff.";

function userMessage(input: GenerateUnitTestsInput): string {
  const target =
    input.targetFunction === undefined
      ? `Write unit tests for the public API in ${input.filePath}.`
      : `Write unit tests for the function ${input.targetFunction} in ${input.filePath}.`;
  return input.context === undefined ? target : `${target}\n\nContext: ${input.context}`;
}

export function buildGenerateUnitTests(input: GenerateUnitTestsInput): TaskPlan {
  const messages: readonly ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage(input) },
  ];
  return {
    allowsTools: false,
    allowsPatch: true,
    allowsVerification: true,
    targetFile: input.filePath,
    messages,
    rationale: `generate-unit-tests for ${input.filePath}`,
  };
}
