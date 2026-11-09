// Closed step records use the orchestrator's exclusive intent; this adapter owns no file.
import { isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

const MODES = new Set(["governed-assist", "supervised-coding", "autonomous-delivery"]);
const PHASES = ["prepared", "pending", "completed"];
const STATUSES = new Set(["green", "red", "unverified"]);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const DIGEST = /^[a-f\d]{64}$/u;
const MAX_STEP_BYTES = 65_536;
const STEPS = {
  "w12-templates": {
    counts: new Set(["templates", "installed", "verified"]),
    details: new Set([
      "templates-installed",
      "templates-reverified",
      "templates-pending-unverified",
      "templates-native-metadata-unavailable",
      "templates-verification-failed",
      "templates-aborted",
    ]),
  },
  "w12-rule-probes": {
    counts: new Set(["requestedModes", "probedModes", "refusals", "nativeWrites", "approvals"]),
    details: new Set([
      "rule-probes-confirmed",
      "rule-probe-refusal-missing",
      "rule-probe-native-change",
      "rule-probe-approval-refused",
      "rule-probe-readback-unavailable",
      "rule-probes-pending",
      "rule-probes-aborted",
    ]),
  },
  "ac5-project": {
    counts: new Set([
      "deniedAttempts",
      "deniedProjects",
      "deniedIssues",
      "createdProjects",
      "issues",
      "approvals",
    ]),
    details: new Set([
      "project-created",
      "project-reverified",
      "project-pending",
      "project-identity-unavailable",
      "project-refusal-unverified",
      "project-native-change",
      "project-create-unconfirmed",
      "project-readback-unavailable",
      "project-aborted",
      "denied-chat-unavailable",
    ]),
  },
  "ac6-sprint-bulk": {
    counts: new Set([
      "size",
      "batch",
      "created",
      "selected",
      "moved",
      "done",
      "createBatches",
      "moveBatches",
      "decisions",
      "constraintRefusals",
      "membershipPages",
      "backlogPages",
      "unconfirmedReceipts",
      "wireWrites",
    ]),
    details: new Set([
      "sprint-bulk-confirmed",
      "sprint-bulk-reverified",
      "sprint-bulk-pending",
      "sprint-bulk-native-unavailable",
      "sprint-bulk-verification-failed",
      "sprint-bulk-aborted",
      "sprint-bulk-receipt-unconfirmed",
    ]),
  },
  "ac9-ui-language-en": languageStep(),
  "ac9-ui-language-de": languageStep(),
  "ac9-cards-readable": {
    counts: new Set(["cards", "keys", "links", "serious", "critical", "chatWrites", "reloads"]),
    details: new Set([
      "cards-readable-confirmed",
      "cards-readable-pending",
      "cards-readable-aborted",
      "cards-readability-failed",
      "cards-accessibility-failed",
      "cards-reload-changed",
      "cards-reload-replayed",
      "cards-readback-unavailable",
    ]),
  },
};

function languageStep() {
  return {
    counts: new Set(["changes"]),
    details: new Set([
      "ui-language-confirmed",
      "ui-language-pending",
      "ui-language-aborted",
      "ui-language-unavailable",
    ]),
  };
}

function requireValue(condition) {
  if (!condition) throw new TypeError("Invalid limit step journal");
}
function record(value, keys) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
  );
  requireValue(Object.getOwnPropertyNames(value).every((key) => keys.has(key)));
  requireValue(
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) =>
      Object.hasOwn(entry, "value"),
    ),
  );
}
function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
function counts(value, definition) {
  record(value, definition.counts);
  requireValue(Object.values(value).every((count) => integer(count)));
}
function template(value) {
  record(value, new Set(["id", "revision", "digest", "issueType"]));
  requireValue(
    typeof value.id === "string" && value.id.startsWith("msk_") && UUID.test(value.id.slice(4)),
  );
  requireValue(
    integer(value.revision, 1) && typeof value.digest === "string" && DIGEST.test(value.digest),
  );
  requireValue(new Set(["Epic", "Task", "Bug", "Sub-task"]).has(value.issueType));
}
function templateResources(value) {
  record(value, new Set(["projectId", "epicLinkFieldId", "templates"]));
  if (value.projectId !== undefined)
    requireValue(typeof value.projectId === "string" && /^[1-9]\d{0,19}$/u.test(value.projectId));
  if (value.epicLinkFieldId !== undefined)
    requireValue(
      typeof value.epicLinkFieldId === "string" &&
        /^customfield_[1-9]\d{0,19}$/u.test(value.epicLinkFieldId),
    );
  if (value.templates !== undefined) {
    requireValue(Array.isArray(value.templates) && value.templates.length <= 4);
    for (const entry of value.templates) template(entry);
    requireValue(new Set(value.templates.map((entry) => entry.id)).size === value.templates.length);
  }
}
function probeResources(value) {
  record(value, new Set(["chatId", "completedModes", "baselineDigest"]));
  if (value.chatId !== undefined)
    requireValue(typeof value.chatId === "string" && UUID.test(value.chatId));
  if (value.baselineDigest !== undefined)
    requireValue(typeof value.baselineDigest === "string" && DIGEST.test(value.baselineDigest));
  if (value.completedModes !== undefined) {
    requireValue(Array.isArray(value.completedModes) && value.completedModes.length <= 3);
    requireValue(value.completedModes.every((mode) => MODES.has(mode)));
    requireValue(new Set(value.completedModes).size === value.completedModes.length);
  }
}

function digestValue(value) {
  return typeof value === "string" && DIGEST.test(value);
}
function uuidValue(value) {
  return typeof value === "string" && UUID.test(value);
}
function nativeId(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
}
function resourceFields(value, fields) {
  record(value, new Set(Object.keys(fields)));
  for (const [key, entry] of Object.entries(value)) requireValue(fields[key](entry));
}
function projectResources(value) {
  resourceFields(value, {
    chatId: uuidValue,
    deniedChatId: uuidValue,
    deniedActorClass: (value) => value === "restricted",
    deniedActorDigest: digestValue,
    permittedActorDigest: digestValue,
    deniedKey: (key) => typeof key === "string" && /^[A-Z][A-Z\d_]{1,31}$/u.test(key),
    projectId: nativeId,
    boardId: nativeId,
    filterId: nativeId,
    baselineDigest: digestValue,
    deniedVerified: (verified) => typeof verified === "boolean",
    deniedPodId: uuidValue,
    deniedAuthenticationGeneration: (generation) => integer(generation, 1),
    deniedBindingGeneration: (generation) => integer(generation, 1),
    permittedPodId: uuidValue,
    permittedAuthenticationGeneration: (generation) => integer(generation, 1),
    permittedBindingGeneration: (generation) => integer(generation, 1),
  });
}
function projectIssueKey(value, projectKey) {
  return (
    typeof value === "string" &&
    value.startsWith(`${projectKey}-`) &&
    /^[1-9]\d{0,19}$/u.test(value.slice(projectKey.length + 1))
  );
}
function taskReferences(value, projectKey) {
  requireValue(Array.isArray(value) && value.length <= 300);
  for (const task of value) {
    record(task, new Set(["id", "key"]));
    requireValue(nativeId(task.id) && projectIssueKey(task.key, projectKey));
  }
  requireValue(new Set(value.map((task) => task.id)).size === value.length);
  requireValue(new Set(value.map((task) => task.key)).size === value.length);
  return true;
}
function sprintResources(value, projectKey) {
  resourceFields(value, {
    boardId: nativeId,
    sprintId: nativeId,
    sprintRenamed: (renamed) => renamed === true,
    epicKey: (key) => projectIssueKey(key, projectKey),
    provenanceDigest: digestValue,
    taskRefs: (refs) => taskReferences(refs, projectKey),
    doneKeys: (keys) =>
      Array.isArray(keys) &&
      keys.length <= 10 &&
      keys.every((key) => projectIssueKey(key, projectKey)) &&
      new Set(keys).size === keys.length,
  });
}
function languageResources(value) {
  resourceFields(value, { locale: (locale) => locale === "en" || locale === "de" });
}
function cardsResources(value) {
  resourceFields(value, {
    chatId: uuidValue,
    cardDigest: digestValue,
    keyDigest: digestValue,
    linkDigest: digestValue,
  });
}
function resources(value, step, projectKey) {
  if (step === "w12-templates") return templateResources(value);
  if (step === "w12-rule-probes") return probeResources(value);
  if (step === "ac5-project") return projectResources(value);
  if (step === "ac6-sprint-bulk") return sprintResources(value, projectKey);
  if (step === "ac9-cards-readable") return cardsResources(value);
  return languageResources(value);
}
function resultRecord(value, definition) {
  record(value, new Set(["status", "detail", "counts"]));
  requireValue(STATUSES.has(value.status) && definition.details.has(value.detail));
  counts(value.counts, definition);
}
function validateState(value, projectKey, step) {
  record(
    value,
    new Set([
      "schemaVersion",
      "projectKey",
      "step",
      "phase",
      "revision",
      "resources",
      "counts",
      "result",
    ]),
  );
  requireValue(value.schemaVersion === 1 && value.projectKey === projectKey && value.step === step);
  requireValue(PHASES.includes(value.phase) && integer(value.revision));
  resources(value.resources, step, projectKey);
  counts(value.counts, STEPS[step]);
  if (value.result !== undefined) resultRecord(value.result, STEPS[step]);
  requireValue(JSON.stringify(value).length <= MAX_STEP_BYTES);
}
function guardAbort(ctx) {
  if (ctx.signal?.aborted) {
    const error = new Error("limit-step-aborted");
    error.name = "AbortError";
    throw error;
  }
}
function intentEvidenceFile(ctx) {
  if (ctx.intent.path === undefined) return undefined;
  requireValue(typeof ctx.intent.path === "string" && isAbsolute(ctx.intent.path));
  const inside = relative(ctx.sessionDir, ctx.intent.path);
  requireValue(
    inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside),
  );
  return ctx.intent.path;
}

function identity(ctx, step) {
  guardAbort(ctx);
  requireValue(typeof ctx.projectKey === "string" && /^[A-Z][A-Z\d_]{1,31}$/u.test(ctx.projectKey));
  requireValue(Object.hasOwn(STEPS, step));
  requireValue(typeof ctx.sessionDir === "string" && isAbsolute(ctx.sessionDir));
  requireValue(ctx.intent !== null && typeof ctx.intent === "object" && !Array.isArray(ctx.intent));
  requireValue(typeof ctx.intent.record === "function");
  const data = ctx.intent.state;
  requireValue(data !== null && typeof data === "object" && !Array.isArray(data));
  return intentEvidenceFile(ctx);
}

async function loadStep(ctx, step) {
  const previous = ctx.intent.state[step];
  const state = previous ?? {
    schemaVersion: 1,
    projectKey: ctx.projectKey,
    step,
    phase: "prepared",
    revision: 0,
    resources: {},
    counts: {},
  };
  validateState(state, ctx.projectKey, step);
  if (previous === undefined) await ctx.intent.record(step, structuredClone(state));
  return structuredClone(state);
}

function stepMethods(ctx, step, state, evidenceFile) {
  async function commit(next, allowAborted = false) {
    if (!allowAborted) guardAbort(ctx);
    validateState(next, ctx.projectKey, step);
    requireValue(isDeepStrictEqual(ctx.intent.state[step], state));
    const durable = structuredClone(next);
    const persisted = ctx.intent.record(step, durable);
    Object.assign(state, structuredClone(durable));
    await persisted;
  }
  return {
    state,
    evidenceFile,
    async checkpoint(patch) {
      record(patch, new Set(["phase", "resources", "counts"]));
      if (Object.hasOwn(patch, "resources")) resources(patch.resources, step, ctx.projectKey);
      if (Object.hasOwn(patch, "counts")) counts(patch.counts, STEPS[step]);
      const next = {
        ...state,
        ...patch,
        revision: state.revision + 1,
        resources: { ...state.resources, ...patch.resources },
        counts: { ...state.counts, ...patch.counts },
      };
      requireValue(PHASES.indexOf(next.phase) >= PHASES.indexOf(state.phase));
      await commit(next);
    },
    async result(status, detail, observedCounts) {
      const result = { status, detail, counts: observedCounts };
      resultRecord(result, STEPS[step]);
      await commit(
        {
          ...state,
          result,
          counts: { ...state.counts, ...observedCounts },
          revision: state.revision + 1,
        },
        status === "unverified",
      );
      return { step, ...result, ...(evidenceFile === undefined ? {} : { evidenceFile }) };
    },
  };
}

/** Pending on reopening is uncertain: callers return unverified without replay; completed is reverified. */
export async function openLimitStep(ctx, step) {
  const evidenceFile = identity(ctx, step);
  const state = await loadStep(ctx, step);
  return stepMethods(ctx, step, state, evidenceFile);
}
