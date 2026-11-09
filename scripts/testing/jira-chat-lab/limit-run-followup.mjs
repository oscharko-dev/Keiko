// Selective follow-up steps after a completed limit run. They reuse the limit run's retained
// product state, Chats, Pods and field truth and repeat none of its earlier steps. Their own
// intent file keeps the original `browser-limit-run.pending.json` untouched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivateFile } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import {
  limitRunArguments,
  limitRunIntentHandle,
  loadLimitRunBlocks,
  runLimitStep,
} from "./browser-limit-run.mjs";

export const FOLLOWUP_OWNERS = Object.freeze({
  runStoryBulk: "./requirements/story-bulk.mjs",
  runCodingJira: "./requirements/coding-jira.mjs",
});

/** Selectable follow-up steps in their fixed execution order, with the owner export of each. */
export const FOLLOWUP_STEPS = Object.freeze({
  story: { name: "ac4-story", owner: "runStoryBulk" },
  "coding-jira": { name: "ac10-coding-jira", owner: "runCodingJira" },
});

const PARENT_FILE = "browser-limit-run.pending.json";
const FOLLOWUP_FILE = "browser-limit-followup.pending.json";
const REQUIRED_PARENT_STEPS = ["ac2-epics", "ac4-hierarchy"];
const CHAT_SLOTS = ["document", "report", "denied"];

/** The limit run's six arguments followed by a comma-separated step selection. */
export function followupArguments(argv) {
  assert.equal(argv.length, 7, "Usage: <six limit-run arguments> <story|coding-jira[,...]>");
  const base = limitRunArguments(argv.slice(0, 6));
  const requested = argv[6].split(",");
  assert.ok(
    requested.length > 0 &&
      new Set(requested).size === requested.length &&
      requested.every((name) => Object.hasOwn(FOLLOWUP_STEPS, name)),
    "Follow-up steps are story and coding-jira, each at most once",
  );
  const steps = Object.keys(FOLLOWUP_STEPS).filter((name) => requested.includes(name));
  return { ...base, steps };
}

function greenParentSteps(parent) {
  return REQUIRED_PARENT_STEPS.every((step) =>
    parent.results.some((entry) => entry.step === step && entry.result?.status === "green"),
  );
}

/** The completed, fully verified limit run this follow-up continues; anything else is refused. */
export function readCompletedLimitRun(sessionDir, identity) {
  const parent = JSON.parse(readPrivateFile(join(sessionDir, PARENT_FILE)));
  assert.ok(parent?.kind === "browser-limit-run" && parent.schemaVersion === 1);
  assert.ok(isDeepStrictEqual(parent.identity, identity), "The limit run belongs to other inputs");
  assert.equal(parent.phase, "completed", "The limit run must have completed");
  assert.equal(parent.data?.orchestrator?.phase, "steps-verified");
  assert.ok(greenParentSteps(parent), "The limit run must have verified Epics and hierarchy");
  assert.ok(
    typeof parent.data.stateDirectory === "string" && isAbsolute(parent.data.stateDirectory),
    "The retained product state is unavailable",
  );
  assert.ok(
    CHAT_SLOTS.every((slot) => parent.data.chats?.[slot]?.chatId && parent.data.chats[slot].podId),
    "The limit run's Chats and Pods are unavailable",
  );
  return parent;
}

/**
 * The follow-up's own durable intent. A first call copies the finished run's state (Chats, Pods,
 * field truth, retained state directory) and reserves the file exclusively; a later call resumes
 * the same file, so a step that was interrupted reconciles from its own checkpoint.
 */
export function openLimitFollowupIntent(sessionDir, identity, assertOwned = () => undefined) {
  const path = join(sessionDir, FOLLOWUP_FILE);
  const parent = readCompletedLimitRun(sessionDir, identity);
  assertOwned();
  if (!existsSync(path)) {
    const state = {
      schemaVersion: 1,
      kind: "browser-limit-followup",
      id: randomUUID(),
      parentId: parent.id,
      identity,
      phase: "reserved",
      data: structuredClone(parent.data),
      results: [],
    };
    privateJson(path, state, true);
    return limitRunIntentHandle(path, state, assertOwned);
  }
  const state = JSON.parse(readPrivateFile(path));
  assert.ok(state?.kind === "browser-limit-followup" && state.schemaVersion === 1);
  assert.ok(
    state.parentId === parent.id && isDeepStrictEqual(state.identity, identity),
    "The follow-up belongs to another limit run",
  );
  return limitRunIntentHandle(path, state, assertOwned);
}

export const loadFollowupBlocks = (importer) => loadLimitRunBlocks(importer, FOLLOWUP_OWNERS);

/** Truth the finished run recorded, plus the issue types the follow-up steps need. */
export async function prepareFollowupTruth(ctx, readTruth) {
  const saved = ctx.intent.state.fieldTruth;
  assert.ok(saved?.fieldIds?.epicLink && saved.requiredFieldsByType, "Field truth is unavailable");
  const extra = await readTruth(ctx.read, ctx.projectKey, ["Story"]);
  ctx.truth = {
    ...ctx.truth,
    fieldIds: { ...saved.fieldIds, ...extra.fieldIds },
    requiredFieldsByType: { ...saved.requiredFieldsByType, ...extra.requiredFieldsByType },
  };
  ctx.intent.record("followupFieldTruth", {
    fieldIds: ctx.truth.fieldIds,
    requiredFieldsByType: ctx.truth.requiredFieldsByType,
  });
}

/** Runs the selected steps in their fixed order; the first step that is not green stops the rest. */
export async function runLimitFollowup(ctx, steps, blocks) {
  const results = [];
  const selected = steps.map((name) => FOLLOWUP_STEPS[name]);
  const next = async (remaining) => {
    if (remaining.length === 0) return;
    const [{ name, owner }, ...rest] = remaining;
    await runLimitStep(ctx, results, name, () => blocks[owner](ctx));
    await next(rest);
  };
  try {
    await next(selected);
    const verified = selected.length === results.length;
    ctx.intent.record("followup", {
      phase: verified ? "steps-verified" : "steps-unverified",
      results,
    });
    if (verified) ctx.intent.complete();
    else ctx.intent.failed();
    return { status: verified ? "green" : "unverified", results };
  } catch (error) {
    ctx.intent.record("followup", { phase: "steps-unverified", results });
    ctx.intent.failed();
    throw error;
  }
}
