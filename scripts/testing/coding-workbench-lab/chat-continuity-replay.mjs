// Replay an already measured state through a frozen product's ordinary Chat route.
// Originals stay read-only; the measured question/answer are removed only from the clone.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  RECALL_QUESTION,
  continuityCorpusManifest,
  continuityDigest,
  evaluateContinuityAnswer,
} from "./chat-continuity-corpus.mjs";
import { privateContinuityOutput } from "./chat-continuity-runtime.mjs";
import { readContinuityBuildIdentity } from "./chat-continuity-build.mjs";
import { parseCli, runMain } from "./lab-common.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";

function assertMeasuredAnswer(messages, question, answerDigest) {
  const answer = messages.at(-1);
  if (
    messages.at(-2)?.id !== question.id ||
    answer?.chat_id !== question.chat_id ||
    answer.role !== "assistant" ||
    continuityDigest(answer.content) !== answerDigest
  )
    throw new TypeError("replay-answer-binding-mismatch");
  return answer;
}

function bindMeasuredProbe(db, row) {
  const messages = db.prepare("SELECT rowid, * FROM chat_messages ORDER BY rowid").all();
  const questions = messages.filter(
    (m) => m.role === "user" && continuityDigest(m.content) === continuityDigest(RECALL_QUESTION),
  );
  if (questions.length !== 1) throw new TypeError("replay-question-binding-ambiguous");
  const question = questions[0];
  const answer = assertMeasuredAnswer(messages, question, row.answerDigest);
  const chat = db
    .prepare("SELECT id, project_path, selected_model FROM chats WHERE id = ?")
    .get(question.chat_id);
  if (chat?.selected_model !== row.model || row.kind !== "plain")
    throw new TypeError("replay-chat-binding-mismatch");
  const remaining = messages.slice(0, -2);
  const corpus = continuityCorpusManifest();
  for (const key of ["initialDigest", "correctionDigest"])
    if (
      !remaining.some(
        (m) =>
          m.chat_id === chat.id && m.role === "user" && continuityDigest(m.content) === corpus[key],
      )
    )
      throw new TypeError("replay-original-agreements-missing");
  return { messages, question, answer, chat, remaining };
}

export function removeMeasuredProbe(db, row) {
  const { question, answer, chat, remaining } = bindMeasuredProbe(db, row);
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted = db
      .prepare("DELETE FROM chat_messages WHERE id IN (?, ?)")
      .run(question.id, answer.id);
    if (deleted.changes !== 2) throw new Error("replay-probe-removal-failed");
    const actual = db.prepare("SELECT rowid, * FROM chat_messages ORDER BY rowid").all();
    if (JSON.stringify(actual) !== JSON.stringify(remaining))
      throw new Error("replay-originals-changed");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    chat,
    originalScore: evaluateContinuityAnswer(answer.content),
    canonicalMessages: remaining.length,
    canonicalDigest: continuityDigest(JSON.stringify(remaining)),
  };
}

function replayInputs(ledgerPath, indices) {
  const bytes = readFileSync(ledgerPath);
  let source;
  try {
    source = JSON.parse(bytes);
  } catch {
    throw new TypeError("invalid-replay-ledger-json");
  }
  const corpus = continuityCorpusManifest();
  for (const key of ["initialDigest", "correctionDigest", "questionDigest"])
    if (source.corpus?.[key] !== corpus[key]) throw new TypeError("replay-corpus-prompt-mismatch");
  const selected = indices.split(",").map(Number);
  const acceptable = (n) =>
    Number.isSafeInteger(n) &&
    n >= 0 &&
    source.ledger[n]?.score &&
    source.ledger[n]?.kind === "plain";
  if (
    selected.length > 100 ||
    new Set(selected).size !== selected.length ||
    !selected.every(acceptable)
  )
    throw new TypeError("replay-scored-plain-indices-required");
  return { source, selected, sourceLedgerDigest: continuityDigest(bytes), corpus };
}

function replayReport(input, subject, config) {
  return {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    scope:
      "retained-post-probe-state-with-measured-turn-removed; cold-restart-replay-not-a-new-long-campaign",
    inheritedDerivedState: "preserved-identically-between-replays",
    sourceLedgerDigest: input.sourceLedgerDigest,
    subject: readContinuityBuildIdentity(subject),
    corpus: input.corpus,
    observerDigest: continuityDigest(readFileSync(new URL(import.meta.url))),
    configDigest: continuityDigest(readFileSync(config)),
    cases: [],
    physical: [],
    preflight: "settings-chat-readiness-probe-before-each-replay",
    timingComparability: "uncontrolled-shared-host; descriptive-only",
    globalSystemScore: null,
  };
}

async function prepareReplayCase(subjectRuntime, source, dir, row) {
  await subjectRuntime.snapshotContinuityState(source, dir);
  const db = new DatabaseSync(join(dir, "ui", "keiko-ui.db"));
  try {
    return removeMeasuredProbe(db, row);
  } finally {
    db.close();
  }
}

function plainReplayBody(prepared, model) {
  return {
    chatId: prepared.chat.id,
    projectPath: prepared.chat.project_path,
    modelId: model,
    content: RECALL_QUESTION,
    expectedSkillSelectionRevision: null,
    clientTurnId: randomUUID(),
  };
}

export async function sendReplayRequest(
  runtime,
  prepared,
  model,
  index,
  result,
  checkpoint = () => undefined,
) {
  const stage = (value) => {
    result.stage = value;
    checkpoint();
  };
  stage("readiness");
  runtime.setActive(`readiness:${index}`);
  const ready = await runtime.request("POST", "/api/gateway/readiness", {
    modelId: model,
    options: { probes: ["chat"] },
  });
  result.readinessHttpStatus = ready.status;
  result.readinessPassed =
    ready.json?.probes?.some((p) => p.name === "chat" && p.status === "passed") === true;
  if (ready.status !== 200 || !result.readinessPassed) {
    result.status = "readiness-failed";
    stage(result.status);
    return;
  }
  runtime.setActive(`replay:${index}`);
  stage("request");
  const started = performance.now();
  const response = await runtime.request(
    "POST",
    "/api/desktop/chat",
    plainReplayBody(prepared, model),
  );
  result.elapsedMs = performance.now() - started;
  result.httpStatus = response.status;
  if (response.status !== 200) {
    result.status = "request-failed";
    stage(result.status);
    return;
  }
  const answer = response.json.messages?.findLast((m) => m.role === "assistant")?.content;
  if (typeof answer !== "string") throw new Error("replay-answer-missing");
  result.answerDigest = continuityDigest(answer);
  result.score = evaluateContinuityAnswer(answer);
  stage("draining");
  await runtime.drain();
  result.status = "completed";
  stage(result.status);
}

async function runReplayCase(context, index) {
  const { input, subjectRuntime, target, ledgerPath, config, report, cancellation, save } = context;
  cancellation.signal.throwIfAborted();
  const row = input.source.ledger[index],
    dir = join(target, `case-${index}`);
  const prepared = await prepareReplayCase(
    subjectRuntime,
    join(dirname(ledgerPath), `probe-${index}`),
    dir,
    row,
  );
  const result = {
    index,
    model: row.model,
    originalScore: prepared.originalScore,
    canonicalMessages: prepared.canonicalMessages,
    canonicalDigest: prepared.canonicalDigest,
    status: "running",
  };
  report.cases.push(result);
  save();
  let runtime;
  try {
    runtime = await subjectRuntime.startContinuityRuntime(dir, config, report.physical, {
      signal: cancellation.signal,
    });
    await sendReplayRequest(runtime, prepared, row.model, index, result, save);
  } finally {
    try {
      await runtime?.close();
    } finally {
      save();
    }
  }
}

async function runReplayCases(context, subject) {
  const { report, cancellation, save, input } = context;
  const cancel = () => cancellation.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    for (const index of input.selected) await runReplayCase(context, index);
    const after = readContinuityBuildIdentity(subject);
    if (JSON.stringify(after) !== JSON.stringify(report.subject))
      throw new Error("replay-subject-changed");
    report.status = report.cases.every((c) => c.status === "completed")
      ? "completed"
      : "incomplete";
  } catch (error) {
    report.status = cancellation.signal.aborted ? "terminated" : "failed";
    throw error;
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    report.finishedAt = new Date().toISOString();
    save();
  }
  return report;
}

export async function replayContinuityCases({
  ledger: ledgerPath,
  subject,
  config,
  output,
  indices,
}) {
  const input = replayInputs(ledgerPath, indices);
  const report = replayReport(input, subject, config);
  const target = privateContinuityOutput(output);
  mkdirSync(target, { mode: 0o700 });
  const subjectRuntime = await import(
    pathToFileURL(join(subject, "scripts/testing/coding-workbench-lab/chat-continuity-runtime.mjs"))
      .href
  );
  const save = () =>
    writeFileSync(join(target, "replay.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  save();
  return runReplayCases(
    {
      input,
      report,
      target,
      subjectRuntime,
      ledgerPath,
      config,
      cancellation: new globalThis.AbortController(),
      save,
    },
    subject,
  );
}

async function main() {
  const cli = parseCli({
    usage:
      "chat-continuity-replay.mjs --ledger <source> --subject <frozen-checkout> --config <native-config> --indices <ledger-indices> --output <new-private-directory>",
    options: Object.fromEntries(
      ["ledger", "subject", "config", "indices", "output"].map((key) => [key, { type: "string" }]),
    ),
  });
  if (cli.help) return;
  if (
    ["ledger", "subject", "config", "indices", "output"].some(
      (key) => typeof cli.values[key] !== "string",
    )
  )
    throw new TypeError("all-replay-options-required");
  const report = await replayContinuityCases(cli.values);
  if (report.status !== "completed") process.exitCode = 1;
  console.log(
    JSON.stringify({
      status: report.status,
      cases: report.cases.map((c) => ({
        index: c.index,
        model: c.model,
        status: c.status,
        score: c.score,
      })),
    }),
  );
}
if (isMainModule(import.meta.url)) runMain(main);
