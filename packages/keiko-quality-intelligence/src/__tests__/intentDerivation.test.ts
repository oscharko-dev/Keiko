import { describe, expect, it } from "vitest";

import { deriveIntent } from "../domain/intentDerivation.js";
import { bankingDefault } from "../domain/policyProfile.js";
import { loadFixture } from "./_fixtureLoader.js";

describe("deriveIntent", () => {
  it("returns an empty summary for an empty envelope list", () => {
    const summary = deriveIntent([]);
    expect(summary.themes).toEqual([]);
    expect(summary.requirementCandidates).toEqual([]);
    expect(summary.riskHints).toEqual([]);
    expect(summary.priorityHint).toBe("unknown");
  });

  it("extracts themes, requirement candidates, and risk hints from synthetic banking envelopes", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const summary = deriveIntent(fixture.envelopes, bankingDefault);
    expect(summary.themes.length).toBeGreaterThan(0);
    expect(summary.themes).toContain("kyc");
    expect(summary.requirementCandidates.length).toBeGreaterThan(0);
    // Banking profile lists 'aml' under both priority and risk keywords.
    expect(summary.riskHints).toContain("aml");
    expect(summary.priorityHint).not.toBe("unknown");
  });

  it("is deterministic across two independent runs", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const a = deriveIntent(fixture.envelopes, bankingDefault);
    const b = deriveIntent(fixture.envelopes, bankingDefault);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns 'unknown' priority when no policy keyword matches and labels are blank", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const blanked = fixture.envelopes.map((envelope) => ({ ...envelope, displayLabel: "" }));
    const summary = deriveIntent(blanked, bankingDefault);
    expect(summary.priorityHint).toBe("unknown");
    expect(summary.themes).toEqual([]);
  });
});
