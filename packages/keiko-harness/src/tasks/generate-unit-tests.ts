// generate-unit-tests: proposes a test patch for a target file. The harness may reach
// patch-proposal and verification, but NEVER applies the patch (dry-run by default).
// Tool use is not part of this task path. State path:
// intake -> planning -> context-selection -> model-call -> patch-proposal -> verification
//        -> reporting -> completed (verification may loop back to model-call).

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type { GenerateUnitTestsInput } from "../types.js";
import type { TaskPlan } from "./policy.js";
import { renderRetrievedContext } from "./renderRetrievedContext.js";

const SYSTEM_PROMPT =
  "You are a senior engineer writing rigorous unit tests. Produce a unified diff that " +
  "adds tests for the target. Cover edge cases (null, empty, boundary, error paths). " +
  "Output only the diff.";

// Composes the user turn from the target instruction plus, when supplied, the governed retrieved
// context pack (#1211) and the legacy free-form context string. The pack is rendered deterministically
// and framed as untrusted reference data; both context forms are optional and may co-occur.
function userMessage(input: GenerateUnitTestsInput): string {
  const target =
    input.targetFunction === undefined
      ? `Write unit tests for the public API in ${input.filePath}.`
      : `Write unit tests for the function ${input.targetFunction} in ${input.filePath}.`;
  const retrieved =
    input.retrievedContext === undefined ? "" : renderRetrievedContext(input.retrievedContext);
  const legacy = input.context === undefined ? "" : `Context: ${input.context}`;
  return [target, retrieved, legacy].filter((section) => section.length > 0).join("\n\n");
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
