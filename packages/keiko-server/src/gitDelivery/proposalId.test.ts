// Regression coverage for the shared proposal-id owner (opencode-tools-residuals follow-up):
// before this module existed, five call sites hand-restated the same "<prefix>-<digits>" shape
// -- three inline minters (runtimeGitService.ts, verifiedCommitService.ts, draftDeliveryFacts.ts)
// and two independent copies of keiko_git_execute's proposalId pattern (opencodeToolSchemas.ts
// and coding-sidecar-gateway.test.ts's hand-typed pin) -- with nothing to keep them in sync.
// These tests fail if any minted id ever falls outside the schema's own derived pattern, and if
// the derived pattern itself drifts from the exact three prefixes the server mints.

import { describe, expect, it } from "vitest";
import { PROPOSAL_ID_PREFIXES, mintProposalId, proposalIdPattern } from "./proposalId.js";

describe("proposalId", () => {
  it("derives a pattern that accepts exactly the three model-visible prefixes", () => {
    expect(proposalIdPattern()).toBe("^(?:stage|delivery|commit)-[0-9]{1,39}$");
    const accepted = new RegExp(proposalIdPattern(), "u");
    expect(accepted.test("stage-1")).toBe(true);
    expect(accepted.test("delivery-1")).toBe(true);
    expect(accepted.test("commit-1")).toBe(true);
    expect(accepted.test("recovery-1")).toBe(false);
    expect(accepted.test("other-1")).toBe(false);
    expect(accepted.test("stage-")).toBe(false);
    expect(accepted.test("stage-abc")).toBe(false);
  });

  it("mints an id for every model-visible prefix that matches the derived pattern", () => {
    const accepted = new RegExp(proposalIdPattern(), "u");
    for (const prefix of PROPOSAL_ID_PREFIXES) {
      const minted = mintProposalId(prefix);
      expect(accepted.test(minted)).toBe(true);
      expect(minted.startsWith(`${prefix}-`)).toBe(true);
    }
  });

  it("mints a recovery id in the same shape even though it is outside the model-visible pattern", () => {
    const minted = mintProposalId("recovery");
    expect(minted).toMatch(/^recovery-[0-9]{1,39}$/u);
    expect(new RegExp(proposalIdPattern(), "u").test(minted)).toBe(false);
  });
});
