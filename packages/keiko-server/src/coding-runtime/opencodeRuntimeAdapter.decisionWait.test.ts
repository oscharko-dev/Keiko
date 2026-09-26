import { describe, expect, it, vi } from "vitest";

// A human-decision wait of the test's own, so a generated source can only carry it by reading the
// contract.
const decisionWait = vi.hoisted(() => ({ ms: 123_456 }));

vi.mock("@oscharko-dev/keiko-contracts/runtime/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oscharko-dev/keiko-contracts/runtime/tools")>()),
  GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS: decisionWait.ms,
}));

const { createGeneratedOpenCodeBundle } = await import("./opencodeRuntimeAdapter.js");

// PR #3452 review: the permission ask a governed-assist or supervised run shows the operator expired
// after a hardcoded 300000 ms, a copy of the one human-decision wait every governed layer budgets,
// so a change to the contract would have left the displayed expiry behind the enforced wait.
describe("the generated permission ask", () => {
  it("expires after the contract's human-decision wait", () => {
    const sources = Object.values(createGeneratedOpenCodeBundle().toolSources);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toContain(`expiresAt: new Date(Date.now() + ${String(decisionWait.ms)})`);
    }
  });
});
