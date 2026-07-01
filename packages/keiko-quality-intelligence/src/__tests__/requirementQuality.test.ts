import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { analyzeRequirementQuality } from "../domain/requirementQuality.js";

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-rq-0001");

function atom(id: string): QualityIntelligence.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
    kind: "requirement",
    sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("qi-env-rq-0001"),
    canonicalHashSha256Hex: "b".repeat(64),
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

function categoriesFor(text: string): readonly string[] {
  return analyzeRequirementQuality({
    runId: RUN_ID,
    atoms: [{ atom: atom("qi-atom-rq-0001"), canonicalText: text }],
  }).map((finding) => finding.category);
}

describe("analyzeRequirementQuality", () => {
  it("flags vague and weak German banking requirement wording", () => {
    const categories = categoriesFor("ZAHL: Die Auszahlung sollte zeitnah erfolgen.");

    expect(categories).toContain("ambiguity");
    expect(categories).toContain("weak-modality");
  });

  it("flags open placeholders as high-confidence requirement-quality defects", () => {
    const findings = analyzeRequirementQuality({
      runId: RUN_ID,
      atoms: [{ atom: atom("qi-atom-rq-0002"), canonicalText: "KRED: TBD Limitfreigabe klaeren." }],
    });

    const placeholder = findings.find((finding) => finding.category === "open-placeholder");
    expect(placeholder).toBeDefined();
    expect(placeholder?.kind).toBe("requirement-quality");
    expect(placeholder?.severity).toBe("high");
    expect(placeholder?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(placeholder?.evidenceAtomIds.map(String)).toEqual(["qi-atom-rq-0002"]);
  });

  it("flags coupled duties as compound requirements", () => {
    expect(
      categoriesFor("VERS: Der Kunde muss seine IBAN eingeben und die TAN bestaetigen."),
    ).toContain("compound-requirement");
  });

  it("does not flag a clear measurable requirement", () => {
    const findings = analyzeRequirementQuality({
      runId: RUN_ID,
      atoms: [
        {
          atom: atom("qi-atom-rq-0003"),
          canonicalText:
            "ZAHL: Ueberweisungen ab 10.000 EUR muessen innerhalb von 2 Sekunden verarbeitet werden.",
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it("redacts secret-shaped material before it reaches the summary excerpt", () => {
    const secret = "AKIA" + "LEAKLEAKLEAKLEAK";
    const [finding] = analyzeRequirementQuality({
      runId: RUN_ID,
      atoms: [
        {
          atom: atom("qi-atom-rq-0004"),
          canonicalText: `COMP: ${secret} Der Prozess muss zeitnah reagieren.`,
        },
      ],
    });

    expect(finding).toBeDefined();
    expect(finding?.summary).toContain("[REDACTED]");
    expect(finding?.summary).not.toContain(secret);
  });
});
