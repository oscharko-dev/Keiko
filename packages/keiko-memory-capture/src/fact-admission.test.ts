import { describe, expect, it } from "vitest";

import { admitProposedFact, type FactDropReason } from "./fact-admission.js";

function admit(text: string, evidence: string, body = evidence, about = "self") {
  return admitProposedFact({ body, evidence, about }, text);
}

function reasonOf(text: string, evidence: string, body = evidence, about = "self"): FactDropReason | null {
  const admission = admit(text, evidence, body, about);
  return admission.admitted ? null : admission.reason;
}

describe("admitProposedFact", () => {
  it.each([
    ["Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.", "Ich bevorzuge Tabellen"],
    ["Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.", "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst."],
    ["Can you help? Ich bevorzuge Tabellen. Thanks.", "Ich bevorzuge Tabellen."],
    ["Frau Ostrander rechnet alles in Excel, ich führe meine Zahlen immer im Wiki.", "ich führe meine Zahlen immer im Wiki"],
    ["If I preferred tables, I would have told you. I actually like plain text.", "I actually like plain text"],
    ["Ab jetzt bevorzuge ich Listen.", "Ab jetzt bevorzuge ich Listen"],
    ["I'm a data engineer.", "I'm a data engineer"],
    ["Ich bin Team Lead im Controlling.", "Ich bin Team Lead im Controlling"],
    ["Mein Editor ist Vim.", "Mein Editor ist Vim"],
  ])("admits %s", (text, evidence) => {
    expect(admit(text, evidence).admitted).toBe(true);
  });

  it.each<[string, string, string, FactDropReason]>([
    ["no span", "Ich mag Tabellen.", "", "no-evidence"],
    ["a span elsewhere", "Ich mag Tabellen.", "Ich mag Listen", "evidence-not-verbatim"],
    ["a different case", "Ich mag Tabellen.", "ich mag tabellen", "evidence-not-verbatim"],
    ["a span over two sentences", "Ich mag Tabellen. Ich mag Listen.", "Ich mag Tabellen. Ich mag Listen", "not-clause-boundary"],
    ["half a clause", "Ich mag Tabellen nicht.", "Ich mag Tabellen", "not-clause-boundary"],
    ["a start inside a clause", "Heute mag ich Tabellen.", "ich Tabellen", "not-clause-boundary"],
    ["a question", "Ich mag Tabellen, oder?", "Ich mag Tabellen", "question"],
    ["a quote", 'Er schrieb: "Ich mag Tabellen" in die Mail.', "Ich mag Tabellen", "quoted"],
    ["a German quote", "Der Satz „Ich mag Tabellen“ steht dort.", "Ich mag Tabellen", "quoted"],
    ["a hypothetical", "If I preferred tables, I would have told you.", "I would have told you", "hypothetical"],
    ["a German hypothetical", "Wenn ich Tabellen mag, sage ich es.", "Wenn ich Tabellen mag", "hypothetical"],
    ["a subjunctive", "Ich würde Tabellen nehmen.", "Ich würde Tabellen nehmen", "hypothetical"],
    ["irony", "Klar, ich liebe es ja total, wenn Besprechungen um sieben Uhr anfangen.", "ich liebe es ja total", "ironic"],
    ["a joke marker", "Ich liebe Montage, haha.", "Ich liebe Montage", "ironic"],
    ["doubt", "For minutes I always use Word, although no, I never use Word for that, I honestly do not know.", "For minutes I always use Word", "uncertain"],
    ["a denial", "Es stimmt nicht, dass ich Tabellen mag.", "ich Tabellen mag", "negated-context"],
    ["reported speech", "Er sagte, ich mag Tabellen.", "ich mag Tabellen", "negated-context"],
    ["a group", "Wir nutzen Tabellen.", "Wir nutzen Tabellen", "we-statement"],
    ["an English group", "We decided to release on Tuesdays.", "We decided to release on Tuesdays", "we-statement"],
    ["no first person", "Sie beginnen immer mit einer Zusammenfassung.", "Sie beginnen immer mit einer Zusammenfassung", "no-first-person"],
    ["a titled person", "Frau Ostrander rechnet und ich auch.", "Frau Ostrander rechnet und ich auch", "third-party"],
    ["a relation", "Mein Kollege Peter bevorzugt Tabellen.", "Mein Kollege Peter bevorzugt Tabellen", "third-party"],
    ["an English relation", "My wife prefers tables.", "My wife prefers tables", "third-party"],
  ])("drops %s", (_case, text, evidence, reason) => {
    expect(reasonOf(text, evidence)).toBe(reason);
  });

  it.each(["other", "unclear", "", "SELF?"])("drops a fact labelled %s", (about) => {
    expect(reasonOf("Ich mag Tabellen.", "Ich mag Tabellen", "Mag Tabellen", about)).toBe("not-self");
  });

  it("accepts the label in any case", () => {
    expect(admit("Ich mag Tabellen.", "Ich mag Tabellen", "Mag Tabellen", " Self ").admitted).toBe(true);
  });

  it.each([
    ["a word the person did not use", "Bevorzugt Kaffee"],
    ["only framing", "Bevorzugt"],
    ["a translation", "Prefers spreadsheets"],
  ])("does not admit a body with %s", (_case, body) => {
    expect(reasonOf("Ich mag Tabellen.", "Ich mag Tabellen", body)).toBe("not-entailed");
  });

  it("does not admit a body that drops or adds a negation", () => {
    expect(reasonOf("Ich mag keine Tabellen.", "Ich mag keine Tabellen", "Mag Tabellen")).toBe(
      "polarity-changed",
    );
    expect(reasonOf("Ich mag Tabellen.", "Ich mag Tabellen", "Mag keine Tabellen")).toBe(
      "polarity-changed",
    );
    expect(reasonOf("I don't like tables.", "I don't like tables", "Likes tables")).toBe(
      "polarity-changed",
    );
  });

  it("allows a predicate word the person did not use", () => {
    expect(admit("Ich will Tabellen.", "Ich will Tabellen", "Bevorzugt Tabellen").admitted).toBe(true);
  });

  it("marks a change without a subject, and gives it less confidence", () => {
    const subjectless = admit("Ab jetzt lieber Listen.", "Ab jetzt lieber Listen", "Bevorzugt Listen");
    const stated = admit("Ich bevorzuge Listen.", "Ich bevorzuge Listen", "Bevorzugt Listen");
    expect(subjectless).toMatchObject({ admitted: true, subjectless: true });
    expect(stated).toMatchObject({ admitted: true, subjectless: false });
    if (subjectless.admitted && stated.admitted) {
      expect(subjectless.confidence).toBeLessThan(stated.confidence);
      expect(stated.confidence).toBeLessThanOrEqual(0.9);
    }
  });

  it("does not take an oversized span", () => {
    const evidence = `Ich mag ${"sehr ".repeat(100)}Tabellen`;
    expect(reasonOf(`${evidence}.`, evidence)).toBe("evidence-too-long");
  });

  it("stays linear on an adversarial message", () => {
    const text = `${"ich ".repeat(50_000)}.`;
    const started = performance.now();
    expect(admit(text, "nicht da").admitted).toBe(false);
    expect(admit(text, "ich ich").admitted).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
