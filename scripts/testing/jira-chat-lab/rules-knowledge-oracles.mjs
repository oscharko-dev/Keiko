// Independent acceptance oracles. Model prose alone never proves an effect or a refusal.
import { epicConforms, gradeBacklog, sectionsPresent } from "./requirements/oracles.mjs";
import { STRUCTURE_RULES } from "./requirements/corpus.mjs";
import { gradeFormatInventory, FORMATS } from "./requirements/formats.mjs";
import { completedToolExchange, toolExchangeOf } from "./requirements/tool-exchanges.mjs";

const CONTENT_RULES = new Set([
  "summary-pattern",
  "section-missing",
  "section-empty",
  "label-missing",
]);

export function newNativeIssues(before, after) {
  const previous = new Set(before.map((issue) => issue.id));
  return after.filter((issue) => !previous.has(issue.id));
}

function formalViolation(exchange, template, ruleId) {
  if (!toolExchangeOf(exchange, "jira.create")) return false;
  const data = exchange.result?.data;
  return (
    data?.outcome === "rejected" &&
    data.reason === "field-validation" &&
    data.issueKey === undefined &&
    data.issueId === undefined &&
    data.violations?.some(
      (violation) =>
        (ruleId === undefined
          ? CONTENT_RULES.has(violation.ruleId)
          : violation.ruleId === ruleId) &&
        violation.template?.toLowerCase() === template.toLowerCase(),
    ) === true
  );
}

/** Even a real refusal is insufficient if another call created an issue in the same turn. */
export function gradeRuleRefusal({ exchanges, before, after, template, ruleId }) {
  return (
    exchanges.some((exchange) => formalViolation(exchange, template, ruleId)) &&
    !exchanges.some((exchange) => exchange.effectStarted === true) &&
    newNativeIssues(before, after).length === 0 &&
    JSON.stringify(before) === JSON.stringify(after)
  );
}

function correctedParentFields(issue, issueType, parentKey, epicLinkFieldId) {
  if (issueType === "Sub-task")
    return issue.fields.issuetype.subtask === true && issue.fields.parent?.key === parentKey;
  if (issue.fields[epicLinkFieldId] !== parentKey) return false;
  return issueType !== "Bug" || typeof issue.fields.priority?.id === "string";
}
function correctedFields(issue, { requirementId, issueType, parentKey, epicLinkFieldId }) {
  if (issue.fields.issuetype?.name !== issueType) return false;
  if (issueType === "Epic") return epicConforms(issue, requirementId);
  if (!issue.fields.summary.startsWith(`[${requirementId}]`)) return false;
  const rule = issueType === "Sub-task" ? STRUCTURE_RULES.Task : STRUCTURE_RULES[issueType];
  if (!sectionsPresent(issue.fields.description, rule.sections)) return false;
  return correctedParentFields(issue, issueType, parentKey, epicLinkFieldId);
}

export function gradeCorrectedCreate({
  exchanges,
  before,
  after,
  requirementId,
  issueType = "Epic",
  parentKey,
  epicLinkFieldId,
}) {
  const created = newNativeIssues(before, after);
  if (
    created.length !== 1 ||
    !correctedFields(created[0], { requirementId, issueType, parentKey, epicLinkFieldId })
  )
    return false;
  return exchanges.some(
    (exchange) =>
      completedToolExchange(exchange, "jira.create") &&
      exchange.result.data?.outcome === "succeeded" &&
      exchange.result.data.issueKey === created[0].key,
  );
}

/** A prose-only skill is active, yet its invented label requirement is not a native gate. */
export function gradeProseBoundary({ exchanges, before, after, forbiddenLabel }) {
  const created = newNativeIssues(before, after);
  return (
    created.length === 1 &&
    Array.isArray(created[0].fields.labels) &&
    !created[0].fields.labels.includes(forbiddenLabel) &&
    exchanges.some(
      (exchange) =>
        completedToolExchange(exchange, "jira.create") &&
        exchange.result.data?.outcome === "succeeded" &&
        exchange.result.data.issueKey === created[0].key,
    ) &&
    !exchanges.some((exchange) => exchange.result?.data?.violations?.length > 0)
  );
}

function inventoryPage(exchange) {
  if (!completedToolExchange(exchange, "knowledge.requirements")) return false;
  const args = exchange.call.arguments ?? {};
  const filtered = ["ids", "query", "priorities", "documents"].some((key) =>
    typeof args[key] === "string" ? args[key].length > 0 : args[key]?.length > 0,
  );
  return (
    !filtered &&
    exchange.result.data?.outcome === "succeeded" &&
    exchange.result.data.view === "units"
  );
}

/** A terminal page from a different query cannot complete a missing middle page. */
export function completeRequirementPages(exchanges) {
  const pages = exchanges.filter(inventoryPage);
  const chain = [];
  const seen = new Set();
  let cursor;
  for (;;) {
    const page = pages.find((item) => item.call.arguments?.cursor === cursor);
    if (page === undefined || seen.has(page)) return undefined;
    chain.push(page);
    seen.add(page);
    const next = page.result.data.nextCursor;
    if (next === undefined) return chain;
    if (typeof next !== "string" || next.length === 0) return undefined;
    cursor = next;
  }
}

function completeCriteria(items, truth, extension) {
  return truth.every((requirement) =>
    items.some((item) => {
      if (item.id !== requirement.id || !item.documentName?.endsWith(extension)) return false;
      if (item.criteriaTruncated === true || item.statementTruncated === true) return false;
      const criteria = item.acceptanceCriteria?.map((criterion) => criterion.text);
      return JSON.stringify(criteria) === JSON.stringify(requirement.acceptance);
    }),
  );
}

export function gradeDocumentInventory(exchanges, truth) {
  const pages = completeRequirementPages(exchanges);
  if (pages === undefined || pages.at(-1).result.data.totals?.documentsNotExtracted !== 0)
    return false;
  const items = pages.flatMap((page) => page.result.data.items);
  return FORMATS.every(
    ({ extension }) =>
      gradeFormatInventory({ exchanges: pages, truth, extension }).status === "green" &&
      completeCriteria(items, truth, extension),
  );
}

function readableTrace(issue, requirement, documentNames) {
  const description = issue.fields.description;
  return (
    typeof description === "string" &&
    description.includes("Keiko traceability") &&
    description.includes("End of Keiko traceability") &&
    documentNames.some((name) => description.includes(name)) &&
    description.includes(requirement.id) &&
    requirement.acceptance.every((criterion) => description.includes(criterion))
  );
}

function tracedCreate(exchanges, inventory, issue, requirementId) {
  const references = new Set(
    inventory.filter((item) => item.id === requirementId).map((item) => item.reference),
  );
  return exchanges.some((exchange) => {
    const selected = exchange.call.arguments?.requirementIds;
    return (
      completedToolExchange(exchange, "jira.create") &&
      exchange.result.data?.outcome === "succeeded" &&
      exchange.result.data.issueKey === issue.key &&
      Array.isArray(selected) &&
      selected.length > 0 &&
      selected.every(
        (reference) =>
          typeof reference === "string" &&
          references.has(reference) &&
          issue.fields.description.includes(`Reference: ${reference}`),
      )
    );
  });
}

export function gradeDerivedEpics({
  before,
  after,
  truth,
  answer,
  documentNames,
  exchanges,
  inventoryExchanges,
}) {
  const created = newNativeIssues(before, after);
  const inventory =
    completeRequirementPages(inventoryExchanges)?.flatMap((page) => page.result.data.items) ?? [];
  const backlog = gradeBacklog({ requested: truth.map((item) => item.id), created, answer });
  return (
    backlog.mappingOk &&
    backlog.namesOk &&
    truth.every((requirement) => {
      const issue = created.find((item) => item.fields.summary.startsWith(`[${requirement.id}]`));
      return (
        issue?.fields.issuetype?.name === "Epic" &&
        epicConforms(issue, requirement.id) &&
        readableTrace(issue, requirement, documentNames) &&
        tracedCreate(exchanges, inventory, issue, requirement.id)
      );
    })
  );
}

/** Epics can belong to a board while its backlog lists schedulable issues separately. */
export function gradeEpicVisibility({ created, boardEpics, backlog, exchanges, boardId }) {
  if (created.length === 0) return false;
  const visible = new Set(boardEpics.map((issue) => String(issue.id)));
  const queued = new Set(backlog.map((issue) => String(issue.id)));
  const observedReads = ["jira.board-epics", "jira.board-backlog"].every((operation) =>
    exchanges.some(
      (exchange) =>
        completedToolExchange(exchange, operation) &&
        String(exchange.call.arguments?.boardId) === boardId,
    ),
  );
  return (
    observedReads &&
    created.every((issue) => visible.has(String(issue.id)) && !queued.has(String(issue.id)))
  );
}
