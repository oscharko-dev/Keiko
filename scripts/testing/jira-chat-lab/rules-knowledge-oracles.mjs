// Independent acceptance oracles. Model prose alone never proves an effect or a refusal.
import { createHash } from "node:crypto";
import { canonicalDesktopChatTurnReferenceSeed } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import {
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MANAGED_ACTION_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { matchingJiraIssueTemplates } from "@oscharko-dev/keiko-connectors";
import { KNOWLEDGE_CHAT_TOOLS } from "../../../packages/keiko-server/dist/requirementsToolName.js";
import { workflowHistory } from "./browser-workflow-turn.mjs";
import { checkNativeIssueTemplates } from "./requirements/deviation-report.mjs";
import { readInstalledTemplateScope } from "./requirements/progress-simulation.mjs";
import {
  goldenProjectKey,
  goldenRequirementTraceReference,
  gradeGoldenEpics,
  loadGoldenManifest,
  readGoldenIssues,
  validateGoldenManifest,
} from "./requirements/golden-jira-oracle.mjs";
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

function rejectedCreateReceipt(exchange) {
  if (!toolExchangeOf(exchange, "jira.create")) return false;
  const { result } = exchange;
  return (
    result.status === "failed" &&
    result.reason === "provider-reported-error" &&
    result.effectStarted === false &&
    (exchange.mutationOutcome === undefined ||
      new Set(["rejected", "not-dispatched"]).has(exchange.mutationOutcome))
  );
}

function formalViolation(exchange, template, ruleId) {
  if (!rejectedCreateReceipt(exchange)) return false;
  const data = exchange.result.data;
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
    exchanges.every(terminalWithoutWrite) &&
    newNativeIssues(before, after).length === 0 &&
    JSON.stringify(before) === JSON.stringify(after)
  );
}

function correctedChildContext(issue, { issueType, parentKey, epicLinkFieldId }) {
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
  return correctedChildContext(issue, { issueType, parentKey, epicLinkFieldId });
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

const BULK_STEP = "ac1-bulk-refusals";
const BULK_RULES = new Set(JIRA_TEMPLATE_RULE_IDS);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function bulkInput(ctx, seeded) {
  goldenProjectKey(ctx.projectKey);
  const manifest = ctx.truth ?? loadGoldenManifest();
  const requirements = validateGoldenManifest(manifest);
  const known = new Set(requirements.map((item) => item.id));
  if (
    !Array.isArray(seeded) ||
    seeded.length < Math.ceil(requirements.length * 0.1) ||
    seeded.length > Math.floor(requirements.length * 0.15)
  )
    throw new TypeError("The deliberate violation selection is unavailable");
  if (
    !seeded.every((item) => known.has(item?.requirementId) && BULK_RULES.has(item?.ruleId)) ||
    new Set(seeded.map((item) => item.requirementId)).size !== seeded.length
  )
    throw new TypeError("The deliberate violation identities are unavailable");
  return {
    manifest,
    requirements,
    seeded: seeded.map(({ requirementId, ruleId }) => ({ requirementId, ruleId })),
  };
}

function bulkResult(ctx, status, counts, reason) {
  return {
    step: BULK_STEP,
    status,
    detail: reason,
    counts,
    ...(nonempty(ctx.intent?.path) ? { evidenceFile: ctx.intent.path } : {}),
  };
}

function fieldCatalog(value) {
  if (
    !Array.isArray(value) ||
    !value.every((field) => nonempty(field?.id) && nonempty(field?.name))
  )
    throw new TypeError("Native field metadata is unavailable");
  return value.map(({ id, name }) => ({ id, name }));
}

async function bulkNativeEvidence(ctx, input) {
  const [issues, fields, templateScope] = await Promise.all([
    readGoldenIssues(ctx.read, ctx.projectKey, { signal: ctx.signal }),
    ctx.read("/rest/api/2/field"),
    readInstalledTemplateScope(ctx),
  ]);
  ctx.signal.throwIfAborted();
  if (templateScope.project !== ctx.projectKey)
    throw new TypeError("Native template scope changed");
  const truth = { project: ctx.projectKey, templateScope, fieldCatalog: fieldCatalog(fields) };
  const rows = await checkNativeIssueTemplates(issues, truth);
  if (rows === undefined) throw new TypeError("Native rule evidence is unavailable");
  const grade = gradeGoldenEpics({ manifest: input.manifest, issues, projectKey: ctx.projectKey });
  const counts = {
    seededCount: input.seeded.length,
    nativeIssueCount: issues.length,
    withoutTemplateCount: rows.filter((row) => !row.covered).length,
    violatingIssueCount: rows.filter((row) => row.violations.length > 0).length,
    violationCount: rows.reduce((sum, row) => sum + row.violations.length, 0),
    duplicateRequirementCount: grade.counts.duplicateRequirementCount,
    missingRequirementCount: grade.counts.missingCount,
  };
  return { issues, truth, grade, counts, rows };
}

function bulkBinding(ctx, input, truth) {
  const seeds = [...input.seeded].sort((left, right) =>
    left.requirementId.localeCompare(right.requirementId),
  );
  return hash(
    JSON.stringify({
      projectKey: ctx.projectKey,
      chatId: ctx.chat.id,
      seeds,
      manifest: input.manifest,
      templates: truth.templateScope.templates
        .map(({ id, revision, sha256 }) => ({ id, revision, sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

function bulkAnchors(ctx, saved, input) {
  if (
    saved?.projectKey !== ctx.projectKey ||
    saved.chatId !== ctx.chat.id ||
    !Array.isArray(saved.refusals) ||
    saved.refusals.length !== input.seeded.length
  )
    throw new TypeError("The current bulk turn handoff is unavailable");
  const expected = new Map(input.seeded.map((item) => [item.requirementId, item.ruleId]));
  const anchors = saved.refusals;
  const valid = anchors.every(
    (item) =>
      expected.has(item?.requirementId) &&
      expected.get(item.requirementId) === item.ruleId &&
      typeof item.clientTurnId === "string" &&
      /^[0-9a-f-]{36}$/u.test(item.clientTurnId),
  );
  if (
    !valid ||
    new Set(anchors.map((item) => item.requirementId)).size !== expected.size ||
    new Set(anchors.map((item) => item.clientTurnId)).size !== expected.size
  )
    throw new TypeError("The current bulk turn binding is ambiguous");
  return anchors;
}

function historyTurns(history, chatId) {
  const messages = history?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length >= 500 ||
    messages.some((item) => item.chatId !== chatId || !nonempty(item.id)) ||
    new Set(messages.map((item) => item.id)).size !== messages.length
  )
    throw new TypeError("Complete stored turn evidence is unavailable");
  return messages.filter((item) => item.role === "user");
}

function anchoredTurn(turns, chatId, anchor) {
  const reference = hash(canonicalDesktopChatTurnReferenceSeed(chatId, anchor.clientTurnId));
  const matches = turns.filter((turn) => turn.canonicalTurnRef === reference);
  if (
    matches.length !== 1 ||
    matches[0].turnState !== "completed" ||
    !Array.isArray(matches[0].toolTranscript?.exchanges)
  )
    throw new TypeError("The anchored turn is unavailable");
  return matches[0];
}

function requirementNativeIssue(native, requirementId) {
  const mapping = native.grade.privateMappings.find((item) => item.requirementId === requirementId);
  return native.issues.find((issue) => String(issue.id) === mapping?.id);
}

function refusalTarget(exchange, issue, requirement, projectKey) {
  const args = exchange.call?.arguments;
  const reference = goldenRequirementTraceReference(issue.fields.description, requirement);
  return (
    nativeCreateTarget(args, issue, projectKey) &&
    nonempty(reference) &&
    Array.isArray(args.requirementIds) &&
    args.requirementIds.length === 1 &&
    args.requirementIds[0] === reference
  );
}

function nativeCreateTarget(args, issue, projectKey) {
  return (
    nonempty(args?.projectId) &&
    nonempty(args?.issueTypeId) &&
    new Set([projectKey, issue.fields.project.id]).has(args.projectId) &&
    new Set([issue.fields.issuetype.id, issue.fields.issuetype.name]).has(args.issueTypeId)
  );
}

function nativeTemplateNames(native, issue, projectKey) {
  return matchingJiraIssueTemplates(
    native.truth.templateScope.templates.map((item) => item.rules),
    {
      operation: "create",
      projectKey,
      issueType: issue.fields.issuetype,
      fields: issue.fields,
    },
  ).map((template) => `${template.project}/${template.issueType}`);
}

const BULK_READ_IDS = new Set(
  [...JIRA_MANAGED_READ_TOOLS, ...KNOWLEDGE_CHAT_TOOLS].map((name) => `keiko.${name}`),
);
const BULK_WRITE_IDS = new Set(
  Object.keys(JIRA_MANAGED_ACTION_TYPES)
    .map((name) => `keiko.${name}`)
    .filter((name) => !BULK_READ_IDS.has(name)),
);

function terminalWithoutWrite(exchange) {
  const result = exchange.result;
  if (exchange.effectStarted === true || typeof result?.effectStarted !== "boolean") return false;
  const canonicalId = result.toolRef?.canonicalId;
  if (BULK_READ_IDS.has(canonicalId))
    return (
      result.status === "completed" &&
      result.reason === "none" &&
      exchange.mutationOutcome === undefined
    );
  return terminalRefusedWrite(exchange);
}

function terminalRefusedWrite(exchange) {
  const { result } = exchange;
  const canonicalId = result.toolRef?.canonicalId;
  if (
    exchange.mutationOutcome !== undefined &&
    !new Set(["rejected", "not-dispatched"]).has(exchange.mutationOutcome)
  )
    return false;
  return (
    BULK_WRITE_IDS.has(canonicalId) &&
    result.effectStarted === false &&
    new Set(["completed", "failed", "denied", "cancelled"]).has(result.status)
  );
}

function settledWithoutEffects(turn) {
  const exchanges = turn.toolTranscript.exchanges;
  return (
    exchanges.every(terminalWithoutWrite) &&
    exchanges.every(
      (exchange) => nonempty(exchange.result.invocationId) && nonempty(exchange.call?.id),
    ) &&
    new Set(exchanges.map((exchange) => exchange.result.invocationId)).size === exchanges.length &&
    new Set(exchanges.map((exchange) => exchange.call.id)).size === exchanges.length
  );
}

function turnRefusal(ctx, turn, anchor, input, native) {
  const exchanges = turn.toolTranscript.exchanges;
  const creates = exchanges.filter((exchange) => toolExchangeOf(exchange, "jira.create"));
  if (
    exchanges.some(
      (exchange) =>
        BULK_WRITE_IDS.has(exchange.result?.toolRef?.canonicalId) &&
        exchange.result.effectStarted === true,
    )
  )
    return { status: "red", reason: "A protected probe reports a started effect" };
  if (creates.length > 1)
    return { status: "red", reason: "A protected probe contains repeated native create attempts" };
  if (creates.length !== 1 || !settledWithoutEffects(turn))
    throw new TypeError("The terminal no-effect receipt is unavailable");
  const exchange = creates[0];
  const issue = requirementNativeIssue(native, anchor.requirementId);
  const requirement = input.requirements.find((item) => item.id === anchor.requirementId);
  const templates = nativeTemplateNames(native, issue, ctx.projectKey);
  if (
    !refusalTarget(exchange, issue, requirement, ctx.projectKey) ||
    !templates.some((template) => formalViolation(exchange, template, anchor.ruleId))
  )
    throw new TypeError("The exact native-bound formal refusal is unavailable");
  if (!nonempty(exchange.result.invocationId) || !nonempty(exchange.call?.id))
    throw new TypeError("The invocation identity is unavailable");
  return {
    requirementId: anchor.requirementId,
    ruleId: anchor.ruleId,
    canonicalTurnRef: turn.canonicalTurnRef,
    invocationId: exchange.result.invocationId,
    callId: exchange.call.id,
    issueId: String(issue.id),
    issueKey: issue.key,
  };
}

function completeBulkRefusals(ctx, turns, anchors, input, native) {
  const proofs = [];
  for (const anchor of anchors) {
    const turn = anchoredTurn(turns, ctx.chat.id, anchor);
    const proof = turnRefusal(ctx, turn, anchor, input, native);
    if (proof.status === "red") return proof;
    proofs.push(proof);
  }
  for (const name of ["invocationId", "canonicalTurnRef"]) {
    if (new Set(proofs.map((proof) => proof[name])).size !== proofs.length)
      throw new TypeError("A refusal invocation was reused");
  }
  return { proofs };
}

async function recordBulkResult(ctx, saved, binding, result, observations = {}) {
  ctx.signal.throwIfAborted();
  await ctx.intent.record(BULK_STEP, {
    ...saved,
    projectKey: ctx.projectKey,
    chatId: ctx.chat.id,
    binding,
    result,
    ...observations,
  });
  return result;
}

async function observeBulkRefusals(ctx, input, saved, native) {
  const binding = bulkBinding(ctx, input, native.truth);
  if (saved?.binding !== undefined && saved.binding !== binding)
    throw new TypeError("The saved bulk evidence binding changed");
  const anchors = bulkAnchors(ctx, saved, input);
  const history = await workflowHistory(ctx, ctx.chat.id, { limit: 500 });
  ctx.signal.throwIfAborted();
  const verified = completeBulkRefusals(
    ctx,
    historyTurns(history, ctx.chat.id),
    anchors,
    input,
    native,
  );
  if (verified.status === "red")
    return recordBulkResult(
      ctx,
      saved,
      binding,
      bulkResult(ctx, "red", native.counts, verified.reason),
    );
  if (!confirmedBulkCorrections(historyTurns(history, ctx.chat.id), verified.proofs))
    throw new TypeError("Later confirmed native corrections are unavailable");
  const currentScope = await readInstalledTemplateScope(ctx);
  if (bulkBinding(ctx, input, { templateScope: currentScope }) !== binding)
    throw new TypeError("Formal templates changed during verification");
  const counts = {
    ...native.counts,
    refusedCount: verified.proofs.length,
    correctedCount: verified.proofs.length,
  };
  return recordBulkResult(
    ctx,
    saved,
    binding,
    bulkResult(
      ctx,
      "green",
      counts,
      "Native corrections and anchored no-effect rule refusals match exactly",
    ),
    { proofs: verified.proofs, nativeDigest: hash(JSON.stringify(native.issues)) },
  );
}

/** Read-only AC1 oracle. Seeds are expectations; only native facts and stored receipts prove them. */
function requireBulkOwner(ctx) {
  if (!nonempty(ctx.chat?.id) || typeof ctx.intent?.record !== "function")
    throw new TypeError("The existing evidence owner is unavailable");
}

export async function gradeBulkRefusals(ctx, { seeded } = {}) {
  let counts = {};
  try {
    ctx.signal.throwIfAborted();
    requireBulkOwner(ctx);
    const input = bulkInput(ctx, seeded);
    counts = { seededCount: input.seeded.length };
    const saved = ctx.intent.state[BULK_STEP];
    const native = await bulkNativeEvidence(ctx, input);
    counts = native.counts;
    if (
      !native.grade.ok ||
      counts.violatingIssueCount > 0 ||
      native.grade.counts.epicCount !== counts.nativeIssueCount
    )
      return bulkResult(
        ctx,
        "red",
        counts,
        "Independent native corrections or formal rules do not match",
      );
    if (counts.withoutTemplateCount > 0)
      return bulkResult(ctx, "unverified", counts, "Native template coverage is incomplete");
    return await observeBulkRefusals(ctx, input, saved, native);
  } catch {
    return bulkResult(
      ctx,
      "unverified",
      counts,
      "Complete native facts or anchored refusal evidence is unavailable",
    );
  }
}

/** Draft rows carry a confirmed key; only the single-create receipt also carries an issue ID. */
function creationResult(exchange) {
  const result = exchange.result;
  if (result === undefined) return undefined;
  const data = result.data;
  const completed = result.status === "completed" && result.reason === "none";
  const partial = result.status === "failed" && result.reason === "provider-reported-error";
  if ((!completed && !partial) || result.effectStarted !== true || data?.replayed === true)
    return undefined;
  return result;
}

function bulkCreationReceipts(exchange) {
  const result = creationResult(exchange);
  if (result === undefined) return [];
  const data = result.data;
  if (toolExchangeOf(exchange, "jira.create")) {
    if (result.status !== "completed" || data?.outcome !== "succeeded") return [];
    return [{ kind: "create", issueId: data.issueId, issueKey: data.issueKey }];
  }
  if (!toolExchangeOf(exchange, "jira.draft") || !Array.isArray(data?.items)) return [];
  return data.items
    .filter((item) => item?.state === "created")
    .map((item) => ({ kind: "draft", issueKey: item.issueKey }));
}

/** History order is the product's timestamp/row order; replayed/existing rows are not creations. */
function confirmedBulkCorrections(turns, proofs) {
  const creations = turns.flatMap((turn, turnIndex) => {
    if (turn.turnState !== "completed") return [];
    const exchanges = turn.toolTranscript?.exchanges ?? [];
    return exchanges.flatMap((exchange) =>
      bulkCreationReceipts(exchange).map((receipt) => ({ ...receipt, turnIndex })),
    );
  });
  return proofs.every((proof) => {
    const refusalIndex = turns.findIndex(
      (turn) => turn.canonicalTurnRef === proof.canonicalTurnRef,
    );
    const matches = creations.filter((receipt) => receipt.issueKey === proof.issueKey);
    const [created] = matches;
    return (
      refusalIndex >= 0 &&
      matches.length === 1 &&
      created.turnIndex > refusalIndex &&
      (created.kind === "draft" || created.issueId === proof.issueId)
    );
  });
}
