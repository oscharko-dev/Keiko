// Natural-language catalog selection lane (#4327). Synthetic laboratory only.
// Usage: node catalog-selection.mjs <private-session-directory> <gateway-model-id>
//          [--repeat 3] [--only priorities,worklog]
// Unlike catalog-chat.mjs, a request names neither the tool nor its arguments: the model has to find
// the operation in the full Jira catalog (directly or through jira.discover / jira.describe) and
// build its arguments from the person's words. Reads are graded against an independent native read,
// writes by their native effect on owned synthetic objects, which the lane removes again. A model
// gateway outage during a turn is `invalid`, never a verdict about the product or the model.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { chatReadLogDirectory, jsonRequest, prepareChat, withLiveChat } from "./chat-read.mjs";
import { privateJson } from "./chat-write.mjs";
import { SELECTION_CASES, selectionTruth } from "./catalog-selection-cases.mjs";
import { gradeSelection, summarizeSelection } from "./catalog-selection-grade.mjs";
import {
  createSelectionObjects,
  removeNative,
  orphanedIssues,
  removeSelectionObjects,
  scopeSnapshot,
  selectionNames,
  strayWrites,
} from "./catalog-selection-objects.mjs";
import { loadSession, requireLicense } from "./lab-client.mjs";
import { readGatewayFailures, readToolRejections } from "./requirements/validity.mjs";

const TURN_LIMIT_MS = 480_000;
const MEMORY_OFF = { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} };

const errorName = (error) => (error instanceof Error ? error.name : "unknown");

function stage(operation, extra = {}) {
  console.log(JSON.stringify({ qualification: "jira-catalog-selection", operation, ...extra }));
}

/** One free-form Chat turn; the request carries no tool name and no argument object. */
async function selectionTurn(context, chat, content) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), TURN_LIMIT_MS);
  const signal = globalThis.AbortSignal.any([controller.signal, context.stop]);
  const fromMs = Date.now();
  try {
    const completed = await jsonRequest(
      context.origin,
      context.cookie,
      "catalog-selection-send",
      "/api/desktop/chat",
      {
        chatId: chat.id,
        projectPath: context.projectPath,
        modelId: context.modelId,
        clientTurnId: randomUUID(),
        expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
        content,
        memory: MEMORY_OFF,
      },
      "POST",
      signal,
    );
    const user = completed.messages?.find((message) => message.role === "user");
    return { fromMs, exchanges: user?.toolTranscript?.exchanges ?? [] };
  } catch (error) {
    return { fromMs, exchanges: [], failure: String(error?.message ?? error).slice(0, 160) };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

// Activity Log lines of a turn are flushed shortly after it ends. A turn the lane aborted may still
// complete on the server, so its native effect is read only after a longer grace.
const LOG_SETTLE_MS = 2_500;
const ABORTED_GRACE_MS = 30_000;
const pause = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * An aborted turn may keep running on the server, and its late refusals would land in the next
 * attempt's window, so a turn the lane aborted carries no refusal evidence of its own. A late line
 * of an aborted turn can still reach the next attempt's window; the grace before it narrows this.
 */
export function turnRefusals(turn, read) {
  return turn.failure === undefined ? read() : { rejected: {}, unidentified: 0, failedCalls: 0 };
}

async function withGateway(session, turn) {
  await pause(turn.failure === undefined ? LOG_SETTLE_MS : ABORTED_GRACE_MS);
  const window = { fromMs: turn.fromMs, toMs: Date.now(), pid: process.pid };
  const root = join(chatReadLogDirectory(session), "logs");
  const counts = readGatewayFailures(root, window);
  const tools = turnRefusals(turn, () => readToolRejections(root, window));
  // A transport failure of the lab's own call to Keiko is no gateway evidence; a turn that failed
  // without a transcript is graded invalid on its own.
  return {
    ...turn,
    gateway: {
      unrecovered: counts.outages,
      circuit: counts.circuit,
      failedCalls: tools.failedCalls,
      rejected: tools.rejected,
      unidentified: tools.unidentified,
    },
  };
}

/** The owned scope is clean before a write turn: no effect of this case exists yet. */
async function cleanBefore(session, fixture, entry, marker, tag) {
  const existing = await entry.verify(session, fixture, marker, tag);
  await removeNative(session, existing.cleanup);
  const again = await entry.verify(session, fixture, marker, tag);
  if (again.effects > 0 || again.cleanup.length > 0)
    throw new TypeError(`Owned scope of ${entry.id} is not clean before the turn`);
}

/** The native effect and stray writes of a finished write turn; removes both again. */
async function settleWrite(session, run, entry, turnFor, before) {
  const { fixture, marker, tag } = turnFor;
  const effect = await entry.verify(session, fixture, marker, tag);
  const after = await scopeSnapshot(session, fixture, fixture.selection);
  const stray = strayWrites(before, after, effect.cleanup, `Auswahl ${run.tag}`);
  await removeNative(session, [...effect.cleanup, ...stray.remove]);
  // The lane runs alone in its session; a foreign object is never deleted, only reported.
  if (stray.foreign > 0) run.foreignStray += stray.foreign;
  const { foreign, changed, removed, issueChanged } = stray;
  return {
    proof: { effect: { ...effect, stray: stray.count } },
    stray: { foreign, changed, removed, issueChanged },
  };
}

/**
 * The recovery after a failed settlement: the whole scope is brought back to its state before the
 * turn, not only the case's own effect, and proven by a fresh snapshot. A scope that cannot be
 * shown clean throws, so the run stops with its pending marker kept for reconciliation.
 */
export async function recoverScope(session, run, entry, turnFor, before) {
  const { fixture, marker, tag } = turnFor;
  const wide = `Auswahl ${run.tag}`;
  const after = await scopeSnapshot(session, fixture, fixture.selection);
  await removeNative(session, strayWrites(before, after, [], wide).remove);
  await cleanBefore(session, fixture, entry, marker, tag);
  const final = await scopeSnapshot(session, fixture, fixture.selection);
  // A changed or removed baseline object cannot be undone by the lane; only an unchanged scope lets
  // the run continue, otherwise it stops and keeps its pending marker for reconciliation.
  if (strayWrites(before, final, [], wide).count > 0)
    throw new TypeError(`Owned scope of ${entry.id} is not clean after recovery`);
}

/**
 * One write turn on owned objects. A native read or removal that fails after the turn makes this
 * attempt invalid; the case's own scope is then cleaned again, and only if that also fails does
 * the run stop, keeping the pending marker for reconciliation.
 */
async function writeAttempt(context, run, entry, turnFor) {
  const { session } = context;
  const { fixture, marker, tag } = turnFor;
  privateJson(run.pendingPath, { id: entry.id, marker, tag }, true);
  await cleanBefore(session, fixture, entry, marker, tag);
  let before;
  try {
    before = await scopeSnapshot(session, fixture, fixture.selection);
  } catch (error) {
    // Nothing was sent yet, so this attempt is invalid and the owned scope is still clean.
    stage("verify-unavailable", { id: entry.id, errorType: errorName(error) });
    rmSync(run.pendingPath);
    const turn = { exchanges: [], gateway: { unrecovered: 0, circuit: 0 } };
    return { turn, proof: { truthUnavailable: true } };
  }
  const turn = await withGateway(session, await turnFor.send());
  let settled;
  try {
    settled = await settleWrite(session, run, entry, turnFor, before);
  } catch (error) {
    stage("verify-unavailable", { id: entry.id, errorType: errorName(error) });
    await recoverScope(session, run, entry, turnFor, before);
    settled = { proof: { truthUnavailable: true } };
  }
  rmSync(run.pendingPath);
  return { turn, ...settled };
}

/** A failed native truth read is a lab error of this attempt; it never stops the other cases. */
async function readAttempt(context, run, entry, turnFor) {
  const turn = await withGateway(context.session, await turnFor.send());
  try {
    return { turn, proof: { tokens: await selectionTruth(context.session, run.fixture, entry) } };
  } catch (error) {
    stage("truth-unavailable", { id: entry.id, errorType: errorName(error) });
    return { turn, proof: { truthUnavailable: true } };
  }
}

async function attempt(context, run, entry, round) {
  const tag = `${run.tag}-${round}-${entry.id}`;
  const marker = `Auswahl ${run.tag}-${round}`;
  const write = entry.effect === "write";
  const chat = await prepareChat(
    context.origin,
    context.cookie,
    context.session,
    context.projectPath,
    context.modelId,
    "api",
    write ? "autonomous-delivery" : "governed-assist",
  );
  const turnFor = {
    fixture: run.fixture,
    marker,
    tag,
    send: () => selectionTurn(context, chat, entry.prompt(run.fixture, marker, tag)),
  };
  const outcome = await (write ? writeAttempt : readAttempt)(context, run, entry, turnFor);
  const verdict = gradeSelection(entry, outcome.turn, outcome.proof);
  stage("attempt", { id: entry.id, round, status: verdict.status, path: verdict.path });
  return {
    id: entry.id,
    catalog: entry.catalog,
    effect: entry.effect,
    round,
    ...verdict,
    gateway: outcome.turn.gateway,
    ...(outcome.stray === undefined ? {} : { stray: outcome.stray }),
  };
}

// Every attempt opens its own Chat with its own Atlassian credential, and one product instance
// retains at most 64 of them (`credential-limit-exceeded`, HTTP 429): the 65th attempt of a single
// instance stopped the run with 8 of 72 attempts missing (#4352). A lifecycle therefore serves
// half that bound, like the AC7 driver, and the next one starts on a fresh paired instance.
export const LIFECYCLE_ATTEMPTS_MAX = 32;

/** The attempts of every round in order, cut into lifecycles that stay under the product bound. */
export function attemptBatches(cases, repeat, size = LIFECYCLE_ATTEMPTS_MAX) {
  const schedule = Array.from({ length: repeat }, (_, index) =>
    cases.map((entry) => ({ entry, round: index + 1 })),
  ).flat();
  return Array.from({ length: Math.ceil(schedule.length / size) }, (_, index) =>
    schedule.slice(index * size, (index + 1) * size),
  );
}

async function runAttempts(context, run, batch) {
  for (const { entry, round } of batch) {
    if (run.stop.signal.aborted) throw new TypeError("The run was stopped by a signal");
    await requireLicense(context.session);
    run.attempts.push(await attempt({ ...context, stop: run.stop.signal }, run, entry, round));
  }
}

function markdown(report) {
  const { summary } = report;
  const lines = [
    `# Jira catalog selection (${report.model}, ${report.repeat} rounds)`,
    "",
    `Selected ${summary.selected}/${summary.valid} valid attempts exactly, ${summary.alternative} through an equivalent alternative, ${summary.wrongArguments} with the right tool but refused arguments; ${summary.invalid} invalid.`,
    report.complete ? "" : "**Incomplete: the run stopped before every attempt finished.**",
    summary.sufficient ? "" : "**Insufficient: fewer than half of the attempts were valid.**",
    report.foreignStray > 0
      ? `**${report.foreignStray} foreign objects appeared during write turns and were left in place.**`
      : "",
    "",
    "| Case | Catalog | Runs | Selected / alternative / valid |",
    "| --- | --- | --- | --- |",
    ...summary.rows.map(
      (row) =>
        `| ${row.id} | ${row.catalog} | ${row.runs.join(", ")} | ${row.selected}/${row.alternative}/${row.valid} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function writeReport(session, report) {
  const output = join(session.directory, "catalog-selection");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const stamp = report.startedAt.replaceAll(":", "-");
  writeFileSync(join(output, `${stamp}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(join(output, "latest.md"), markdown(report), { mode: 0o600 });
}

function options() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { repeat: { type: "string", default: "3" }, only: { type: "string" } },
  });
  const [directory, modelId] = positionals;
  const repeat = Number(values.repeat);
  if (!directory || !modelId || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10)
    throw new TypeError("Usage: catalog-selection.mjs <session> <model> [--repeat 1..10]");
  const only = values.only === undefined ? undefined : new Set(values.only.split(","));
  return { directory, modelId, repeat, only };
}

function selectionRun(fixture, repeat, pendingPath) {
  const tag = randomUUID().slice(0, 8);
  const created = selectionNames(fixture, tag);
  return {
    tag,
    repeat,
    pendingPath,
    created,
    foreignStray: 0,
    attempts: [],
    stop: new globalThis.AbortController(),
    fixture: { ...fixture, selection: created },
  };
}

/** The report of the attempts so far; an interrupted or failed run is marked incomplete. */
function finishReport(session, modelId, run, startedAt, complete) {
  const { attempts } = run;
  const report = { startedAt, model: modelId, repeat: run.repeat, complete, attempts };
  report.foreignStray = run.foreignStray;
  report.summary = summarizeSelection(attempts);
  writeReport(session, report);
  const { selected, alternative, wrongArguments, valid, invalid, sufficient } = report.summary;
  stage("completed", {
    complete,
    selected,
    alternative,
    wrongArguments,
    valid,
    invalid,
    sufficient,
  });
  // A signal's exit code is kept; otherwise an incomplete or insufficient run fails.
  if (!sufficient || !complete) process.exitCode ??= 1;
}

async function measure(session, modelId, run, cases) {
  const startedAt = new Date().toISOString();
  let complete = false;
  let stopped;
  // A refusal before the first turn still writes a report, marked incomplete with no attempts, so
  // an older report is never read as this run's result.
  try {
    await createSelectionObjects(session, run.fixture, run.tag, run.created);
    // Refuse before any model turn: a project beyond the snapshot bound, or orphans of a killed run.
    const preflight = await scopeSnapshot(session, run.fixture, run.created);
    const orphans = orphanedIssues(preflight, run.created);
    if (orphans > 0)
      throw new TypeError(
        `${orphans} issues summarized "Auswahl Vorgang|Ziel" of an earlier run remain; delete them natively first`,
      );
    for (const batch of attemptBatches(cases, run.repeat)) {
      if (run.stop.signal.aborted) break;
      stage("lifecycle-started", { attempts: batch.length });
      await withLiveChat({
        session,
        modelId,
        run: async (context) => {
          await runAttempts(context, run, batch);
        },
      });
    }
    // A signal during the last attempt ends the loop normally, but the run was still stopped.
    complete = !run.stop.signal.aborted;
  } catch (error) {
    stopped = error;
    throw error;
  } finally {
    reportBeside(stopped, () => finishReport(session, modelId, run, startedAt, complete));
  }
}

/** A failed report write never replaces the error that stopped the run; it is reported beside it. */
function reportBeside(stopped, write) {
  try {
    write();
  } catch (error) {
    if (stopped === undefined) throw error;
    stage("report-failed", { errorType: error instanceof Error ? error.name : "unknown" });
  }
}

/** A cleanup failure never replaces the error that stopped the run; it is reported beside it. */
async function cleanUp(session, run, failed) {
  try {
    await removeSelectionObjects(session, run.created);
    // Every write targets owned objects, which this removal deleted, so no effect is left to
    // reconcile; only a failed removal keeps the pending marker.
    rmSync(run.pendingPath, { force: true });
  } catch (error) {
    if (!failed) throw error;
    stage("cleanup-failed", { errorType: error instanceof Error ? error.name : "unknown" });
  }
}

async function main() {
  const { directory, modelId, repeat, only } = options();
  const session = loadSession(directory);
  const pendingPath = join(session.directory, "catalog-selection.pending.json");
  if (existsSync(pendingPath))
    throw new TypeError("A previous write attempt is pending; reconcile it natively first");
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const cases = SELECTION_CASES.filter((entry) => only === undefined || only.has(entry.id));
  const run = selectionRun(fixture, repeat, pendingPath);
  // A signal stops the run between steps: the turn in flight is aborted, its effect is still
  // verified and removed, and the owned objects are cleaned up before the process exits.
  const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  // A second signal exits at once, for a native request that hangs; owned objects then remain and
  // the next run refuses to start until they are removed by hand.
  const interrupted = (signal) => {
    const repeated = run.stop.signal.aborted;
    stage("stop-requested", { signal, repeated });
    if (repeated) process.exit(EXIT_CODES[signal]);
    process.exitCode = EXIT_CODES[signal];
    run.stop.abort();
  };
  for (const signal of Object.keys(EXIT_CODES)) process.on(signal, interrupted);
  let failed = false;
  try {
    await measure(session, modelId, run, cases);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await cleanUp(session, run, failed);
  }
}

if (isMainModule(import.meta.url))
  await main().catch((error) => {
    stage("failed", { errorType: errorName(error) });
    console.error(`jira-catalog-selection: ${String(error?.message ?? error).slice(0, 200)}`);
    process.exitCode ??= 1;
  });
