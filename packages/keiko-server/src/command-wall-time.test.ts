import { describe, expect, it } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_VERIFICATION_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/verification";
import { codingRuntimeCommandPolicyForMode } from "./coding-runtime/runtimeAuthorityService.js";
import { COMMAND_RUN_MAX_DURATION_MS, COMMAND_SANDBOX_POLICY } from "./command-wall-time.js";
import { buildTerminalPolicySummary } from "./terminal.js";

const MODES: readonly CodingWorkbenchMode[] = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
];

// Owner decision 2026-11-24: one command may run as long as one verification step.
describe("the command wall time", () => {
  it("is thirty minutes, one governed verification step", () => {
    expect(COMMAND_RUN_MAX_DURATION_MS).toBe(30 * 60_000);
    expect(COMMAND_RUN_MAX_DURATION_MS).toBe(DEFAULT_VERIFICATION_LIMITS.wallTimeMs);
    expect(COMMAND_SANDBOX_POLICY.defaultTimeoutMs).toBe(COMMAND_RUN_MAX_DURATION_MS);
  });

  it("is the limit the terminal advertises to the person", () => {
    expect(buildTerminalPolicySummary().limits.defaultTimeoutMs).toBe(COMMAND_RUN_MAX_DURATION_MS);
  });

  it.each(MODES)("is the Authority Envelope's command ceiling in %s", (mode) => {
    expect(codingRuntimeCommandPolicyForMode(mode).maxCommandTimeoutMs).toBe(
      COMMAND_RUN_MAX_DURATION_MS,
    );
  });
});
