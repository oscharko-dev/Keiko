// Deterministic generator of the golden Lastenheft "Kundenportal und Zahlungsverkehr".
//
// It writes the specification as Markdown, Word and PDF together with `manifest.json`, the list of
// every requirement the document states (identifier, title, priority, statement, acceptance
// criteria, section path). The manifest is the expectation of the golden test; it is produced here,
// from the same data that produces the document, and never from the inventory under test.
//
//   node scripts/generate-lastenheft-golden.mjs           # (re)write
//   node scripts/generate-lastenheft-golden.mjs --check   # verify
//   node scripts/generate-lastenheft-golden.mjs --out <directory>                                         # elsewhere

import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 as zlibCrc32 } from "node:zlib";

import { GROUPS } from "./lastenheft-golden-features.mjs";

export const DOCUMENT_TITLE = "Lastenheft Kundenportal und Zahlungsverkehr";
export const FILE_BASE = "lastenheft-kundenportal-zahlungsverkehr";

// ─── Deterministic randomness ────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  int(low, high) {
    return low + Math.floor(this.next() * (high - low + 1));
  }
  pick(list) {
    return list[this.int(0, list.length - 1)];
  }
  chance(probability) {
    return this.next() < probability;
  }
  /** `count` distinct entries of `list`, in a deterministic order. */
  sample(list, count) {
    const pool = [...list];
    const out = [];
    while (out.length < count && pool.length > 0)
      out.push(pool.splice(this.int(0, pool.length - 1), 1)[0]);
    return out;
  }
}

// ─── Vocabulary of the generated text ────────────────────────────────────────────────────────

const PRIORITIES = ["Muss", "Soll", "Kann"];
const ENGLISH_PRIORITY = { Muss: "Must", Soll: "Should", Kann: "Could" };
const MODAL = { Muss: "muss", Soll: "soll", Kann: "kann" };
const CRITERIA_COUNTS = [0, 1, 2, 2, 3, 3, 3, 4, 4, 5, 6];

const SOURCES = [
  "Fachkonzept Zahlungsverkehr, Kapitel 4",
  "Fachkonzept Kundenportal, Kapitel 2",
  "Regulatorik-Katalog 2026, Abschnitt 7",
  "Workshop Fachbereich vom 14.03.2026",
  "Betriebskonzept, Kapitel 5",
  "Sicherheitskonzept, Kapitel 3",
];
const NOTES = [
  "Die fachliche Abstimmung mit der Rechtsabteilung ist noch ausstehend.",
  "Die Umsetzung erfolgt in der zweiten Ausbaustufe des Portals.",
  "Der Fachbereich bewertet die Anforderung als wettbewerbsrelevant.",
  "Für Firmenkunden gelten abweichende Rahmenwerte, die im Vertrag geregelt sind.",
  "Die technische Machbarkeit wurde im Architekturboard bestätigt.",
];
const STATUSES = ["Freigegeben", "In Abstimmung", "Zur Prüfung"];

function details(random, ref) {
  const n = random.int(2, 9);
  return [
    `Die Verarbeitung ist für den Kunden spätestens nach ${String(n)} Sekunden abgeschlossen.`,
    "Fehlerhafte Eingaben werden dem Nutzer verständlich und ohne technische Fehlercodes angezeigt.",
    "Jede Änderung wird mit Zeitstempel, Benutzerkennung und Kanal im Prüfprotokoll festgehalten.",
    "Die Funktion steht in der mobilen App und im Browser mit gleichem Funktionsumfang zur Verfügung.",
    `Die Regelung gilt in Verbindung mit ${ref()}.`,
    `Die Abgrenzung zu den Vorgaben des Kernbanksystems ist in ${ref()} beschrieben.`,
    `Für Sonderfälle wie Vollmachten oder Gemeinschaftskonten gilt ergänzend (siehe ${ref()}).`,
    "Beträge werden in Euro mit zwei Nachkommastellen geführt; Fremdwährungen sind gesondert ausgewiesen.",
    "Alle Texte stehen in Deutsch und Englisch zur Verfügung und stammen aus der zentralen Textverwaltung.",
    "Die Angaben stammen aus dem Kernbanksystem und werden nicht lokal dupliziert.",
  ];
}

function criteriaPool(random, title, ref) {
  const sec = random.int(1, 4);
  const users = random.pick([50, 200, 500, 1000]);
  const rate = random.pick(["0,1", "0,5", "1"]);
  const major = random.int(1, 4);
  const minor = random.int(0, 9);
  const test = random.int(100, 899);
  return [
    `Die Funktion „${title}“ ist nach erfolgreicher Anmeldung innerhalb von ${String(sec)} Sekunden erreichbar.`,
    "Bei ungültiger Eingabe erscheint eine Fehlermeldung mit Korrekturhinweis, und der Vorgang wird nicht ausgeführt.",
    "Der Vorgang wird im Prüfprotokoll mit Zeitstempel, Benutzerkennung und Ergebnis erfasst.",
    `Ein Test mit ${String(users)} gleichzeitigen Nutzern ergibt eine Fehlerrate von höchstens ${rate} Prozent.`,
    `Die Darstellung entspricht dem freigegebenen Entwurf in Version ${String(major)}.${String(minor)}.`,
    `Die Fachabteilung bestätigt die Funktion im Abnahmetest TC-${String(test)}.`,
    "Gegeben ein angemeldeter Kunde, wenn er den Vorgang abbricht, dann bleiben seine bisherigen Daten unverändert.",
    "Gegeben ein Kunde ohne Berechtigung, wenn er die Funktion aufruft, dann wird der Zugriff abgelehnt und protokolliert.",
    "Die Funktion ist mit einem Screenreader ohne fremde Hilfe bedienbar.",
    "Für den Betrag 1.234,56 € und das Datum 31.12.2026 gelten die Formate der gewählten Sprache.",
    "Die Anforderung ist in der Testumgebung mit synthetischen Daten nachgewiesen.",
    "Der Vorgang lässt sich bei Ausfall der Verbindung ohne doppelte Ausführung wiederholen.",
    `Die Abnahme berücksichtigt die Wechselwirkung mit ${ref()}.`,
    "Die Bedienung funktioniert in Chrome, Firefox, Safari und Edge in der jeweils aktuellen Version.",
  ];
}

const CASES = [
  "einem Kunden mit Einzelverfügung",
  "einem Auftrag über Gemeinschaftskonten",
  "einer Verfügung durch Bevollmächtigte",
  "einem Auftrag außerhalb der Annahmezeit",
  "einer abgelehnten Prüfung",
  "einem Auftrag mit Terminvorgabe",
  "einer Wiederholung nach Zeitüberschreitung",
  "einem Auftrag eines Firmenkunden",
  "einem Auftrag in Fremdwährung",
  "einer Rückfrage der Sachbearbeitung",
];
const ACTIONS = [
  "der Vorgang zur Sachbearbeitung geleitet",
  "der Kunde mit einem verständlichen Hinweis informiert",
  "die Bearbeitung nach festgelegter Frist erneut versucht",
  "der Vorgang mit dem Status „in Klärung“ gekennzeichnet",
  "die Entscheidung durch einen zweiten Berechtigten bestätigt",
  "der Vorgang ohne weitere Eingabe abgeschlossen",
];

/** A statement of about `target` characters made of numbered rules; ends at a sentence. */
function longStatement(random, lead, target) {
  let text = lead;
  let rule = 1;
  while (text.length < target) {
    const version = `${String(random.int(1, 6))}.${String(random.int(0, 9))}`;
    text += ` Regel ${String(rule)}: Bei ${CASES[(rule - 1) % CASES.length]} wird ${ACTIONS[(rule * 3) % ACTIONS.length]} und das Ergebnis mit der Regelversion ${version} im Prüfprotokoll festgehalten.`;
    rule += 1;
  }
  return text;
}

const LONG_TARGETS = new Map([
  ["Erfassung einer SEPA-Überweisung", 1700],
  ["Auslandsüberweisung außerhalb SEPA", 2600],
  ["Import von Zahlungsdateien", 3300],
  ["Antrag auf Ratenkredit", 3900],
  ["Schadenmeldung erfassen", 4700],
]);
const WRAPPED_LONG = new Set(["Auslandsüberweisung außerhalb SEPA", "Antrag auf Ratenkredit"]);

// ─── Requirements ────────────────────────────────────────────────────────────────────────────

function allocate() {
  const counters = new Map();
  const requirements = [];
  for (const [groupIndex, group] of GROUPS.entries()) {
    for (const [title, predicate] of group.features) {
      const next = (counters.get(group.prefix) ?? 0) + 1;
      counters.set(group.prefix, next);
      const id = group.dotted
        ? `${group.prefix}-${String(groupIndex + 1)}.${String(next)}`
        : `${group.prefix}-${String(next).padStart(3, "0")}`;
      requirements.push({ id, title, predicate, group, groupIndex });
    }
  }
  return requirements;
}

// eslint-disable-next-line complexity -- one requirement is drawn from the seeded stream in a fixed order; splitting would reorder the stream
function buildRequirement(item, ids, random) {
  const { group, title } = item;
  const priority = random.pick([...PRIORITIES, ...PRIORITIES, "Muss", "Muss", "Soll"]);
  const shown = group.priorityValues === undefined ? priority : ENGLISH_PRIORITY[priority];
  const ref = () => random.pick(ids.filter((other) => other !== item.id));
  const first = `${group.subject} ${MODAL[priority]} ${item.predicate}.`;
  const longTarget = LONG_TARGETS.get(title);
  let paragraphs;
  if (longTarget !== undefined) paragraphs = [longStatement(random, first, longTarget)];
  else {
    const extra = group.style === "table" ? 1 : random.int(0, 2);
    const sentences = random.sample(details(random, ref), extra);
    paragraphs = [[first, ...sentences].join(" ")];
    if (group.style !== "table" && random.chance(0.18))
      paragraphs.push(random.sample(details(random, ref), 1)[0]);
  }
  const criteria =
    group.style === "table"
      ? []
      : random.sample(criteriaPool(random, title, ref), random.pick(CRITERIA_COUNTS));
  const meta = {};
  if (group.style === "heading" || group.style === "plain") {
    if (random.chance(0.22)) meta.note = random.pick(NOTES);
    if (random.chance(0.25)) meta.source = random.pick(SOURCES);
    if (random.chance(0.12)) meta.status = random.pick(STATUSES);
    if (random.chance(0.15)) meta.dependency = [ref(), ref()].sort().join(", ");
    if (random.chance(0.08)) meta.jira = `KRED-${String(random.int(20, 400))}`;
  }
  return {
    id: item.id,
    title,
    priority: shown,
    paragraphs,
    statement: paragraphs.join(" "),
    criteria,
    meta,
    group,
    criteriaOrderFirst: random.chance(0.2),
    numbered: item.groupIndex % 2 === 1,
    wrap: group.style !== "table" && (WRAPPED_LONG.has(title) || random.chance(0.22)),
  };
}

// ─── Document model ──────────────────────────────────────────────────────────────────────────

const h = (level, text) => ({ t: "h", level, text });
const p = (text, wrap = false) => ({ t: "p", text, wrap });
const table = (header, rows, records) => ({ t: "table", header, rows, records });
const bullets = (items) => ({ t: "list", ordered: false, items, lead: undefined });
const lines = (rows) => ({ t: "lines", rows });

// eslint-disable-next-line complexity -- the optional parts of one requirement are laid out in document order
function requirementBlocks(requirement) {
  const { group } = requirement;
  const blocks = [];
  const criteriaKey =
    group.priorityKey === "Priority" ? "Acceptance criteria:" : "Abnahmekriterien:";
  const priorityLine = `${group.priorityKey ?? "Priorität"}: ${requirement.priority}`;
  if (group.style === "bracket") {
    blocks.push(h(6, `[${requirement.id}] ${requirement.title} [${requirement.priority}]`));
  } else if (group.style === "heading") {
    blocks.push(h(6, `${requirement.id} ${requirement.title}`));
  } else {
    blocks.push(p(`${requirement.id}: ${requirement.title}`));
  }
  for (const [index, text] of requirement.paragraphs.entries())
    blocks.push(p(text, requirement.wrap && index === 0));
  const keyLines = [];
  if (requirement.meta.note !== undefined) keyLines.push(`Hinweis: ${requirement.meta.note}`);
  if (group.style !== "bracket") keyLines.push(priorityLine);
  if (requirement.meta.source !== undefined) keyLines.push(`Quelle: ${requirement.meta.source}`);
  if (requirement.meta.status !== undefined) keyLines.push(`Status: ${requirement.meta.status}`);
  if (requirement.meta.dependency !== undefined)
    keyLines.push(`Abhängigkeiten: ${requirement.meta.dependency}`);
  if (requirement.meta.jira !== undefined) keyLines.push(`Jira: ${requirement.meta.jira}`);
  const criteria = {
    t: "list",
    ordered: requirement.numbered,
    items: requirement.criteria,
    lead: criteriaKey,
  };
  const hasCriteria = requirement.criteria.length > 0;
  if (requirement.criteriaOrderFirst && hasCriteria) blocks.push(criteria);
  if (keyLines.length > 0) blocks.push(lines(keyLines));
  if (!requirement.criteriaOrderFirst && hasCriteria) blocks.push(criteria);
  return blocks.map((block) => ({ ...block, req: requirement.id }));
}

function tableBlocks(requirements) {
  const german = requirements[0].group.priorityValues === undefined;
  return [
    table(
      ["ID", "Titel", "Anforderung", german ? "Priorität" : "Priority"],
      requirements.map((r) => [r.id, r.title, r.statement, r.priority]),
      // A PDF has no table cells to project: its typesetting repeats each row as a record.
      requirements.map((r) => ({
        id: r.id,
        head: `${r.id} ${r.title}`,
        statement: r.statement,
        priority: `${german ? "Priorität" : "Priority"}: ${r.priority}`,
      })),
    ),
  ];
}

const GLOSSARY = [
  ["SEPA", "Single Euro Payments Area, der einheitliche Euro-Zahlungsverkehrsraum"],
  ["IBAN", "International Bank Account Number, die internationale Kontonummer"],
  ["PSD2", "Zweite Zahlungsdiensterichtlinie der Europäischen Union"],
  ["SCA", "Starke Kundenauthentifizierung mit mindestens zwei unabhängigen Faktoren"],
  [
    "TIPS",
    "TARGET Instant Payment Settlement, der europäische Abwicklungsdienst für Echtzeitzahlungen",
  ],
  ["Kernbanksystem", "Führendes System für Konten, Buchungen und Salden der Bank"],
  ["Bevollmächtigter", "Person, die im Namen eines Kunden über Konten verfügen darf"],
  ["Mandant", "Organisationseinheit mit eigenem Datenbestand und eigenen Rollen"],
  [
    "Prüfprotokoll",
    "Revisionssichere Aufzeichnung fachlicher und sicherheitsrelevanter Ereignisse",
  ],
  ["Wertstellung", "Datum, ab dem eine Buchung für die Zinsberechnung gilt"],
  ["Echtzeitüberweisung", "Überweisung, die innerhalb von zehn Sekunden gutgeschrieben wird"],
  ["Auftraggeber", "Kunde, der einen Zahlungsauftrag erteilt"],
];
const ERROR_CODES = [
  ["ERR-4001", "Ungültige IBAN"],
  ["ERR-4002", "Betrag außerhalb des zulässigen Bereichs"],
  ["ERR-4003", "Verwendungszweck zu lang"],
  ["ERR-4010", "Empfängerüberprüfung nicht möglich"],
  ["ERR-4031", "Limit überschritten"],
  ["ERR-4032", "Konto gesperrt"],
  ["ERR-4091", "Doppelte Auftrags-ID"],
  ["ERR-5001", "Kernbanksystem nicht erreichbar"],
  ["ERR-5002", "Zeitüberschreitung beim Clearing"],
  ["ERR-5030", "Dienst vorübergehend nicht verfügbar"],
];
const STANDARDS = [
  "ISO/IEC 27001:2022 Informationssicherheits-Managementsysteme",
  "ISO-20022 Nachrichtenstandard für den Zahlungsverkehr",
  "DIN EN ISO 9241-210 Prozess zur Gestaltung gebrauchstauglicher interaktiver Systeme",
  "PCI-DSS-4.0 Datensicherheitsstandard der Zahlungskartenbranche",
  "RFC 7519 JSON Web Token",
  "TLS-1.3 nach RFC 8446",
  "SHA-256 nach FIPS 180-4",
  "WCAG 2.1 Web Content Accessibility Guidelines",
];

// eslint-disable-next-line max-lines-per-function -- the introduction is the literal document content, held as data
function frontMatter(overview, core) {
  return [
    h(1, DOCUMENT_TITLE),
    table(
      ["Eigenschaft", "Wert"],
      [
        ["Dokumentkennung", "LH-KPZ-2026"],
        ["Version", "1.4"],
        ["Stand", "07.11.2026"],
        ["Auftraggeber", "Fachbereich Digitale Kanäle"],
        ["Klassifizierung", "Intern"],
      ],
    ),
    h(2, "1 Einleitung und Zielsetzung"),
    p(
      "Dieses Dokument beschreibt die fachlichen und technischen Anforderungen der Bank an ein neues Kundenportal mit integriertem Zahlungsverkehr.",
    ),
    h(3, "1.1 Ausgangslage"),
    h(4, "1.1.1 Fachlicher Hintergrund"),
    h(5, "1.1.1.1 Ist-Situation"),
    p(
      "Kunden erledigen Zahlungen heute in zwei getrennten Anwendungen. Das Portal wird von rund 1,2 Millionen Privat- und 85.000 Firmenkunden genutzt. Schadenmeldungen werden bislang telefonisch aufgenommen und manuell erfasst.",
    ),
    p("ZVS-2000 wird bis Ende 2027 durch die neue Plattform abgelöst."),
    p(
      "Das Vorhaben wird im Jira-Projekt KRED geführt; der übergeordnete Epic trägt die Kennung KRED-29.",
    ),
    h(5, "1.1.1.2 Zielbild"),
    p(
      `Die neue Plattform bündelt Konten, Zahlungen, Karten, Kredite und Versicherungen in einem Kanal. Die Zahlungsfunktionen (${core.first} bis ${core.last}) bilden den Kern, die Anforderungen an Sicherheit (NFA-SEC-001 und folgende) gelten für alle Funktionen.`,
    ),
    h(3, "1.2 Zweck und Geltungsbereich"),
    h(4, "1.2.1 Zweck des Dokuments"),
    h(5, "1.2.1.1 Aufbau der Anforderungen"),
    p(
      "Jede Anforderung trägt eine eindeutige Kennung, etwa REQ-FA-001, einen Titel, eine Priorität und gegebenenfalls Abnahmekriterien. Die Kennungen sind über die Lebensdauer des Dokuments stabil.",
    ),
    table(
      ["Präfix", "Bereich"],
      [
        ["REQ-FA", "Funktionale Anforderungen"],
        ["NFA-PERF, NFA-AVL, NFA-OPS", "Leistung, Verfügbarkeit und Betrieb"],
        ["NFA-SEC, NFA-DSG, NFA-REG", "Sicherheit, Datenschutz und Regulatorik"],
        ["NFA-UX", "Bedienbarkeit und Barrierefreiheit"],
        ["SCH-IF", "Schnittstellen"],
        ["MIG_DAT, MIG_ROL, ABN, BET-SLA", "Migration, Abnahme und Betrieb"],
      ],
    ),
    h(5, "1.2.1.2 Prioritäten"),
    p(
      "Die Priorität einer Anforderung ist Muss, Soll oder Kann. In der Schnittstellenspezifikation werden die englischen Begriffe Must, Should und Could verwendet.",
    ),
    h(3, "1.3 Begriffe und Referenzen"),
    h(4, "1.3.1 Glossar"),
    h(5, "1.3.1.1 Fachbegriffe"),
    table(["Begriff", "Bedeutung"], GLOSSARY),
    h(4, "1.3.2 Normen und Referenzen"),
    h(5, "1.3.2.1 Normative Referenzen"),
    bullets(STANDARDS),
    h(3, "1.4 Rahmenbedingungen"),
    h(4, "1.4.1 Organisation und Projekt"),
    h(5, "1.4.1.1 Beteiligte"),
    table(
      ["Rolle", "Name", "Verantwortung"],
      [
        ["Product Owner", "Fachbereich Digitale Kanäle", "Priorisierung und fachliche Abnahme"],
        ["Architektur", "IT-Architektur", "Technische Konzeption"],
        ["Datenschutz", "Datenschutzbeauftragter", "Datenschutzrechtliche Bewertung"],
        ["Betrieb", "IT-Betrieb", "Betrieb und Überwachung"],
      ],
    ),
    h(5, "1.4.1.2 Zeitplan"),
    p(
      "Der Pilotbetrieb beginnt im ersten Quartal 2027, die Umstellung aller Kunden ist bis zum dritten Quartal 2027 vorgesehen.",
    ),
    h(3, "1.5 Überblick der wichtigsten Anforderungen"),
    h(4, "1.5.1 Kernfunktionen"),
    h(5, "1.5.1.1 Anforderungen mit höchster Priorität im Überblick"),
    p(
      "Die folgende Übersicht nennt die Kernanforderungen vorab. Ihre ausführliche Beschreibung steht in den Kapiteln 3 bis 6.",
    ),
    table(["ID", "Titel", "Priorität"], overview),
    h(2, "2 Gesamtsystem"),
    p("Das Kapitel ordnet das Portal in die Systemlandschaft der Bank ein."),
    h(3, "2.1 Systemkontext"),
    h(4, "2.1.1 Beteiligte Systeme"),
    h(5, "2.1.1.1 Innere und äußere Systeme"),
    p(
      "Das Portal greift auf das Kernbanksystem, das Archivsystem und die Zahlungsverkehrsnetze zu. Externe Dienstleister liefern Auskünfte, Identitätsprüfung und Versand.",
    ),
    table(
      ["Komponente", "Beschreibung"],
      [
        ["Kundenportal", "Web-Anwendung und mobile App für Privat- und Firmenkunden"],
        ["Zahlungsverkehrssystem", "Annahme, Prüfung und Weiterleitung von Zahlungsaufträgen"],
        ["Versicherungsmodul", "Verträge, Policen und Schadenmeldungen"],
        ["Kernbanksystem", "Führendes System für Konten und Buchungen"],
      ],
    ),
    h(4, "2.1.2 Nutzergruppen"),
    h(5, "2.1.2.1 Rollen im Portal"),
    bullets([
      "Privatkunden mit einem oder mehreren Konten",
      "Firmenkunden mit Zeichnungsberechtigten",
      "Bevollmächtigte und Betreuer",
      "Mitarbeiter der Kundenbetreuung mit eingeschränkter Sicht",
    ]),
  ];
}

function appendix(traceRows) {
  return [
    h(2, "7 Anhang"),
    h(3, "7.1 Fehlercodes"),
    h(4, "7.1.1 Fehlercodes der Schnittstellen"),
    h(5, "7.1.1.1 Tabelle der Fehlercodes"),
    table(["Code", "Bedeutung"], ERROR_CODES),
    h(3, "7.2 Rückverfolgbarkeit"),
    h(4, "7.2.1 Zuordnung zu Abnahmetests"),
    h(5, "7.2.1.1 Testfallzuordnung"),
    table(["Anforderungs-ID", "Testfall", "Status"], traceRows),
    h(3, "7.3 Änderungshistorie"),
    h(4, "7.3.1 Versionen"),
    h(5, "7.3.1.1 Verlauf"),
    table(
      ["Version", "Datum", "Autor", "Änderung"],
      [
        ["1.0", "12.01.2026", "Fachbereich", "Erste Fassung"],
        ["1.2", "03.05.2026", "Fachbereich", "Ergänzung Zahlungsverkehr"],
        ["1.4", "07.11.2026", "Fachbereich", "Ergänzung Schnittstellen und Migration"],
      ],
    ),
  ];
}

// ─── Assembly ────────────────────────────────────────────────────────────────────────────────

function pdfLayoutOf(span) {
  return {
    firstPage: Math.floor(span.first / PDF_LINES_PER_PAGE) + 1,
    lastPage: Math.floor(span.last / PDF_LINES_PER_PAGE) + 1,
    wrapsOntoIdentifier: span.lines.slice(1).some((line) => IDENTIFIER_AT_START.test(line)),
  };
}

// eslint-disable-next-line max-lines-per-function -- assembles the document and its manifest in one pass over the same data
export function buildSpecification() {
  const random = new Random(20261107);
  const allocated = allocate();
  const ids = allocated.map((item) => item.id);
  const requirements = allocated.map((item) => buildRequirement(item, ids, random));

  const overview = requirements
    .filter((r) => r.priority === "Muss" && r.group.prefix === "REQ-FA")
    .filter((_, index) => index % 9 === 0)
    .map((r) => [r.id, r.title, r.priority]);
  const traceRows = requirements
    .filter((_, index) => index % 14 === 0)
    .map((r, index) => [
      r.id,
      `TC-${String(100 + index)}`,
      index % 3 === 0 ? "Bestanden" : "Geplant",
    ]);

  const sepa = requirements.filter((r) => r.group.path[3].includes("SEPA-Überweisung"));
  const blocks = frontMatter(overview, { first: sepa[0].id, last: sepa.at(-1).id });
  let lastPath = [];
  const chapterBlocks = [];
  let tableRun = [];
  const flushTable = () => {
    if (tableRun.length > 0) chapterBlocks.push(...tableBlocks(tableRun));
    tableRun = [];
  };
  for (const requirement of requirements) {
    const path = requirement.group.path;
    if (path.join("|") !== lastPath.join("|")) {
      flushTable();
      for (const [level, label] of path.entries()) {
        if (
          lastPath[level] !== label ||
          path.slice(0, level).join("|") !== lastPath.slice(0, level).join("|")
        )
          chapterBlocks.push(h(level + 2, label));
      }
      lastPath = path;
    }
    if (requirement.group.style === "table") tableRun.push(requirement);
    else chapterBlocks.push(...requirementBlocks(requirement));
  }
  flushTable();
  blocks.push(...chapterBlocks, ...appendix(traceRows));

  const flat = renderFlatLines(blocks);
  const manifest = {
    document: DOCUMENT_TITLE,
    requirementCount: requirements.length,
    statementClipChars: 4000,
    requirements: requirements.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      statement: r.statement,
      acceptanceCriteria: r.criteria,
      sectionPath: r.group.path,
      presentation: r.group.style,
      layout: {
        paragraphCount: r.paragraphs.length,
        hardWrapped: r.wrap,
        criteriaBeforePriority: r.criteriaOrderFirst && r.criteria.length > 0,
        numberedCriteria: r.numbered,
        metaLines: Object.keys(r.meta),
        markdownWrapsOntoIdentifier: r.wrap && wrapsOntoIdentifier(r.paragraphs[0], MARKDOWN_WRAP),
        pdf: pdfLayoutOf(flat.spans.get(r.id)),
      },
    })),
    /** Identifiers a traceability matrix lists; they are definitions elsewhere, never here. */
    traceabilityIds: traceRows.map(([id]) => id),
    negativeControls: {
      /** Prose that explains the priority words with the words themselves (a legend). */
      priorityLegend: [
        "Die Priorität einer Anforderung ist Muss, Soll oder Kann.",
        "In der Schnittstellenspezifikation werden die englischen Begriffe Must, Should und Could verwendet.",
      ],
      /** Tokens that look like identifiers but are not requirements; none may become an entry. */
      identifierLikeTokens: [
        "LH-KPZ-2026",
        "ZVS-2000",
        "KRED-29",
        ...ERROR_CODES.map(([code]) => code),
        "ISO-20022",
        "TLS-1.3",
        "PCI-DSS-4.0",
      ],
      /** Rows of tables and prose sentences that state facts, never an obligation. */
      sentences: [
        "Dieses Dokument beschreibt die fachlichen und technischen Anforderungen",
        "Das Portal wird von rund 1,2 Millionen Privat- und 85.000 Firmenkunden genutzt.",
        "Schadenmeldungen werden bislang telefonisch aufgenommen und manuell erfasst.",
        "Der Pilotbetrieb beginnt im ersten Quartal 2027",
        "Das Portal greift auf das Kernbanksystem, das Archivsystem und die Zahlungsverkehrsnetze zu.",
      ],
    },
  };
  return { blocks, manifest, requirements };
}

// ─── Renderers ───────────────────────────────────────────────────────────────────────────────

function wrapWords(text, width) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line.length === 0 ? word : `${line} ${word}`;
  }
  if (line.length > 0) out.push(line);
  return out;
}

const cell = (value) => value.replaceAll("|", "\\|");

export function renderMarkdown(blocks) {
  const out = [];
  for (const block of blocks) {
    switch (block.t) {
      case "h":
        out.push(`${"#".repeat(block.level)} ${block.text}`);
        break;
      case "p":
        out.push(block.wrap ? wrapWords(block.text, MARKDOWN_WRAP).join("\n") : block.text);
        break;
      case "lines":
        out.push(block.rows.join("\n"));
        break;
      case "list": {
        const items = block.items.map((item, index) =>
          block.ordered ? `${String(index + 1)}. ${item}` : `- ${item}`,
        );
        out.push([...(block.lead === undefined ? [] : [block.lead]), ...items].join("\n"));
        break;
      }
      default:
        out.push(
          [
            `| ${block.header.map(cell).join(" | ")} |`,
            `| ${block.header.map(() => "---").join(" | ")} |`,
            ...block.rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
          ].join("\n"),
        );
    }
  }
  return `${out.join("\n\n")}\n`;
}

const xml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function docxParagraph(text, style) {
  const props = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function docxTable(header, rows) {
  const row = (cells, isHeader) =>
    `<w:tr>${isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells
      .map((value) => `<w:tc>${docxParagraph(value)}</w:tc>`)
      .join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${row(header, true)}${rows
    .map((cells) => row(cells, false))
    .join("")}</w:tbl>`;
}

export function renderDocumentXml(blocks) {
  const parts = [];
  for (const block of blocks) {
    switch (block.t) {
      case "h":
        parts.push(docxParagraph(block.text, `Heading${String(block.level)}`));
        break;
      case "p":
        parts.push(docxParagraph(block.text));
        break;
      case "lines":
        for (const row of block.rows) parts.push(docxParagraph(row));
        break;
      case "list":
        if (block.lead !== undefined) parts.push(docxParagraph(block.lead));
        for (const [index, item] of block.items.entries())
          parts.push(docxParagraph(block.ordered ? `${String(index + 1)}. ${item}` : `- ${item}`));
        break;
      default:
        parts.push(docxTable(block.header, block.rows));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join("")}</w:body></w:document>`;
}

function crc32(buffer) {
  return typeof zlibCrc32 === "function" ? zlibCrc32(buffer) >>> 0 : slowCrc32(buffer);
}
function slowCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) entries with a fixed timestamp: the bytes are reproducible on every platform. */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.content, "utf8");
    const packed = raw;
    const checksum = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0x6000, 10);
    head.writeUInt16LE(0x5c27, 12);
    head.writeUInt32LE(checksum, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0x6000, 12);
    dir.writeUInt16LE(0x5c27, 14);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(head, name, packed);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export function renderDocx(blocks) {
  return zip([
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: "word/document.xml", content: renderDocumentXml(blocks) },
  ]);
}

const IDENTIFIER_AT_START = /^[A-Z][A-Z0-9]*(?:[-_][A-Z][A-Z0-9]*)*[-_]\d/u;
const MARKDOWN_WRAP = 88;
const PDF_WRAP = 92;

/** Whether a hard-wrapped paragraph carries an identifier at the start of a continuation line. */
function wrapsOntoIdentifier(text, width) {
  return wrapWords(text, width).some((line, index) => index > 0 && IDENTIFIER_AT_START.test(line));
}

/**
 * The flat text a PDF carries (no recorded headings, no table cells) and, per requirement, the
 * lines it occupies, so the page break positions of the typeset PDF are known.
 */
// eslint-disable-next-line complexity -- one switch over the block kinds of the document model
export function renderFlatLines(blocks) {
  const out = [];
  const spans = new Map();
  const note = (id, from) => {
    let start = from;
    while (out[start] === "") start += 1;
    const span = spans.get(id) ?? { first: start, last: start, lines: [] };
    span.last = out.length - 1;
    span.lines.push(...out.slice(start));
    spans.set(id, span);
  };
  for (const block of blocks) {
    const from = out.length;
    switch (block.t) {
      case "h":
        out.push("", block.text);
        break;
      case "p":
        out.push(...wrapWords(block.text, PDF_WRAP));
        break;
      case "lines":
        out.push(...block.rows);
        break;
      case "list":
        if (block.lead !== undefined) out.push(block.lead);
        for (const [index, item] of block.items.entries())
          out.push(
            ...wrapWords(block.ordered ? `${String(index + 1)}. ${item}` : `- ${item}`, PDF_WRAP),
          );
        break;
      default:
        if (block.records !== undefined) {
          for (const record of block.records) {
            const start = out.length;
            out.push(record.head, ...wrapWords(record.statement, PDF_WRAP), record.priority);
            note(record.id, start);
            out.push("");
          }
          continue;
        }
        out.push(block.header.join("  "));
        for (const row of block.rows) out.push(...wrapWords(row.join("  "), PDF_WRAP));
    }
    if (block.req !== undefined) note(block.req, from);
  }
  return { lines: out, spans };
}

const CP1252 = new Map([
  [0x20ac, 0x80],
  [0x201e, 0x84],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2013, 0x96],
]);

function pdfString(text) {
  let out = "";
  for (const char of text) {
    const code = CP1252.get(char.codePointAt(0) ?? 0x3f) ?? char.codePointAt(0) ?? 0x3f;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `(${out})`;
}

const PDF_LINES_PER_PAGE = 54;
const PDF_LINE_HEIGHT = 14;

/** A multi-page text-layer PDF, one positioned line each. */
export function renderPdf(lines) {
  const pages = [];
  for (let at = 0; at < lines.length; at += PDF_LINES_PER_PAGE)
    pages.push(lines.slice(at, at + PDF_LINES_PER_PAGE));
  const height = (PDF_LINES_PER_PAGE + 4) * PDF_LINE_HEIGHT;
  const kids = pages.map((_, index) => `${String(4 + index * 2)} 0 R`).join(" ");
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  for (const [index, page] of pages.entries()) {
    const operators = page.map(
      (line, row) =>
        `1 0 0 1 40 ${String(height - (row + 2) * PDF_LINE_HEIGHT)} Tm ${pdfString(line)} Tj`,
    );
    const stream = `BT\n/F1 10 Tf\n${operators.join("\n")}\nET`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${String(height)}] /Contents ${String(5 + index * 2)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let document = "%PDF-1.4\n";
  const offsets = bodies.map((body, index) => {
    const offset = document.length;
    document += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  document += `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${String(bodies.length + 1)} /Root 1 0 R >>\nstartxref\n${String(document.length)}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

export function buildArtifacts() {
  const { blocks, manifest } = buildSpecification();
  const flat = renderFlatLines(blocks);
  return {
    [`${FILE_BASE}.md`]: Buffer.from(renderMarkdown(blocks), "utf8"),
    [`${FILE_BASE}.docx`]: renderDocx(blocks),
    [`${FILE_BASE}.pdf`]: renderPdf(flat.lines),
    "manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  };
}

function main(argv) {
  const here = join(
    dirname(fileURLToPath(import.meta.url)),
    "../tests/fixtures/requirements/lastenheft-kundenportal",
  );
  const outIndex = argv.indexOf("--out");
  const directory = outIndex >= 0 ? (argv[outIndex + 1] ?? here) : here;
  const artifacts = buildArtifacts();
  if (argv.includes("--check")) {
    const stale = Object.entries(artifacts).filter(([name, bytes]) => {
      try {
        return !readFileSync(join(directory, name)).equals(bytes);
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      process.stderr.write(`stale: ${stale.map(([name]) => name).join(", ")}\n`);
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(artifacts))
    writeFileSync(join(directory, name), bytes);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
