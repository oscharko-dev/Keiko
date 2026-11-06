import { describe, expect, it } from "vitest";

import {
  admitProposedFact,
  reasonNamesOtherPerson,
  type FactAdmission,
  type FactDropReason,
} from "./fact-admission.js";

function admit(text: string, evidence: string, body = evidence, about = "self"): FactAdmission {
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
    ["a paraphrase about the user", "Der Benutzer mag Tabellen"],
  ])("admits the person's words whatever the model's statement has: %s", (_case, body) => {
    expect(admit("Ich mag Tabellen.", "Ich mag Tabellen", body)).toMatchObject({
      admitted: true,
      claim: "Ich mag Tabellen",
    });
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
    ["a comparison in the reason", "I use Vim because it feels like home."],
    ["an impersonal finding", "Ich nutze Google, weil man dort alles findet."],
    ["a passive decision", "Ich nutze Excel, weil es so entschieden wurde."],
    ["a tool's need", "Ich nutze Vim, weil das Tool es so will."],
    ["two own clauses", "Ich mag Tabellen und ich nutze Excel."],
    ["two own English clauses", "I like Vim and I use Linux."],
    ["a relative what", "Ich nutze das, was funktioniert."],
    ["a habit", "I'm used to Vim."],
    ["an appreciation", "Ich schätze Klarheit."],
    ["a way of thinking", "Ich denke in Tabellen."],
    ["a belief in a method", "I believe in testing."],
    ["a preposition before me", "Für mich sind Listen besser."],
    ["a replacement made", "Ich habe Excel durch Python ersetzt."],
    ["a choice made", "Ich habe Python gewählt."],
    ["leading a team", "Ich leite das Team."],
    ["leading an English team", "I lead this team."],
    ["managing a team", "I manage this team of five."],
    ["owning a team", "Ich verantworte das Team Kredit."],
    ["belonging to a team", "I'm part of this team."],
    ["a client tool", "I use this client for Git."],
    ["a job title", "My job title is manager."],
    ["an employer", "I'm an employee of Foo."],
    ["a field of law", "Ich bin ein Anwalt für Steuerrecht."],
    ["living with code", "I live with legacy code."],
    ["living with pets", "I live with two cats."],
    ["a job as partner", "I am married to my job."],
    ["a value with one object", "Ich schätze klare Strukturen."],
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
    [
      "another's wish beside an own one",
      "Ich nutze Excel, weil ich es will und Anna es mag.",
      "third-party",
    ],
    ["a recommendation of another", "Ich nutze Excel, weil Peter es empfiehlt.", "third-party"],
    ["a partner", "Ich lebe mit Peter zusammen.", "third-party"],
    ["a spouse", "Ich bin mit Anna verheiratet.", "third-party"],
    ["an English spouse", "I'm married to Sam.", "third-party"],
    ["a role toward another", "Ich bin der Vorgesetzte von Anna.", "third-party"],
    ["a genitive relation", "Ich bin Annas Chef.", "third-party"],
    ["a doctor behind a possessive", "Ich vertraue meinem Arzt.", "third-party"],
    ["a pair opening the claim", "Anna und ich nutzen Jira.", "we-statement"],
    ["an English pair mid-sentence", "Today Anna and I use Jira.", "we-statement"],
    ["another English pair", "Since March Sam and I prefer Vim.", "we-statement"],
    ["someone else's liking", "I use Vim because Anna likes it.", "third-party"],
    ["a named person behind an article", "Ich nutze Jira, weil der Peter es will.", "third-party"],
    ["a role behind an article", "I use Jira because the CTO wants it.", "third-party"],
    ["a hedge without a comma", "Ich glaube Tabellen sind besser.", "uncertain"],
    ["a hedge about another", "Ich denke Peter mag Jazz.", "uncertain"],
    ["a hedge with a clause", "Ich schätze Anna nutzt Jira.", "uncertain"],
    ["living with a named person", "I live with Sam.", "third-party"],
    ["an English role toward another", "I'm the boss of Sam.", "third-party"],
    ["a pair with a plural verb", "Heute haben Anna und ich Jira eingeführt.", "we-statement"],
    ["a hedge", "Ich glaube, ich nutze Jira.", "uncertain"],
    ["an English hedge", "I think I use Jira.", "uncertain"],
    ["a colloquial perfect", "Ich hab Excel genutzt.", "past-statement"],
    ["a German simple past of development", "Ich entwickelte Java-Anwendungen.", "past-statement"],
    ["an English simple past of management", "I managed a team.", "past-statement"],
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

describe("a span copied without the first words of its clause", () => {
  function claimOf(text: string, evidence: string, body = evidence, about = "self"): string | null {
    const admission = admit(text, evidence, body, about);
    return admission.admitted ? admission.claim : null;
  }

  function evidenceOf(text: string, evidence: string, about = "self"): string | null {
    const admission = admit(text, evidence, evidence, about);
    return admission.admitted ? admission.evidence : null;
  }

  const team =
    "We decided as a team to release only on Tuesdays, because support is fully staffed then.";

  it.each([
    ["the subject left out", "decided as a team to release only on Tuesdays"],
    ["only the verb phrase", "release only on Tuesdays"],
    ["a cut inside the first word", "ecided as a team to release only on Tuesdays"],
  ])("stores the whole clause, never the fragment: %s", (_label, evidence) => {
    expect(claimOf(team, evidence, "The team decided to release only on Tuesdays", "team")).toBe(
      "We decided as a team to release only on Tuesdays",
    );
    expect(evidenceOf(team, evidence, "team")).toBe(
      "We decided as a team to release only on Tuesdays",
    );
  });

  it("opens the clause, not the sentence", () => {
    expect(
      claimOf(
        "Frau Ostrander nutzt Excel, ich führe meine Zahlen im Wiki.",
        "meine Zahlen im Wiki",
      ),
    ).toBe("Ich führe meine Zahlen im Wiki");
    expect(claimOf("Heute mag ich Tabellen.", "ich Tabellen")).toBe("Heute mag ich Tabellen");
    expect(claimOf("Mein Home-Office nutze ich montags.", "Office nutze ich montags")).toBe(
      "Mein Home-Office nutze ich montags",
    );
  });

  it.each<[string, string, string, string, FactDropReason]>([
    [
      "another person opening it",
      "Mein Kollege mag Tabellen.",
      "mag Tabellen",
      "self",
      "third-party",
    ],
    ["no first person in it", "Er mag Tabellen.", "mag Tabellen", "self", "no-first-person"],
    [
      "a team clause without a team",
      "We release only on Tuesdays.",
      "release only on Tuesdays",
      "team",
      "not-self",
    ],
    ["a reason that is not the team's", team, "support is fully staffed then", "team", "not-self"],
  ])("judges the words it gains: %s", (_label, text, evidence, about, reason) => {
    expect(reasonOf(text, evidence, evidence, about)).toBe(reason);
  });

  it("drops a model statement the whole clause inverts", () => {
    expect(reasonOf("Ich mag keine Tabellen.", "Tabellen", "Ich mag Tabellen")).toBe(
      "polarity-changed",
    );
  });

  it("still reads the words before the clause", () => {
    expect(reasonOf("Es stimmt nicht, dass ich Tabellen mag.", "Tabellen mag")).toBe(
      "negated-context",
    );
    expect(reasonOf("Er sagte, ich mag Tabellen.", "mag Tabellen")).toBe("negated-context");
    expect(reasonOf("Wenn ich Tabellen mag, sage ich es.", "Tabellen mag")).toBe("hypothetical");
  });

  it.each<[string, string, string, FactDropReason]>([
    ["Anna says I like tables.", "I like tables", "I like tables", "negated-context"],
    ["Anna says I like tables.", "Anna says I like tables", "I like tables", "negated-context"],
    ["Anna sagt ich bevorzuge Tabellen.", "ich bevorzuge Tabellen", "", "negated-context"],
    ["Anna told me I prefer tables.", "I prefer tables", "", "negated-context"],
    ["Stell dir vor ich nutze Excel.", "ich nutze Excel", "", "hypothetical"],
    ["Hypothetically I use Excel.", "I use Excel", "", "hypothetical"],
  ])(
    "reads the words up to the person's subject without a comma: %s",
    (text, evidence, body, reason) => {
      expect(reasonOf(text, evidence, body === "" ? evidence : body)).toBe(reason);
    },
  );

  it.each<[string, string, FactDropReason]>([
    ["Dass ich Tabellen mag, sagt Anna.", "Dass ich Tabellen mag", "negated-context"],
    ["Ich nutze Jira, sagt Anna.", "Ich nutze Jira, sagt Anna", "negated-context"],
    ["I use Vim, Anna says.", "I use Vim", "negated-context"],
    ["Laut Anna nutze ich Vim.", "Laut Anna nutze ich Vim", "negated-context"],
    ["Laut meinem Chef nutze ich Vim.", "nutze ich Vim", "negated-context"],
    ["According to Anna I use Vim.", "I use Vim", "negated-context"],
    ["Anna thinks I use Vim.", "Anna thinks I use Vim", "negated-context"],
    ["Anna findet, ich nutze Vim.", "ich nutze Vim", "negated-context"],
    ["Angeblich nutze ich Vim.", "Angeblich nutze ich Vim", "negated-context"],
    ["Supposedly I use Vim.", "I use Vim", "negated-context"],
    ["Sollte ich Vim nutzen, sage ich es.", "Sollte ich Vim nutzen", "hypothetical"],
    ["Gesetzt den Fall, ich nutze Vim.", "ich nutze Vim", "hypothetical"],
    ["Unless I use Vim, nothing changes.", "Unless I use Vim", "hypothetical"],
    ["I should use Vim.", "I should use Vim", "hypothetical"],
  ])("keeps another's words or a condition out: %s", (text, evidence, reason) => {
    expect(reasonOf(text, evidence)).toBe(reason);
  });

  it.each([
    ["Das Daily findet montags statt, ich nutze dann Vim.", "ich nutze dann Vim"],
    ["Ich sage immer, dass ich Tabellen mag.", "dass ich Tabellen mag"],
    ["Ehrlich gesagt mag ich Tabellen.", "Ehrlich gesagt mag ich Tabellen"],
    ["Ich höre gern laute Musik.", "Ich höre gern laute Musik"],
  ])("keeps a genuine statement that only resembles one: %s", (text, evidence) => {
    expect(admit(text, evidence).admitted).toBe(true);
  });

  it("keeps an aside in brackets out of the person's clause", () => {
    const text = "Ich mag Tee (aber Anna mag Kaffee).";
    expect(admit(text, "Anna mag Kaffee", "Ich mag Kaffee").admitted).toBe(false);
    expect(admit(text, "mag Kaffee", "Ich mag Kaffee").admitted).toBe(false);
  });

  it("does not move the end", () => {
    expect(reasonOf("Ich mag Tabellen nicht.", "mag Tabellen")).toBe("not-clause-boundary");
  });

  it("does not reach further back than a span may be long", () => {
    const text = `Ich mag ${"sehr ".repeat(100)}Tabellen.`;
    expect(reasonOf(text, "Tabellen")).toBe("evidence-too-long");
  });

  it("reaches back exactly as far as a span may be long", () => {
    const sentence = (fill: number): string => `Ich ${"x".repeat(fill)} mag Tabellen.`;
    const fillFor = (length: number): number => length - "Ich  mag Tabellen".length;
    expect(reasonOf(sentence(fillFor(400)), "mag Tabellen")).not.toBe("evidence-too-long");
    expect(reasonOf(sentence(fillFor(401)), "mag Tabellen")).toBe("evidence-too-long");
  });

  it("stops looking back at the span limit on a long message", () => {
    const text = `${"ich ".repeat(50_000)}mag Tabellen.`;
    expect(reasonOf(text, "mag Tabellen")).toBe("evidence-too-long");
  });
});

describe("a team's fact", () => {
  const decision =
    "We decided as a team to release only on Tuesdays, because support is fully staffed then.";

  it("admits the team's own decision for its project", () => {
    const admission = admitProposedFact(
      { body: decision, evidence: decision, about: "team" },
      decision,
    );
    expect(admission).toMatchObject({ admitted: true, subject: "team", subjectless: false });
  });

  it("keeps a group statement labelled as the person's own out", () => {
    expect(reasonOf(decision, decision)).toBe("we-statement");
  });

  it.each([
    ["names a teammate", "Anna and I decided to release on Tuesdays."],
    ["names a titled person", "Wir haben mit Frau Müller entschieden, dienstags zu releasen."],
    ["names a relative", "Wir nehmen mit unserem Sohn jeden Freitag frei."],
  ])("drops a team fact that %s", (_, text) => {
    const evidence = text.slice(0, -1);
    expect(admitProposedFact({ body: evidence, evidence, about: "team" }, text)).toEqual({
      admitted: false,
      reason: "third-party",
    });
  });

  it.each([
    ["Unser Team hat entschieden, freitags nichts zu releasen."],
    ["Wir haben im Projekt vereinbart, jeden Pull Request zu reviewen."],
    ["In our team we write every ticket in English."],
    ["Unser Entwicklungsteam nutzt Jira für jedes Ticket."],
    ["Wir und unser Team nutzen Jira."],
  ])("admits a statement that names the group as the person's team: %s", (text) => {
    const evidence = text.slice(0, -1);
    expect(admitProposedFact({ body: evidence, evidence, about: "team" }, text)).toMatchObject({
      admitted: true,
      subject: "team",
    });
  });

  it.each([
    ["a household", "Wir erwarten im Mai ein Kind.", "not-self"],
    ["a couple", "We are getting divorced.", "not-self"],
    ["where they live", "Wir wohnen in Hamburg.", "not-self"],
    ["a decision about someone", "We decided to fire Tom Becker next month.", "not-self"],
    [
      "a decision naming a person",
      "Wir haben entschieden, dass Anna die Releases verantwortet.",
      "not-self",
    ],
    ["another team", "The marketing team decided that we ship on Fridays.", "not-self"],
    [
      "another department",
      "Das Marketing hat entschieden, dass wir freitags releasen.",
      "not-self",
    ],
    ["a group with someone named", "Wir und Anna nutzen im Team Jira.", "third-party"],
    ["someone named with the group", "Anna und wir nutzen im Team Jira.", "third-party"],
    ["the person's people", "Unser Team und meine Leute nutzen Jira.", "third-party"],
    ["the group with someone named", "Unser Team und Anna nutzen Jira.", "third-party"],
    ["the team's lead", "Our team lead decided we use Jira.", "third-party"],
  ])("drops %s", (_, text, reason) => {
    const evidence = text.slice(0, -1);
    expect(admitProposedFact({ body: evidence, evidence, about: "team" }, text)).toEqual({
      admitted: false,
      reason,
    });
  });

  it("drops a team label without a group", () => {
    const text = "Ich nutze Excel.";
    expect(
      admitProposedFact(
        { body: "Ich nutze Excel", evidence: "Ich nutze Excel", about: "team" },
        text,
      ),
    ).toEqual({ admitted: false, reason: "not-self" });
  });
});

describe("a pronoun for the person's own thing", () => {
  const text = "Sie beginnen immer mit einer Zusammenfassung in drei Saetzen.";
  const evidence = text.slice(0, -1);
  const body = "Meine Berichte beginnen immer mit einer Zusammenfassung in drei Saetzen";

  it("admits the claim when the person named the thing as theirs just before", () => {
    const admission = admitProposedFact({ body, evidence, about: "self" }, text, {
      previousUserText: "Ich habe eine neue Regel fuer meine Berichte.",
    });
    expect(admission).toMatchObject({ admitted: true, subject: "self", subjectless: false });
  });

  it.each([
    ["without a previous message", undefined],
    ["when the thing was not theirs", "Ich lese oft Berichte."],
    ["when another thing was theirs", "Ich habe eine Regel fuer meine Notizen."],
  ])("drops it %s", (_, previousUserText) => {
    expect(
      admitProposedFact({ body, evidence, about: "self" }, text, { previousUserText }).admitted,
    ).toBe(false);
  });

  it("resolves it when the model's statement names the thing without the possessive", () => {
    const admission = admitProposedFact(
      { body: "Berichte beginnen immer mit einer Zusammenfassung", evidence, about: "self" },
      text,
      { previousUserText: "Ich habe eine neue Regel fuer meine Berichte." },
    );
    expect(admission).toMatchObject({
      admitted: true,
      claim: `Meine Berichte ${evidence.slice(4)}`,
    });
  });

  it.each([
    [
      "Es braucht neue Reifen.",
      "Mein Auto braucht neue Reifen",
      "Ich fahre mit meinem Auto.",
      "Mein Auto braucht neue Reifen",
    ],
    ["It runs offline.", "My server runs offline", "I set up my server.", "My server runs offline"],
  ])(
    "takes the possessive and noun from the person's words: %s",
    (said, body, previousUserText, claim) => {
      expect(
        admitProposedFact({ body, evidence: said.slice(0, -1), about: "self" }, said, {
          previousUserText,
        }),
      ).toMatchObject({ admitted: true, claim });
    },
  );

  it.each([
    [
      "the model kept the pronoun",
      "Sie beginnen immer mit einer Zusammenfassung",
      "fuer meine Berichte",
    ],
    [
      "the model named another thing",
      "Notizen beginnen immer mit einer Zusammenfassung",
      "fuer meine Berichte",
    ],
  ])("drops it when %s", (_, proposed, named) => {
    const admission = admitProposedFact({ body: proposed, evidence, about: "self" }, text, {
      previousUserText: `Ich habe eine neue Regel ${named}.`,
    });
    expect(admission.admitted).toBe(false);
  });

  it.each([
    [
      "Sie wohnt in Berlin.",
      "Sie wohnt in Berlin",
      "Danke, ich schicke meinen Bericht heute noch.",
    ],
    ["Sie sind alle über 80.", "Meine Patienten sind alle über 80", "Das sind meine Patienten."],
    ["They are all in year nine.", "My students are all in year nine", "I graded my students."],
    ["Diese Regel gilt immer.", "Meine Berichte Regel gilt immer", "Das ist für meine Berichte."],
  ])(
    "never makes a pronoun or a person the person's own thing: %s",
    (said, body, previousUserText) => {
      expect(
        admitProposedFact({ body, evidence: said.slice(0, -1), about: "self" }, said, {
          previousUserText,
        }).admitted,
      ).toBe(false);
    },
  );

  it.each([
    [
      "Sie ist unfreundlich.",
      "Meine Vermieterin ist unfreundlich",
      "Ich schreibe gerade meiner Vermieterin.",
    ],
    ["It is a nightmare.", "My landlord is a nightmare", "I need to email my landlord."],
    [
      "Sie sind unzuverlässig.",
      "Meine Leute sind unzuverlässig",
      "Ich muss meine Leute informieren.",
    ],
    ["They are loud.", "My kids are loud", "I picked up my kids."],
  ])("drops a pronoun resolved to a person: %s", (said, resolved, previousUserText) => {
    expect(
      admitProposedFact({ body: resolved, evidence: said.slice(0, -1), about: "self" }, said, {
        previousUserText,
      }),
    ).toEqual({ admitted: false, reason: "third-party" });
  });

  it("still drops a pronoun for a person the person named", () => {
    const said = "Sie arbeitet in Berlin.";
    expect(
      admitProposedFact(
        { body: "Meine Kollegin arbeitet in Berlin", evidence: said.slice(0, -1), about: "self" },
        said,
        { previousUserText: "Ich mag meine Kollegin." },
      ),
    ).toEqual({ admitted: false, reason: "third-party" });
  });
});

describe("people named by their relation to the person", () => {
  it.each([
    ["Meine Vermieterin ist unfreundlich."],
    ["My landlord never answers."],
    ["Meine Eltern wohnen in Bonn."],
    ["Meine Oma backt sonntags."],
  ])("drops a statement about them: %s", (text) => {
    expect(reasonOf(text, text.slice(0, -1))).toBe("third-party");
  });

  it.each([
    ["Ich unterrichte Kinder in Mathe."],
    ["Ich bin Lehrerin an einer Grundschule."],
    ["I am a teacher and I grade on Fridays."],
    ["Ich bin Mieterin in Köln."],
    ["Als Lehrerin korrigiere ich viel."],
    ["Als Chef entscheide ich schnell."],
  ])("keeps the person's own work and role: %s", (text) => {
    expect(reasonOf(text, text.slice(0, -1))).toBeNull();
  });
});
