// Private, body-free W12 step journal. The orchestrator retains the exclusive parent intent.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { privateJson } from "./private-json.mjs";
import { readPrivateFile } from "./lab-client.mjs";

const MODES = new Set(["governed-assist", "supervised-coding", "autonomous-delivery"]);
const PHASES = ["prepared", "pending", "completed"];
const STATUSES = new Set(["green", "red", "unverified"]);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const DIGEST = /^[a-f\d]{64}$/u;
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
};

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
  if (step === "w12-templates") templateResources(value.resources);
  else probeResources(value.resources);
  counts(value.counts, STEPS[step]);
  if (value.result !== undefined) resultRecord(value.result, STEPS[step]);
}
function guardAbort(ctx) {
  if (ctx.signal?.aborted) {
    const error = new Error("limit-step-aborted");
    error.name = "AbortError";
    throw error;
  }
}
function identity(ctx, step) {
  guardAbort(ctx);
  requireValue(typeof ctx.projectKey === "string" && /^[A-Z][A-Z\d_]{1,31}$/u.test(ctx.projectKey));
  requireValue(Object.hasOwn(STEPS, step));
  requireValue(typeof ctx.sessionDir === "string" && isAbsolute(ctx.sessionDir));
  requireValue(ctx.intent !== null && typeof ctx.intent === "object" && !Array.isArray(ctx.intent));
  if (ctx.intent.steps === undefined) ctx.intent.steps = {};
  requireValue(
    ctx.intent.steps !== null &&
      typeof ctx.intent.steps === "object" &&
      !Array.isArray(ctx.intent.steps),
  );
  return join(ctx.sessionDir, `limit-run-${ctx.projectKey}-${step}.json`);
}

function readState(path) {
  try {
    const text = readPrivateFile(path);
    requireValue(text.length <= 16_384);
    return JSON.parse(text);
  } catch {
    throw new TypeError("Invalid limit step journal");
  }
}

function loadStep(ctx, step, evidenceFile) {
  const previous = ctx.intent.steps[step];
  if (previous !== undefined) validateState(previous, ctx.projectKey, step);
  const onDisk = existsSync(evidenceFile);
  const state = onDisk
    ? readState(evidenceFile)
    : structuredClone(
        previous ?? {
          schemaVersion: 1,
          projectKey: ctx.projectKey,
          step,
          phase: "prepared",
          revision: 0,
          resources: {},
          counts: {},
        },
      );
  validateState(state, ctx.projectKey, step);
  if (previous !== undefined && onDisk) {
    requireValue(state.revision >= previous.revision);
    if (state.revision === previous.revision) requireValue(isDeepStrictEqual(state, previous));
  }
  if (!onDisk) privateJson(evidenceFile, state, true);
  return state;
}

function stepMethods(ctx, step, state, evidenceFile) {
  async function commit(next, allowAborted = false) {
    if (!allowAborted) guardAbort(ctx);
    validateState(next, ctx.projectKey, step);
    const durable = structuredClone(next);
    privateJson(evidenceFile, durable);
    Object.assign(state, durable);
    await ctx.intent.persist?.();
  }
  return {
    state,
    evidenceFile,
    async checkpoint(patch) {
      record(patch, new Set(["phase", "resources", "counts"]));
      if (Object.hasOwn(patch, "resources")) {
        if (step === "w12-templates") templateResources(patch.resources);
        else probeResources(patch.resources);
      }
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
      return { step, ...result, evidenceFile };
    },
  };
}

/** Pending on reopening is uncertain: callers return unverified without replay; completed is reverified. */
export async function openLimitStep(ctx, step) {
  const evidenceFile = identity(ctx, step);
  const state = loadStep(ctx, step, evidenceFile);
  ctx.intent.steps[step] = state;
  await ctx.intent.persist?.();
  return stepMethods(ctx, step, state, evidenceFile);
}
