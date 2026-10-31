// Deterministic synthetic project corpus for epic #4173 (#4174). Fictional organisation only.
// buildCorpus(version) returns the requirements specification as Markdown plus its ground truth.
const AREAS = [
  ["Anmeldung", ["Kundennummer", "Einmalcode", "Sitzungsende", "Gerätewechsel", "Sperre"]],
  ["Schadenerfassung", ["Schadenart", "Schadenort", "Fotos", "Zeugen", "Entwurf", "Pflichtfelder"]],
  ["Statusverfolgung", ["Statusanzeige", "Benachrichtigung", "Verlauf", "Fristen", "Abschluss"]],
  ["Rückfragen", ["Rückfrage", "Antwort", "Nachreichung", "Erinnerung", "Eskalation"]],
  ["Datenschutz", ["Löschfrist", "Metadaten", "Einwilligung", "Auskunft", "Rechenzentrum"]],
  ["Betrieb", ["Lastverhalten", "Verfügbarkeit", "Protokollierung", "Export", "Wiederanlauf"]],
  ["Barrierefreiheit", ["Tastatur", "Kontrast", "Screenreader", "Sprache", "Schriftgröße"]],
  ["Schnittstellen", ["Bestandssystem", "Zahlungsstatus", "Gutachter", "Postausgang", "Archiv"]],
];
const PRIORITIES = ["Muss", "Muss", "Soll", "Muss", "Kann"];
// Seeded quality defects: vague wording and missing acceptance criteria (S15).
const VAGUE_EVERY = 7;
const NO_ACCEPTANCE_EVERY = 9;
// Version 2 changes (S14): edited, removed and added requirements.
const CHANGED_V2 = new Set(["LH-004", "LH-017", "LH-029"]);
const REMOVED_V2 = new Set(["LH-012"]);
const ADDED_V2 = [
  ["Schadenerfassung", "Sprachnotiz"],
  ["Statusverfolgung", "Kalenderexport"],
];

function requirement(index, area, topic, revised) {
  const id = `LH-${String(index).padStart(3, "0")}`;
  const priority = PRIORITIES[index % PRIORITIES.length];
  const vague = index % VAGUE_EVERY === 0;
  const limit = revised ? 15 : 10;
  const text = vague
    ? `Das Portal unterstützt ${topic} schnell und benutzerfreundlich.`
    : `Das Portal unterstützt ${topic} im Bereich ${area}; die Bearbeitung ist innerhalb von ${limit} Minuten abgeschlossen.`;
  const acceptance =
    index % NO_ACCEPTANCE_EVERY === 0
      ? []
      : [
          `${topic} ist für angemeldete Versicherungsnehmer verfügbar.`,
          `Fehlerhafte Eingaben zu ${topic} werden vor dem Absenden gemeldet.`,
        ];
  return { id, title: `${area}: ${topic}`, area, priority, text, acceptance, vague };
}

function requirementsFor(version) {
  const list = [];
  let index = 0;
  for (const [area, topics] of AREAS) {
    for (const topic of topics) {
      index += 1;
      const id = `LH-${String(index).padStart(3, "0")}`;
      if (version === 2 && REMOVED_V2.has(id)) continue;
      list.push(requirement(index, area, topic, version === 2 && CHANGED_V2.has(id)));
    }
  }
  if (version === 2) {
    for (const [area, topic] of ADDED_V2) list.push(requirement(++index, area, topic, false));
  }
  return list;
}

function markdown(version, requirements) {
  const lines = [
    `# Lastenheft — Kundenportal „Schadenmeldung Online“ (synthetisch)`,
    "",
    `Version ${version}.0 · Auftraggeber: Muster Versicherung AG (fiktiv)`,
    "",
    "## 1. Ausgangslage",
    "",
    "Schadenmeldungen werden heute telefonisch erfasst. Ziel ist ein Online-Portal.",
    "",
  ];
  let chapter = 1;
  for (const [area] of AREAS) {
    const inArea = requirements.filter((item) => item.area === area);
    chapter += 1;
    lines.push(`## ${chapter}. ${area}`, "");
    for (const item of inArea) {
      lines.push(`### ${item.id} ${item.title}`, "", item.text);
      if (item.acceptance.length > 0) {
        lines.push("", "Abnahmekriterien:", ...item.acceptance.map((line) => `- ${line}`));
      }
      lines.push("", `Priorität: ${item.priority}.`, "");
    }
  }
  lines.push(`## ${chapter + 1}. Abgrenzung`, "", "Nicht Bestandteil: Zahlungsabwicklung.", "");
  return lines.join("\n");
}

/** Returns the specification Markdown and its ground truth for version 1 or 2. */
export function buildCorpus(version = 1) {
  const requirements = requirementsFor(version);
  return {
    fileName: `Lastenheft-Schadenmeldung-v${version}.md`,
    markdown: markdown(version, requirements),
    truth: requirements.map(({ id, title, priority, acceptance, vague, area }) => ({
      id,
      title,
      area,
      priority,
      acceptanceCount: acceptance.length,
      vague,
    })),
  };
}

/** Ground truth of the v1 → v2 change (S14). */
export function corpusChange() {
  const before = new Map(buildCorpus(1).truth.map((item) => [item.id, item]));
  const after = new Map(buildCorpus(2).truth.map((item) => [item.id, item]));
  return {
    changed: [...CHANGED_V2].sort(),
    removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
    added: [...after.keys()].filter((id) => !before.has(id)).sort(),
  };
}

/** The structure rules a project lead would define (input for S01 and the compliance oracle). */
export const STRUCTURE_RULES = Object.freeze({
  Epic: {
    summary: "[LH-xxx] <title>",
    sections: ["Ziel", "Fachlicher Kontext", "Abnahmekriterien", "Quelle", "Abgrenzung"],
    labels: ["anforderung"],
  },
  Task: { sections: ["Umsetzungsschritte", "Definition of Done", "Testhinweise"], parent: true },
  Bug: {
    sections: ["Erwartet", "Tatsächlich", "Reproduktionsschritte", "Umgebung"],
    parent: true,
    priority: true,
  },
});
