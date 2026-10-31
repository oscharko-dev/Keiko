// Journey definitions and oracles of epic #4173 (#4174): the request sent through Chat and the
// independent judgement of its effects. The live plumbing is injected through the context so the
// grading is testable without Keiko or Jira:
//   ctx.turn(chat, content)  -> { answer, failure, durationMs, toolCalls, toolExchanges,
//                                 approvals: { reads, writes } }
//   ctx.search(query, fields) -> every matching Jira issue (admin read, all pages)
//   ctx.refusals()           -> count of generation-changed refusals in the live log
//   ctx.truth                -> generated ground truth of the report project
// A check names the catalog obligations it verifies in `covers`; the scorecard credits them only
// when the check is green, so a check that covers part of a scenario never turns it green.
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";
import {
  epicConforms,
  gradeBacklog,
  gradeDeviationReport,
  gradeRequirementListing,
  draftIdentity,
  sectionsPresent,
  structuredDeviations,
  turnIssues,
} from "./oracles.mjs";

const result = (status, turn, detail, covers) => ({
  status,
  covers,
  detail: `${detail}; ${Math.round(turn.durationMs / 1000)} s, ${turn.toolCalls} tool calls${turn.failure ? `, failed: ${turn.failure}` : ""}`,
});

/**
 * The issues a query matches before a turn: their keys, which the oracle compares against, and the
 * draft identity labels they already carry, which a duplicate would repeat.
 */
async function snapshotBefore(ctx, query) {
  const issues = await ctx.search(query, "summary,labels");
  return {
    keys: new Set(issues.map((issue) => issue.key)),
    identities: new Set(issues.map(draftIdentity).filter((identity) => identity !== undefined)),
  };
}

/** "3 epics created, 2 reconciled, 1 duplicates" - a run that only reconciled reads as such. */
const countsOf = (turn, label) =>
  `${turn.created.length} ${label} created, ${turn.reconciled.length} reconciled` +
  (turn.duplicates.length === 0 ? "" : `, ${turn.duplicates.length} duplicates`);

export const JOURNEYS = {
  async S04(ctx, chat) {
    const truth = buildCorpus(1).truth;
    const turn = await ctx.turn(
      chat,
      "Liste ALLE Anforderungen aus dem Lastenheft im Wissens-Pod vollständig auf: je Zeile ID, Titel, Priorität und Kapitel. Nutze kein Jira-Werkzeug.",
    );
    const grade = gradeRequirementListing(turn.answer, truth);
    const gaps = Object.entries(grade.incomplete)
      .map(([aspect, ids]) => `${ids.length} without ${aspect}`)
      .join(", ");
    return result(
      grade.ok ? "green" : "red",
      turn,
      `${truth.length - grade.missing.length}/${truth.length} requirements listed, ${grade.invented.length} invented, ${gaps}`,
      ["all-requirements", "title", "priority", "source-location"],
    );
  },
  async S05(ctx, chat) {
    const query = "project = REQ AND issuetype = Epic";
    const before = await snapshotBefore(ctx, query);
    const ids = ["LH-001", "LH-002", "LH-003"];
    const turn = await ctx.turn(
      chat,
      `Lege im Jira-Projekt REQ für die Anforderungen ${ids.join(", ")} aus dem Lastenheft je ein Epic genau nach der Strukturvorgabe an. Ermittle Felder und Pflichtfelder mit den Jira-Werkzeugen. Melde die Vorgangsschlüssel oder den genauen Fehler.`,
    );
    const epics = turnIssues({
      before,
      issues: await ctx.search(query, "summary,description,labels"),
      exchanges: turn.toolExchanges,
    });
    const conforming = ids.filter(
      (id) => epics.credited.filter((epic) => epicConforms(epic, id)).length === 1,
    );
    const writes = turn.approvals.writes;
    const epicsOk =
      conforming.length === ids.length &&
      epics.credited.length === ids.length &&
      epics.duplicates.length === 0;
    return result(
      epicsOk && writes === 1 ? "green" : "red",
      turn,
      `${conforming.length}/${ids.length} conforming epics, ${countsOf(epics, "epics")}, ${writes} write approvals`,
      ["epic-per-requirement", "template-conformance", "single-approval"],
    );
  },
  async S07(ctx, chat) {
    const query = "project = REQ AND issuetype = Task";
    const before = await snapshotBefore(ctx, query);
    const turn = await ctx.turn(
      chat,
      "Lege im Jira-Projekt REQ zwei Umsetzungsaufgaben (Vorgangstyp Task) für die Anforderung LH-002 nach der Strukturvorgabe an und ordne sie dem Epic von LH-002 zu. Lege das Epic an, falls es fehlt. Melde die Schlüssel oder den genauen Fehler.",
    );
    const link = ctx.truth.fieldIds.epicLink;
    const epics = await ctx.search(
      'project = REQ AND issuetype = Epic AND summary ~ "LH-002"',
      "summary",
    );
    const epicKeys = new Set(epics.map((epic) => epic.key));
    const tasks = turnIssues({
      before,
      issues: await ctx.search(query, `summary,description,labels,${link}`),
      exchanges: turn.toolExchanges,
    });
    const good = tasks.credited.filter(
      (task) =>
        epicKeys.has(task.fields[link]) &&
        sectionsPresent(task.fields.description, STRUCTURE_RULES.Task.sections),
    );
    const tasksOk =
      good.length === 2 && tasks.credited.length === 2 && tasks.duplicates.length === 0;
    return result(
      tasksOk ? "green" : "red",
      turn,
      `${good.length} of ${tasks.credited.length} tasks of this turn linked to the LH-002 epic with required sections, ${countsOf(tasks, "tasks")}`,
      ["tasks-created", "required-fields", "parent-relation"],
    );
  },
  async S10(ctx, chat) {
    const turn = await ctx.turn(
      chat,
      "Werte den Fortschritt des Jira-Projekts RPT aus. Antworte mit genau einer Zeile je Kombination im Format TYP;STATUS;ANZAHL für alle Vorgänge des Projekts, ohne weitere Zeilen.",
    );
    const issues = await ctx.search("project = RPT", "issuetype,status");
    const expected = new Map();
    for (const issue of issues) {
      const key = `${issue.fields.issuetype.name};${issue.fields.status.name}`.toLowerCase();
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const reported = new Map(
      [...turn.answer.matchAll(/^\s*([^;\n]+);([^;\n]+);\s*(\d+)\s*$/gm)].map((m) => [
        `${m[1].trim()};${m[2].trim()}`.toLowerCase(),
        Number(m[3]),
      ]),
    );
    const matched = [...expected].filter(([key, count]) => reported.get(key) === count).length;
    const ok = matched === expected.size && reported.size === expected.size;
    return result(
      ok ? "green" : "red",
      turn,
      `${matched}/${expected.size} type/status counts exact over ${issues.length} issues`,
      ["counts-by-type-status"],
    );
  },
  async S11(ctx, chat) {
    const turn = await ctx.turn(
      chat,
      "Prüfe als Projektleiter jeden Vorgang des Jira-Projekts RPT gegen die Strukturvorgabe und liste die Schlüssel ALLER abweichenden Vorgänge mit ihren Abweichungen auf.",
    );
    // The tool result is the evidence of what Jira holds; the answer only has to say it, not deny it.
    const structured = structuredDeviations(turn.toolExchanges);
    if (structured === undefined) {
      return result(
        "unverified",
        turn,
        "no completed jira.report result with deviations in the turn; nothing is credited",
        [],
      );
    }
    const grade = gradeDeviationReport(
      turn.answer,
      ctx.truth.issues,
      structured,
      ctx.truth.fieldIds,
    );
    return result(
      grade.keysOk && grade.detailOk ? "green" : "red",
      turn,
      `${grade.found}/${grade.expected} deviating issues found, ${grade.falseFindings.length} false findings, ${grade.undescribed.length} of ${grade.deviationCount} seeded deviations not described in the answer, ${grade.unreported.length} not reported by the tool`,
      ["deviating-issues", "deviation-detail"],
    );
  },
  async S17(ctx, chat) {
    const query = "project = REQ AND issuetype = Epic";
    const before = await snapshotBefore(ctx, query);
    const requested = buildCorpus(1)
      .truth.filter((item) => item.priority === "Muss")
      .map((item) => item.id);
    const refusalsBefore = ctx.refusals();
    const turn = await ctx.turn(
      chat,
      "Lege im Jira-Projekt REQ für ALLE Anforderungen mit Priorität Muss aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde am Ende alle angelegten Schlüssel.",
    );
    const epics = turnIssues({
      before,
      issues: await ctx.search(query, "summary,labels"),
      exchanges: turn.toolExchanges,
    });
    // Only this turn's refusals count; earlier journeys share the same live log.
    const refused = ctx.refusals() > refusalsBefore;
    const grade = gradeBacklog({ requested, created: epics.credited, answer: turn.answer });
    const ok =
      !turn.failure &&
      grade.mappingOk &&
      grade.namesOk &&
      !refused &&
      epics.duplicates.length === 0;
    return result(
      ok ? "green" : "red",
      turn,
      `${grade.mapped}/${requested.length} requirements mapped to one epic each, ${countsOf(epics, "epics")}, ${grade.stray} unmapped, ${grade.unnamed} reported keys missing from the answer${refused ? ", generation-changed refusal logged" : ""}`,
      ["epic-per-must-requirement", "answer-lists-created-keys", "no-generation-refusal"],
    );
  },
};

export const JOURNEY_IDS = Object.freeze(Object.keys(JOURNEYS));
