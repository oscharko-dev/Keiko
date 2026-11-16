// Defects the 370-requirement Lastenheft golden test (tests/fixtures/requirements/lastenheft-kundenportal)
// found in the requirement inventory (Epic #4173). Each case is the smallest text that shows one
// cause, written the way the Markdown, Word and PDF parsers hand a specification over: Word emits a
// blank line between every paragraph, a PDF breaks a page inside a sentence. Synthetic documents only.

import { describe, expect, it } from "vitest";

import {
  deriveRequirementInventory,
  type RequirementInventory,
  type RequirementInventoryEntry,
} from "../domain/requirementInventory.js";

function derive(lines: readonly string[]): RequirementInventory {
  return deriveRequirementInventory({ text: lines.join("\n"), documentKey: "doc:lastenheft" });
}

function entryOf(inventory: RequirementInventory, id: string): RequirementInventoryEntry {
  const entry = inventory.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry;
}

function criteriaOf(entry: RequirementInventoryEntry): string[] {
  return entry.acceptanceCriteria.map(({ text }) => text);
}

function derivedStatements(inventory: RequirementInventory): string[] {
  return inventory.entries
    .filter(({ idOrigin }) => idOrigin === "derived")
    .map(({ statement }) => statement);
}

describe("a flat identifier block with a second statement paragraph", () => {
  const block = [
    "REQ-FA-025: Sichere Sitzungskennung",
    "",
    "Das Kundenportal soll die Sitzungskennung in einem Cookie führen.",
    "",
    "Für Sonderfälle wie Vollmachten gilt ergänzend (siehe NFA-PERF-002).",
    "",
    "Abnahmekriterien:",
    "- Erstes Kriterium.",
    "- Zweites Kriterium.",
    "",
    "Prio: Soll",
  ];

  it.each([
    ["a Markdown chapter heading", ["## 3.2 Profil"]],
    ["a plain chapter heading", ["3.2 Profil und Einstellungen"]],
  ])("keeps both paragraphs, the criteria and the priority before %s", (_name, heading) => {
    const inventory = derive([
      "# Anforderungen",
      "",
      ...block,
      "",
      ...heading,
      "",
      "REQ-FA-026: Zweite Anforderung",
      "",
      "Das Kundenportal muss etwas anderes tun.",
      "",
      "Prio: Muss",
    ]);

    const entry = entryOf(inventory, "REQ-FA-025");
    expect(entry.statement).toBe(
      "Das Kundenportal soll die Sitzungskennung in einem Cookie führen. Für Sonderfälle wie Vollmachten gilt ergänzend (siehe NFA-PERF-002).",
    );
    expect(criteriaOf(entry)).toEqual(["Erstes Kriterium.", "Zweites Kriterium."]);
    expect(entry.priority).toBe("Soll");
    expect(inventory.entries.map(({ id }) => id)).toEqual(["REQ-FA-025", "REQ-FA-026"]);
    expect(derivedStatements(inventory)).toEqual([]);
    expect(entryOf(inventory, "REQ-FA-026").statement).toBe(
      "Das Kundenportal muss etwas anderes tun.",
    );
  });

  it("keeps a second paragraph behind the last block of a document", () => {
    const inventory = derive([
      ...block.slice(0, 5),
      "",
      "Prio: Soll",
      "",
      "REQ-FA-026: Zweite Anforderung",
      "",
      "Das Kundenportal muss etwas anderes tun.",
      "",
      "Dazu gehört auch die Protokollierung.",
      "",
      "Prio: Muss",
    ]);

    expect(entryOf(inventory, "REQ-FA-026").statement).toBe(
      "Das Kundenportal muss etwas anderes tun. Dazu gehört auch die Protokollierung.",
    );
    expect(entryOf(inventory, "REQ-FA-026").priority).toBe("Muss");
    expect(derivedStatements(inventory)).toEqual([]);
  });
});

describe("numbered criteria behind a blank-separated lead", () => {
  it("reads every numbered paragraph of a Word list", () => {
    const inventory = derive([
      "REQ-FA-015: Starke Kundenauthentifizierung",
      "",
      "Das Kundenportal soll die starke Kundenauthentifizierung erzwingen.",
      "",
      "Abnahmekriterien:",
      "",
      "1. Die Fachabteilung bestätigt die Funktion.",
      "",
      "2. Die Darstellung entspricht dem Entwurf.",
      "",
      "Priorität: Soll",
      "",
      "REQ-FA-016: Anmeldung über Bank-ID",
      "",
      "Das Kundenportal muss die Anmeldung über Bank-ID anbieten.",
      "",
      "Priorität: Muss",
    ]);

    const entry = entryOf(inventory, "REQ-FA-015");
    expect(criteriaOf(entry)).toEqual([
      "Die Fachabteilung bestätigt die Funktion.",
      "Die Darstellung entspricht dem Entwurf.",
    ]);
    expect(entry.priority).toBe("Soll");
    expect(derivedStatements(inventory)).toEqual([]);
  });

  it("reads a list a page break separated from its lead", () => {
    const inventory = derive([
      "REQ-FA-042: Verwaltung der Einwilligungen",
      "Das Kundenportal kann dem Kunden die Einsicht ermöglichen.",
      "Abnahmekriterien:",
      "",
      "1. Die Funktion ist erreichbar.",
      "2. Die Darstellung entspricht dem Entwurf.",
      "",
      "REQ-FA-043: Widerruf",
      "Das Kundenportal soll den Widerruf erlauben.",
      "Priorität: Soll",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-042"))).toEqual([
      "Die Funktion ist erreichbar.",
      "Die Darstellung entspricht dem Entwurf.",
    ]);
  });

  it("still ends the criteria at a numbered list that starts a new paragraph after bullets", () => {
    const inventory = derive([
      "REQ-FA-050: Titel",
      "",
      "Das Kundenportal soll etwas tun.",
      "",
      "Abnahmekriterien:",
      "- Erstes Kriterium.",
      "",
      "1. Schritt des Ablaufs.",
      "",
      "REQ-FA-051: Nächste",
      "",
      "Das Kundenportal muss mehr tun.",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-050"))).toEqual(["Erstes Kriterium."]);
  });
});

describe("a traceability matrix", () => {
  const definitions = [
    "REQ-FA-001: Selbstregistrierung",
    "",
    "Das Kundenportal muss die Selbstregistrierung anbieten.",
    "",
    "Priorität: Muss",
    "",
    "REQ-FA-015: Anmeldung",
    "",
    "Das Kundenportal soll die Anmeldung anbieten.",
    "",
    "Priorität: Soll",
    "",
  ];

  it("defines no requirement in a Markdown table and conflicts with none", () => {
    const inventory = derive([
      ...definitions,
      "| Anforderungs-ID | Testfall | Status |",
      "| --- | --- | --- |",
      "| REQ-FA-001 | TC-100 | Bestanden |",
      "| REQ-FA-015 | TC-101 | Geplant |",
    ]);

    expect(inventory.conflictingIds).toEqual([]);
    expect(entryOf(inventory, "REQ-FA-001").statement).toBe(
      "Das Kundenportal muss die Selbstregistrierung anbieten.",
    );
    expect(inventory.entries).toHaveLength(2);
  });

  it("defines no requirement in a Word table projection", () => {
    const inventory = derive([
      ...definitions,
      "Table row 1: Anforderungs-ID=REQ-FA-001 | Testfall=TC-100 | Status=Bestanden",
      "Table row 2: Anforderungs-ID=REQ-FA-015 | Testfall=TC-101 | Status=Geplant",
    ]);

    expect(inventory.conflictingIds).toEqual([]);
    expect(inventory.entries).toHaveLength(2);
  });

  it("defines no requirement in flat PDF text and takes no text behind it", () => {
    const inventory = derive([
      ...definitions,
      "Anforderungs-ID Testfall Status",
      "REQ-FA-001 TC-100 Bestanden",
      "REQ-FA-015 TC-101 Geplant",
      "",
      "Version Datum Autor Änderung",
      "1.0 12.01.2026 Fachbereich Das System muss geprüft werden.",
    ]);

    expect(inventory.conflictingIds).toEqual([]);
    expect(inventory.entries.filter(({ idOrigin }) => idOrigin === "explicit")).toHaveLength(2);
  });

  it("keeps reading a table that names an identifier and an unknown column by position", () => {
    const inventory = derive([
      "| ID | Wichtigkeit |",
      "| --- | --- |",
      "| FR-1 | Das System muss X tun. |",
    ]);

    expect(inventory.entries.map(({ id }) => id)).toEqual(["FR-1"]);
  });

  it("never lets a mention of a defined identifier conflict with its definition", () => {
    const inventory = derive([
      ...definitions,
      "REQ-FA-001 Selbstregistrierung wird im Test abgedeckt",
      "REQ-FA-015 Anmeldung wird im Test abgedeckt, es gilt die Vorgabe des Fachbereichs und es muss gelten",
    ]);

    expect(inventory.conflictingIds).toEqual([]);
    expect(entryOf(inventory, "REQ-FA-015").statement).toBe(
      "Das Kundenportal soll die Anmeldung anbieten.",
    );
  });
});

describe("an identifier at the start of a wrapped line", () => {
  const head = [
    "REQ-FA-113: Währungsliste",
    "",
    "Das System muss die Währungen anzeigen. Die Regelung gilt in Verbindung mit",
  ];

  it.each([
    ["with a full stop", "REQ-FA-163."],
    ["with a closing bracket", "REQ-FA-163)"],
    ["alone", "REQ-FA-163"],
  ])("is a reference, not a definition, %s", (_name, wrapped) => {
    const inventory = derive([
      ...head,
      wrapped,
      "",
      "Priorität: Muss",
      "",
      "REQ-FA-163: Digitale Karte",
      "",
      "Das System soll die Karte anzeigen.",
      "",
      "Priorität: Soll",
    ]);

    expect(inventory.entries.map(({ id }) => id)).toEqual(["REQ-FA-113", "REQ-FA-163"]);
    expect(inventory.conflictingIds).toEqual([]);
    expect(entryOf(inventory, "REQ-FA-113").statement).toContain("in Verbindung mit REQ-FA-163");
    expect(entryOf(inventory, "REQ-FA-113").priority).toBe("Muss");
    expect(entryOf(inventory, "REQ-FA-163").statement).toBe("Das System soll die Karte anzeigen.");
  });

  it("still opens a unit behind a heading line and behind a finished sentence", () => {
    const inventory = derive([
      "3.1.1.3 Sitzungsverwaltung",
      "REQ-FA-018: Automatische Abmeldung",
      "Das Kundenportal soll eine Sitzung beenden.",
      "REQ-FA-019 Warnung vor Sitzungsende",
      "Das Kundenportal muss den Kunden warnen.",
    ]);

    expect(inventory.entries.map(({ id }) => id)).toEqual(["REQ-FA-018", "REQ-FA-019"]);
  });
});

describe("the priority vocabulary used as nouns", () => {
  it.each([
    ["German", "Die Priorität einer Anforderung ist Muss, Soll oder Kann."],
    [
      "English",
      "In der Schnittstellenspezifikation werden die englischen Begriffe Must, Should und Could verwendet.",
    ],
    ["lower case", "Requirements are rated as must, should or could."],
    ["a listing row", "Die Stufen lauten Muss / Soll / Kann."],
  ])("states no obligation in a %s legend", (_name, sentence) => {
    expect(derivedStatements(derive(["1.2 Prioritäten", "", sentence]))).toEqual([]);
  });

  it("still derives a requirement from a real obligation", () => {
    expect(
      derivedStatements(
        derive([
          "Das System muss Zahlungen prüfen.",
          "Das System MUSS Zahlungen buchen.",
          "The system must log every access.",
        ]),
      ),
    ).toEqual([
      "Das System muss Zahlungen prüfen.",
      "Das System MUSS Zahlungen buchen.",
      "The system must log every access.",
    ]);
  });

  it("reads a listing of identifier, title and priority as references, not as obligations", () => {
    const inventory = derive([
      "ID Titel Priorität",
      "REQ-FA-003 E-Mail-Bestätigung Muss",
      "REQ-FA-021 Sitzungsübersicht Muss",
      "",
      "2 Gesamtsystem",
      "Das Kapitel muss die Systemlandschaft der Bank einordnen.",
      "",
      "REQ-FA-003 E-Mail-Bestätigung",
      "Das Kundenportal muss die E-Mail-Adresse verifizieren.",
      "Priorität: Muss",
      "REQ-FA-021 Sitzungsübersicht",
      "Das Kundenportal muss alle Sitzungen anzeigen.",
      "Priorität: Muss",
    ]);

    expect(inventory.conflictingIds).toEqual([]);
    expect(entryOf(inventory, "REQ-FA-003").title).toBe("E-Mail-Bestätigung");
    expect(entryOf(inventory, "REQ-FA-021").statement).toBe(
      "Das Kundenportal muss alle Sitzungen anzeigen.",
    );
    // The chapter line is part of the paragraph, as in any flat text; what matters is the listing.
    expect(derivedStatements(inventory)).toHaveLength(1);
    expect(derivedStatements(inventory)[0]).toContain("Das Kapitel muss die Systemlandschaft");
  });
});

describe("a page break inside a requirement", () => {
  it("continues a marked criterion with a capitalised noun behind the break", () => {
    const inventory = derive([
      "REQ-FA-170: Reklamationsprozess",
      "Das Kundenportal muss einen Reklamationsvorgang anlegen.",
      "Priorität: Muss",
      "Abnahmekriterien:",
      "- Die Funktion ist nach erfolgreicher Anmeldung innerhalb von 2",
      "",
      "Sekunden erreichbar.",
      "- Die Funktion ist mit einem Screenreader bedienbar.",
      "REQ-FA-171: Benachrichtigung",
      "Das Kundenportal soll eine Benachrichtigung auslösen.",
      "Priorität: Soll",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-170"))).toEqual([
      "Die Funktion ist nach erfolgreicher Anmeldung innerhalb von 2 Sekunden erreichbar.",
      "Die Funktion ist mit einem Screenreader bedienbar.",
    ]);
  });

  it("continues the last criterion of a block with a capitalised word", () => {
    const inventory = derive([
      "REQ-FA-184: Manuelle Prüfung",
      "Die Kreditentscheidung soll Anträge weiterleiten.",
      "Priorität: Soll",
      "Abnahmekriterien:",
      "- Die Anforderung ist nachgewiesen.",
      "- Die Bedienung funktioniert in Chrome und Edge in der jeweils aktuellen",
      "",
      "Version.",
      "REQ-FA-185: Begründung",
      "Die Kreditentscheidung muss die Gründe mitteilen.",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-184"))).toEqual([
      "Die Anforderung ist nachgewiesen.",
      "Die Bedienung funktioniert in Chrome und Edge in der jeweils aktuellen Version.",
    ]);
    expect(derivedStatements(inventory)).toEqual([]);
  });

  it("continues a statement with a capitalised noun behind the break", () => {
    const inventory = derive([
      "REQ-FA-018: Automatische Abmeldung",
      "Das Kundenportal soll eine Sitzung nach zehn Minuten ohne Aktivität innerhalb von zwei",
      "",
      "Werktagen automatisch beenden.",
      "Priorität: Soll",
      "Abnahmekriterien:",
      "- Die Abmeldung ist protokolliert.",
      "- Die Warnung erscheint zuvor.",
    ]);

    expect(entryOf(inventory, "REQ-FA-018").statement).toBe(
      "Das Kundenportal soll eine Sitzung nach zehn Minuten ohne Aktivität innerhalb von zwei Werktagen automatisch beenden.",
    );
    expect(entryOf(inventory, "REQ-FA-018").priority).toBe("Soll");
  });

  it("keeps a numbered item that wraps and breaks the page behind its last line", () => {
    const inventory = derive([
      "REQ-FA-070: Titel",
      "Das Kundenportal muss etwas tun.",
      "Abnahmekriterien:",
      "1. Bei ungültiger Eingabe erscheint eine Meldung und der Vorgang",
      "wird nicht ausgeführt.",
      "",
      "2. Ein Test ergibt eine Fehlerrate.",
      "3. Die Abnahme ist dokumentiert.",
      "REQ-FA-071: Nächste",
      "Das Kundenportal soll mehr tun.",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-070"))).toEqual([
      "Bei ungültiger Eingabe erscheint eine Meldung und der Vorgang wird nicht ausgeführt.",
      "Ein Test ergibt eine Fehlerrate.",
      "Die Abnahme ist dokumentiert.",
    ]);
  });

  it("does not merge separate unpunctuated criteria with the paragraph behind them", () => {
    const inventory = derive([
      "REQ-FA-060: Titel",
      "Das Kundenportal soll etwas tun.",
      "Abnahmekriterien:",
      "- Login funktioniert",
      "- Logout funktioniert",
      "",
      "Die Anforderung gilt für Privatkunden.",
      "REQ-FA-061: Nächste",
      "Das Kundenportal muss mehr tun.",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-060"))).toEqual([
      "Login funktioniert",
      "Logout funktioniert",
    ]);
  });
});

describe("obligation phrases that are verbs, not priority terms", () => {
  it.each([
    "The Contractor Shall log every access to the archive.",
    "Das System Muss alle Zahlungen vor der Buchung prüfen.",
    "Export of invoices. The System Must support CSV files.",
    "Das System muss/soll alle Zahlungen vor der Buchung prüfen.",
    "The system must/should log every access to the archive.",
    "Das System muss bzw. soll alle Zahlungen vor der Buchung prüfen.",
  ])("derives a requirement from: %s", (sentence) => {
    expect(derivedStatements(derive([sentence])).length).toBeGreaterThan(0);
  });

  it.each([
    "Die Priorität ist Muss oder Kann.",
    "Priority is Must.",
    "Die Stufen sind Muss, Soll, Kann.",
    "Prio: Soll",
  ])("reads a legend as no obligation: %s", (sentence) => {
    expect(derivedStatements(derive(["1.2 Prioritäten", "", sentence]))).toEqual([]);
  });
});

describe("a blank line between two paragraphs", () => {
  it("never joins the next sentence to an unfinished one in a document without lists", () => {
    const inventory = derive([
      "REQ-FA-001: Anmeldung",
      "",
      "Das System muss Benutzer anmelden",
      "",
      "Alle Zeiten sind in UTC angegeben.",
    ]);

    expect(entryOf(inventory, "REQ-FA-001").statement).toBe("Das System muss Benutzer anmelden");
  });

  it("never joins a paragraph to an open criterion of a Markdown document", () => {
    const inventory = derive([
      "REQ-FA-001: Anmeldung",
      "",
      "Das System soll Benutzer anmelden.",
      "",
      "Abnahmekriterien:",
      "",
      "- Die Anmeldung ist protokolliert.",
      "",
      "- Die Zeiten sind angegeben",
      "",
      "Alle Zeiten sind in UTC angegeben.",
    ]);

    expect(criteriaOf(entryOf(inventory, "REQ-FA-001"))).toEqual([
      "Die Anmeldung ist protokolliert.",
      "Die Zeiten sind angegeben",
    ]);
  });
});

describe("a list of error codes in flat text", () => {
  const codes = [
    "7.1.1.1 Tabelle der Fehlercodes",
    "Code Bedeutung",
    "ERR-4001 Ungültige IBAN",
    "ERR-4002 Betrag außerhalb des zulässigen Bereichs",
    "",
    "ERR-5001 Kernbanksystem nicht erreichbar",
    "ERR-5002 Zeitüberschreitung beim Clearing",
  ];

  it("defines no requirement, like the same table with cells", () => {
    const inventory = derive(codes);

    expect(inventory.entries).toEqual([]);
    expect(inventory.rejectedCandidateCount).toBe(4);
  });

  it("matches the pipe table of the same codes", () => {
    const table = derive([
      "| Code | Bedeutung |",
      "| --- | --- |",
      "| ERR-4001 | Ungültige IBAN |",
      "| ERR-4002 | Betrag außerhalb des zulässigen Bereichs |",
    ]);

    expect(table.entries).toEqual([]);
  });

  it("keeps reading consecutive one-line requirements under a chapter heading", () => {
    const inventory = derive([
      "3.1 Funktionale Anforderungen",
      "REQ-1 Das System muss Zahlungen prüfen.",
      "REQ-2 Das System muss Zahlungen buchen.",
    ]);

    expect(inventory.entries.map(({ id }) => id)).toEqual(["REQ-1", "REQ-2"]);
  });
});
