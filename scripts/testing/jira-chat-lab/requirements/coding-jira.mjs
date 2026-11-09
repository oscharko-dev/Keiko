// Coding step of the limit run: a Coding Workbench run, started in the ordinary Workbench UI with
// the run's Jira Pod switched on, reads the lab Epics through the governed Jira tools. Jira's own
// REST answer is the oracle for what the run said, and the Activity Log is the oracle for where the
// call came from: `coding-runtime.jira-pod` lines exist only for a Coding run's Jira tools.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { goldenProjectKey } from "./golden-jira-oracle.mjs";
import {
  flatten,
  readActivityEvents,
  selectRunEvents,
} from "../../coding-workbench-lab/activity-log-events.mjs";
import { normalizeRunSuffix } from "../../coding-workbench-lab/lab-common.mjs";
import { stepEvidence } from "./step-evidence.mjs";

export const CODING_JIRA_STEP = "ac10-coding-jira";
export const CODING_JIRA_OPERATION = "coding-runtime.jira-pod";
const KEYS_ASKED = 5;
const RUN_TIMEOUT_MS = 20 * 60_000;
const LOG_SETTLE_MS = 30_000;
const LOG_POLL_MS = 1000;
const ERROR_DETAIL_CHARS = 160;

/** The Workbench request: a read of the lab Epics, no file change and no Jira write. */
export function codingJiraPrompt(projectKey) {
  goldenProjectKey(projectKey);
  return (
    `Use the Jira tools of this run to search the Jira project ${projectKey} for all issues of ` +
    "type Epic. Reply with the exact number of Epics and the keys of the first " +
    `${KEYS_ASKED} Epics ordered by key ascending. Do not edit any file and do not create, ` +
    "change or transition any Jira issue."
  );
}

const keyNumber = (key) => Number(key.slice(key.lastIndexOf("-") + 1));

/** What Jira holds: the number of Epics and the lowest keys, from the issues the oracle read. */
export function epicTruth(issues) {
  const keys = issues
    .filter((issue) => issue?.fields?.issuetype?.name === "Epic" && typeof issue.key === "string")
    .map((issue) => issue.key)
    .toSorted((left, right) => keyNumber(left) - keyNumber(right));
  return { count: keys.length, firstKeys: keys.slice(0, KEYS_ASKED) };
}

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Whether the answer states the exact Epic count and names every one of the first Epic keys. */
export function gradeCodingAnswer(text, truth) {
  const body = typeof text === "string" ? text : "";
  const countNamed =
    truth.count > 0 && new RegExp(String.raw`(?<![\w.-])${truth.count}(?![\w-])`, "u").test(body);
  const keysNamed = truth.firstKeys.filter((key) =>
    new RegExp(String.raw`(?<![\w-])${escapeRegExp(key)}(?![\w-])`, "u").test(body),
  ).length;
  return {
    ok: countNamed && truth.firstKeys.length > 0 && keysNamed === truth.firstKeys.length,
    countNamed,
    keysNamed,
  };
}

const inWindow = (event, window) => {
  const at = Date.parse(event.ts ?? "");
  return Number.isFinite(at) && at >= window.startedAtMs && at <= window.endedAtMs;
};

/**
 * What the Activity Log says about the run's Jira tools: the Pod bound to the run, the completed
 * read calls, any write attempt and the failed or refused lines. A line counts when it falls into
 * the run's time window; `correlated` counts those that also carry the run's own correlation.
 */
export function gradeCodingJiraCalls(events, { runId, startedAtMs, endedAtMs }) {
  const window = { startedAtMs, endedAtMs };
  const lines = events.map(flatten).filter((line) => line.op === CODING_JIRA_OPERATION);
  const own = new Set(
    selectRunEvents(events, normalizeRunSuffix(runId)).map((event) => event.correlationId),
  );
  const inRun = lines.filter((line) => inWindow(line, window));
  const calls = inRun.filter((line) => line.action === "call");
  const counts = {
    bound: inRun.filter((line) => line.action === "bind" && line.outcome === "bound").length,
    reads: calls.filter((line) => line.outcome === "completed" && line.toolClass === "jira-read")
      .length,
    writes: calls.filter((line) => line.toolClass === "jira-write").length,
    failed: inRun.filter((line) => line.outcome === "failed" || line.outcome === "refused").length,
    correlated: inRun.filter((line) => own.has(line.correlationId)).length,
  };
  return { ok: counts.bound >= 1 && counts.reads >= 1 && counts.writes === 0, counts };
}

/** Jira was only read: the same issues, each with its last-update time unchanged. */
export function jiraUnchanged(before, after) {
  const stamp = (issues) =>
    issues.map((issue) => `${issue.key}@${issue.fields?.updated ?? ""}`).toSorted();
  const left = stamp(before);
  const right = stamp(after);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contextReady(ctx) {
  return (
    typeof ctx.projectKey === "string" &&
    ["origin", "secret", "modelId", "projectPath", "sessionDir"].every(
      (name) => typeof ctx[name] === "string" && ctx[name].length > 0,
    ) &&
    typeof ctx.search === "function" &&
    typeof ctx.intent?.record === "function"
  );
}

const { publicResult, finish } = stepEvidence(
  CODING_JIRA_STEP,
  "coding-jira.json",
  (counts) => `reads=${counts.reads ?? 0}; writes=${counts.writes ?? 0}`,
);

/** The log is written asynchronously: wait until a completed read shows, or the settle time ends. */
async function settledCalls(events, run, deadline) {
  const grade = gradeCodingJiraCalls(await events(), run);
  if (grade.counts.reads >= 1 || Date.now() >= deadline) return grade;
  await delay(LOG_POLL_MS);
  return settledCalls(events, run, deadline);
}

async function loadDrivers() {
  const [{ chromium }, workbench, common, pairing, contracts, run] = await Promise.all([
    import("@playwright/test"),
    import("../../coding-workbench-lab/wb-ui.mjs"),
    import("../../coding-workbench-lab/lab-common.mjs"),
    import("../../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js"),
    import("@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing"),
    import("../browser-limit-run.mjs"),
  ]);
  return {
    chromium,
    workbench,
    common,
    pairing,
    contracts,
    podLabel: run.LIMIT_RUN_JIRA_POD_LABEL,
  };
}

/** A page of its own, paired with the running Keiko, whose only window is the Coding Workbench. */
async function pairedWorkbenchPage(ctx, browser, drivers) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1300 },
    baseURL: ctx.origin,
  });
  const page = await context.newPage();
  await drivers.workbench.seedWorkbenchWindow(page, ctx.projectPath);
  const fragment = drivers.contracts.encodeCodingAppSessionPairingFragment(
    drivers.pairing.mintLauncherPairingAttestation({
      secret: ctx.secret,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  await drivers.workbench.waitForWorkbench(page);
  return page;
}

async function runtimeAvailable(page) {
  const readiness = await page.request.get(
    "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery",
  );
  return (await readiness.json().catch(() => ({})))?.runtimeAvailable === true;
}

async function followRun(page, drivers, runId, startedAtMs) {
  const { workbench, common } = drivers;
  const post = async (path, data) => ({
    status: (await page.request.post(path, { headers: common.CSRF_HEADERS, data })).status(),
  });
  const snapshot = await common.watchOrStop(
    () =>
      workbench.watchRun(page, runId, { approve: "none", deadline: startedAtMs + RUN_TIMEOUT_MS }),
    post,
    runId,
  );
  await common.stopUnfinishedRun(post, runId, snapshot);
  return snapshot;
}

/** Starts the Workbench run in its own paired browser, exactly as a person would, and follows it. */
export async function driveCodingWorkbench(ctx, prompt) {
  const drivers = await loadDrivers();
  const { workbench, common } = drivers;
  const browser = await drivers.chromium.launch({ headless: true });
  try {
    const page = await pairedWorkbenchPage(ctx, browser, drivers);
    if (!(await runtimeAvailable(page))) return { unavailable: true };
    await workbench.selectCheckout(page, ctx.projectPath, "main");
    const panel = await workbench.reopenWorkbench(page);
    const startedAtMs = Date.now();
    const runId = await workbench.startRun(page, panel, {
      model: ctx.modelId,
      mode: common.MODES.find((mode) => mode.id === "autonomous-delivery"),
      text: prompt,
      jiraPod: drivers.podLabel,
    });
    const snapshot = await followRun(page, drivers, runId, startedAtMs);
    await delay(2500);
    const text = await panel.innerText();
    return { runId, state: snapshot.state, text, startedAtMs, endedAtMs: Date.now() };
  } finally {
    await browser.close();
  }
}

function errorSummary(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
  return text.replaceAll(/[\r\n\p{Cc}]+/gu, " ").slice(0, ERROR_DETAIL_CHARS);
}

async function gradeRun(ctx, ports, before, truth, driven) {
  const calls = await settledCalls(
    ports.events,
    driven,
    Date.now() + (ports.settleMs ?? LOG_SETTLE_MS),
  );
  const answer = gradeCodingAnswer(driven.text, truth);
  const unchanged = jiraUnchanged(
    before,
    await ctx.search(`project = ${ctx.projectKey}`, "summary,updated"),
  );
  const counts = {
    epics: truth.count,
    keysNamed: answer.keysNamed,
    countNamed: Number(answer.countNamed),
    jiraChanged: Number(!unchanged),
    ...calls.counts,
  };
  const ok = driven.state === "succeeded" && answer.ok && calls.ok && unchanged;
  return finish(ctx, ok ? "green" : "red", ok ? "native-and-log-oracle" : "oracle-refused", counts);
}

/** One Workbench run that only reads Jira; graded by Jira's REST readback and the Activity Log. */
export async function runCodingJira(ctx, ports = {}) {
  if (!contextReady(ctx)) return publicResult("unverified", "context-unavailable");
  const settled = {
    drive: ports.drive ?? driveCodingWorkbench,
    settleMs: ports.settleMs,
    events: ports.events ?? (async () => readActivityEvents(await logDirectory(ctx))),
  };
  try {
    const before = await ctx.search(`project = ${ctx.projectKey}`, "summary,updated");
    const truth = epicTruth(before);
    if (truth.count < KEYS_ASKED) return await finish(ctx, "unverified", "epics-unavailable");
    const driven = await settled.drive(ctx, codingJiraPrompt(ctx.projectKey));
    if (driven.unavailable) return await finish(ctx, "unverified", "coding-runtime-unavailable");
    return await gradeRun(ctx, settled, before, truth, driven);
  } catch (error) {
    return finish(ctx, "unverified", `interrupted-or-invalid-evidence: ${errorSummary(error)}`);
  }
}

async function logDirectory(ctx) {
  const { chatReadLogDirectory } = await import("../chat-read.mjs");
  return chatReadLogDirectory(ctx.session);
}
