import { describe, expect, it } from "vitest";

import {
  REQUIREMENT_INVENTORY_ENTRIES_MAX,
  deriveRequirementInventory,
  derivedRequirementId,
  documentScopeOf,
  requirementContentDigest,
  type RequirementInventoryInput,
  type RequirementInventorySection,
} from "../domain/requirementInventory.js";

const KEY = "doc:cap:src:spec.md";

function detect(
  lines: readonly string[],
  extra: Partial<RequirementInventoryInput> = {},
): ReturnType<typeof deriveRequirementInventory> {
  return deriveRequirementInventory({ text: lines.join("\n"), documentKey: KEY, ...extra });
}
function ids(lines: readonly string[], extra: Partial<RequirementInventoryInput> = {}): string[] {
  return detect(lines, extra).entries.map((entry) => entry.id);
}

interface Spec {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly priority: string;
  readonly criteria: readonly string[];
}

const SPECS: readonly Spec[] = [
  {
    id: "LH-001",
    title: "Anmeldung: Kundennummer",
    text: "Das Portal unterstützt die Anmeldung per Kundennummer; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
    priority: "Muss",
    criteria: ["Die Kundennummer ist für angemeldete Nutzer verfügbar.", "Fehler werden gemeldet."],
  },
  {
    id: "LH-002",
    title: "Anmeldung: Einmalcode",
    text: "Das Portal unterstützt Einmalcodes schnell und benutzerfreundlich.",
    priority: "Soll",
    criteria: [],
  },
  {
    id: "LH-003",
    title: "Statusverfolgung: Verlauf",
    text: "Der Verlauf eines Schadens ist einsehbar.",
    priority: "Kann",
    criteria: ["Der Verlauf zeigt alle Statuswechsel."],
  },
];

interface Rendered {
  readonly text: string;
  readonly sections: readonly RequirementInventorySection[];
}
type Format = "markdown" | "word" | "slides" | "text";

function bodyLines(spec: Spec, bullet: string): readonly string[] {
  return [
    spec.text,
    ...(spec.criteria.length === 0
      ? []
      : ["", "Abnahmekriterien:", ...spec.criteria.map((criterion) => `${bullet}${criterion}`)]),
    "",
    `Priorität: ${spec.priority}.`,
  ];
}

/** The same specification as each parser would hand it over: text plus section boundaries. */
function render(format: Format): Rendered {
  const lines: string[] = [];
  const sections: RequirementInventorySection[] = [];
  let offset = 0;
  const push = (line: string, section?: readonly string[]): void => {
    if (section !== undefined)
      sections.push({ sectionPath: section, characterStart: offset, characterEnd: -1 });
    lines.push(line);
    offset += line.length + 1;
  };
  push(format === "markdown" ? "# Lastenheft" : "Lastenheft", ["Lastenheft"]);
  push("");
  push("Schadenmeldungen werden heute telefonisch erfasst.");
  push("");
  SPECS.forEach((spec, index) => {
    const heading = `${spec.id} ${spec.title}`;
    const path = ["Lastenheft", heading];
    if (format === "markdown") push(`### ${heading}`, path);
    else if (format === "slides")
      push(`Slide ${String(index + 1)}`, [`Slide ${String(index + 1)}`]);
    else push(heading, format === "word" ? path : undefined);
    if (format === "slides") push(heading);
    push("");
    for (const line of bodyLines(spec, format === "markdown" ? "- " : "")) push(line);
    push("");
  });
  const closed = sections.map((section, index) => ({
    ...section,
    characterEnd: sections[index + 1]?.characterStart ?? offset,
  }));
  return { text: lines.join("\n"), sections: closed };
}

function content(format: Format): readonly unknown[] {
  const { text, sections } = render(format);
  return deriveRequirementInventory({ text, sections, documentKey: KEY }).entries.map((entry) => [
    entry.id,
    entry.title,
    entry.priority,
    entry.statement,
    entry.acceptanceCriteria,
    entry.digest,
  ]);
}

describe("deriveRequirementInventory — structure", () => {
  it("enumerates every explicit requirement with title, priority, criteria and location", () => {
    const { text, sections } = render("markdown");
    const inventory = deriveRequirementInventory({ text, sections, documentKey: KEY });

    expect(inventory.entries.map((entry) => entry.id)).toEqual(["LH-001", "LH-002", "LH-003"]);
    expect(inventory.totalCount).toBe(3);
    expect(inventory.truncated).toBe(false);
    const first = inventory.entries[0];
    expect(first?.title).toBe("Anmeldung: Kundennummer");
    expect(first?.priority).toBe("Muss");
    expect(first?.acceptanceCriteria[0]).toEqual({
      id: "LH-001/AC1",
      text: "Die Kundennummer ist für angemeldete Nutzer verfügbar.",
    });
    expect(first?.sectionPath).toEqual(["Lastenheft", "LH-001 Anmeldung: Kundennummer"]);
    expect(first?.documentScope).toBe(documentScopeOf(KEY));
    expect(text.slice(first?.characterStart, first?.characterEnd)).toContain("Priorität: Muss.");
  });

  it("returns the same content for Markdown, Word, slides and plain text", () => {
    const reference = content("markdown");

    expect(content("word")).toEqual(reference);
    expect(content("slides")).toEqual(reference);
    expect(content("text")).toEqual(reference);
  });

  it("keeps the digest to normalized content: no location, no detector version", () => {
    const [entry] = deriveRequirementInventory({ ...render("markdown"), documentKey: KEY }).entries;

    expect(entry?.digest).toBe(
      requirementContentDigest({
        id: "LH-001",
        title: "Anmeldung: Kundennummer",
        priority: "Muss",
        statement: SPECS[0]?.text ?? "",
        criteria: SPECS[0]?.criteria ?? [],
      }),
    );
  });

  it("reads the fields of a block an extractor flattened into one line", () => {
    const text = [
      "Einleitung.",
      "Das Portal unterstützt die Anmeldung; Abnahmekriterien: Die Anmeldung ist möglich.Fehler werden gemeldet. Priorität: Muss.",
    ].join("\n");
    const sections = [
      { sectionPath: ["Lastenheft"], characterStart: 0, characterEnd: 11 },
      {
        sectionPath: ["Lastenheft", "REQ-1 Anmeldung"],
        characterStart: 12,
        characterEnd: text.length,
      },
    ];

    const [entry] = deriveRequirementInventory({ text, sections, documentKey: KEY }).entries;

    expect(entry).toMatchObject({
      id: "REQ-1",
      title: "Anmeldung",
      priority: "Muss",
      statement: "Das Portal unterstützt die Anmeldung;",
    });
    expect(entry?.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      "Die Anmeldung ist möglich.",
      "Fehler werden gemeldet.",
    ]);
  });

  it("defines a unit by a recorded heading that is not a line of the text, with a slide label", () => {
    const text = "Slide 1: REQ-7 Export\nDas System muss exportieren.\nPriorität: Soll.";
    const sections = [
      { sectionPath: ["Slide 1: REQ-7 Export"], characterStart: 0, characterEnd: text.length },
    ];

    const [entry] = deriveRequirementInventory({ text, sections, documentKey: KEY }).entries;

    expect(entry).toMatchObject({ id: "REQ-7", title: "Export", priority: "Soll" });
  });

  it("counts units beyond the entry bound instead of dropping them silently", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `REQ-00${String(i + 1)}: Titel ${String(i)}`);

    const inventory = detect(lines, { maxEntries: 3 });

    expect(inventory.entries).toHaveLength(3);
    expect(inventory.totalCount).toBe(5);
    expect(inventory.truncated).toBe(true);
    expect(REQUIREMENT_INVENTORY_ENTRIES_MAX).toBeGreaterThanOrEqual(500);
  });

  it("handles empty, whitespace and CRLF input", () => {
    expect(detect([""]).entries).toEqual([]);
    expect(detect(["", " ", ""]).entries).toEqual([]);
    const crlf = deriveRequirementInventory({
      text: "REQ-1: Titel\r\nPriorität: Muss\r\n",
      documentKey: KEY,
    });
    expect(crlf.entries[0]?.priority).toBe("Muss");
  });
});

describe("deriveRequirementInventory — detection quality (#4179 review, defect 3)", () => {
  it.each([
    [
      "a table row",
      ["| ID | Titel | Priorität |", "|---|---|---|", "| FR-2 | Bar | Soll |"],
      "FR-2",
    ],
    ["a single-letter prefix", ["R-12: Export", "Der Export muss CSV liefern."], "R-12"],
    [
      "a multi-segment prefix",
      ["REQ-FUNC-001: Login", "Das System muss Login bieten."],
      "REQ-FUNC-001",
    ],
    ["an underscore", ["REQ_003: Logout", "Das System muss Logout bieten."], "REQ_003"],
    ["a dotted number", ["FR-12.3: Sperre", "Konten müssen gesperrt werden."], "FR-12.3"],
  ])("detects %s", (_name, lines, id) => {
    expect(ids(lines)).toEqual([id]);
  });

  it("reads a table row with its header roles in any listed language", () => {
    const [row] = detect([
      "| Réf | Titre | Description | Priorité |",
      "| EX-4 | Connexion | Le système doit authentifier. | obligatoire |",
    ]).entries;

    expect(row).toMatchObject({
      id: "EX-4",
      unitKind: "table-row",
      title: "Connexion",
      priority: "obligatoire",
      statement: "Le système doit authentifier.",
    });
  });

  describe("a workbook extraction (Sheet!2: Header=cell | ...)", () => {
    it("reads a row as a requirement with its header roles", () => {
      const [row] = detect([
        "Anforderungen!2: ID=FR-4 | Titel=Export | Anforderung=Der Export liefert CSV. | Priorität=Muss",
      ]).entries;

      expect(row).toMatchObject({
        id: "FR-4",
        unitKind: "table-row",
        title: "Export",
        priority: "Muss",
        statement: "Der Export liefert CSV.",
      });
    });

    it("reads the lines of a multi-line cell as separate criteria, whichever cell is last", () => {
      const [last, middle] = [
        detect([
          "Sheet1!2: ID=FR-4 | Titel=Export | Abnahmekriterien=Datei ist UTF-8.",
          "Datei hat eine Kopfzeile.",
          "Sheet1!3: ID=FR-5 | Titel=Import",
        ]).entries[0],
        detect([
          "Sheet1!2: ID=FR-6 | Titel=Export | Abnahmekriterien=Datei ist UTF-8.",
          "Datei hat eine Kopfzeile. | Priorität=Soll",
        ]).entries[0],
      ];

      expect(last?.acceptanceCriteria.map((item) => item.text)).toEqual([
        "Datei ist UTF-8.",
        "Datei hat eine Kopfzeile.",
      ]);
      expect(middle?.acceptanceCriteria.map((item) => item.text)).toEqual([
        "Datei ist UTF-8.",
        "Datei hat eine Kopfzeile.",
      ]);
      expect(middle?.priority).toBe("Soll");
    });

    it("ends a row at the blank line and defines nothing without an identifier in the first cell", () => {
      const inventory = detect([
        "Sheet1!2: ID=FR-4 | Titel=Export",
        "",
        "Eine Zeile, die keine Zelle ist.",
        "Sheet1!3: Titel=Import | ID=FR-5",
        "Seite!3: Notiz ohne Zellen",
      ]);

      expect(inventory.entries.map((entry) => entry.id)).toEqual(["FR-4"]);
      expect(inventory.entries[0]?.acceptanceCriteria).toEqual([]);
    });
  });

  it("reads a priority tag in a heading", () => {
    const [entry] = detect(["## FR-9 Export (MUSS)", "Der Export liefert CSV."]).entries;

    expect(entry).toMatchObject({ id: "FR-9", title: "Export", priority: "MUSS" });
  });

  it.each([
    ["French", "Le système doit chiffrer les données au repos."],
    ["Spanish", "El sistema debe cifrar los datos en reposo."],
    ["Italian", "Il sistema deve cifrare i dati a riposo."],
    ["English", "The system shall encrypt data at rest."],
    ["German", "Das System muss Daten verschlüsseln."],
  ])("recognises a %s obligation without an identifier", (_language, sentence) => {
    const [entry] = detect([sentence]).entries;

    expect(entry?.idOrigin).toBe("derived");
    expect(entry?.statement).toBe(sentence);
  });

  it.each([
    "## HTTP-2 Support",
    "## AES-256",
    "## ISO-27001",
    "## UTF-8",
    "## SHA-256",
    "## TLS-1",
  ])("does not take the technical name %s for a requirement", (heading) => {
    expect(ids([heading, "", "Die Schnittstelle nutzt dieses Verfahren."])).toEqual([]);
  });

  it("takes a heading identifier only with a body or a second identifier of its prefix", () => {
    expect(ids(["## OAUTH-2", ""])).toEqual([]);
    expect(ids(["## FOO-1 Erstes", "", "Text.", "## FOO-2 Zweites", ""])).toEqual([
      "FOO-1",
      "FOO-2",
    ]);
    expect(ids(["## FOO-1 Erstes", "", "Das System muss es tun."])).toEqual(["FOO-1"]);
  });

  it("extends the vocabulary as data", () => {
    const text = ["EXT-1: Export", "Das System muss exportieren."];

    expect(ids(text)).toContain("EXT-1");
    expect(ids(text, { vocabulary: { reservedPrefixes: ["EXT"] } })).not.toContain("EXT-1");
    expect(
      ids(["REQ-1: Wywóz", "Priorytet: wysoki"], { vocabulary: { priorityKeys: ["Priorytet"] } }),
    ).toEqual(["REQ-1"]);
  });

  it("never starts a requirement at a standard designation or criterion number", () => {
    const inventory = detect([
      "ISO-27001 verlangt ein Managementsystem.",
      "SHA-256 wird verwendet.",
      "REQ-001: Login",
      "Abnahmekriterien:",
      "AC-1: Der Login ist möglich.",
      "REQ-002: Logout",
    ]);

    expect(inventory.entries.map((entry) => entry.id)).toEqual(["REQ-001", "REQ-002"]);
    expect(inventory.entries[0]?.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      "Der Login ist möglich.",
    ]);
  });

  it("accepts a bare identifier line only when its prefix names several identifiers", () => {
    expect(ids(["FOO-1 Einzelnes Wort ohne Gegenstück"])).toEqual([]);
    expect(ids(["FOO-1 Erstes", "Text", "", "FOO-2 Zweites", "Text"])).toEqual(["FOO-1", "FOO-2"]);
  });
});

describe("deriveRequirementInventory — definitions (#4179 review, defect 4)", () => {
  const SECTION = [
    "Inhalt",
    "LH-001 Anmeldung 3",
    "LH-002 Status 4",
    "",
    "LH-001: Anmeldung",
    "Das Portal unterstützt die Anmeldung.",
    "Priorität: Muss.",
    "",
    "LH-002: Status",
    "Der Status ist einsehbar.",
    "Priorität: Soll.",
  ];

  it("lets the definition with a body displace the empty table-of-contents entry", () => {
    const inventory = detect(SECTION);

    expect(inventory.entries.map((entry) => entry.id)).toEqual(["LH-001", "LH-002"]);
    expect(inventory.entries[0]).toMatchObject({
      statement: "Das Portal unterstützt die Anmeldung.",
      priority: "Muss",
    });
    expect(inventory.referenceOnlyCount).toBe(2);
    expect(inventory.conflictingIds).toEqual([]);
  });

  it("reports two different bodies of one identifier instead of picking one silently", () => {
    const inventory = detect([
      "REQ-1: Login",
      "Das System muss Login bieten.",
      "",
      "REQ-1: Login erneut",
      "Das System muss etwas anderes tun.",
    ]);

    expect(inventory.entries).toHaveLength(1);
    expect(inventory.conflictingIds).toEqual(["REQ-1"]);
  });
});

describe("deriveRequirementInventory — flat text (#4179 review, defect 5)", () => {
  it("ends a block at the blank line and keeps later statements out of it", () => {
    const text = [
      "REQ-1: Login",
      "",
      "Das System muss Login bieten.",
      "",
      "Priorität: Muss.",
      "",
      "Das System muss außerdem Berichte erzeugen.",
    ];

    const inventory = detect(text);

    const block = inventory.entries.find((entry) => entry.id === "REQ-1");
    expect(block?.statement).toBe("Das System muss Login bieten.");
    expect(block?.priority).toBe("Muss");
    expect(inventory.entries.map((entry) => entry.statement)).toContain(
      "Das System muss außerdem Berichte erzeugen.",
    );
  });

  it("merges a hard-wrapped paragraph into one unit", () => {
    const [entry] = detect(["Das System muss die", "Daten speichern."]).entries;

    expect(entry?.statement).toBe("Das System muss die Daten speichern.");
  });

  it("splits a paragraph into its obligation sentences", () => {
    const statements = detect([
      "Das System muss Daten speichern. Es gibt eine Übersicht. Das System soll Berichte",
      "erzeugen.",
    ]).entries.map((entry) => entry.statement);

    expect(statements).toEqual([
      "Das System muss Daten speichern.",
      "Das System soll Berichte erzeugen.",
    ]);
  });
});

describe("derived identifiers (#4179 review, defect 6)", () => {
  const SENTENCE = "Das System muss Daten speichern.";

  it("differ for the same sentence in different documents", () => {
    const one = deriveRequirementInventory({ text: SENTENCE, documentKey: "doc:a" }).entries[0];
    const two = deriveRequirementInventory({ text: SENTENCE, documentKey: "doc:b" }).entries[0];

    expect(one?.id).toMatch(/^DRV-[A-P]{8}$/u);
    expect(one?.id).not.toBe(two?.id);
    expect(one?.documentScope).not.toBe(two?.documentScope);
  });

  it("do not move when a sentence is inserted before them or the sections are renumbered", () => {
    const base = detect(["Intro.", SENTENCE]).entries.find((entry) => entry.statement === SENTENCE);
    const inserted = detect(["Das System soll Berichte liefern.", "Intro.", SENTENCE], {
      sections: [{ sectionPath: ["7. Neu nummeriert"], characterStart: 0, characterEnd: 200 }],
    }).entries.find((entry) => entry.statement === SENTENCE);

    expect(inserted?.id).toBe(base?.id);
    expect(base?.id).toBe(derivedRequirementId(KEY, SENTENCE));
  });

  it("follow the wording, not the punctuation or case, and tell identical sentences apart", () => {
    expect(derivedRequirementId(KEY, "DAS System muss  Daten speichern")).toBe(
      derivedRequirementId(KEY, SENTENCE),
    );
    expect(derivedRequirementId(KEY, SENTENCE, 1)).not.toBe(derivedRequirementId(KEY, SENTENCE, 0));
    const twice = detect([SENTENCE, "", SENTENCE]).entries.map((entry) => entry.id);
    expect(new Set(twice).size).toBe(2);
  });
});
