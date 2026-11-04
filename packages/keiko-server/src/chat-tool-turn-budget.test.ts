import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/harness";
import {
  CHAT_TOOL_TURN_BUDGET,
  chatToolTurnBudget,
  chatToolTurnLimits,
} from "./chat-tool-turn-budget.js";

describe("chat tool turn budget (#4175)", () => {
  it("is sized beyond the former fixed coding-harness caps", () => {
    expect(CHAT_TOOL_TURN_BUDGET.maxRuntimeMs).toBeGreaterThan(DEFAULT_LIMITS.maxWallTimeMs);
    expect(CHAT_TOOL_TURN_BUDGET.maxToolCalls).toBeGreaterThan(DEFAULT_LIMITS.maxToolCalls);
    expect(CHAT_TOOL_TURN_BUDGET.maxPatchBytes).toBe(0);
    expect(Object.isFrozen(CHAT_TOOL_TURN_BUDGET)).toBe(true);
  });

  it("derives every loop ceiling from the envelope budget", () => {
    const budget = {
      maxRuntimeMs: 1_000,
      maxToolCalls: 4,
      maxPromptTokens: 10,
      maxPatchBytes: 0,
    } as const;
    expect(chatToolTurnLimits(budget)).toMatchObject({
      maxIterations: 5,
      maxModelCalls: 10,
      maxToolCalls: 4,
      maxWallTimeMs: 1_000,
    });
  });

  it("uses a composed budget and falls back to the default", () => {
    const narrow = {
      maxRuntimeMs: 1,
      maxToolCalls: 1,
      maxPromptTokens: 1,
      maxPatchBytes: 0,
    } as const;
    expect(chatToolTurnBudget({ chatToolTurnBudget: narrow })).toBe(narrow);
    expect(chatToolTurnBudget({})).toBe(CHAT_TOOL_TURN_BUDGET);
  });

  it("never widens the default the stored transcript admits", () => {
    const wide = {
      maxRuntimeMs: 1,
      maxToolCalls: CHAT_TOOL_TURN_BUDGET.maxToolCalls + 1,
      maxPromptTokens: CHAT_TOOL_TURN_BUDGET.maxPromptTokens + 1,
      maxPatchBytes: 0,
    } as const;
    expect(chatToolTurnBudget({ chatToolTurnBudget: wide })).toEqual({
      maxRuntimeMs: 1,
      maxToolCalls: CHAT_TOOL_TURN_BUDGET.maxToolCalls,
      maxPromptTokens: CHAT_TOOL_TURN_BUDGET.maxPromptTokens,
      maxPatchBytes: 0,
    });
  });
});
