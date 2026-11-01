// Journey definitions and oracles of epic #4173 (#4174): the request sent through Chat and the
// independent judgement of its effects. The live plumbing is injected through the context so the
// grading is testable without Keiko or Jira:
//   ctx.turn(chat, content)  -> { answer, failure, durationMs, toolCalls, toolExchanges,
//                                 approvals: { reads, writes } }
//   ctx.search(query, fields) -> every matching Jira issue (admin read, all pages)
//   ctx.refusals()           -> count of generation-changed refusals in the live log
//   ctx.truth                -> generated ground truth of the report project
//   ctx.http(name, path, body, method) -> JSON of an ordinary Keiko route (skill library, exports)
//   ctx.deselectSkill(chat)  -> the Chat keeps no selected skill, so only a template can teach it
//   ctx.comments(key)        -> every comment of a Jira issue as { id, body } (admin read)
//   ctx.exportReport(chat, reportId, format) -> the local export file of a finished report
//   ctx.freshChat(toolMode)  -> another Chat bound to the same Pods in the given Chat tool mode
//   ctx.useSpecificationFormat(format) -> the Pod holds the specification as that office format only
//   ctx.replaceSpecification(version) -> the Pod holds the Markdown specification of that version
// ctx.turn(chat, content, { observeBeforeApproval }) calls the observer while a write approval is
// pending, before it is decided; approvals.records lists { approval, call, observed } per approval.
// A check names the catalog obligations it verifies in `covers`; the scorecard credits them only
// when the check is green, so a check that covers part of a scenario never turns it green.
import { changeImpactTruth, structuredChangeSet } from "./change-impact.mjs";
import { STRUCTURE_RULES, buildCorpus, corpusChange } from "./corpus.mjs";
import {
  gradeCoverageMatrix,
  requirementCoverageTruth,
  structuredRequirementCoverage,
} from "./coverage-matrix.mjs";
import {
  epicConforms,
  gradeBacklog,
  gradeChangeImpact,
  gradeCriterionTestCases,
  gradeDeviationReport,
  gradeQualityFindings,
  gradeRequirementListing,
  sectionsPresent,
  structuredDeviations,
  TEST_CASE_FORMAT,
  turnIssues,
} from "./oracles.mjs";
import { everyFormatUsable } from "./formats.mjs";
import { bugWithRelationAndLink, subtasksUnderTask } from "./hierarchy.mjs";
import { modesAndReadableApproval } from "./modes.mjs";
import { rerunCreatesNoDuplicates } from "./rerun.mjs";
import {
  complianceFieldIds,
  estimateOf,
  gradeProgress,
  progressTruth,
} from "./progress-report.mjs";
import {
  computedCommentTexts,
  finishedReports,
  gradeCsvExport,
  gradeMarkdownExport,
  gradeReportComment,
} from "./report-export.mjs";
import { countsOf, NO_TURN, result, snapshotBefore } from "./journey-support.mjs";
import {
  epicTemplateConforms,
  epicTemplateMarkdown,
  gradeProposal,
  gradeTemplateListing,
  gradeTemplateRepair,
  gradeTemplateValidation,
  listTemplates,
  proposeTemplates,
  validateTemplate,
  complianceTemplates,
  withTemplate,
  withTemplates,
} from "./templates.mjs";

const EPIC_QUERY = "project = REQ AND issuetype = Epic";
const EPIC_TEMPLATE = "REQ/Epic";

/** The Jira Pod the Chat is bound to; the template routes read the instance through it. */
const podOf = (chat) => chat.jiraPodBinding?.podId;

/** Validates and lists a defined template: what the lead sees in the settings. */
async function inspectTemplate(ctx, chat, markdown, skill) {
  const podId = podOf(chat);
  const [templates, validation] = await Promise.all([
    listTemplates(ctx.http),
    podId === undefined ? undefined : validateTemplate(ctx.http, markdown, podId),
  ]);
  return {
    listing: gradeTemplateListing(templates, skill, { project: "REQ", issueType: "Epic" }),
    validation: validation === undefined ? undefined : gradeTemplateValidation(validation),
  };
}

/** Exactly one new epic for the requirement, and it satisfies the template as Jira holds it. */
function appliedTemplate(epics, requirementId) {
  const [epic] = epics.credited;
  return (
    epics.credited.length === 1 &&
    epics.duplicates.length === 0 &&
    epic.fields.summary.startsWith(`[${requirementId}]`) &&
    epicTemplateConforms(epic)
  );
}

async function templateDefinedAndApplied(ctx, chat) {
  const markdown = epicTemplateMarkdown("REQ");
  return withTemplate(ctx.http, markdown, "REQ-Epic", async (skill) => {
    const { listing, validation } = await inspectTemplate(ctx, chat, markdown, skill);
    if (validation === undefined) {
      return result(
        "unverified",
        NO_TURN,
        "the Chat is bound to no Jira Pod; nothing is credited",
        [],
      );
    }
    const before = await snapshotBefore(ctx, EPIC_QUERY);
    await ctx.deselectSkill(chat);
    const turn = await ctx.turn(
      chat,
      "Lege im Jira-Projekt REQ für die Anforderung LH-004 aus dem Lastenheft ein Epic an. Melde den Vorgangsschlüssel oder den genauen Fehler.",
    );
    const epics = turnIssues({
      before,
      issues: await ctx.search(EPIC_QUERY, "summary,description,labels"),
      exchanges: turn.toolExchanges,
    });
    const applied = appliedTemplate(epics, "LH-004");
    return result(
      listing.defined && listing.activated && validation.ok && applied ? "green" : "red",
      turn,
      `template listed valid ${listing.defined}, active on create ${listing.activated}, instance findings ${validation.findings ?? "unchecked"}; ${countsOf(epics, "epics")}, ${applied ? "the epic satisfies the template" : "no single epic satisfying the template"}`,
      ["template-defined", "template-activated", "template-applied"],
    );
  });
}

const sameIds = (left, right) =>
  left.length === right.length &&
  left.every((entry) => right.some((other) => other.id === entry.id));

/** S02 without a Chat: the proposal is read-only, the lead reviews it and only then defines it. */
async function proposalReviewedBeforeActivation(ctx, chat) {
  const podId = podOf(chat);
  if (podId === undefined) {
    return result(
      "unverified",
      NO_TURN,
      "the Chat is bound to no Jira Pod; nothing is credited",
      [],
    );
  }
  const before = await listTemplates(ctx.http);
  const proposals = await proposeTemplates(ctx.http, "RPT", podId);
  const after = await listTemplates(ctx.http);
  const grades = ["Epic", "Task", "Bug"].map((type) => gradeProposal(proposals, type));
  const unchanged = sameIds(before, after);
  const epic = proposals.find((proposal) => proposal.issueType?.toLowerCase() === "epic");
  const reviewed =
    epic === undefined
      ? false
      : await withTemplate(ctx.http, epic.markdown, "RPT-Epic", async (skill) => {
          const [listed, validation] = await Promise.all([
            listTemplates(ctx.http),
            validateTemplate(ctx.http, epic.markdown, podId),
          ]);
          const listing = gradeTemplateListing(listed, skill, {
            project: "RPT",
            issueType: "Epic",
          });
          return listing.defined && listing.activated && gradeTemplateValidation(validation).ok;
        });
  const fromIssues = grades.every((grade) => grade.ok);
  const detail = grades
    .map((g) => `${g.issueType} ${g.ok ? "ok" : `missing [${g.missing}] surplus [${g.surplus}]`}`)
    .join(", ");
  return result(
    fromIssues && unchanged && reviewed ? "green" : "red",
    NO_TURN,
    `proposals ${detail}; library unchanged by proposing ${unchanged}; reviewed proposal validates and activates only once defined ${reviewed}`,
    ["proposal-from-existing-issues", "proposal-reviewed-before-activation"],
  );
}

async function violationsRepairedBeforeWrite(ctx, chat) {
  const before = await snapshotBefore(ctx, EPIC_QUERY);
  return withTemplate(ctx.http, epicTemplateMarkdown("REQ"), "REQ-Epic", async () => {
    await ctx.deselectSkill(chat);
    const turn = await ctx.turn(
      chat,
      "Lege im Jira-Projekt REQ für die Anforderung LH-005 zunächst ein Epic mit genau der Zusammenfassung „Schnelltest Statusanzeige“ und genau der Beschreibung „Kurzer Test.“ an. Falls das Anlegen abgelehnt wird, korrigiere den Vorgang anhand der gemeldeten Verstöße und lege ihn erneut an. Melde den Vorgangsschlüssel oder den genauen Fehler.",
    );
    const epics = turnIssues({
      before,
      issues: await ctx.search(EPIC_QUERY, "summary,description,labels"),
      exchanges: turn.toolExchanges,
    });
    const grade = gradeTemplateRepair({
      exchanges: turn.toolExchanges,
      issues: epics.credited,
      template: EPIC_TEMPLATE,
    });
    if (!grade.detected) {
      return result(
        "unverified",
        turn,
        `no template refusal in the turn (${grade.refusals} refusals, ${grade.issues} issues written); the gate was not exercised and nothing is credited`,
        [],
      );
    }
    return result(
      grade.repaired ? "green" : "red",
      turn,
      `${grade.refusals} refusals (${grade.ruleIds.join(", ")}), ${grade.receipts} with a receipt, written after the first refusal ${grade.writtenAfter}, ${grade.issues} issues of the turn of which ${grade.nonconforming.length} violate the template`,
      ["violations-detected", "repaired-before-write"],
    );
  });
}

// ---------- S10 ----------

const PROGRESS_FIELDS = (fieldIds) =>
  ["issuetype", "status", "parent", fieldIds.epicLink, fieldIds.storyPoints]
    .filter((field) => field !== undefined)
    .join(",");

const estimateLine = (estimate) =>
  estimate.unit === "seconds"
    ? `SCHÄTZUNG;<gesamt>;<erledigt>;<offen> - genau eine Zeile: die Summe der ursprünglichen Schätzung (${estimate.label}) in Stunden über alle Vorgänge des Projekts, davon in der Statuskategorie Done, und die Differenz.`
    : `SCHÄTZUNG;<gesamt>;<erledigt>;<offen> - genau eine Zeile: die Summe des Feldes ${estimate.label} über alle Vorgänge des Projekts, davon in der Statuskategorie Done, und die Differenz.`;

/** The S10 prompt; `estimate` names the field the instance estimates with (none: no line asked). */
const PROGRESS_PROMPT = (estimate) =>
  [
    "Werte den Fortschritt des Jira-Projekts RPT aus. Antworte ausschließlich mit Zeilen in genau diesen Formaten, ohne weitere Zeilen:",
    "ANZAHL;<Vorgangstyp>;<Status>;<Anzahl> - eine Zeile je Kombination aus Vorgangstyp und Status, die im Projekt vorkommt (alle Vorgänge des Projekts, auch Epics).",
    "EPIC;<Epic-Schlüssel>;<Anzahl>;<davon erledigt> - eine Zeile je Epic des Projekts: die Anzahl aller dem Epic zugeordneten Vorgänge (Tasks, Bugs und deren Sub-Tasks, ohne das Epic selbst) und wie viele davon in der Statuskategorie Done sind.",
    ...(estimate === undefined ? [] : [estimateLine(estimate)]),
  ].join("\n");

async function projectProgress(ctx, chat) {
  const turn = await ctx.turn(chat, PROGRESS_PROMPT(estimateOf(ctx.truth)));
  const issues = await ctx.search("project = RPT", PROGRESS_FIELDS(ctx.truth.fieldIds));
  const truth = progressTruth(issues, ctx.truth.fieldIds, ctx.truth.estimate);
  const grade = gradeProgress(turn.answer, truth);
  const parts = [
    ["counts-by-type-status", grade.counts],
    ["per-epic-progress", grade.epics],
    ["estimate-totals", grade.estimate],
  ].filter(([, part]) => part.graded);
  const failed = parts.filter(([, part]) => !part.ok);
  const ungraded = [grade.epics, grade.estimate].filter((part) => !part.graded).length;
  return result(
    failed.length === 0 ? "green" : "red",
    turn,
    `${issues.length} issues; type/status counts ${grade.counts.matched}/${grade.counts.expected} exact (${grade.counts.extra} extra), epics ${grade.epics.graded ? `${grade.epics.matched}/${grade.epics.expected}` : "not gradable"}, estimate ${grade.estimate.graded ? (grade.estimate.ok ? "exact" : "wrong") : "not gradable"}, ${grade.conflicts} conflicting lines${ungraded > 0 ? "; ungradable parts are not credited" : ""}`,
    parts.map(([name]) => name),
  );
}

// ---------- S12 ----------

async function coverageMatrix(ctx, chat) {
  const requirementIds = buildCorpus(1).truth.map((item) => item.id);
  const turn = await ctx.turn(
    chat,
    "Erstelle eine Abdeckungsmatrix der Anforderungen des Lastenhefts für das Jira-Projekt RPT: welche Anforderung wird von welchen Vorgängen genannt und welche von keinem. Berücksichtige ALLE Anforderungen des Lastenhefts. Antworte ausschließlich mit einer Zeile je Anforderung im Format `LH-001;ABGEDECKT;RPT-1, RPT-2` (kommagetrennt die Schlüssel aller Vorgänge, die die Anforderung nennen) oder `LH-010;OFFEN;` (kein Vorgang nennt sie).",
  );
  const issues = await ctx.search("project = RPT", "summary,labels,description");
  const truth = requirementCoverageTruth(issues, requirementIds);
  const open = requirementIds.filter((id) => truth.get(id).size === 0);
  const seeded = ctx.truth.uncoveredRequirements;
  if (
    seeded !== undefined &&
    (seeded.length !== open.length || !open.every((id) => seeded.includes(id)))
  ) {
    return result(
      "unverified",
      turn,
      `Jira names ${requirementIds.length - open.length} requirements but the seeded ground truth leaves ${seeded.length} uncovered; the laboratory drifted and nothing is credited`,
      [],
    );
  }
  const structured = structuredRequirementCoverage(turn.toolExchanges);
  if (structured === undefined) {
    return result(
      "unverified",
      turn,
      "no complete jira.report result with requirement coverage in the turn; nothing is credited",
      [],
    );
  }
  const grade = gradeCoverageMatrix(turn.answer, truth, structured);
  return result(
    grade.matrixOk && grade.openOk ? "green" : "red",
    turn,
    `${grade.covered} covered and ${grade.open} open requirements expected; ${grade.wrong.length} requirements wrong in the answer or the tool result, ${grade.unreported.length} not reported by the tool, ${grade.invented.length} invented`,
    ["coverage-matrix", "uncovered-requirements"],
  );
}

// ---------- S13 ----------

async function reportExportAndComment(ctx, chat) {
  const target = ctx.truth.issues.find((issue) => issue.type === "Epic")?.key;
  const known = new Set((await ctx.comments(target)).map((comment) => comment.id));
  const turn = await ctx.turn(
    chat,
    `Erstelle einen vollständigen Bericht für das Jira-Projekt RPT (Fortschritt, Abweichungen, Abdeckung) und hinterlege den vom Berichtswerkzeug berechneten Kommentartext des Berichts unverändert als genau einen Kommentar am Vorgang ${target}. Melde den Schlüssel des Vorgangs.`,
  );
  const reports = finishedReports(turn.toolExchanges);
  if (reports.length === 0) {
    return result(
      "unverified",
      turn,
      "no complete jira.report result in the turn; nothing is credited",
      [],
    );
  }
  const [comments, issues] = await Promise.all([
    ctx.comments(target),
    ctx.search("project = RPT", "summary"),
  ]);
  const comment = gradeReportComment(
    comments.filter((entry) => !known.has(entry.id)),
    computedCommentTexts(turn.toolExchanges),
    reports,
  );
  const report = comment.report ?? reports.at(-1);
  const exported = await Promise.all(
    ["csv", "markdown"].map((format) => ctx.exportReport(chat, report.reportId, format)),
  ).then(
    ([csv, markdown]) => [
      gradeCsvExport(
        csv,
        report.digest,
        issues.map((issue) => issue.key),
      ),
      gradeMarkdownExport(markdown, report.digest),
    ],
    (error) => [{ ok: false, reason: `export request failed: ${String(error.message)}` }],
  );
  const readAll = report.issuesRead === issues.length;
  const exportOk = readAll && exported.every((entry) => entry.ok);
  return result(
    exportOk && comment.ok ? "green" : "red",
    turn,
    `report read ${report.issuesRead} of ${issues.length} issues; exports: ${exported.map((entry) => entry.reason).join(" | ")}; ${comment.newComments} new comments on ${target}, ${comment.computedTexts} computed comment texts, comment is the computed text ${comment.ok}`,
    ["report-export", "jira-comment"],
  );
}

async function complianceReport(ctx, chat) {
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
    complianceFieldIds(ctx.truth),
  );
  return result(
    grade.keysOk && grade.detailOk ? "green" : "red",
    turn,
    `${grade.found}/${grade.expected} deviating issues found, ${grade.falseFindings.length} false findings, ${grade.undescribed.length} of ${grade.deviationCount} seeded deviations not described in the answer, ${grade.unreported.length} not reported by the tool`,
    ["deviating-issues", "deviation-detail"],
  );
}

export const JOURNEYS = {
  S01: (ctx, chat) => templateDefinedAndApplied(ctx, chat),
  S02: (ctx, chat) => proposalReviewedBeforeActivation(ctx, chat),
  S03: (ctx) => everyFormatUsable(ctx),
  async S04(ctx, chat) {
    const truth = buildCorpus(1).truth;
    const turn = await ctx.turn(
      chat,
      "Liste ALLE Anforderungen aus dem Lastenheft im Wissens-Pod vollständig auf: je Zeile ID, Titel, Priorität und Kapitel.",
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
  S06: (ctx, chat) => violationsRepairedBeforeWrite(ctx, chat),
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
  S08: (ctx, chat) => bugWithRelationAndLink(ctx, chat),
  S09: (ctx, chat) => subtasksUnderTask(ctx, chat),
  S10: (ctx, chat) => projectProgress(ctx, chat),
  S11: (ctx, chat) =>
    // AC1 before AC3: the lead's templates for RPT are the structure the compliance check applies.
    withTemplates(ctx.http, complianceTemplates("RPT", complianceFieldIds(ctx.truth)), () =>
      complianceReport(ctx, chat),
    ),
  S12: (ctx, chat) => coverageMatrix(ctx, chat),
  S13: (ctx, chat) => reportExportAndComment(ctx, chat),
  async S14(ctx, chat) {
    const query = "project = REQ AND issuetype = Epic";
    const change = corpusChange();
    const traced = [...change.changed, ...change.removed];
    const before = await snapshotBefore(ctx, query);
    const first = await ctx.turn(
      chat,
      `Lege im Jira-Projekt REQ für die Anforderungen ${traced.join(", ")} aus dem Lastenheft je ein Epic nach der Strukturvorgabe an. Melde die Vorgangsschlüssel.`,
    );
    // Epics the draft reconciled from an earlier run count too: the traced keys are what matters.
    const created = turnIssues({
      before,
      issues: await ctx.search(query, "summary,labels"),
      exchanges: first.toolExchanges,
    }).credited;
    await ctx.replaceSpecification(2);
    const turn = await ctx.turn(
      chat,
      "Das Lastenheft liegt jetzt in einer neuen Version vor. Vergleiche es mit den bereits angelegten Epics im Jira-Projekt REQ. Antworte in genau vier Zeilen: `GEÄNDERT:` mit den IDs der geänderten Anforderungen, `ENTFERNT:` mit den IDs der entfernten, `NEU:` mit den IDs der neuen, von keinem Epic nachverfolgten Anforderungen und `BETROFFENE VORGÄNGE:` mit den Schlüsseln der Epics, die geänderte oder entfernte Anforderungen nachverfolgen.",
    );
    // Jira, not the first turn, is the truth: any journey's epic that traces a requirement counts.
    const truth = changeImpactTruth(
      await ctx.search(query, "summary,labels"),
      change,
      buildCorpus(2).truth.map((item) => item.id),
    );
    const structured = structuredChangeSet(turn.toolExchanges);
    if (structured === undefined) {
      return result(
        "unverified",
        turn,
        "no complete knowledge.requirements changes result in the turn; nothing is credited",
        [],
      );
    }
    const grade = gradeChangeImpact(turn.answer, truth, structured);
    return result(
      !first.failure && created.length === traced.length && grade.ok ? "green" : "red",
      turn,
      `${created.length}/${traced.length} epics created beforehand, baseline traceable ${truth.traceable}; changed ${grade.changed}, removed ${grade.removed}, untraced (NEU) ${grade.added}, affected issues ${grade.affected}`,
      ["changes-detected", "affected-issues"],
    );
  },
  async S15(ctx, chat) {
    const truth = buildCorpus(1).truth;
    const turn = await ctx.turn(
      chat,
      "Prüfe ALLE Anforderungen des Lastenhefts auf Qualitätsmängel. Antworte in genau zwei Zeilen: `UNKLAR:` mit den IDs der Anforderungen mit unklarer, nicht prüfbarer Formulierung und `OHNE ABNAHMEKRITERIEN:` mit den IDs der Anforderungen ohne Abnahmekriterien.",
    );
    const grade = gradeQualityFindings(turn.answer, truth);
    return result(
      grade.vagueOk && grade.missingOk ? "green" : "red",
      turn,
      `vague wording ${grade.vagueReported}/${grade.vague} (exact: ${grade.vagueOk}), missing acceptance criteria ${grade.missingReported}/${grade.missing} (exact: ${grade.missingOk})`,
      ["vague-wording-findings", "missing-acceptance-findings"],
    );
  },
  async S16(ctx, chat) {
    const item = buildCorpus(1).truth.find((entry) => entry.id === "LH-002");
    const turn = await ctx.turn(
      chat,
      `Entwirf für die Anforderung LH-002 aus dem Lastenheft zu jedem Abnahmekriterium genau einen Testfall. Schreibe jeden Testfall in genau eine Zeile im Format \`${TEST_CASE_FORMAT.replace("<id>", "LH-002")}\`, mit der Kriterium-Referenz LH-002/AC1, LH-002/AC2 usw. Lege nichts in Jira an.`,
    );
    const grade = gradeCriterionTestCases(turn.answer, item);
    return result(
      grade.ok ? "green" : "red",
      turn,
      `${grade.cases} test cases for ${item.acceptanceCount} criteria: ${grade.missing.length} missing, ${grade.unusable.length} without usable steps or result, ${grade.duplicated.length} duplicated, ${grade.invented.length} invented references`,
      ["test-case-per-criterion", "traceability"],
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
  S18: (ctx) => modesAndReadableApproval(ctx),
  S19: (ctx, chat) => rerunCreatesNoDuplicates(ctx, chat),
};

export const JOURNEY_IDS = Object.freeze(Object.keys(JOURNEYS));
