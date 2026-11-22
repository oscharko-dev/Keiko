// #4492: the scripted model of the acceptance task. Its turn advances by the tool replies the
// runtime resends, never by how often the model was called, so a title request or a repeated call
// cannot skip or repeat a step.

import { describe, expect, it } from "vitest";

import type { GatewayRequest } from "@oscharko-dev/keiko-model-gateway";

import {
  ACCEPTANCE_CHECK_COMMAND,
  ACCEPTANCE_MAVEN_CHECK_COMMAND,
  ACCEPTANCE_STALE_SUFFIX,
  acceptanceResponse,
  type AcceptanceModelScript,
} from "../test-support/functional-acceptance-model.js";
import { functionalChatModelId } from "../test-support/functional-bff-server.js";
import { openCodeNativeVerificationKind } from "./opencodeNativePolicy.js";
import { functionalGatewayConfig } from "./productionOpenCodeBackend.functional/_support.js";

function script(plan: AcceptanceModelScript["plan"] = "verify"): AcceptanceModelScript {
  return {
    modelId: functionalChatModelId(),
    target: "src/target.js",
    checkCommand: ACCEPTANCE_CHECK_COMMAND,
    old: "before\n",
    next: "after\n",
    plan,
  };
}

/** A tool-offering request after `replies` tool results, as the runtime sends it. */
function afterReplies(replies: number): GatewayRequest {
  return {
    modelId: functionalChatModelId(),
    messages: [
      { role: "user", content: "task" },
      ...Array.from({ length: replies }, () => ({ role: "tool" as const, content: "done" })),
    ],
    toolCatalog: { tools: [] },
  } as unknown as GatewayRequest;
}

function plannedCalls(acceptance: AcceptanceModelScript): readonly unknown[] {
  return Array.from({ length: 7 }, (_, replies) => {
    const call = acceptanceResponse(acceptance, afterReplies(replies)).toolCalls[0];
    return call === undefined ? "answer" : [call.name, call.arguments];
  });
}

const CHECK = ["shell", { command: ACCEPTANCE_CHECK_COMMAND, timeout: 120_000 }];
const REPAIR = ["edit", { path: "src/target.js", oldString: "before\n", newString: "after\n" }];

describe("acceptance model (#4492)", () => {
  it("runs a check the production policy reads as the project's tests", () => {
    expect(openCodeNativeVerificationKind([ACCEPTANCE_CHECK_COMMAND])).toBe("test");
  });

  it("runs the Maven project's own check, which the production policy reads as its tests", () => {
    expect(openCodeNativeVerificationKind([ACCEPTANCE_MAVEN_CHECK_COMMAND])).toBe("test");
    const maven: AcceptanceModelScript = {
      ...script(),
      target: "src/main/java/Invoice.java",
      checkCommand: ACCEPTANCE_MAVEN_CHECK_COMMAND,
    };
    const calls = plannedCalls(maven);
    const check = ["shell", { command: "mvn -B -q test", timeout: 120_000 }];
    expect(calls[0]).toEqual(check);
    expect(calls[1]).toEqual(["read", { path: "src/main/java/Invoice.java" }]);
    expect(calls[3]).toEqual(check);
  });

  it("answers as the functional gateway's own chat model", () => {
    const chat = functionalGatewayConfig().capabilities?.find((model) => model.kind === "chat");
    expect(functionalChatModelId()).toBe(chat?.id);
    expect(acceptanceResponse(script(), afterReplies(0)).modelId).toBe(chat?.id);
  });

  it("fails the check, reads, repairs and checks again", () => {
    expect(plannedCalls(script())).toEqual([
      CHECK,
      ["read", { path: "src/target.js" }],
      REPAIR,
      CHECK,
      "answer",
      "answer",
      "answer",
    ]);
  });

  it("leaves the check out, or makes it stale with one more edit", () => {
    expect(plannedCalls(script("skip-check")).slice(2, 4)).toEqual([REPAIR, "answer"]);
    expect(plannedCalls(script("stale-check")).slice(3, 6)).toEqual([
      CHECK,
      [
        "edit",
        {
          path: "src/target.js",
          oldString: "after\n",
          newString: `after\n${ACCEPTANCE_STALE_SUFFIX}`,
        },
      ],
      "answer",
    ]);
  });

  it("answers a request that offers no tools, such as the title request, without a tool", () => {
    const { toolCatalog: _omitted, ...title } = afterReplies(0);
    expect(acceptanceResponse(script(), title).toolCalls).toEqual([]);
    expect(acceptanceResponse(script(), afterReplies(0)).toolCalls[0]?.name).toBe("shell");
  });

  it("gives every tool call its own id", () => {
    const first = acceptanceResponse(script(), afterReplies(0)).toolCalls[0]?.id;
    const second = acceptanceResponse(script(), afterReplies(0)).toolCalls[0]?.id;
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });
});
