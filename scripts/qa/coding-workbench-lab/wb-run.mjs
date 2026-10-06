#!/usr/bin/env node
// Drives one Coding Workbench run over the dev server's HTTP API and prints body-free progress
// plus the final answer text (the lab repository is synthetic). Use it for read-only tasks and
// the chaos scenarios: edits are applied by the live Workbench editor bridge in a browser, so an
// API-started run refuses every edit with NO_ACTIVE_SESSION (finding F4). Use wb-ui.mjs for tasks
// that edit files.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  TERMINAL_STATES,
  describeSnapshot,
  exitCodeForState,
  formatTaskList,
  labBaseUrl,
  log,
  minutesToMs,
  openApiSession,
  parseApprove,
  parseCli,
  resolveTaskInput,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-run.mjs (--task-id <id> | --task <text>) [--mode <label|id>] [--model <id>]",
  "                       [--approve all|none|ask] [--timeout-min 30] [--repo <path>]",
  "                       [--branch main] [--base-url <origin>] [--list-tasks]",
  "",
  "  --mode      Ask for approval | Supervised workspace | Full access (or governed-assist,",
  "              supervised-coding, autonomous-delivery); default: the task's mode, else Supervised",
  "  --approve   all approves every permission once, none denies, ask leaves them to the operator",
  "  --repo      lab repository to select first (default KEIKO_LAB_REPO; else the server's current one)",
  "",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL,",
  "KEIKO_LAB_REPO. Exit code: 0 succeeded, 1 another terminal state, 3 timed out, 2 usage.",
].join("\n");

const OPTIONS = {
  task: { type: "string" },
  "task-id": { type: "string" },
  mode: { type: "string" },
  model: { type: "string", default: "gemma-4-31b-it" },
  approve: { type: "string", default: "all" },
  "timeout-min": { type: "string", default: "30" },
  repo: { type: "string" },
  branch: { type: "string", default: "main" },
  "base-url": { type: "string" },
  "list-tasks": { type: "boolean" },
};
const POLL_MS = 3000;

async function selectCheckout(session, repo, branch) {
  const response = await session.request("POST", "/api/task-workspaces/local", {
    root: repo,
    branch,
    requestedBy: "studio-operator",
  });
  log("local checkout", response.status);
}

async function startRun(session, { text, mode, model }) {
  const started = await session.request("POST", "/api/coding-workbench/runtime/runs", {
    requestId: `lab-${randomUUID()}`,
    taskIntent: text,
    requestedMode: mode.id,
    runtimePreference: "managed-gateway",
    modelId: model,
    projectMemory: { enabled: false },
  });
  if (started.status >= 300) {
    const body = JSON.stringify(started.json).slice(0, 600);
    throw new Error(
      `start failed (HTTP ${String(started.status)}) ${body} corr ${started.correlationId}`,
    );
  }
  const runId = started.json.runId ?? started.json.snapshot?.runId;
  log("started", runId, "mode", mode.label, "model", model, "state", started.json.state);
  return runId;
}

async function decidePermission(session, runId, snapshot, approve) {
  const pending = snapshot.pendingPermission;
  const review = await session.request(
    "GET",
    `/api/coding-workbench/runtime/runs/${runId}/approval-review`,
  );
  log(
    "approval requested:",
    describeSnapshot(snapshot),
    `review fields: ${Object.keys(review.json).join(",")}`,
  );
  if (approve === "ask") return;
  const decision = approve === "all" ? "approved" : "denied";
  const answered = await session.request(
    "POST",
    `/api/coding-workbench/runtime/runs/${runId}/approvals`,
    {
      requestId: pending.requestId,
      expectedRevision: snapshot.revision,
      decision,
      grantScope: "once",
    },
  );
  log("decision", decision, "->", answered.status);
}

async function watchRun(session, runId, { approve, deadline }) {
  let last = "";
  let snapshot;
  const decided = new Set();
  while (Date.now() < deadline) {
    const response = await session.request("GET", `/api/coding-workbench/runtime/runs/${runId}`);
    snapshot = response.json.snapshot ?? response.json;
    const line = describeSnapshot(snapshot);
    if (line !== last) {
      log(line);
      last = line;
    }
    if (TERMINAL_STATES.includes(snapshot.state)) break;
    const pending = snapshot.pendingPermission;
    if (snapshot.state === "awaiting-approval" && pending && !decided.has(pending.requestId)) {
      decided.add(pending.requestId);
      await decidePermission(session, runId, snapshot, approve);
    }
    await sleep(POLL_MS);
  }
  return snapshot;
}

async function printAnswer(session) {
  const channel = await session.request("GET", "/api/coding-workbench/app-session/channel");
  const lastTurn = (channel.json?.content?.feed?.turns ?? []).at(-1);
  const text = (lastTurn?.messages ?? [])
    .filter((message) => message.role !== "user")
    .flatMap((message) => (message.segments ?? []).map((segment) => segment.text ?? ""))
    .join("\n")
    .trim();
  console.log(`----- answer -----\n${text || "(no assistant text)"}`);
}

async function main() {
  const cli = parseCli({ usage: USAGE, options: OPTIONS });
  if (cli.help) return 0;
  if (cli.values["list-tasks"]) {
    console.log(formatTaskList());
    return 0;
  }
  const { text, mode } = resolveTaskInput(cli.values);
  const approve = parseApprove(cli.values.approve);
  const timeoutMs = minutesToMs(cli.values["timeout-min"]);
  const session = await openApiSession(labBaseUrl(cli.values["base-url"]));
  const repo = cli.values.repo ?? process.env.KEIKO_LAB_REPO;
  if (repo) await selectCheckout(session, repo, cli.values.branch);
  const runId = await startRun(session, { text, mode, model: cli.values.model });
  const snapshot = await watchRun(session, runId, { approve, deadline: Date.now() + timeoutMs });
  const summary = {
    state: snapshot?.state,
    failure: snapshot?.failure,
    terminal: snapshot?.terminalReason,
    conversationId: snapshot?.conversationId,
  };
  log("final", JSON.stringify(summary).slice(0, 600));
  await printAnswer(session);
  console.log(`----- run ${runId} -----`);
  return exitCodeForState(snapshot?.state);
}

if (isMainModule(import.meta.url)) runMain(main);
