import { describe, expect, it } from "vitest";

import { NO_EVIDENCE_ANSWER_MAX_CHARS, isNoEvidenceAnswerText } from "./no-evidence-answer.js";

describe("isNoEvidenceAnswerText", () => {
  it.each([
    // The customer's German refusal: matched by neither former list.
    "In den bereitgestellten Dokumenten wurden keine Informationen oder Vorgaben zur Java-Version gefunden.",
    "Dazu enthalten die Dokumente keine Angaben.",
    "Die Java-Version wird in den bereitgestellten Quellen nicht erwähnt.",
    "Diese Information ist in den Dokumenten nicht enthalten.",
    "Ich konnte dazu nichts in den Dokumenten finden und nichts Passendes gefunden.",
    "Es wurden keine relevanten Informationen gefunden.",
    "The provided documents do not contain any information about the Java version.",
    "I could not find information about the Java version in the provided documents.",
    "There is no information about the Java version in the provided context.",
    "The Java version is not mentioned in the provided documents.",
    // Stock phrasings the former lists carried.
    "No evidence found in the connected scope.",
    "Insufficient evidence to answer.",
    "Keine Evidenz im ausgewaehlten Wissensumfang gefunden.",
    "Nicht genug Belege vorhanden.",
    "  In den Dokumenten\n\nwurden keine Hinweise gefunden.  ",
  ])("recognises the refusal %j", (answer) => {
    expect(isNoEvidenceAnswerText(answer)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "Java 17 wird verwendet [1, 7, 8].",
    "Die Java-Version ist 17 [1].",
    // A refusal that still cites a source is an answer about that source.
    "In den Dokumenten wurden keine Vorgaben gefunden [2].",
    // A partial answer: the absence statement continues with a contrast.
    "Die Dokumente enthalten keine Angaben zur Java-Version, aber Maven 3.9 ist in Kapitel 3 beschrieben.",
    "The documents do not contain the Java version, however they describe the Maven setup.",
    // Substantive statements that merely contain the word "not" or "no".
    "Java 17 wird nicht mehr unterstützt.",
    "The client does not retry on a 429.",
    "There is no data loss when the process restarts.",
    // Short negative FACTS (PR #3678 review): a negated verb without any mention of the evidence.
    "The API does not provide authentication. Requests are anonymous.",
    "The protocol does not contain a checksum. It relies on TLS.",
    "Der Dienst ist nicht dokumentiert abgesichert, er nutzt mTLS.",
    "The export does not include deleted records.",
  ])("does not treat %j as a refusal", (answer) => {
    expect(isNoEvidenceAnswerText(answer)).toBe(false);
  });

  it("never treats a long answer as a bare refusal", () => {
    const long = `Es wurden keine Informationen gefunden. ${"Weitere Erläuterung. ".repeat(20)}`;

    expect(long.length).toBeGreaterThan(NO_EVIDENCE_ANSWER_MAX_CHARS);
    expect(isNoEvidenceAnswerText(long)).toBe(false);
  });
});
