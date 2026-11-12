// AC7 model-free qualification through the existing lab and application-owned catalog.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHostExecutable } from "../../lib/host-executable.mjs";
import { withModelFreeJira, prepareModelFreeChat } from "./chat-read.mjs";
import { reportFaultQualificationFailure } from "./chat-lifecycle.mjs";
import {
  assertSessionServerInfo,
  basicAuth,
  labRequest,
  loadSession,
  requireLicense,
} from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import { observeQualificationFixtures } from "./api-qualification-cases.mjs";
import { dispatchQualification, qualificationWitness } from "./api-qualification-runtime.mjs";
import {
  API_QUALIFICATION_ALL_CASES,
  assertQualificationRecipeCoverage,
} from "./api-qualification-case-list.mjs";
import { requireQualificationSnapshot } from "./api-qualification-snapshot.mjs";
import { decidedQualificationDeferrals, ownerDeferredRow } from "./api-qualification-policy.mjs";
import {
  classifyQualification,
  qualificationDigest,
  qualificationSummary,
} from "./api-qualification-evidence.mjs";
import {
  measuredAssertionCount,
  resetAssertionCount,
  resetNativeReadCount,
} from "./api-qualification-assert.mjs";
import { NativeReadError } from "./api-qualification-read.mjs";
import {
  annotateCause,
  causeSummary,
  describeFailure,
  localRefusal,
  markNotAttempted,
} from "./api-qualification-cause.mjs";

const repository = resolve(import.meta.dirname, "..", "..", "..");
const ledgerPath = join(repository, "docs/local-knowledge/jira-api-coverage/operations.json");
const proposalPath = "docs/local-knowledge/jira-api-coverage/qualification-proposals.json";
const stage = (value) =>
  console.log(JSON.stringify({ operation: "jira-api-qualification", ...value }));

export async function runQualificationBatches({
  session,
  specifications,
  witness,
  stateReady,
  run,
}) {
  // Keep the product's retained-authority bound intact. Each finite batch uses the existing
  // paired-product lifecycle sequentially against the same owned Jira, with separate evidence.
  for (let start = 0; start < specifications.length; start += 32) {
    const batch = start / 32;
    await withModelFreeJira({
      session,
      decorateAtlassianHttp: witness?.decorate,
      decoratePrivateLifecycle: witness?.privateLifecycle,
      stateReady: (root) => stateReady?.(root, batch),
      run: (context) => run(context, specifications.slice(start, start + 32), batch),
    });
  }
}

function sourceRevision() {
  const options = { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  const dirty = execFileSync(
    resolveHostExecutable("git"),
    ["status", "--porcelain", "--untracked-files=normal"],
    options,
  );
  assert.equal(
    dirty,
    "",
    "Commit the complete qualification sources before recording native evidence",
  );
  return execFileSync(resolveHostExecutable("git"), ["rev-parse", "HEAD"], options).trim();
}

function caseRows(ledger, cases) {
  const tools = new Map();
  for (const row of ledger.operations)
    for (const tool of row.currentCapabilityIds) {
      assert.ok(!tools.has(tool), "A native qualification tool has one exact identity");
      tools.set(tool, row.identity);
    }
  return cases.map((entry) => {
    const identity = tools.get(entry.tool);
    assert.ok(identity, "Every qualification case must belong to the operation ledger");
    return { ...entry, identity };
  });
}

const readbackFailure = (error) => {
  if (error instanceof NativeReadError) return "oracle-read-refused";
  return error instanceof assert.AssertionError ? "readback-mismatch" : "readback-failed";
};
/** The readback runs under the assertion meter; a verification that already ran carries its count. */
async function measuredReadback(context, specification, attempted, fixture) {
  if (attempted.readback !== undefined)
    return { ...attempted.readback, measuredAssertionCount: attempted.measuredAssertionCount ?? 0 };
  resetAssertionCount();
  const readback = await specification.readback(context, attempted.dispatch.result?.data, fixture);
  return { ...readback, measuredAssertionCount: measuredAssertionCount() };
}
async function observeReadback(context, specification, attempted, fixture, snapshot) {
  // A refusal before any native request leaves nothing to read back; it is not a mismatch.
  const refusal = localRefusal(attempted.dispatch, snapshot);
  if (refusal !== undefined) return { failure: "product-refused", product: refusal };
  if (attempted.verifyRefused !== undefined)
    return { failure: "outcome-refused", product: attempted.verifyRefused };
  try {
    const readback = await measuredReadback(context, specification, attempted, fixture);
    return { readback: { ...readback, measuredPresenceReads: attempted.presenceReads ?? 0 } };
  } catch (error) {
    return { failure: readbackFailure(error), detail: describeFailure(error) };
  }
}
function caseEvidence(specification, attempted, observation, readback, extra, report) {
  const runtimeAvailability = classifyQualification({
    ...attempted,
    identity: specification.identity,
    witness: observation,
    readback,
  });
  return {
    runId: report.runId,
    sourceRevision: report.sourceRevision,
    release: report.release,
    imageDigest: report.imageDigest,
    id: caseId(specification),
    identity: specification.identity,
    tool: specification.tool,
    runtimeAvailability,
    binding: attempted.binding,
    mutation: specification.mutation === true,
    dispatch: {
      kind: attempted.dispatch.kind,
      result: {
        status: attempted.dispatch.result.status,
        data: {
          operationBinding: attempted.dispatch.result.data?.operationBinding,
          outcome: attempted.dispatch.result.data?.outcome,
          reason: attempted.dispatch.result.data?.reason,
        },
      },
      receipt: attempted.dispatch.receipt,
    },
    witness: observation,
    receipt: attempted.dispatch.receipt,
    journal:
      attempted.journal === undefined
        ? null
        : {
            phase: attempted.journal.phase,
            outcome: attempted.journal.outcome,
            httpStatus: attempted.journal.httpStatus,
          },
    resultDigest: qualificationDigest(attempted.dispatch.result),
    readback,
    ...extra,
  };
}
/** The one intentional stop: a native effect whose outcome is not certain is never built upon. */
class ReconcileRequiredError extends TypeError {
  constructor() {
    super("Uncertain native effect requires reconciliation before any further dispatch");
    this.name = "ReconcileRequiredError";
  }
}
const caseId = (specification) =>
  specification.fixtureId ?? qualificationDigest(specification.identity).slice(0, 24);
/**
 * A case that could not be prepared or dispatched is graded unknown; it never aborts the run.
 * `effects` is the real count of started native writes; `refused` says each one was definitely refused.
 * `extra` carries the safe failure detail and the cause tracking (`blockedBy`, snapshot).
 */
function ungradedEvidence(specification, report, failure, effects, refused = false, extra = {}) {
  const { detail, blockedBy, snapshot } = extra;
  return annotateCause(
    {
      runId: report.runId,
      sourceRevision: report.sourceRevision,
      release: report.release,
      imageDigest: report.imageDigest,
      id: caseId(specification),
      identity: specification.identity,
      tool: specification.tool,
      runtimeAvailability: "unknown",
      mutation: specification.mutation === true,
      failure,
      ...(detail === undefined ? {} : { detail }),
      // An effect that started before the failure needs reconciliation before it is trusted.
      ...(effects > 0 && !refused ? { reconcileRequired: true } : {}),
      ...(effects > 0 && refused ? { refusedEffects: effects } : {}),
    },
    { blockedBy, snapshot },
  );
}
function recordUngraded(specification, directory, evidence) {
  privateJson(join(directory, `${evidence.id}.json`), evidence, true);
  stage({
    identity: specification.identity,
    runtimeAvailability: "unknown",
    failure: evidence.failure,
    cause: evidence.cause,
    ...(evidence.blockedBy === undefined ? {} : { blockedBy: evidence.blockedBy.tool }),
    ...(evidence.reconcileRequired ? { reconcileRequired: true } : {}),
  });
  return evidence;
}
const prepareFailure = (error) =>
  error instanceof assert.AssertionError ? "prepare-precondition" : "prepare-failed";
async function prepareCase(context, chat, specification, fixture) {
  try {
    await specification.prepare?.(context, fixture, chat);
    return undefined;
  } catch (error) {
    if (error instanceof ReconcileRequiredError) throw error;
    context.qualificationPrepareDetail = describeFailure(error);
    return prepareFailure(error);
  }
}
/**
 * Statuses with which Jira refuses a request without applying it. A timeout (408), early-data
 * refusal (425) or rate limit (429) says nothing definite about the effect, so it still stops the run.
 */
const DEFINITE_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 412, 415, 422]);
const refusedOnly = (snapshot) =>
  snapshot.blocked === 0 &&
  snapshot.responses.length > 0 &&
  snapshot.responses.every((response) => DEFINITE_REFUSAL_STATUSES.has(response.status));
/**
 * An ungraded case after a native effect needs reconciliation unless every response was a refusal or
 * the effect is certain (a settled native 2xx that the oracle merely could not confirm).
 */
export const unknownAfterEffect = (evidence, witness) =>
  evidence.runtimeAvailability === "unknown" &&
  evidence.certainEffect !== true &&
  witness.effectsStarted() > 0 &&
  !refusedOnly(witness.snapshot());
async function dispatchCase(context, chat, specification, fixture, witness, pending) {
  try {
    return {
      attempted: await dispatchQualification(context, chat, specification, () =>
        specification.arguments(fixture),
      ),
    };
  } catch (error) {
    const detail = describeFailure(error);
    stage({ identity: specification.identity, dispatchFailure: detail });
    // Before any native effect started, a refusal or local failure proves nothing about Jira.
    // A native effect whose every observed response is a definite refusal changed nothing.
    if (witness.effectsStarted() > 0 && !refusedOnly(witness.snapshot()))
      throw new ReconcileRequiredError();
    rmSync(pending);
    return { failure: "dispatch-failed", detail };
  }
}
function recordAuxiliaries(attempted, directory, report) {
  return (attempted.auxiliaries ?? []).map((auxiliary) => {
    const specification = {
      tool: auxiliary.tool,
      identity: auxiliary.identity,
      mutation: auxiliary.attempted.mutation,
      fixtureId: `fixture-${randomUUID()}`,
    };
    const row = caseEvidence(
      specification,
      auxiliary.attempted,
      auxiliary.attempted.witness,
      auxiliary.readback,
      {},
      report,
    );
    assert.equal(row.runtimeAvailability, "executable", "Auxiliary evidence must remain verified");
    privateJson(join(directory, `${row.id}.json`), row, true);
    return `${row.id}.json`;
  });
}
/** A settled refusal that the case's own readback reproduced independently left nothing to reconcile. */
function settledRefusal(journal, evidence) {
  if (journal.phase !== "settled") return false;
  const { runtimeAvailability, readback } = evidence;
  // The running release does not publish the write at all (route-level 404/405, or a shadowed route).
  if (runtimeAvailability === "unavailable")
    return readback?.capabilityAbsent === true && new Set([400, 404, 405]).has(journal.httpStatus);
  // A native 403 independently reproduced as a refusal wrote nothing either.
  return (
    runtimeAvailability === "denied" &&
    readback?.permissionDenied === true &&
    journal.httpStatus === 403
  );
}
/** An unsettled or unknown native write stops the run unless it is such a settled refusal. */
function needsReconcile(journal, evidence, snapshot) {
  if (journal?.outcome !== "unknown" && journal?.phase !== "dispatched") return false;
  // A settled write whose every native response was a definite refusal changed nothing. This is an
  // intentional rule (#4287): the case stays unknown and later cases never build on its effect.
  if (journal.phase === "settled" && refusedOnly(snapshot)) return false;
  return !settledRefusal(journal, evidence);
}
/**
 * A mutation whose journal settled with a native 2xx the witness itself observed is a certain
 * effect: it happened, whatever the oracle could see. Anything else (an unsettled journal, a
 * timeout, a rate limit, 5xx, a lost transport) stays uncertain and still needs reconciliation.
 */
export function certainEffect(journal, snapshot) {
  return (
    journal?.phase === "settled" &&
    new Set(["succeeded", "succeeded-unconfirmed"]).has(journal.outcome) &&
    snapshot.blocked === 0 &&
    snapshot.responses.length > 0 &&
    snapshot.responses.every(
      (response) =>
        response.status >= 200 &&
        response.status < 300 &&
        response.status === journal.httpStatus &&
        (response.truncated === false || response.statusOnly === true),
    )
  );
}
async function gradeCase(
  { context, specification, fixture, witness, directory, report },
  attempted,
) {
  const snapshot = attempted.witness ?? witness.snapshot();
  const { readback, ...extra } = await observeReadback(
    context,
    specification,
    attempted,
    fixture,
    snapshot,
  );
  const evidence = annotateCause(
    caseEvidence(specification, attempted, snapshot, readback, extra, report),
    { snapshot },
  );
  if (evidence.runtimeAvailability === "unknown" && certainEffect(attempted.journal, snapshot))
    evidence.certainEffect = true;
  evidence.auxiliaryReferences = recordAuxiliaries(attempted, directory, report);
  privateJson(join(directory, `${evidence.id}.json`), evidence, true);
  if (needsReconcile(attempted.journal, evidence, evidence.witness))
    throw new ReconcileRequiredError();
  rmSync(join(directory, `${evidence.id}.pending.json`));
  stage({
    identity: specification.identity,
    runtimeAvailability: evidence.runtimeAvailability,
    ...(evidence.failure ? { failure: evidence.failure } : {}),
    ...(evidence.cause ? { cause: evidence.cause } : {}),
  });
  return evidence;
}
const auxiliaryBlocker = (context) =>
  context.qualificationAuxiliaryFailure === undefined
    ? undefined
    : { kind: "auxiliary", ...context.qualificationAuxiliaryFailure };
export async function runQualificationCase(
  context,
  chat,
  specification,
  fixture,
  witness,
  directory,
  report,
) {
  const failure = await prepareCase(context, chat, specification, fixture);
  if (failure !== undefined)
    return recordUngraded(
      specification,
      directory,
      ungradedEvidence(specification, report, failure, witness.effectsStarted(), false, {
        detail: context.qualificationPrepareDetail,
        blockedBy: auxiliaryBlocker(context),
      }),
    );
  const id = caseId(specification);
  const pending = join(directory, `${id}.pending.json`);
  privateJson(
    pending,
    { identity: specification.identity, phase: "dispatch-may-have-started" },
    true,
  );
  witness.arm(specification.identity, specification.mutation === true);
  const dispatched = await dispatchCase(context, chat, specification, fixture, witness, pending);
  if (dispatched.attempted === undefined)
    return recordUngraded(
      specification,
      directory,
      ungradedEvidence(
        specification,
        report,
        dispatched.failure,
        witness.effectsStarted(),
        refusedOnly(witness.snapshot()),
        {
          detail: dispatched.detail,
          blockedBy: auxiliaryBlocker(context),
          snapshot: witness.snapshot(),
        },
      ),
    );
  return gradeCase(
    { context, specification, fixture, witness, directory, report },
    dispatched.attempted,
  );
}

function attachFixtureDispatcher(
  context,
  chat,
  specification,
  fixture,
  witness,
  directory,
  report,
) {
  context.qualificationFixture = async ({
    tool,
    arguments: argumentsForFixture,
    readback,
    publishHumanInput,
  }) => {
    const operation = JSON.parse(readFileSync(ledgerPath, "utf8")).currentCapabilities[tool];
    assert.ok(operation && operation.effect === "write");
    assert.equal(context.actor, "admin", "Auxiliary effects use the existing explicit admin Chat");
    assert.equal(specification.administration, true);
    assert.ok(report.snapshotId, "Auxiliary fixture effects require the owned snapshot");
    const fixtureCase = {
      tool,
      identity: operation.identity,
      mutation: true,
      fixtureId: `fixture-${randomUUID()}`,
      arguments: () => argumentsForFixture,
      readback,
      ...(publishHumanInput === undefined ? {} : { publishHumanInput }),
    };
    const evidence = await runQualificationCase(
      context,
      chat,
      fixtureCase,
      fixture,
      witness,
      directory,
      report,
    );
    if (evidence.runtimeAvailability !== "executable")
      context.qualificationAuxiliaryFailure ??= { tool, identity: operation.identity };
    assert.equal(
      evidence.runtimeAvailability,
      "executable",
      "An auxiliary fixture must have settled independently verified native evidence",
    );
    witness.markVerified();
    return evidence;
  };
}
/** The first declared root cause of this case that already failed earlier in the run. */
function failedRoot(specification, failedRoots) {
  const tool = (specification.dependsOn ?? []).find((root) => failedRoots.has(root));
  return tool === undefined ? undefined : { kind: "case", tool, identity: failedRoots.get(tool) };
}
/**
 * Root-cause cases run before their declared dependents; every other case keeps its position, so the
 * order stays deterministic. A dependency outside the selection never moves anything.
 */
export function orderByDependencies(specifications) {
  const byTool = new Map(specifications.map((entry) => [entry.tool, entry]));
  const ordered = [];
  const placed = new Set();
  const place = (entry, trail = new Set()) => {
    if (placed.has(entry.tool) || trail.has(entry.tool)) return;
    trail.add(entry.tool);
    for (const root of entry.dependsOn ?? []) if (byTool.has(root)) place(byTool.get(root), trail);
    placed.add(entry.tool);
    ordered.push(entry);
  };
  for (const entry of specifications) place(entry);
  return ordered;
}
function recordBlocked(specification, directory, report, blockedBy) {
  return recordUngraded(
    specification,
    directory,
    ungradedEvidence(specification, report, "blocked-by-root", 0, false, { blockedBy }),
  );
}
async function chatFor(context, chats, specification) {
  const binding = `${context.actor}:${specification.administration === true}`;
  if (!chats.has(binding))
    chats.set(
      binding,
      await prepareModelFreeChat(context, context.actor, specification.administration === true),
    );
  return chats.get(binding);
}
async function executeCase(state, specification) {
  const { context, fixture, report, directory, witness } = state;
  await requireLicense(context.session);
  context.actor = specification.actor ?? "api";
  const chat = await chatFor(context, state.chats, specification);
  context.qualificationChat = chat;
  context.qualificationAuxiliaryFailure = undefined;
  resetNativeReadCount();
  attachFixtureDispatcher(context, chat, specification, fixture, witness, directory, report);
  witness.reset();
  const blockedBy = failedRoot(specification, state.failedRoots);
  if (blockedBy !== undefined) return recordBlocked(specification, directory, report, blockedBy);
  return runQualificationCase(context, chat, specification, fixture, witness, directory, report);
}
async function executeCases(context, specifications, report, directory, witness, priorFixture) {
  context.actor = "api";
  const fixture =
    priorFixture ??
    (await observeQualificationFixtures(
      context,
      JSON.parse(readFileSync(join(context.session.directory, "fixture.json"), "utf8")),
    ));
  fixture.runId = report.runId;
  context.qualificationFixtureState = fixture;
  context.qualificationWitness = witness;
  const state = {
    context,
    fixture,
    report,
    directory,
    witness,
    chats: new Map(),
    failedRoots: report.failedRoots,
  };
  for (const specification of specifications) {
    const evidence = await executeCase(state, specification);
    const row = report.operations.find(
      (operation) => operation.identity === specification.identity,
    );
    Object.assign(row, evidence, {
      verificationReferences:
        evidence.runtimeAvailability === "unknown" ? [] : [`${report.file}#${evidence.id}`],
    });
    if (evidence.runtimeAvailability === "unknown")
      state.failedRoots.set(specification.tool, specification.identity);
    privateJson(join(directory, report.file), report);
    // A failure before any native effect leaves nothing to reconcile; the run continues.
    if (unknownAfterEffect(evidence, witness)) throw new ReconcileRequiredError();
    if (evidence.runtimeAvailability === "executable")
      await specification.cleanup?.(context, fixture);
  }
  return fixture;
}

function createReport(session, ledger, revision, runId) {
  const proposals = JSON.parse(readFileSync(join(repository, proposalPath), "utf8"));
  const decisions = decidedQualificationDeferrals(proposals, ledger);
  const identities = new Set(ledger.operations.map((row) => row.identity));
  for (const proposal of proposals.proposals)
    assert.ok(proposal.identities.every((identity) => identities.has(identity)));
  const report = {
    schemaVersion: 1,
    runId,
    sourceRevision: revision,
    release: session.jiraVersion,
    imageDigest: session.jiraImageDigest,
    inventoryDigest: qualificationDigest(ledger.operations.map((row) => row.identity)),
    file: `qualification-${session.jiraVersion}-${runId}.json`,
    modelCalls: 0,
    phase: "running",
    proposals: proposals.proposals.map((proposal) => ({
      id: proposal.id,
      status: proposals.status,
      proposedDisposition: proposal.proposedDisposition,
      identities: proposal.identities,
      reference: `${proposalPath}#${proposal.id}`,
    })),
    operations: ledger.operations.map((row) =>
      decisions.has(row.identity)
        ? ownerDeferredRow(row.identity, decisions.get(row.identity), {
            runId,
            sourceRevision: revision,
            release: session.jiraVersion,
            imageDigest: session.jiraImageDigest,
          })
        : { identity: row.identity, runtimeAvailability: "unknown", verificationReferences: [] },
    ),
  };
  // Run state, not evidence: the tools whose failure quarantines their declared dependents.
  Object.defineProperty(report, "failedRoots", { value: new Map(), enumerable: false });
  return report;
}
async function observeRelease(session) {
  const native = await labRequest(
    session,
    "GET",
    "/rest/api/2/serverInfo",
    basicAuth(session, "admin"),
  );
  assert.equal(native.status, 200);
  assertSessionServerInfo(session, native.value);
}
function prepareRun(session, ledger, revision) {
  const runId = randomUUID();
  const output = join(session.directory, `api-qualification-${runId}`);
  const pending = join(session.directory, "api-qualification.pending.json");
  privateJson(
    pending,
    {
      runId,
      sourceRevision: revision,
      release: session.jiraVersion,
      output,
      reconcileBeforeRetry: true,
    },
    true,
  );
  mkdirSync(output, { mode: 0o700 });
  const report = createReport(session, ledger, revision, runId);
  return { report, output, pending };
}
async function admitSnapshot(session, selected, report, snapshotId) {
  if (!selected.some((entry) => entry.destructiveAdministration)) return;
  assert.ok(snapshotId, "Destructive administration requires a verified owned snapshot");
  const snapshot = await requireQualificationSnapshot(session, snapshotId);
  report.snapshotId = snapshot.id;
}
function qualificationPlan(directory, only) {
  const session = loadSession(directory);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.operations.length, 439);
  const revision = sourceRevision();
  if (only === undefined)
    assertQualificationRecipeCoverage(
      ledger,
      decidedQualificationDeferrals(
        JSON.parse(readFileSync(join(repository, proposalPath), "utf8")),
        ledger,
      ),
    );
  const selected = orderByDependencies(
    caseRows(ledger, API_QUALIFICATION_ALL_CASES).filter(
      (entry) => only === undefined || only.includes(entry.tool),
    ),
  );
  assert.ok(selected.length > 0);
  return { session, ledger, revision, selected };
}
/** Every row's cause is complete before the summary: rows never reached are named as such. */
function finishReport(report, output) {
  markNotAttempted(report.operations);
  report.counts = qualificationSummary(report.operations);
  report.causeCounts = causeSummary(report.operations);
  privateJson(join(output, report.file), report);
}
async function runBatches({ session, selected, witness, report, output, emailDefaultOracle }) {
  let fixture;
  await runQualificationBatches({
    session,
    specifications: selected,
    witness,
    stateReady: (root, batch) => {
      const file = batch === 0 ? "product-state.json" : `product-state-${batch}.json`;
      privateJson(join(output, file), { root }, true);
      report.productStateFiles ??= [];
      report.productStateFiles.push(file);
      privateJson(join(output, report.file), report);
    },
    run: async (context, batchCases) => {
      context.qualificationEmailDefaultOracle = emailDefaultOracle;
      fixture = await executeCases(context, batchCases, report, output, witness, fixture);
    },
  });
}
async function qualifyApi(directory, only, snapshotId, { emailDefaultOracle } = {}) {
  const { session, ledger, revision, selected } = qualificationPlan(directory, only);
  await observeRelease(session);
  const { report, output, pending } = prepareRun(session, ledger, revision);
  await admitSnapshot(session, selected, report, snapshotId);
  const witness = qualificationWitness(session);
  privateJson(join(output, report.file), report, true);
  try {
    await runBatches({ session, selected, witness, report, output, emailDefaultOracle });
  } catch (error) {
    // The one intentional stop still leaves a complete cause record of everything it did not reach.
    report.phase = "incomplete";
    report.stoppedEarly = { errorType: error instanceof Error ? error.name : "unknown" };
    finishReport(report, output);
    throw error;
  }
  assert.equal(sourceRevision(), revision, "Qualification sources changed during the run");
  finishReport(report, output);
  report.phase = report.counts.unknown === 0 ? "complete" : "incomplete";
  privateJson(join(output, report.file), report);
  rmSync(pending);
  stage({
    release: session.jiraVersion,
    sourceRevision: revision,
    counts: report.counts,
    causes: report.causeCounts,
    proposals: report.proposals.length,
  });
  return { report, counts: report.counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, only, snapshotId, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
      throw new TypeError(
        "Usage: api-qualification.mjs <private-session> [comma-separated-tools] [owned-snapshot-id]",
      );
    const { counts } = await qualifyApi(
      directory,
      only === "*" ? undefined : only?.split(","),
      snapshotId,
    );
    if (counts.unknown > 0) process.exitCode = 1;
  } catch (error) {
    stage({
      passed: false,
      reconcileRequired: true,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    reportFaultQualificationFailure("jira-api-qualification", error);
  }
}
