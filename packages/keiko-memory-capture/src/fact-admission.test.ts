import { describe, expect, it } from "vitest";

import {
  admitProposedFact,
  reasonNamesOtherPerson,
  type FactDropReason,
} from "./fact-admission.js";

function admit(text: string, evidence: string, body = evidence, about = "self") {
  return admitProposedFact({ body, evidence, about }, text);
}

function reasonOf(
  text: string,
  evidence: string,
  body = evidence,
  about = "self",
): FactDropReason | null {
  const admission = admit(text, evidence, body, about);
  return admission.admitted ? null : admission.reason;
}

describe("admitProposedFact", () => {
  it.each([
    ["Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.", "Ich bevorzuge Tabellen"],
    [
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
      "Ich bevorzuge Tabellen, wenn du mir Zahlen zeigst.",
    ],
    ["Can you help? Ich bevorzuge Tabellen. Thanks.", "Ich bevorzuge Tabellen."],
    [
      "Frau Ostrander rechnet alles in Excel, ich führe meine Zahlen immer im Wiki.",
      "ich führe meine Zahlen immer im Wiki",
    ],
    [
      "If I preferred tables, I would have told you. I actually like plain text.",
      "I actually like plain text",
    ],
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
    [
      "a span over two sentences",
      "Ich mag Tabellen. Ich mag Listen.",
      "Ich mag Tabellen. Ich mag Listen",
      "not-clause-boundary",
    ],
    ["half a clause", "Ich mag Tabellen nicht.", "Ich mag Tabellen", "not-clause-boundary"],
    ["a start inside a clause", "Heute mag ich Tabellen.", "ich Tabellen", "not-clause-boundary"],
    ["a question", "Ich mag Tabellen, oder?", "Ich mag Tabellen", "question"],
    ["a quote", 'Er schrieb: "Ich mag Tabellen" in die Mail.', "Ich mag Tabellen", "quoted"],
    ["a German quote", "Der Satz „Ich mag Tabellen“ steht dort.", "Ich mag Tabellen", "quoted"],
    [
      "a hypothetical",
      "If I preferred tables, I would have told you.",
      "I would have told you",
      "hypothetical",
    ],
    [
      "a German hypothetical",
      "Wenn ich Tabellen mag, sage ich es.",
      "Wenn ich Tabellen mag",
      "hypothetical",
    ],
    ["a subjunctive", "Ich würde Tabellen nehmen.", "Ich würde Tabellen nehmen", "hypothetical"],
    [
      "irony",
      "Klar, ich liebe es ja total, wenn Besprechungen um sieben Uhr anfangen.",
      "ich liebe es ja total",
      "ironic",
    ],
    ["a joke marker", "Ich liebe Montage, haha.", "Ich liebe Montage", "ironic"],
    [
      "doubt",
      "For minutes I always use Word, although no, I never use Word for that, I honestly do not know.",
      "For minutes I always use Word",
      "uncertain",
    ],
    ["a denial", "Es stimmt nicht, dass ich Tabellen mag.", "ich Tabellen mag", "negated-context"],
    ["reported speech", "Er sagte, ich mag Tabellen.", "ich mag Tabellen", "negated-context"],
    [
      "a polite request",
      "Erklaere mir bitte kurz, was Apache Kafka ist.",
      "Erklaere mir bitte kurz",
      "request",
    ],
    [
      "an English request",
      "Please give me a short summary.",
      "Please give me a short summary",
      "request",
    ],
    ["a bare German request", "Zeig mir die Zahlen.", "Zeig mir die Zahlen", "request"],
    ["a bare English request", "Show me the numbers.", "Show me the numbers", "request"],
    [
      "an opinion about others",
      "Ich glaube, Kunden lieben Tabellen.",
      "Kunden lieben Tabellen",
      "uncertain",
    ],
    [
      "a past habit",
      "Früher habe ich Excel genutzt.",
      "Früher habe ich Excel genutzt",
      "past-statement",
    ],
    ["a German perfect", "Ich habe Excel genutzt.", "Ich habe Excel genutzt", "past-statement"],
    ["an English past", "I used to work in Berlin.", "I used to work in Berlin", "past-statement"],
    ["someone beside me", "Anna und ich nutzen Jira.", "Anna und ich nutzen Jira", "we-statement"],
    ["a pronoun", "Ich weiss, sie mag Tabellen.", "Ich weiss, sie mag Tabellen", "third-party"],
    [
      "a role pointing at one person",
      "Ich schreibe dem Kunden immer formell.",
      "Ich schreibe dem Kunden immer formell",
      "third-party",
    ],
    ["a group", "Wir nutzen Tabellen.", "Wir nutzen Tabellen", "we-statement"],
    [
      "an English group",
      "We decided to release on Tuesdays.",
      "We decided to release on Tuesdays",
      "we-statement",
    ],
    [
      "no first person",
      "Sie beginnen immer mit einer Zusammenfassung.",
      "Sie beginnen immer mit einer Zusammenfassung",
      "no-first-person",
    ],
    [
      "a titled person",
      "Frau Ostrander rechnet und ich auch.",
      "Frau Ostrander rechnet und ich auch",
      "third-party",
    ],
    [
      "a relation",
      "Mein Kollege Peter bevorzugt Tabellen.",
      "Mein Kollege Peter bevorzugt Tabellen",
      "third-party",
    ],
    ["an English relation", "My wife prefers tables.", "My wife prefers tables", "third-party"],
  ])("drops %s", (_case, text, evidence, reason) => {
    expect(reasonOf(text, evidence)).toBe(reason);
  });

  it.each([
    ["hate", "Ich hasse Excel.", "Ich hasse Excel", "Nutzt Excel"],
    ["avoid", "I avoid Excel.", "I avoid Excel", "Uses Excel"],
    ["without", "Ich nutze Jira ohne Plugins.", "Ich nutze Jira ohne Plugins", "Nutzt Plugins"],
  ])("does not let a body invert %s", (_case, text, evidence, body) => {
    expect(reasonOf(text, evidence, body)).toBe("polarity-changed");
  });

  it("reads a decomposed umlaut like the composed one", () => {
    const text = "Ich wu\u0308rde Tabellen nehmen.";
    expect(reasonOf(text, "Ich wu\u0308rde Tabellen nehmen")).toBe("hypothetical");
  });

  it("does not judge a sentence-ending fact by the sentence after it", () => {
    const text = "Ich mag Tabellen. Meinst du das ernst?";
    expect(reasonOf(text, "Ich mag Tabellen.")).toBeNull();
  });

  it("keeps a person's own role and a change they made", () => {
    expect(reasonOf("Ich bin Manager.", "Ich bin Manager")).toBeNull();
    expect(reasonOf("Ich habe zu Listen gewechselt.", "Ich habe zu Listen gewechselt")).toBeNull();
  });

  it.each(["other", "unclear", "", "SELF?"])("drops a fact labelled %s", (about) => {
    expect(reasonOf("Ich mag Tabellen.", "Ich mag Tabellen", "Mag Tabellen", about)).toBe(
      "not-self",
    );
  });

  it("accepts the label in any case", () => {
    expect(admit("Ich mag Tabellen.", "Ich mag Tabellen", "Mag Tabellen", " Self ").admitted).toBe(
      true,
    );
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
    expect(admit("Ich will Tabellen.", "Ich will Tabellen", "Bevorzugt Tabellen").admitted).toBe(
      true,
    );
  });

  it("marks a change without a subject, and gives it less confidence", () => {
    const subjectless = admit(
      "Ab jetzt lieber Listen.",
      "Ab jetzt lieber Listen",
      "Bevorzugt Listen",
    );
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

  it.each([
    ["a reason about things", "Ich nutze Tabellen, weil sie übersichtlich sind."],
    ["an English reason about things", "I use spreadsheets because they are consistent."],
    ["a reason about a tool", "Ich nutze Vim, weil er schneller ist."],
    ["the formal address", "Ich schicke Ihnen meine Zahlen immer als Tabelle."],
    ["a kind of work", "Ich arbeite mit Kunden."],
    ["a style toward a kind of person", "Ich schreibe Kunden immer formell."],
    ["a decision made", "I decided on a local queue."],
    ["a switch made", "I switched to Linux."],
    ["a compound role", "I work on customer tickets."],
    ["a noun that starts like a participle", "Ich habe ein Gerät mit Touch."],
    ["a habit", "Ich habe eine Gewohnheit, morgens zu planen."],
    ["an earlier time inside the reason", "Ich nutze Excel, weil es früher schneller war."],
    ["a hyphenated compound", "Ich nutze no-code Werkzeuge."],
    ["a present verb ending like a past one", "Ich arbeite mit Excel."],
    ["a present verb that keeps its stem", "Ich verwalte die Budgets."],
    ["a wish of the person", "Ich nutze Jira, weil ich es so will."],
    ["an own wish without a repeated subject", "Ich nutze Excel und möchte Tabellen."],
    ["an own wish after aber", "Ich nutze Vim, möchte aber Emacs."],
    ["an English own wish", "I use vim and want plugins."],
    ["a relative clause that says something", "I use vim, which says nothing."],
    ["a future reason", "I use Jira because it will scale."],
    ["a hyphenated role compound", "Ich bearbeite die Kunden-Tickets."],
    ["another hyphenated role compound", "Ich mag die Mitarbeiter-App."],
    ["a title-case product name", "Ich nutze ein Customer Relationship Tool."],
    ["a present verb ending in ed", "I embed fonts in my slides."],
    ["a migration made", "I migrated to Postgres."],
    ["an installation made", "I installed Obsidian."],
    ["a start made", "I started using vim."],
    ["a German migration made", "Ich migrierte zu Postgres."],
    ["a perfect migration", "Ich habe zu Postgres migriert."],
    ["a present verb with a stem t", "Ich halte Vorträge."],
  ])("keeps a genuine fact with %s", (_, text) => {
    const evidence = text.slice(0, -1);
    expect(reasonOf(text, evidence)).toBeNull();
  });

  it.each<[string, string, FactDropReason]>([
    ["a pronoun in the claim", "Ich arbeite gern mit ihr.", "third-party"],
    ["a claim-opening pronoun", "Er hilft mir bei Excel.", "third-party"],
    ["an English pronoun in the claim", "I work with her on reports.", "third-party"],
    ["a pointed role", "Ich telefoniere jeden Tag mit dem Kunden.", "third-party"],
    ["a family word without a possessive", "Ich hole Tochter jeden Tag ab.", "third-party"],
    ["someone else's wish", "Ich nutze Jira, weil Anna es wollte.", "third-party"],
    ["someone else's present wish", "Ich nutze Jira, weil Anna es so will.", "third-party"],
    ["someone telling the person", "Ich nutze Jira, weil Anna es mir sagte.", "third-party"],
    ["an English wish of another", "I use Jira because Sam asked for it.", "third-party"],
    ["a pronoun after a colon", "Ich nutze Vim: Er hilft mir.", "third-party"],
    ["a prefixed perfect", "Ich habe Excel verwendet.", "past-statement"],
    ["another prefixed perfect", "Ich habe Word benutzt.", "past-statement"],
    ["the German simple past", "Ich nutzte Excel.", "past-statement"],
    ["an inverted simple past", "Damals verwendete ich Excel.", "past-statement"],
    ["a weak simple past", "Ich arbeitete mit Excel.", "past-statement"],
    ["the English simple past", "I used Excel for reports.", "past-statement"],
    ["an English irregular past", "I wrote my notes in Word.", "past-statement"],
    ["a perfect", "Ich habe Excel genutzt.", "past-statement"],
  ])("drops %s", (_, text, reason) => {
    expect(reasonOf(text, text.slice(0, -1))).toBe(reason);
  });

  it("does not read a present need as a past", () => {
    expect(reasonOf("I need tables for numbers.", "I need tables for numbers")).toBeNull();
  });

  it("stays linear on a long run of spaces before a reason", () => {
    const text = `Ich nutze Excel${" ".repeat(50_000)}, weil Anna es will.`;
    const started = performance.now();
    expect(admit(text, "Ich nutze Excel").admitted).toBe(true);
    expect(reasonNamesOtherPerson(text)).toBe(true);
    expect(reasonNamesOtherPerson(`${" ".repeat(50_000)}weil`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
