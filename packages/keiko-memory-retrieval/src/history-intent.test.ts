import { describe, expect, it } from "vitest";

import { asksAboutEarlierValues } from "./history-intent.js";

describe("asksAboutEarlierValues (#4223)", () => {
  it.each([
    "Was hattest du vorher darüber gespeichert, wo ich arbeite?",
    "Was habe ich dir vor meiner Rückkehr zu Tabellen für Zahlen genannt?",
    "An welchem Tag fand das Teamtreffen früher statt?",
    "Wie wollte ich Berichte ursprünglich haben?",
    "Welche Vorliebe hatte ich zuerst?",
    "Was war meine alte Einstellung?",
    "FRÜHER oder jetzt?",
    "Welche frühere Einstellung hatte ich?",
    "Was war die vorherige Regel?",
    "Wie war das fru\u0308her?",
    "How were hotfixes reviewed before the current rule?",
    "How were hotfixes reviewed at the very beginning?",
    "Which editor theme did I use in between, before I came back to this one?",
    "How often did we ship a release before?",
    "What did I use to prefer?",
    "What was my previous setting?",
    "Which tool did I mention earlier?",
  ])("reads a question about the past: %s", (question) => {
    expect(asksAboutEarlierValues(question)).toBe(true);
  });

  it.each([
    "Wie sollst du mir Zahlen zeigen?",
    "Wo arbeite ich?",
    "Welcher Wochentag ist für das Teamtreffen festgelegt?",
    "Wie alt ist die Datei?",
    "Which editor theme do I use?",
    "How often do we ship a release?",
    "Show the formerlyKnown field.",
    "Was ist der Vorteil?",
  ])("reads a question about the present: %s", (question) => {
    expect(asksAboutEarlierValues(question)).toBe(false);
  });

  it("reads no question as none about the past", () => {
    expect(asksAboutEarlierValues(undefined)).toBe(false);
    expect(asksAboutEarlierValues("")).toBe(false);
  });
});
