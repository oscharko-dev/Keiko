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
    // Further natural refusals (PR #3678 review).
    "Die bereitgestellten Dokumente machen keine Aussage zur Java-Version.",
    "Aus den Dokumenten geht nicht hervor, welche Java-Version verwendet wird.",
    "Aus den Unterlagen geht dazu nichts hervor.",
    "In den Unterlagen steht dazu nichts.",
    "Die Quellen sagen nichts über die Java-Version.",
    "Das kann ich anhand der bereitgestellten Dokumente nicht beantworten.",
    "Den Dokumenten lässt sich die Java-Version nicht entnehmen.",
    "Es liegen keine Informationen zur Java-Version vor.",
    "Es liegen nicht genügend Informationen vor.",
    "Das Repository enthält keine Angaben zur Java-Version.",
    "The provided documents do not say which Java version is used.",
    "I cannot answer this based on the provided context.",
    "There is not enough information to answer this.",
    "No information is available on this topic.",
    "The codebase does not mention the Java version.",
    "I couldn’t find the Java version in the retrieved excerpts.",
    "The **provided documents** do not mention the Java version.",
    // The audit's exact probes.
    "Die Dokumente sagen dazu nichts.",
    "In den Dokumenten steht dazu nichts.",
    "The documents do not say anything about this.",
    "I do not have enough information to answer.",
    "I don't have enough information about this.",
    "There is insufficient information to answer the question.",
    "Nicht genügend Informationen vorhanden.",
    "Ich kann diese Frage anhand der bereitgestellten Dokumente nicht beantworten.",
    "Das geht aus den Unterlagen nicht hervor.",
    "Die Quellen enthalten dazu keine Aussage.",
    "Unable to answer from the provided sources.",
    "The repository does not contain any Kafka usage.",
    // An attribution without a comma never swallows the refusal it introduces (PR #3678 review).
    "According to the search results the retrieved documents do not mention the Java version.",
    "According to the search results, the retrieved documents do not mention the Java version.",
    "Laut der Suche enthalten die bereitgestellten Dokumente keine Angaben zur Java-Version.",
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
    // The evidence word belongs to an independent sentence, not to the negation.
    "The API does not provide authentication. Documentation is public.",
    "Die API bietet keine Authentifizierung an. Die Dokumentation ist öffentlich.",
    // An absent-information noun about the subject, with no evidence referent or search outcome.
    "The API returns no details on errors.",
    "The function returns no information about the caller.",
    "Die Fehlermeldung enthält keine Details.",
    "Es gibt keine Hinweise auf Datenverlust im Betrieb.",
    "Die Datei enthält keine Angaben zum Autor.",
    // A failed search or answer by the subject, not by Keiko over its evidence.
    "Maven could not find the dependency.",
    "The server cannot answer requests while it restarts.",
    // A negative fact that attributes itself to the evidence (PR #3678 review).
    "The API does not provide authentication according to the documentation. Requests are anonymous.",
    "According to the provided documents, the API does not include a retry policy.",
    "Laut der Dokumentation enthält die API keine Authentifizierung.",
    // The attribution written as inline Markdown (PR #3678 review).
    "The API does not provide authentication according to the [documentation](docs/auth.md). Requests are anonymous.",
    "The API does not provide authentication according to the **documentation**.",
    "Den Unterlagen zufolge wird Java 17 nicht mehr unterstützt und nicht erwähnt.",
    // The whole attributed source phrase, possessives, versions and compounds included (PR #3678
    // review).
    "The API does not provide authentication according to the project's [documentation](docs/auth.md). Requests are anonymous.",
    "The API does not provide authentication according to the project’s documentation.",
    "The API does not provide authentication according to the v2 documentation.",
    "The API does not provide authentication as described in the end-user documentation.",
    "According to the current API reference documentation, the API does not provide authentication. Requests are anonymous.",
    "The API does not provide authentication according to the v2.0 documentation.",
    "Gemäß der Dokumentation v2.0 des Projekts bietet die API keine Authentifizierung an.",
    // A nested source keeps its articles after a preposition (PR #3678 review).
    "According to the README of the repository, the API does not provide authentication.",
    "The API does not provide authentication according to the README of the repository.",
    // The audit's exact false-positive probes.
    "Für diesen Endpunkt sind keine Angaben zum Benutzer erforderlich.",
    "The endpoint requires no details about the user.",
    "The library has no reference to global state.",
    "Es gibt keine Hinweise auf Sicherheitslücken in Version 2.",
    "The result contains no information about the user's password.",
  ])("does not treat %j as a refusal", (answer) => {
    expect(isNoEvidenceAnswerText(answer)).toBe(false);
  });

  it("never treats a long answer as a bare refusal", () => {
    const long = `Es wurden keine Informationen gefunden. ${"Weitere Erläuterung. ".repeat(20)}`;

    expect(long.length).toBeGreaterThan(NO_EVIDENCE_ANSWER_MAX_CHARS);
    expect(isNoEvidenceAnswerText(long)).toBe(false);
  });
});
