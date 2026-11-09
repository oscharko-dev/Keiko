// Ordinary visible Chat turns create the Epics; independent native reads grade every batch.
import { createHash } from "node:crypto";
import {
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_TEMPLATE_RULE_IDS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { privateJson } from "./private-json.mjs";
import { gradeRuleRefusal } from "./rules-knowledge-oracles.mjs";
import { toolExchangeOf } from "./requirements/tool-exchanges.mjs";
import { EPIC_SUMMARY_VIOLATION } from "./requirements/templates.mjs";
import {
  GOLDEN_ACCEPTANCE_COUNT,
  GOLDEN_REQUIREMENT_COUNT,
  GOLDEN_NO_CRITERIA_TEXT,
  goldenJiraReadAdapter,
  goldenProjectKey,
  gradeGoldenEpics,
  gradeGoldenEpicViews,
  loadGoldenManifest,
  readGoldenBoardViews,
  readGoldenIssues,
  validateGoldenManifest,
} from "./requirements/golden-jira-oracle.mjs";

const STEP = "ac2-bulk-epics";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requireFact(condition, message) {
  if (!condition) throw new TypeError(message);
}

function batchPrompt(projectKey, requirements) {
  return [
    `Create exactly one Epic in Jira project ${projectKey} for each of the following requirements, and no others.`,
    "Use the actual connected Knowledge source and the installed Epic template. Read all required source pages.",
    "The exact summary is [requirement ID] followed by its complete original title. Preserve every acceptance criterion verbatim as its own list item, including false, zero and empty-value semantics.",
    `When the source supplies zero acceptance criteria, put the prose "${GOLDEN_NO_CRITERIA_TEXT}" under Acceptance criteria. Do not invent a criterion or a list item.`,
    "Bind requirementIds to the one requirement belonging to each Epic so the product writes its own Keiko traceability footer. Preserve the complete section path or exact source page range. Cross-references are not additional requirements to create.",
    "Use the ordinary reviewed draft/create actions. Do not create duplicates, silently omit requirements, retry uncertain writes, or write through another channel.",
    ...requirements.map((requirement) => `[${requirement.id}] ${requirement.title}`),
  ].join("\n");
}

export function planEpicBatches(manifest, { projectKey, batchSize = 20 } = {}) {
  goldenProjectKey(projectKey);
  const requirements = validateGoldenManifest(manifest);
  requireFact(
    Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= JIRA_DRAFT_PAGE_ITEMS_MAX,
    "Bulk Epic batch size exceeds the existing draft bound",
  );
  const batches = [];
  for (let offset = 0; offset < requirements.length; offset += batchSize) {
    const selected = requirements.slice(offset, offset + batchSize);
    const requirementIds = selected.map((requirement) => requirement.id);
    batches.push({
      index: batches.length,
      identity: digest({ projectKey, requirementIds }),
      requirementIds,
      count: selected.length,
      acceptanceCriteriaCount: selected.reduce(
        (sum, requirement) => sum + requirement.acceptanceCriteria.length,
        0,
      ),
      prompt: batchPrompt(projectKey, selected),
    });
  }
  return batches;
}

export function planDeliberateViolations(
  manifest,
  { projectKey, violationRate = 0.125, bulkViolation } = {},
) {
  goldenProjectKey(projectKey);
  const requirements = validateGoldenManifest(manifest);
  requireFact(
    Number.isFinite(violationRate) && violationRate >= 0.1 && violationRate <= 0.15,
    "Bulk violation rate must be between ten and fifteen percent of requirements",
  );
  requireFact(
    typeof bulkViolation?.prompt === "string" &&
      bulkViolation.prompt.trim().length > 0 &&
      JIRA_TEMPLATE_RULE_IDS.includes(bulkViolation.ruleId),
    "Observed installed-template violation metadata is required",
  );
  const count = Math.floor(requirements.length * violationRate);
  return Array.from({ length: count }, (_, index) => {
    const requirement = requirements[Math.floor((index * requirements.length) / count)];
    return {
      requirementId: requirement.id,
      ruleId: bulkViolation.ruleId,
      template: bulkViolation.template ?? `${projectKey}/Epic`,
      identity: digest({ projectKey, violation: requirement.id, ruleId: bulkViolation.ruleId }),
      prompt: [
        `Attempt exactly one ordinary jira.create for Epic [${requirement.id}] ${requirement.title} in project ${projectKey}.`,
        // Data Center requires an Epic Name; without one field admission refuses before the rule.
        `Set the Epic Name Jira requires to ${requirement.id}.`,
        "Use its complete actual source and template except for this deliberate formal violation:",
        bulkViolation.prompt,
        "Expose the real formal rule refusal. Do not correct the proposal, retry, create a replacement, or perform any other write in this turn.",
      ].join("\n"),
    };
  });
}

function stateWriter(options) {
  requireFact(
    typeof options.onState === "function" || typeof options.privateStatePath === "string",
    "A separate private bulk intent sink is required",
  );
  let first = true;
  return async (state) => {
    const captured = structuredClone(state);
    if (options.privateStatePath !== undefined)
      privateJson(options.privateStatePath, captured, first);
    first = false;
    await options.onState?.(captured);
  };
}

function batchState(state, batch, phase, kind = "batch") {
  return {
    ...state,
    phase,
    current: {
      kind,
      identity: batch.identity,
      index: batch.index ?? 0,
      requirementIds: batch.requirementIds ?? [batch.requirementId],
    },
  };
}

async function deliberateViolation(ctx, options, target, state, persist) {
  const before = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
  let next = batchState(state, target, "prepared", "violation");
  await persist(next);
  await ctx.checkLicense?.();
  next = { ...next, phase: "submission-may-have-started" };
  await persist(next);
  const turn = await ctx.turn(options.chat, target.prompt, { operations: ["jira.create"] });
  const after = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
  const exchanges = turn.toolExchanges ?? turn.exchanges;
  requireFact(Array.isArray(exchanges), "Visible violation turn evidence is unavailable");
  requireFact(
    exchanges.filter((exchange) => toolExchangeOf(exchange, "jira.create")).length === 1,
    "A deliberate violation must have exactly one real create attempt",
  );
  requireFact(
    gradeRuleRefusal({
      exchanges,
      before,
      after,
      template: target.template,
      ruleId: target.ruleId,
    }),
    "Deliberate formal violation was not independently refused without effects",
  );
  next = {
    ...next,
    phase: "observed",
    refusedCount: state.refusedCount + 1,
    refusals: [
      ...state.refusals,
      {
        requirementId: target.requirementId,
        ruleId: target.ruleId,
        clientTurnId: turn.clientTurnId ?? null,
        nativeBeforeCount: before.length,
        nativeAfterCount: after.length,
      },
    ],
  };
  await persist(next);
  return next;
}

async function executeBatch(ctx, options, batch, state, persist) {
  ctx.signal?.throwIfAborted();
  let next = batchState(state, batch, "prepared");
  await persist(next);
  await options.beforeBatch?.({
    ctx,
    batch,
    progress: state.coveredIds.length / options.manifest.requirementCount,
  });
  await ctx.checkLicense?.();
  next = { ...next, phase: "submission-may-have-started" };
  await persist(next);
  await ctx.turn(options.chat, batch.prompt, { operations: ["jira.draft", "jira.create"] });
  const issues = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
  const coveredIds = [...state.coveredIds, ...batch.requirementIds];
  const grade = gradeGoldenEpics({
    manifest: options.manifest,
    issues,
    projectKey: options.projectKey,
    requirementIds: coveredIds,
  });
  requireFact(grade.ok, "Native bulk Epic batch does not match its complete manifest prefix");
  next = {
    ...next,
    phase: "observed",
    coveredIds,
    privateMappings: grade.privateMappings,
    observedCounts: grade.counts,
    completedBatches: state.completedBatches + 1,
  };
  await persist(next);
  await options.afterBatch?.({
    ctx,
    batch,
    progress: coveredIds.length / options.manifest.requirementCount,
  });
  return next;
}

/** A low-level browser hook; every write is delegated to the existing visible ctx.turn owner. */
export async function runBrowserEpicsBulk(ctx, options) {
  requireFact(typeof ctx.turn === "function", "An ordinary browser turn owner is required");
  const persist = stateWriter(options);
  const batches = planEpicBatches(options.manifest, options);
  const violations = options.violations ?? [];
  let state = {
    schemaVersion: 1,
    step: STEP,
    projectKey: options.projectKey,
    phase: "prepared",
    seeded: violations.map(({ requirementId, ruleId }) => ({ requirementId, ruleId })),
    refusals: [],
    refusedCount: 0,
    completedBatches: 0,
    coveredIds: [],
    privateMappings: [],
  };
  await persist(state);
  const before = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
  requireFact(
    gradeGoldenEpics({
      manifest: options.manifest,
      issues: before,
      projectKey: options.projectKey,
      requirementIds: [],
    }).ok,
    "Untracked native Epics require independent reconciliation before any bulk write",
  );
  for (const target of violations)
    state = await deliberateViolation(ctx, options, target, state, persist);
  for (const batch of batches) state = await executeBatch(ctx, options, batch, state, persist);
  state = { ...state, phase: "completed" };
  await persist(state);
  return {
    counts: {
      ...state.observedCounts,
      completedBatches: state.completedBatches,
      seededCount: state.seeded.length,
      refusedCount: state.refusedCount,
    },
    privateMappings: state.privateMappings,
  };
}

function publicResult(status, counts, detail) {
  return { step: STEP, status, detail, counts };
}

function contextOptions(ctx) {
  const manifest = ctx.truth ?? loadGoldenManifest();
  const requirements = validateGoldenManifest(manifest);
  requireFact(
    requirements.length === GOLDEN_REQUIREMENT_COUNT &&
      requirements.reduce((sum, item) => sum + item.acceptanceCriteria.length, 0) ===
        GOLDEN_ACCEPTANCE_COUNT,
    "Bulk Golden truth must contain exactly 370 requirements and 1029 acceptance criteria",
  );
  const state = ctx.intent?.state;
  return {
    chat: ctx.chat,
    projectKey: goldenProjectKey(ctx.projectKey),
    manifest,
    read: ctx.read,
    boardId: ctx.boardId ?? state?.["ac5-project"]?.resources?.boardId,
    bulkViolation: ctx.bulkViolation ?? installedEpicViolation(state),
  };
}

/**
 * The project step records its native board; the template step installs the Epic template whose
 * summary pattern the bulk run breaks on purpose. Neither is assumed before its step completed.
 */
function installedEpicViolation(state) {
  return state?.["w12-templates"]?.phase === "completed" ? EPIC_SUMMARY_VIOLATION : undefined;
}

async function viewResult(options, issues) {
  if (options.boardId === undefined) return { ok: false, verified: false };
  const views = await readGoldenBoardViews(options.read, String(options.boardId));
  const grade = gradeGoldenEpicViews({
    epics: issues.filter((issue) => issue.fields.issuetype.name === "Epic"),
    ...views,
  });
  return { ...grade, verified: true };
}

function viewCounts(views) {
  if (!views.verified) return { epicViewVerified: 0, backlogViewVerified: 0 };
  return {
    epicViewVerified: 1,
    backlogViewVerified: 1,
    epicViewCount: views.epics.visibleCount,
    backlogIssueCount: views.backlog.issueCount,
    backlogEpicCount: views.backlog.queuedEpicCount,
  };
}

function intentSeedMap(existing, requirements) {
  const seeded = existing.seeded;
  if (!Array.isArray(seeded) || seeded.length < 37 || seeded.length > 55) return undefined;
  const known = new Set(requirements.map((requirement) => requirement.id));
  const valid = seeded.every(
    (seed) => known.has(seed?.requirementId) && JIRA_TEMPLATE_RULE_IDS.includes(seed?.ruleId),
  );
  if (!valid) return undefined;
  const planned = new Map(seeded.map((seed) => [seed.requirementId, seed.ruleId]));
  return planned.size === seeded.length ? planned : undefined;
}

function completeRefusalSet(existing, planned) {
  const refusals = existing.refusals;
  if (
    !Array.isArray(refusals) ||
    refusals.length !== planned.size ||
    existing.refusedCount !== planned.size
  )
    return false;
  if (new Set(refusals.map((refusal) => refusal?.requirementId)).size !== planned.size)
    return false;
  return refusals.every(
    (refusal) =>
      planned.has(refusal?.requirementId) &&
      planned.get(refusal.requirementId) === refusal.ruleId &&
      Number.isSafeInteger(refusal.nativeBeforeCount) &&
      refusal.nativeBeforeCount >= 0 &&
      refusal.nativeBeforeCount === refusal.nativeAfterCount,
  );
}

function verifiedBulkIntent(existing, options) {
  if (existing.phase !== "completed" || existing.projectKey !== options.projectKey) return false;
  const planned = intentSeedMap(existing, options.manifest.requirements);
  if (planned === undefined || !Array.isArray(existing.coveredIds)) return false;
  const covered = new Set(existing.coveredIds);
  return (
    existing.coveredIds.length === options.manifest.requirementCount &&
    covered.size === options.manifest.requirementCount &&
    options.manifest.requirements.every((requirement) => covered.has(requirement.id)) &&
    completeRefusalSet(existing, planned)
  );
}

async function reconcileBulk(ctx, options, existing) {
  const issues = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
  const grade = gradeGoldenEpics({ ...options, issues });
  const views = await viewResult(options, issues);
  const seededCount = Array.isArray(existing.seeded) ? existing.seeded.length : 0;
  const refusedCount = Number.isSafeInteger(existing.refusedCount) ? existing.refusedCount : 0;
  const complete = grade.ok && views.ok && verifiedBulkIntent(existing, options);
  return publicResult(
    complete ? "green" : "unverified",
    { ...grade.counts, ...viewCounts(views), seededCount, refusedCount, reconciliationOnly: 1 },
    "Independent native reconciliation; no browser write was replayed",
  );
}

function bulkPreflight(options) {
  if (!/^[1-9][0-9]{0,18}$/u.test(String(options.boardId ?? "")))
    return publicResult(
      "unverified",
      { requiredCount: GOLDEN_REQUIREMENT_COUNT, attemptedCount: 0 },
      "Native board identity is unavailable; no write was attempted",
    );
  if (options.bulkViolation === undefined)
    return publicResult(
      "unverified",
      { requiredCount: GOLDEN_REQUIREMENT_COUNT, attemptedCount: 0 },
      "Observed installed-template violation metadata is unavailable; no write was attempted",
    );
  return undefined;
}

async function executeFreshBulk(ctx, options, violations, faults) {
  let latest = { completedBatches: 0, privateMappings: [], refusedCount: 0 };
  const inject = ({ progress }) => faults?.maybeInject(ctx, progress);
  try {
    const result = await runBrowserEpicsBulk(ctx, {
      ...options,
      violations,
      onState: async (state) => {
        latest = state;
        await ctx.intent.record("bulkEpics", state);
      },
      beforeBatch: inject,
      afterBatch: inject,
    });
    const issues = await readGoldenIssues(options.read, options.projectKey, { signal: ctx.signal });
    const views = await viewResult(options, issues);
    await ctx.intent.record("bulkEpics", { ...latest, views });
    return publicResult(
      views.ok ? "green" : "unverified",
      { ...result.counts, ...viewCounts(views) },
      "Native Epics and ordinary Backlog were independently observed as separate views",
    );
  } catch {
    return publicResult(
      "red",
      {
        completedBatches: latest.completedBatches,
        observedEpicCount: latest.privateMappings.length,
        refusedCount: latest.refusedCount,
      },
      "Bulk qualification stopped; retain the private intent and reconcile without replay",
    );
  }
}

/** Fixed integrator entry point. Actual identities stay under ctx.intent.state.bulkEpics only. */
export async function runBulkEpics(ctx, { violationRate = 0.125, faults } = {}) {
  const options = contextOptions(ctx);
  requireFact(
    typeof ctx.intent?.record === "function",
    "The existing private intent owner is required",
  );
  const existing = ctx.intent.state?.bulkEpics;
  if (existing !== undefined) {
    options.read ??= goldenJiraReadAdapter(ctx.session);
    return reconcileBulk(ctx, options, existing);
  }
  const blocked = bulkPreflight(options);
  if (blocked !== undefined) return blocked;
  const violations = planDeliberateViolations(options.manifest, { ...options, violationRate });
  options.read ??= goldenJiraReadAdapter(ctx.session);
  return executeFreshBulk(ctx, options, violations, faults);
}
