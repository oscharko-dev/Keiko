import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { URL } from "node:url";
import { labSessionConnection } from "./lab-client.mjs";
import { expect } from "@playwright/test";
import { openWorkflowBrowser, sendBrowserTurn } from "./browser-workflow-turn.mjs";
import { selectAccessMode } from "./browser-connections.mjs";
import { privateJson } from "./private-json.mjs";
import { resolveLimitBrowser } from "./limit-run-browser.mjs";
import { openLimitStep } from "./limit-run-step.mjs";
import { withEnglishLimitUi } from "./limit-run-language.mjs";
import { nativePages, projectAgileRead } from "./project-agile-oracles.mjs";
import { buildCorpus, STRUCTURE_RULES } from "./requirements/corpus.mjs";
import { epicTemplateMarkdown, templateMarkdown } from "./requirements/templates.mjs";
import {
  browserKnowledgeDocuments,
  createBrowserKnowledgePod,
  uploadBrowserSkill,
  removeBrowserSkill,
} from "./browser-rules-knowledge-setup.mjs";
import {
  newNativeIssues,
  gradeRuleRefusal,
  gradeCorrectedCreate,
  gradeProseBoundary,
  gradeDocumentInventory,
  gradeDerivedEpics,
  gradeEpicVisibility,
} from "./rules-knowledge-oracles.mjs";

const WRITE_TOOLS = ["jira.create"];
const PROSE_LABEL = "prose-only-required";
const ISSUE_FIELDS = "summary,description,labels,issuetype,priority,parent";

async function issues(context, fields = `${ISSUE_FIELDS},${context.epicLinkFieldId}`) {
  return nativePages(
    (path) => projectAgileRead(context.session, path),
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${context.projectKey} ORDER BY id ASC`)}&fields=${fields}`,
    "issues",
  );
}

const RULE_PROBE_MODES = new Set(["governed-assist", "supervised-coding", "autonomous-delivery"]);

function probeDigest(observed) {
  return createHash("sha256").update(JSON.stringify(observed)).digest("hex");
}

function probePrompt(projectKey) {
  return (
    `Erstelle genau ein Epic im Projekt ${projectKey} mit Zusammenfassung 'Regelprobe ohne Kennung', ` +
    "Beschreibung 'Absichtlich ohne Abschnitte' und keinen Labels. Keine Elternzuordnung und keine explizite Priorität. " +
    "Nutze den Jira-Create-Aufruf genau mit diesem Inhalt, ohne Vorabkorrektur. " +
    "Wenn die formale Vorlage verweigert, melde ihre konkrete Regel und beende den Turn ohne erneuten Schreibversuch."
  );
}

function submitProbe(ctx, opened, counts) {
  return sendBrowserTurn(
    opened.page,
    opened.region,
    opened.context,
    opened.chat.id,
    probePrompt(ctx.projectKey),
    {
      operations: WRITE_TOOLS,
      timeoutMs: 1800000,
      beforeDecision: () => {
        counts.approvals += 1;
        throw new TypeError("Formal rule probe reached write approval");
      },
    },
  );
}

function probeFailure(before, after, result, projectKey, counts) {
  if (
    probeDigest(after) !== probeDigest(before) ||
    result.exchanges.some(
      (exchange) =>
        exchange.effectStarted === true ||
        (exchange.call.name === "jira_create" && exchange.result?.data?.outcome === "succeeded"),
    )
  ) {
    counts.nativeWrites += 1;
    return "rule-probe-native-change";
  }
  if (
    result.decisions !== 0 ||
    result.exchanges.some((exchange) => exchange.approval !== undefined)
  ) {
    counts.approvals += result.decisions;
    return "rule-probe-approval-refused";
  }
  if (
    !gradeRuleRefusal({
      exchanges: result.exchanges,
      before,
      after,
      template: `${projectKey}/Epic`,
    })
  )
    return "rule-probe-refusal-missing";
  return undefined;
}

async function probeMode(ctx, opened, journal, mode, counts) {
  const before = await issues(ctx, "*all");
  if (probeDigest(before) !== journal.state.resources.baselineDigest) {
    counts.nativeWrites += 1;
    return "rule-probe-native-change";
  }
  await selectAccessMode(opened.page, opened.region, mode);
  const result = await submitProbe(ctx, opened, counts);
  const after = await issues(ctx, "*all");
  counts.probedModes += 1;
  const failure = probeFailure(before, after, result, ctx.projectKey, counts);
  if (failure !== undefined) return failure;
  await expect(
    opened.region.getByRole("list", { name: "Template rules not met", exact: true }).last(),
  ).toBeVisible();
  counts.refusals += 1;
  await journal.checkpoint({
    resources: { completedModes: [...journal.state.resources.completedModes, mode] },
    counts,
  });
  return undefined;
}

function completedProbeModes({ resources, counts }, modes) {
  return (
    resources.completedModes?.length === modes.length &&
    modes.every((mode) => resources.completedModes.includes(mode)) &&
    counts.refusals === modes.length &&
    counts.probedModes === modes.length &&
    counts.nativeWrites === 0 &&
    counts.approvals === 0
  );
}

async function reverifyProbes(ctx, journal, modes) {
  const { resources, counts } = journal.state;
  if (!completedProbeModes(journal.state, modes))
    return journal.result("unverified", "rule-probe-readback-unavailable", counts);
  let opened;
  try {
    opened = await resolveLimitBrowser(ctx);
  } catch {
    return journal.result("unverified", "rule-probe-readback-unavailable", counts);
  }
  if (opened.chat.id !== resources.chatId)
    return journal.result("unverified", "rule-probe-readback-unavailable", counts);
  const matches = probeDigest(await issues(ctx, "*all")) === resources.baselineDigest;
  return journal.result(
    matches ? "green" : "red",
    matches ? "rule-probes-confirmed" : "rule-probe-native-change",
    counts,
  );
}

async function executeRuleProbes(ctx, journal, modes, counts) {
  const opened = await resolveLimitBrowser(ctx);
  return withEnglishLimitUi(ctx, () => executeOpenedProbes(ctx, opened, journal, modes, counts));
}

async function executeOpenedProbes(ctx, opened, journal, modes, counts) {
  const baselineDigest = probeDigest(await issues(ctx, "*all"));
  await journal.checkpoint({
    phase: "pending",
    resources: { chatId: opened.chat.id, completedModes: [], baselineDigest },
    counts,
  });
  for (const mode of modes) {
    ctx.signal.throwIfAborted();
    const failure = await probeMode(ctx, opened, journal, mode, counts);
    if (failure !== undefined) return journal.result("red", failure, counts);
  }
  await journal.checkpoint({ phase: "completed", counts });
  return journal.result("green", "rule-probes-confirmed", counts);
}

/** The already-open Chat must refuse formal input in every mode, without an approval or native effect. */
export async function runRuleProbes(ctx, { modes }) {
  assert.ok(
    Array.isArray(modes) &&
      modes.length === RULE_PROBE_MODES.size &&
      new Set(modes).size === modes.length &&
      modes.every((mode) => RULE_PROBE_MODES.has(mode)),
    "All three distinct autonomy modes are required",
  );
  const journal = await openLimitStep(ctx, "w12-rule-probes");
  const counts = {
    requestedModes: modes.length,
    probedModes: 0,
    refusals: 0,
    nativeWrites: 0,
    approvals: 0,
  };
  if (journal.state.phase === "pending")
    return journal.result("unverified", "rule-probes-pending", journal.state.counts);
  try {
    if (journal.state.phase === "completed") return await reverifyProbes(ctx, journal, modes);
    return await executeRuleProbes(ctx, journal, modes, counts);
  } catch {
    if (counts.approvals > 0) return journal.result("red", "rule-probe-approval-refused", counts);
    const detail = ctx.signal.aborted ? "rule-probes-aborted" : "rule-probe-readback-unavailable";
    return journal.result("unverified", detail, counts);
  }
}

function turnRunner(opened, context, intentPath) {
  let sequence = 0;
  return (prompt, operations = [], extra = {}) => {
    sequence += 1;
    return sendBrowserTurn(opened.page, opened.region, context, opened.chat.id, prompt, {
      operations,
      timeoutMs: 1800000,
      ...extra,
      persist: (phase) =>
        privateJson(intentPath, {
          schemaVersion: 1,
          scenario: "rules-knowledge",
          sequence,
          chatId: opened.chat.id,
          ...phase,
        }),
    });
  };
}

async function rejectedRuleTurn(opened, context, turn, issueType = "Epic", nativeParentKey) {
  const before = await issues(context);
  const refused = await turn(
    `Erstelle genau ein ${issueType} im Projekt ${context.projectKey} mit Zusammenfassung 'Regelprobe ohne Kennung', ` +
      "Beschreibung 'Absichtlich ohne Abschnitte' und keinen Labels. " +
      (issueType === "Bug"
        ? "Setze eine aktuell erlaubte native Priorität. "
        : "Ohne explizite Priorität. ") +
      (nativeParentKey === undefined
        ? "Keine Elternzuordnung. "
        : `Natives Parent-Feld auf ${nativeParentKey}. `) +
      "Nutze den Jira-Create-Aufruf " +
      "genau mit diesem Inhalt, ohne Vorabkorrektur. Wenn die formale Vorlage verweigert, melde ihre " +
      "konkrete Regel und beende den Turn ohne erneuten Schreibversuch.",
    WRITE_TOOLS,
    {
      beforeDecision: () => {
        throw new TypeError("Invalid formal input reached write approval");
      },
    },
  );
  assert.equal(
    gradeRuleRefusal({
      exchanges: refused.exchanges,
      before,
      after: await issues(context),
      template: `${context.projectKey}/${issueType}`,
    }),
    true,
    "A real content-rule refusal and independently unchanged Jira set are both required",
  );
  await expect(
    opened.region.getByRole("list", { name: "Template rules not met", exact: true }).last(),
  ).toBeVisible();
}

async function correctedEpic(opened, context, turn) {
  // The same stored rule applies in all three modes, before any write approval/effect.
  await rejectedRuleTurn(opened, context, turn);
  await selectAccessMode(opened.page, opened.region, "supervised-coding");
  await rejectedRuleTurn(opened, context, turn);
  await selectAccessMode(opened.page, opened.region, "autonomous-delivery");
  await rejectedRuleTurn(opened, context, turn);
  await selectAccessMode(opened.page, opened.region, "governed-assist");
  const before = await issues(context);
  const corrected = await turn(
    `Korrigiere jetzt den Inhalt und erstelle genau ein Epic im Projekt ${context.projectKey}: Zusammenfassung ` +
      "'[LH-901] Korrigierte Browserregel', Label anforderung und die fünf Beschreibungsabschnitte " +
      STRUCTURE_RULES.Epic.sections.join(", ") +
      ". Jeder Abschnitt enthält den Satz 'Synthetische Browserprüfung.' Keine requirementIds: " +
      "LH-901 ist ein synthetischer Regeltest, keine behauptete Dokumentreferenz. Melde den Jira-Schlüssel.",
    WRITE_TOOLS,
    { reviewText: [context.projectKey, "LH-901"] },
  );
  const after = await issues(context);
  assert.equal(
    gradeCorrectedCreate({
      exchanges: corrected.exchanges,
      before,
      after,
      requirementId: "LH-901",
    }),
    true,
  );
  assert.equal(corrected.decisions, 1);
  return newNativeIssues(before, after);
}

async function correctedChild(opened, context, turn, issueType, parentKey) {
  const subtask = issueType === "Sub-task";
  await rejectedRuleTurn(opened, context, turn, issueType, subtask ? parentKey : undefined);
  const requirementId = { Task: "LH-902", Bug: "LH-903", "Sub-task": "LH-904" }[issueType];
  const rule = subtask ? STRUCTURE_RULES.Task : STRUCTURE_RULES[issueType];
  const parent = subtask
    ? `Native parent-Zuordnung zur beobachteten Task ${parentKey}. `
    : `Epic-Elternzuordnung ${parentKey} über das native Epic-Link-Feld ${context.epicLinkFieldId}. `;
  const before = await issues(context);
  const result = await turn(
    `Korrigiere jetzt und erstelle genau ein ${issueType} in ${context.projectKey}: Titel '[${requirementId}] Browser ${issueType}', ` +
      parent +
      `Beschreibungsabschnitte: ${rule.sections.join(", ")}. ` +
      "Jeder Abschnitt enthält den Satz 'Synthetische Browserprüfung.' " +
      (issueType === "Bug"
        ? "Setze priority ausdrücklich auf eine aktuell über Jira-Metadaten erlaubte Priorität. "
        : "") +
      "Keine requirementIds: synthetischer Regeltest ohne Dokumentbehauptung. Nutze Jira Create und melde den Schlüssel.",
    WRITE_TOOLS,
    { reviewText: [context.projectKey, requirementId] },
  );
  const after = await issues(context);
  assert.equal(
    gradeCorrectedCreate({
      exchanges: result.exchanges,
      before,
      after,
      requirementId,
      issueType,
      parentKey,
      epicLinkFieldId: context.epicLinkFieldId,
    }),
    true,
  );
  assert.equal(result.decisions, 1);
  return newNativeIssues(before, after);
}

async function uploadFormalTypes(opened, context) {
  const skills = [];
  for (const issueType of ["Epic", "Task", "Bug"]) {
    const markdown =
      issueType === "Epic"
        ? epicTemplateMarkdown(context.projectKey)
        : templateMarkdown({
            project: context.projectKey,
            issueType,
            rule: STRUCTURE_RULES[issueType],
            parentField: context.epicLinkFieldId,
            requiredFields: issueType === "Bug" ? ["priority"] : [],
          });
    skills.push(
      await uploadBrowserSkill(
        opened.page,
        opened.region,
        markdown,
        `Browser-${context.projectKey}-${issueType}.md`,
        { project: context.projectKey, issueType },
      ),
    );
  }
  return skills;
}

async function formalRules(opened, context, turn) {
  const skills = await uploadFormalTypes(opened, context);
  const epics = await correctedEpic(opened, context, turn);
  const tasks = await correctedChild(opened, context, turn, "Task", epics[0].key);
  const bugs = await correctedChild(opened, context, turn, "Bug", epics[0].key);
  const subtaskMarkdown = templateMarkdown({
    project: context.projectKey,
    issueType: "Sub-task",
    rule: STRUCTURE_RULES.Task,
    parentField: "parent",
    parentIssueTypes: ["Task"],
  });
  skills.push(
    await uploadBrowserSkill(
      opened.page,
      opened.region,
      subtaskMarkdown,
      `Browser-${context.projectKey}-Sub-task.md`,
      { project: context.projectKey, issueType: "Sub-task", parentIssueTypes: ["Task"] },
    ),
  );
  await rejectedParentType(opened, context, turn, epics[0].key);
  const subtasks = await correctedChild(opened, context, turn, "Sub-task", tasks[0].key);
  // Re-observe the entire chain after Sub-task creation; a prompt is no parent-type rule.
  const freshTask = await projectAgileRead(
    context.session,
    `/rest/api/2/issue/${tasks[0].id}?fields=issuetype,${context.epicLinkFieldId}`,
  );
  assert.equal(freshTask.fields.issuetype.name, "Task");
  assert.equal(freshTask.fields[context.epicLinkFieldId], epics[0].key);
  for (const skill of skills) await removeBrowserSkill(opened.page, opened.region, skill);
  return [...epics, ...tasks, ...bugs, ...subtasks];
}

async function rejectedParentType(opened, context, turn, epicKey) {
  const before = await issues(context);
  const refused = await turn(
    `Erstelle genau einen Sub-task in ${context.projectKey} mit Titel '[LH-904] Elternregelprobe' und nativem parent ${epicKey}. ` +
      `Vollständige Beschreibungsabschnitte: ${STRUCTURE_RULES.Task.sections.join(", ")}. ` +
      "Jeder Abschnitt enthält 'Synthetische Browserprüfung.' Keine requirementIds. " +
      "Nutze genau diesen Create-Aufruf; ändere den Parent nicht vorab. Wenn die gespeicherte formale " +
      "Elterntypregel verweigert, melde sie und beende ohne weiteren Schreibversuch.",
    WRITE_TOOLS,
    {
      beforeDecision: () => {
        throw new TypeError("Disallowed native parent type reached approval");
      },
    },
  );
  assert.equal(
    gradeRuleRefusal({
      exchanges: refused.exchanges,
      before,
      after: await issues(context),
      template: `${context.projectKey}/Sub-task`,
      ruleId: "parent-type-mismatch",
    }),
    true,
  );
  await expect(
    opened.region.getByRole("list", { name: "Template rules not met", exact: true }).last(),
  ).toBeVisible();
}

async function proseSkill(opened, context, turn) {
  const skill = await uploadBrowserSkill(
    opened.page,
    opened.region,
    `# Browser prose convention\n\nEpics should carry the label ${PROSE_LABEL}.\n` +
      "This is prose guidance, without formal Jira template front matter.\n",
    `Browser-${context.projectKey}-Prose.md`,
    false,
  );
  const before = await issues(context);
  const result = await turn(
    "Für diese ausdrücklich gewünschte Ausnahme zur ausgewählten Prosa-Konvention: Erstelle genau " +
      `ein Epic im Projekt ${context.projectKey} mit Titel 'Browser prose exception', Beschreibung 'Bewusste Ausnahme ` +
      "von einem bloßen Prosa-Skill' und ohne Labels. Keine requirementIds, keine formalen Templates " +
      "anlegen. Melde den Schlüssel.",
    WRITE_TOOLS,
    { reviewText: [context.projectKey, "Browser prose exception"] },
  );
  const after = await issues(context);
  assert.equal(
    gradeProseBoundary({ exchanges: result.exchanges, before, after, forbiddenLabel: PROSE_LABEL }),
    true,
    "An active prose skill is not proof of a deterministic formal rule",
  );
  await removeBrowserSkill(opened.page, opened.region, skill);
  return newNativeIssues(before, after);
}

async function derivedEpics(opened, context, turn, documents) {
  await createBrowserKnowledgePod(opened.page, opened.region, documents);
  await uploadBrowserSkill(
    opened.page,
    opened.region,
    epicTemplateMarkdown(context.projectKey),
    `Browser-${context.projectKey}-Knowledge-Epic.md`,
    { project: context.projectKey, issueType: "Epic" },
  );
  const inventory = await turn(
    "Lies über das Anforderungswerkzeug das vollständige Inventar des verbundenen Wissens-Pods " +
      "ohne ID-, Prioritäts-, Dokument- oder Textfilter, Ansicht units, bis zum letzten Cursor. " +
      "Es enthält Word, PDF, Excel und PowerPoint mit derselben synthetischen Spezifikation. " +
      "Erhalte je Dokument die ID, Titel, Priorität und Abnahmekriterien; noch keine Jira-Schreibaktion.",
  );
  assert.equal(
    gradeDocumentInventory(inventory.exchanges, buildCorpus(1).truth),
    true,
    "All four real document formats require complete structured model retrieval",
  );
  const truth = buildCorpus(1).truth.filter((item) => new Set(["LH-001", "LH-002"]).has(item.id));
  const before = await issues(context);
  const created = await turn(
    `Leite jetzt genau zwei Epics im Jira-Projekt ${context.projectKey} ab, je eines für LH-001 und LH-002 aus dem ` +
      "gerade gelesenen Lastenheft. Mehrere Dateiformate beschreiben dieselben Anforderungen, " +
      "also keine Duplikate. Nutze die gültige Epic-Vorlage, übernimm alle Abnahmekriterien wörtlich " +
      "als lesbare Beschreibung und übergib je Epic eine passende dokumentgebundene requirementIds-Referenz " +
      "aus dem tatsächlichen Werkzeugergebnis. Benenne Dokument und Quellabschnitt lesbar; keine " +
      "erfundene Referenz. Nutze einzelne Jira-Create-Aufrufe und melde beide Schlüssel.",
    WRITE_TOOLS,
    { reviewText: [context.projectKey] },
  );
  const after = await issues(context);
  assert.equal(
    gradeDerivedEpics({
      before,
      after,
      truth,
      answer: created.answer,
      documentNames: documents.names,
      exchanges: created.exchanges,
      inventoryExchanges: inventory.exchanges,
    }),
    true,
  );
  return newNativeIssues(before, after);
}

async function epicVisibility(context, turn, created, boardId) {
  const answer = await turn(
    `Lies die Epic-Liste und das Backlog von Board ${boardId} vollständig über die Jira-Werkzeuge. ` +
      `Prüfe die neu erstellten Epics ${created.map((issue) => issue.key).join(", ")}. ` +
      "Erkläre anhand der getrennten Resultate, warum Sichtbarkeit als Board-Epic nicht dasselbe " +
      "wie ein Backlogeintrag ist. Keine Schreibaktion und keine fehlende Epic-Existenz aus dem Backlog ableiten.",
  );
  const read = (path) => projectAgileRead(context.session, path);
  const boardEpics = await nativePages(read, `/rest/agile/1.0/board/${boardId}/epic`, "values");
  const backlog = await nativePages(read, `/rest/agile/1.0/board/${boardId}/backlog`, "issues");
  assert.equal(
    gradeEpicVisibility({ created, boardEpics, backlog, exchanges: answer.exchanges, boardId }),
    true,
  );
}

async function retainedIssueLinks(opened, created, session) {
  await opened.page.reload();
  const lists = opened.region.getByRole("list", { name: "Jira results", exact: true });
  for (const issue of created) {
    const link = lists.getByRole("link").filter({ hasText: issue.key }).first();
    await link.waitFor();
    const url = new URL(await link.getAttribute("href"));
    assert.equal(url.origin, labSessionConnection(session).httpsOrigin);
    assert.equal(url.pathname, `/browse/${issue.key}`);
    assert.equal(url.search + url.hash, "");
  }
}

export async function runBrowserRulesKnowledge(live, { boardId, intentPath, projectKey }) {
  assert.match(projectKey, /^[A-Z][A-Z0-9_]*$/u, "A runtime Jira project key is required");
  const fields = await projectAgileRead(live.session, "/rest/api/2/field");
  assert.ok(Array.isArray(fields));
  const epicLinks = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
  );
  assert.equal(
    epicLinks.length,
    1,
    "The laboratory needs one independently observed native Epic Link field",
  );
  assert.match(epicLinks[0].id, /^customfield_[1-9][0-9]*$/u);
  const context = { ...live, projectKey, epicLinkFieldId: epicLinks[0].id };
  const opened = await openWorkflowBrowser(context);
  const turn = turnRunner(opened, context, intentPath);
  try {
    const formal = await formalRules(opened, context, turn);
    const prose = await proseSkill(opened, context, turn);
    const documents = browserKnowledgeDocuments(context.projectPath);
    const epics = await derivedEpics(opened, context, turn, documents);
    await epicVisibility(context, turn, epics, boardId);
    await retainedIssueLinks(opened, [...formal, ...prose, ...epics], context.session);
    await opened.region.screenshot({
      path: join(context.session.directory, "browser-rules-knowledge.png"),
    });
    return {
      formalRefused: true,
      correctedAccepted: true,
      formalIssueTypes: 4,
      proseNotEnforced: true,
      observedSubtaskTaskEpicChain: true,
      taskParentTypeRuleSupported: true,
      podCreatedThroughUi: true,
      sourcesConnectedThroughUi: true,
      documents: documents.names.length,
      epics: epics.length,
      independentNativeFields: true,
      readableSourceReferences: true,
      epicVisibilityDistinctFromBacklog: true,
      persistedResultLinks: true,
    };
  } finally {
    await opened.browser.close();
  }
}
