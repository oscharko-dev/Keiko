// verify: a deterministic repository-gate task. The harness loop is NOT entered for this task —
// the BFF run engine invokes the verification orchestrator directly (it spawns lint/test/build
// rather than calling a model). This plan exists so the task-policy switch remains total and so
// the discriminated union can carry a verify variant alongside the model-driven tasks. All
// `allows*` flags are false: there is no model call, no tool call, no patch proposal.

import type { ChatMessage } from "../../gateway/types.js";
import type { VerifyInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

export function buildVerify(input: VerifyInput): TaskPlan {
  const messages: readonly ChatMessage[] = [];
  return {
    allowsTools: false,
    allowsPatch: false,
    allowsVerification: false,
    targetFile: input.workspaceRoot,
    messages,
    rationale: `verify gates over ${input.workspaceRoot} (deterministic, no model call)`,
  };
}
