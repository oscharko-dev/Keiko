import { describe, expect, it } from "vitest";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { GroundedSynthesisAttemptTracker } from "./grounded-answer.js";
import {
  GROUNDED_TOOL_TURN_GUIDANCE,
  callGroundedSynthesisModel,
} from "./grounded-plural-synthesis.js";
import type { ChatToolTurnPort } from "./chat-tool-turn.js";

const ANSWER = { content: "answer", toolCalls: [] } as unknown as NormalizedResponse;
const REQUEST: GatewayCallRequest = {
  modelId: "model",
  messages: [{ role: "user", content: "List every requirement of the specification." }],
  stream: false,
};
const TRACKER = {
  confirmToolRound: (): void => undefined,
  remainingSynthesisCalls: (): number => 1,
} as unknown as GroundedSynthesisAttemptTracker;
const MODEL = { call: () => Promise.resolve(ANSWER) } as unknown as ModelPort;

function capturingTurn(seen: GatewayCallRequest[]): ChatToolTurnPort {
  return {
    call: (_model: ModelPort, request: GatewayCallRequest) => {
      seen.push(request);
      return Promise.resolve(ANSWER);
    },
    hasUsableObservation: () => true,
  } as unknown as ChatToolTurnPort;
}

describe("grounded synthesis with offered tools (#4179)", () => {
  it("tells the model that the evidence is ranked excerpts and complete reads need a tool", async () => {
    const seen: GatewayCallRequest[] = [];
    const controller = new AbortController();
    await callGroundedSynthesisModel(
      MODEL,
      REQUEST,
      controller.signal,
      TRACKER,
      capturingTurn(seen),
    );
    const system = seen[0]?.messages.at(-1);
    expect(system).toEqual({ role: "system", content: GROUNDED_TOOL_TURN_GUIDANCE });
    expect(GROUNDED_TOOL_TURN_GUIDANCE).toContain("Evidence is ranked excerpts");
    expect(GROUNDED_TOOL_TURN_GUIDANCE).toContain("read all with an offered tool");
  });

  it("points progress, compliance and coverage questions at one jira.report call (#4181)", () => {
    expect(GROUNDED_TOOL_TURN_GUIDANCE).toContain("call jira.report once");
    expect(GROUNDED_TOOL_TURN_GUIDANCE).toContain("requirementsFromPods");
    expect(GROUNDED_TOOL_TURN_GUIDANCE).toContain("never count issues yourself");
  });

  it("adds no tool guidance when no tool is offered", async () => {
    const calls: GatewayCallRequest[] = [];
    const model = {
      call: (request: GatewayCallRequest) => {
        calls.push(request);
        return Promise.resolve(ANSWER);
      },
    } as unknown as ModelPort;
    await callGroundedSynthesisModel(model, REQUEST, new AbortController().signal, TRACKER);
    expect(calls[0]?.messages).toEqual(REQUEST.messages);
  });
});
