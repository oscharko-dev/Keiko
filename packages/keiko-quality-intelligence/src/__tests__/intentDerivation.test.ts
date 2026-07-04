import { describe, expect, it } from "vitest";

import { deriveIntent } from "../domain/intentDerivation.js";
import { bankingDefault, insuranceDefault } from "../domain/policyProfile.js";
import { loadFixture } from "./_fixtureLoader.js";

describe("deriveIntent", () => {
  it("returns an empty summary for an empty envelope list", () => {
    const summary = deriveIntent([]);
    expect(summary.themes).toEqual([]);
    expect(summary.requirementCandidates).toEqual([]);
    expect(summary.riskHints).toEqual([]);
    expect(summary.priorityHint).toBe("unknown");
    expect(summary.sourceMode).toBe("empty");
    expect(summary.diagnostics).toContain("intent:no-meaningful-text");
  });

  it("extracts themes, requirement candidates, and risk hints from synthetic banking envelopes", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const summary = deriveIntent(fixture.envelopes, bankingDefault);
    expect(summary.themes.length).toBeGreaterThan(0);
    expect(summary.themes).toContain("KYC");
    expect(summary.requirementCandidates.length).toBeGreaterThan(0);
    // Banking profile lists 'aml' under both priority and risk keywords.
    expect(summary.riskHints).toContain("aml");
    expect(summary.priorityHint).not.toBe("unknown");
    expect(summary.sourceMode).toBe("label-only");
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
    expect(summary.sourceMode).toBe("empty");
  });

  it("derives requirement candidates from canonical body text instead of generic labels", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const envelopes = fixture.envelopes.map((envelope) => ({
      ...envelope,
      displayLabel: "Generic upload label",
    }));
    const summary = deriveIntent(envelopes, bankingDefault, {
      evidenceTexts: [
        "KRED: Überweisungen ab 10.000 EUR müssen eine Vier-Augen-Freigabe erzwingen.",
      ],
    });

    expect(summary.sourceMode).toBe("body");
    expect(summary.diagnostics).toContain("intent:body-text");
    expect(summary.requirementCandidates).toContain(
      "KRED: Überweisungen ab 10.000 EUR müssen eine Vier-Augen-Freigabe erzwingen.",
    );
    expect(summary.themes).toContain("KRED");
    expect(summary.themes).toContain("EUR");
  });

  it("marks the display-label-only path as a fallback", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const summary = deriveIntent(fixture.envelopes, bankingDefault, { evidenceTexts: ["   "] });

    expect(summary.sourceMode).toBe("label-only");
    expect(summary.diagnostics).toContain("intent:label-only-fallback");
  });

  it("recognises German modal verbs and negated requirement phrases", () => {
    const summary = deriveIntent([], bankingDefault, {
      evidenceTexts: ["Der Kunde muss die TAN eingeben.", "Der Kunde darf keine Zahlung auslösen."],
    });

    expect(summary.requirementCandidates).toContain("Der Kunde muss die TAN eingeben.");
    expect(summary.requirementCandidates).toContain("Der Kunde darf keine Zahlung auslösen.");
  });

  it.each([
    ["Geldwaesche", "P0"],
    ["Sanktion", "P0"],
    ["Zahlung", "P1"],
    ["Ueberweisung", "P1"],
    ["Bonitaet", "P1"],
  ] as const)("triggers German banking profile keywords for %s", (term, priority) => {
    const summary = deriveIntent([], bankingDefault, {
      evidenceTexts: [`Der Kunde muss ${term} prüfen.`],
    });

    expect(summary.priorityHint).toBe(priority);
    expect(summary.riskHints.length).toBeGreaterThan(0);
  });

  it.each(["Schadenfall", "Praemie", "Police"] as const)(
    "triggers German insurance profile keywords for %s",
    (term) => {
      const summary = deriveIntent([], insuranceDefault, {
        evidenceTexts: [`Der Versicherungsnehmer muss ${term} prüfen.`],
      });

      expect(summary.priorityHint).toBe("P1");
      expect(summary.riskHints.length).toBeGreaterThan(0);
    },
  );

  it("does not treat keyword substrings inside irrelevant words as risk hints", () => {
    const summary = deriveIntent([], bankingDefault, {
      evidenceTexts: ["Pinterest und Marketingpraeferenzen sind keine Banking-Fachanforderung."],
    });

    expect(summary.riskHints).toEqual([]);
  });

  it("keeps short domain tokens, acronyms, and traceability IDs while filtering German stopwords", () => {
    const summary = deriveIntent([], bankingDefault, {
      evidenceTexts: ["Der Kunde muss die IBAN und BIC fuer EU P0 KRED-001 TAN prüfen."],
    });

    expect(summary.themes).toEqual(
      expect.arrayContaining(["IBAN", "BIC", "TAN", "EU", "P0", "KRED-001"]),
    );
    expect(summary.themes).not.toEqual(
      expect.arrayContaining(["der", "die", "und", "fuer", "muss"]),
    );
  });
});
