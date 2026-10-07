#!/usr/bin/env node
// Drives one Coding Workbench run over the dev server's HTTP API and prints body-free progress
// plus the final answer text (the lab repository is synthetic). Use it for read-only tasks and
// the chaos scenarios: edits are applied by the live Workbench editor bridge in a browser, so an
// API-started run refuses every edit with NO_ACTIVE_SESSION (finding F4). Use wb-ui.mjs for tasks
// that edit files. The driver acts as the operator, so it is fail-closed: the approval policy and
// the lab repository are always named, and it never runs in the dev server's current workspace.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  TERMINAL_STATES,
  approvalPolicyLine,
  assertCheckoutSelected,
  checkoutRequest,
  describeSnapshot,
  exitCodeForState,
  formatTaskList,
  gateActions,
  labBaseUrl,
  labRepositoryPath,
  log,
  minutesToMs,
  openApiSession,
  parseApprove,
  parseCli,
  resolveTaskInput,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-run.mjs (--task-id <id> | --task <text>) --approve all|none|ask",
  "                       (--repo <path> | KEIKO_LAB_REPO) [--mode <label|id>] [--model <id>]",
  "                       [--timeout-min 30] [--branch main] [--base-url <origin>] [--list-tasks]",
  "",
  "  --approve   required, no default: all approves every permission ask once, none denies every",
  "              ask, ask leaves them to a person (answer them in a paired Workbench window)",
  "  --repo      required unless KEIKO_LAB_REPO is set: the lab repository, a copy of",
  "              tests/fixtures/coding-workbench-lab/ledger-lab; it is always selected first and a",
  "              checkout whose package.json does not name ledger-lab is refused",
  "  --mode      Ask for approval | Supervised workspace | Full access (or governed-assist,",
  "              supervised-coding, autonomous-delivery); default: the task's mode, else Supervised",
  "",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL,",
  "KEIKO_LAB_REPO. Exit code: 0 succeeded, 1 another terminal state, 3 timed out, 2 usage.",
].join("\n");

const OPTIONS = {
  task: { type: "string" },
  "task-id": { type: "string" },
  mode: { type: "string" },
  model: { type: "string", default: "gemma-4-31b-it" },
  approve: { type: "string" },
  "timeout-min": { type: "string", default: "30" },
  repo: { type: "string" },
  branch: { type: "string", default: "main" },
  "base-url": { type: "string" },
  "list-tasks": { type: "boolean" },
};
const POLL_MS = 3000;
// Key of the one notice a paused run gets; permission request ids never look like it.
const PAUSED_NOTICE = "paused";

async function selectCheckout(session, repo, branch) {
  const response = await session.request(
    "POST",
    "/api/task-workspaces/local",
    checkoutRequest(repo, branch),
  );
  log("local checkout", response.status);
  assertCheckoutSelected(response.status);
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

async function logApprovalRequest(session, runId, snapshot) {
  const review = await session.request(
    "GET",
    `/api/coding-workbench/runtime/runs/${runId}/approval-review`,
  );
  log(
    "approval requested:",
    describeSnapshot(snapshot),
    `review fields: ${Object.keys(review.json).join(",")}`,
  );
}

async function answerPermission(session, runId, snapshot, decision) {
  const answered = await session.request(
    "POST",
    `/api/coding-workbench/runtime/runs/${runId}/approvals`,
    {
      requestId: snapshot.pendingPermission.requestId,
      expectedRevision: snapshot.revision,
      decision,
      grantScope: "once",
    },
  );
  log("decision", decision, "->", answered.status);
}

/** The operator gates of a run, answered as the approval policy says (see gateActions). */
async function answerGates(session, runId, snapshot, { approve, decided, announced }) {
  const pending = snapshot.pendingPermission;
  if (snapshot.state === "awaiting-approval" && pending && !announced.has(pending.requestId)) {
    announced.add(pending.requestId);
    await logApprovalRequest(session, runId, snapshot);
  }
  for (const action of gateActions(snapshot, approve, decided)) {
    if (action.kind === "permission") {
      await answerPermission(session, runId, snapshot, action.decision);
    } else if (!announced.has(PAUSED_NOTICE)) {
      announced.add(PAUSED_NOTICE);
      log(
        "paused for the package-script trust decision; wb-run.mjs cannot answer it (wb-trust.mjs grant, or wb-ui.mjs)",
      );
    }
  }
}

/** Polls the run until it is terminal or the deadline passes; `wait` and `now` are injectable. */
export async function watchRun(
  session,
  runId,
  { approve, deadline, wait = sleep, now = Date.now },
) {
  let last = "";
  let snapshot;
  const gates = { approve, decided: new Set(), announced: new Set() };
  while (now() < deadline) {
    const response = await session.request("GET", `/api/coding-workbench/runtime/runs/${runId}`);
    snapshot = response.json.snapshot ?? response.json;
    const line = describeSnapshot(snapshot);
    if (line !== last) {
      log(line);
      last = line;
    }
    if (TERMINAL_STATES.includes(snapshot.state)) break;
    await answerGates(session, runId, snapshot, gates);
    await wait(POLL_MS);
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
  const repo = labRepositoryPath(cli.values.repo);
  const timeoutMs = minutesToMs(cli.values["timeout-min"]);
  const session = await openApiSession(labBaseUrl(cli.values["base-url"]));
  log(approvalPolicyLine("wb-run", approve));
  await selectCheckout(session, repo, cli.values.branch);
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
  log(approvalPolicyLine("wb-run", approve));
  console.log(`----- run ${runId} -----`);
  return exitCodeForState(snapshot?.state);
}

if (isMainModule(import.meta.url)) runMain(main);
