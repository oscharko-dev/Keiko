// editor-agent-turn (issue #2489, Findings 1/2): the Keiko-native producer task. Unlike
// explain-plan (read-only), this task allows tool calls -- the governed subset is enforced by the
// producer's own ToolPort (only the four retrofit editor-agent tools are ever listed), not by this
// file. No patch/verification state: proposeEdit/requestVerification route through the governed
// EditorAgentToolHost -> agentRoutes tool-call path, never the harness's own patch pipeline.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type { EditorAgentTurnInput } from "../types.js";
import type { TaskPlan } from "./policy.js";

const SYSTEM_PROMPT =
  "You are a governed editor agent. You may call only the tools offered to you in this turn, " +
  "each requiring the exact sessionId given below and a fresh idempotencyKey. Every call is " +
  "dispatched through a server-validated Authority Envelope and audited; you cannot act outside " +
  "it. Do not claim a tool ran unless its result says so.";

export function buildEditorAgentTurn(input: EditorAgentTurnInput): TaskPlan {
  const messages: readonly ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `sessionId: ${input.sessionId}\nGoal: ${input.goal}` },
  ];
  return {
    allowsTools: true,
    allowsPatch: false,
    allowsVerification: false,
    targetFile: input.sessionId,
    messages,
    rationale: `editor-agent-turn for session ${input.sessionId}`,
  };
}
