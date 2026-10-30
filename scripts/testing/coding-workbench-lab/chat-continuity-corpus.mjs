// Synthetic, predeclared conversation facts. Oracles never accompany the recall question.
import { createHash } from "node:crypto";

export const CONTINUITY_CORPUS_VERSION = "chat-continuity-v1";
export const INITIAL_CONTEXT = [
  "Wir bearbeiten das Projekt Kestrel. Zuständig ist Mira Seidel.",
  "Die kurze Vorgangskennung lautet Q7-42. Das ursprüngliche Budget beträgt 7300 EUR.",
  "Unser erster vereinbarter Termin ist der 18. März 2027.",
  "Wir entscheiden uns für eine lokale Warteschlange. Eine externe Volltextablage verwerfen wir.",
  "Der nächste noch offene Arbeitsschritt ist die Integrationsprobe.",
  "Eine wichtige Einschränkung: Die Rohdaten dürfen das Gerät nicht verlassen.",
  "Bitte behalte diese Arbeitsvereinbarungen für die weitere Unterhaltung bei.",
  "Antworte jetzt ausschließlich mit OK.",
].join("\n");
export const CORRECTION_CONTEXT = [
  "Korrektur zu unserem Projekt: Das Budget beträgt ab jetzt 8100 EUR.",
  "Der vereinbarte Termin verschiebt sich auf den 9. April 2027.",
  "Diese beiden Angaben ersetzen die früheren Werte. Alles andere bleibt bestehen.",
  "Antworte ausschließlich mit OK.",
].join("\n");
export const RECALL_QUESTION = [
  "Erinnere dich an unsere bisherigen Arbeitsvereinbarungen, auch an spätere Korrekturen.",
  "Gib nur ein JSON-Objekt mit diesen Schlüsseln aus:",
  "projekt, verantwortlich, kennung, budget, termin, ersteEntscheidung, verworfeneAlternative,",
  "offenerSchritt, einschraenkung. Verwende null, falls du die Angabe nicht mehr weißt.",
  "Erfinde keine Angaben. Gib keine Erklärungen aus.",
].join("\n");

const EXPECTED = Object.freeze({
  projekt: /kestrel/iu,
  verantwortlich: /mira\s+seidel/iu,
  kennung: /Q7[-‐‑– ]?42/iu,
  budget: /8[.,\s]?100/iu,
  termin: /(?:2027-04-09|0?9[./]0?4[./](?:2027|27)|9\.?\s*april\s*2027)/iu,
  ersteEntscheidung: /lokal.{0,35}(?:warteschlange|queue)/iu,
  verworfeneAlternative: /extern.{0,35}volltext/iu,
  offenerSchritt: /integrationsprobe/iu,
  einschraenkung:
    /(?:rohdat|raw\s*data).{0,60}(?:nicht.{0,40}(?:verlassen|extern|übertrag)|(?:bleib|verbleib).{0,20}lokal|(?:must|may).{0,10}not.{0,20}leave)/iu,
});

export function continuityDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function evaluateContinuityAnswer(content) {
  let parsed;
  try {
    const source = content
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, "");
    parsed = JSON.parse(source);
  } catch {
    return { validJson: false, correct: 0, total: Object.keys(EXPECTED).length, fields: {} };
  }
  const fields = Object.fromEntries(
    Object.entries(EXPECTED).map(([key, pattern]) => [
      key,
      { correct: pattern.test(String(parsed?.[key] ?? "")), unknown: parsed?.[key] == null },
    ]),
  );
  return {
    validJson: true,
    correct: Object.values(fields).filter((field) => field.correct).length,
    total: Object.keys(EXPECTED).length,
    fields,
  };
}

export function continuityCorpusManifest() {
  return {
    version: CONTINUITY_CORPUS_VERSION,
    initialDigest: continuityDigest(INITIAL_CONTEXT),
    correctionDigest: continuityDigest(CORRECTION_CONTEXT),
    questionDigest: continuityDigest(RECALL_QUESTION),
    oracleDigest: continuityDigest(
      JSON.stringify(Object.entries(EXPECTED).map(([k, v]) => [k, v.source])),
    ),
    criticalFields: Object.keys(EXPECTED),
  };
}

export function continuityPressureNote(round, part, characters) {
  const opening = `Unverbindliche synthetische Arbeitsnotiz ${round}.${part}. Diese Notiz ändert keine Projektvereinbarung.\n`;
  const block =
    "Temporäre Beobachtung: Der Probelauf enthält wiederholte technische Zwischenstände ohne neue Entscheidungen.\n";
  return `${opening}${block.repeat(Math.ceil(characters / block.length))}\nAntworte ausschließlich mit OK.`;
}
