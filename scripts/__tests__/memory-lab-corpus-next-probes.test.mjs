// What each probe of the "next" corpus (#4208) can and cannot be passed with. A probe that passes
// without the memory measures nothing about memory (audit F3): the answer a model gives unprompted
// is written down here for every answer probe, in the register of a model that has no memory (a hedge
// that names the usual choices, a plain "I do not know") and must fail the probe. A new answer probe
// without such an answer fails the corpus until its author writes one.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { loadScenarioDirectory } from "../testing/memory-lab/scenario.mjs";
import { scoreProbe } from "../testing/memory-lab/score.mjs";

const NEXT = join(REPO_ROOT, "scripts", "testing", "memory-lab", "scenarios-next");
const scenarios = loadScenarioDirectory(NEXT);

// Keyed `<scenario id>:<probe id>`. The values a person would choose unprompted (a common format,
// theme, cadence, hour or number of reviewers) appear in these answers on purpose.
const MEMORY_FREE_ANSWERS = Object.freeze({
  "earlier-hotfix-en:current":
    "Hotfixes usually go through a pull request with at least two reviewers, three for critical systems.",
  "earlier-hotfix-en:previous":
    "Before the current rule hotfixes were most likely reviewed by one or two engineers.",
  "earlier-hotfix-en:first":
    "I can't tell which rule applied first; two reviewers is a common baseline for hotfixes.",
  "earlier-korrektur-de:current": "Das weiß ich nicht, dazu habe ich keine Angabe.",
  "earlier-korrektur-de:previous": "Dazu habe ich keine frühere Angabe gespeichert.",
  "earlier-rueckkehr-de:current": "Zahlen zeigt man am besten in Tabellen.",
  "earlier-rueckkehr-de:previous": "Du hast mir vermutlich Listen oder Aufzählungen genannt.",
  "earlier-theme-en:current":
    "Most developers choose a dark theme such as Dracula, Nord, Solarized or Gruvbox.",
  "earlier-theme-en:previous": "You probably used the light theme in between.",
  "long-horizon-berichte-de:format-now":
    "Statusberichte baut man am besten als Tabelle mit einer Zeile pro Vorgang oder Aufgabe.",
  "long-horizon-berichte-de:day-now":
    "Teamtreffen finden oft dienstags oder donnerstags statt, meist vormittags um 10 Uhr.",
  "long-horizon-berichte-de:day-before": "Früher war es vermutlich dienstags, häufig um 10 Uhr.",
  "long-horizon-berichte-de:dept-old":
    "Deine Abteilung heißt vermutlich Kreditrisiko oder Risikocontrolling.",
  "long-horizon-distractors-en:room":
    "The audit review is probably in a large meeting room or the main conference room.",
  "long-horizon-distractors-en:room-plain":
    "The audit review is probably in a large meeting room or the main conference room.",
  "long-horizon-gewohnheit-de:standing": "Viele lesen Berichte morgens, andere am Nachmittag.",
  "long-horizon-gewohnheit-de:this-week": "Diese Woche liest du sie vielleicht abends.",
  "long-horizon-gewohnheit-de:both":
    "Normalerweise liest du Berichte morgens, diese Woche vielleicht abends.",
  "long-horizon-oft-genutzt-en:caterer": "The catering is probably done by a local provider.",
  "long-horizon-oft-genutzt-en:caterer-plain": "The food is probably provided by a local caterer.",
  "long-horizon-release-en:theme-now":
    "Most developers choose a dark theme such as Dracula, Nord or Catppuccin.",
  "long-horizon-release-en:cadence-now":
    "Many teams ship every two weeks, others weekly or monthly.",
  "long-horizon-release-en:cadence-before": "Before that you probably shipped weekly.",
  "long-horizon-release-en:team-old": "I don't know what your team is called.",
  "paraphrase-buero-de-en:cross-language":
    "Your workplace is probably on the second or third floor.",
  "paraphrase-buero-de-en:control-lexical":
    "Dein Büro liegt vermutlich im zweiten oder dritten Stock.",
  "paraphrase-commute-en:synonym":
    "I don't know how you commute; most people drive or take the train or the bus.",
  "paraphrase-commute-en:control-lexical": "You probably get to the office by car, train or bus.",
  "paraphrase-lisbon-en-de:cross-language":
    "Am Ende der Woche bist du vermutlich im Büro oder im Homeoffice erreichbar.",
  "paraphrase-lisbon-en-de:control-lexical": "I don't know which city you work from on Fridays.",
  "paraphrase-pendeln-de:synonym":
    "Du pendelst vermutlich mit dem Auto, der Bahn oder dem Fahrrad.",
  "paraphrase-pendeln-de:control-lexical":
    "Du kommst vermutlich mit dem Auto oder der Bahn zur Arbeit.",
  "scale-abgelaufen-de:target":
    "Gleitzeitkonten werden meist am Monatsende abgeschlossen, manchmal freitags.",
  "scale-abgelaufen-de:control-recent":
    "Deine Urlaubsvertretung übernimmt vermutlich eine Kollegin aus dem Team.",
  "scale-archiviert-de:target":
    "Release-Fenster liegen meist dienstags oder donnerstags am Vormittag.",
  "scale-archiviert-de:control-recent":
    "Retrospektiven finden oft montags oder freitags am Nachmittag statt.",
  "scale-vorschlaege-en:target":
    "Gateways are usually switched to read-only during a night-time maintenance window, often on a weekend.",
  "scale-vorschlaege-en:control-recent":
    "Incident reviews are often held weekly, for example on Thursday afternoon.",
  "seed-earlier-value-en:now": "Rosa probably wants the weekly report as a PDF or Markdown file.",
  "seed-earlier-value-en:before": "Earlier she probably wanted it as a PDF file.",
  "seed-needs-two-en:both":
    "The planning meeting is probably in a conference room on a weekday, for example Tuesday.",
  "seed-needs-two-en:room-only": "I don't know which room the planning meeting is in.",
  "two-memories-batch-en:direct":
    "A batch window is usually set to 2 am, after the nightly settlement feed has finished.",
  "two-memories-batch-en:indirect": "Overnight jobs often run at 2 am to avoid the daytime load.",
  "two-memories-compare-en:compare":
    "Atlas probably uses PostgreSQL and Borealis probably uses MongoDB.",
  "two-memories-drei-de:three":
    "Als Teamleiterin führst du vermutlich fünf bis zehn Personen an deinem Standort.",
  "two-memories-format-de:direct": "Berichte bekommt man meist als PDF oder als Excel-Datei.",
  "two-memories-format-de:indirect":
    "Zusammenfassungen kommen meist als PDF, für Mittelstandskunden auch als Excel.",
  "two-memories-team-de:direct":
    "Du leitest vermutlich ein Team im Bereich Risiko und bekommst Berichte montags.",
  "two-memories-team-de:indirect":
    "Du bist vermutlich für das Risikomanagement verantwortlich und bekommst Auswertungen montags.",
});

const answerProbes = scenarios.flatMap((scenario) =>
  scenario.probes
    .filter((probe) => probe.expect.kind === "answer")
    .map((probe) => ({ scenario, probe, key: `${scenario.id}:${probe.id}` })),
);

describe("an answer probe of the next corpus", () => {
  it("has a memory-free answer written down, and no stale one", () => {
    expect(Object.keys(MEMORY_FREE_ANSWERS).toSorted()).toEqual(
      answerProbes.map(({ key }) => key).toSorted(),
    );
  });

  it.each(answerProbes.map((entry) => [entry.key, entry]))(
    "%s is not passed by what a model answers unprompted",
    (key, { scenario, probe }) => {
      const answer = MEMORY_FREE_ANSWERS[key];
      // Nothing reached the model, so a pass can only come from the answer itself.
      expect(scoreProbe(scenario, probe, answer, []).passed, answer).toBe(false);
    },
  );
});
