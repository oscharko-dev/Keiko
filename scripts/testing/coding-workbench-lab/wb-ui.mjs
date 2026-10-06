#!/usr/bin/env node
// Drives one Coding Workbench run through the real UI in headless Chromium, so the Workbench's own
// editor bridge applies edits exactly as for a human operator. The driver pairs the browser with
// the dev server, selects the lab repository, chooses the model and the Run authority, starts the
// task, then polls the run and approves permissions and the package-script trust pause for you.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  CSRF_HEADERS,
  TERMINAL_STATES,
  browserBaseUrl,
  describeSnapshot,
  exitCodeForState,
  formatTaskList,
  labBaseUrl,
  labRepositoryPath,
  log,
  mintPairing,
  minutesToMs,
  parseApprove,
  parseCli,
  resolveTaskInput,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node wb-ui.mjs (--task-id <id> | --task <text>) [--repo <path>] [--mode <label|id>]",
  "                      [--model <id>] [--approve all|none|ask] [--timeout-min 40]",
  "                      [--branch main] [--base-url <origin>] [--shots <dir>]",
  "                      [--text-out <file>] [--headed] [--list-tasks]",
  "",
  "  --mode       Ask for approval | Supervised workspace | Full access; default: the task's mode",
  "  --approve    all approves every permission once and allows package scripts, none denies,",
  "               ask leaves both to the operator (use it with --headed)",
  "  --shots      directory for one screenshot per run state change",
  "  --text-out   file for the final Workbench text (the answer, so it stays outside the repo)",
  "",
  "Environment: KEIKO_LAB_REPO (the repository, unless --repo), KEIKO_LAB_BASE_URL (default",
  "http://127.0.0.1:1983), KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required). A Chromium build",
  "for Playwright must be installed: npx playwright install chromium.",
  "Exit code: 0 succeeded, 1 another terminal state, 3 timed out, 2 usage.",
].join("\n");

const OPTIONS = {
  task: { type: "string" },
  "task-id": { type: "string" },
  repo: { type: "string" },
  mode: { type: "string" },
  model: { type: "string", default: "gemma-4-31b-it" },
  approve: { type: "string", default: "all" },
  "timeout-min": { type: "string", default: "40" },
  branch: { type: "string", default: "main" },
  "base-url": { type: "string" },
  shots: { type: "string" },
  "text-out": { type: "string" },
  headed: { type: "boolean" },
  "list-tasks": { type: "boolean" },
};
const WORKBENCH = 'section[aria-label="Coding Workbench"][data-state]';
const VIEWPORT = { width: 1600, height: 1300 };
const SETTLE_MS = 1500;
const POLL_MS = 3000;
const UI_TIMEOUT_MS = 60_000;

/** Opens the Workbench window bound to the lab repository, as the desktop would restore it. */
async function seedWorkbenchWindow(page, repo) {
  await page.addInitScript((root) => {
    const windowState = {
      id: "lab-workbench",
      type: "coding",
      x: 20,
      y: 20,
      w: 1400,
      h: 1000,
      z: 10,
      zoom: 1,
      cfg: { repositoryPath: root },
      max: false,
    };
    globalThis.localStorage.setItem("keiko.workspace.v4", JSON.stringify([windowState]));
  }, repo);
}

async function waitForWorkbench(page) {
  const workbench = page.locator(WORKBENCH);
  await workbench.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await sleep(SETTLE_MS);
  return workbench;
}

async function selectCheckout(page, repo, branch) {
  const response = await page.request.post("/api/task-workspaces/local", {
    headers: CSRF_HEADERS,
    data: { root: repo, branch, requestedBy: "studio-operator" },
  });
  log("local checkout", response.status());
  await page.reload();
  return waitForWorkbench(page);
}

async function chooseOption(page, comboName, optionName) {
  await page.getByRole("combobox", { name: comboName }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function startRun(page, workbench, { model, mode, text }) {
  const newTask = page.getByRole("button", { name: "New task", exact: true });
  if (await newTask.isVisible().catch(() => false)) {
    await newTask.click();
    await sleep(1000);
  }
  await chooseOption(page, "Coding model", model);
  await chooseOption(page, "Run authority", mode.label);
  const composer = workbench.locator("textarea").first();
  await composer.fill(text);
  if ((await composer.inputValue()) !== text) {
    throw new Error("the composer holds a different text than the task; not starting (finding F6)");
  }
  const isStart = (response) =>
    response.url().endsWith("/api/coding-workbench/runtime/runs") &&
    response.request().method() === "POST";
  const started = page.waitForResponse(isStart, { timeout: UI_TIMEOUT_MS });
  await page.getByRole("button", { name: "Start coding run" }).click();
  const response = await started;
  const body = await response.json().catch(() => ({}));
  const runId = body.runId ?? body.snapshot?.runId;
  log("started", response.status(), runId, "mode", mode.label, "model", model);
  if (!runId) throw new Error(`the run did not start: ${JSON.stringify(body).slice(0, 500)}`);
  return runId;
}

async function clickIfVisible(locator, label) {
  if (!(await locator.isVisible().catch(() => false))) return false;
  log(label, await locator.textContent());
  await locator.click();
  return true;
}

async function decidePermission(page, runId, snapshot, approve) {
  const name = approve === "all" ? /^(Approve|Allow|Apply)/u : /^(Deny|Reject)/u;
  if (await clickIfVisible(page.getByRole("button", { name }).first(), "approval via UI:")) return;
  const decision = approve === "all" ? "approved" : "denied";
  const response = await page.request.post(
    `/api/coding-workbench/runtime/runs/${runId}/approvals`,
    {
      headers: CSRF_HEADERS,
      data: {
        requestId: snapshot.pendingPermission.requestId,
        expectedRevision: snapshot.revision,
        decision,
        grantScope: "once",
      },
    },
  );
  log("approval via API:", decision, response.status());
}

/** The two operator gates of a run: the package-script trust pause and a permission request. */
async function answerGates(page, runId, snapshot, { approve, decided }) {
  if (approve === "ask") return;
  if (snapshot.state === "paused" && approve === "all") {
    const allow = page.getByRole("button", { name: /^Allow package scripts/u }).first();
    await clickIfVisible(allow, "script trust via UI:");
  }
  const pending = snapshot.pendingPermission;
  if (snapshot.state === "awaiting-approval" && pending && !decided.has(pending.requestId)) {
    decided.add(pending.requestId);
    await decidePermission(page, runId, snapshot, approve);
  }
}

async function watchRun(page, runId, { approve, deadline, shots }) {
  let last = "";
  let shotCount = 0;
  let snapshot = {};
  const decided = new Set();
  while (Date.now() < deadline) {
    const response = await page.request.get(`/api/coding-workbench/runtime/runs/${runId}`);
    const body = (await response.json().catch(() => ({}))) ?? {};
    snapshot = body.snapshot ?? body;
    const line = describeSnapshot(snapshot);
    if (line !== last) {
      log(line);
      last = line;
      if (shots) {
        shotCount += 1;
        const file = `${String(shotCount).padStart(2, "0")}-${snapshot.state}.png`;
        await page.screenshot({ path: join(shots, file) });
      }
    }
    if (TERMINAL_STATES.includes(snapshot.state)) break;
    await answerGates(page, runId, snapshot, { approve, decided });
    await sleep(POLL_MS);
  }
  return snapshot;
}

async function reportRun(page, workbench, runId, snapshot, { shots, textOut }) {
  await sleep(2500);
  const text = await workbench.innerText();
  if (textOut) writeFileSync(textOut, text, { mode: 0o600 });
  const summary = { state: snapshot.state, result: snapshot.result?.status };
  log(
    "final",
    JSON.stringify({ ...summary, failure: snapshot.failure ?? snapshot.result?.failure }).slice(
      0,
      500,
    ),
  );
  const tail = text.split("\n").filter(Boolean).slice(-40).join("\n");
  console.log(`----- workbench tail -----\n${tail}`);
  console.log(`----- run ${runId} -----`);
  if (shots) await page.screenshot({ path: join(shots, "zz-final.png"), fullPage: true });
}

async function driveRun(browser, options) {
  const { repo, base, branch, shots, textOut, approve, timeoutMs, task } = options;
  const context = await browser.newContext({ viewport: VIEWPORT, baseURL: base });
  const page = await context.newPage();
  page.on("pageerror", (error) => log("pageerror", String(error).slice(0, 200)));
  await seedWorkbenchWindow(page, repo);
  const { fragment } = await mintPairing();
  await page.goto(`/${fragment}`);
  await waitForWorkbench(page);
  const workbench = await selectCheckout(page, repo, branch);
  const runId = await startRun(page, workbench, task);
  const snapshot = await watchRun(page, runId, {
    approve,
    deadline: Date.now() + timeoutMs,
    shots,
  });
  await reportRun(page, workbench, runId, snapshot, { shots, textOut });
  return exitCodeForState(snapshot.state);
}

async function main() {
  const cli = parseCli({ usage: USAGE, options: OPTIONS });
  if (cli.help) return 0;
  if (cli.values["list-tasks"]) {
    console.log(formatTaskList());
    return 0;
  }
  const { text, mode } = resolveTaskInput(cli.values);
  const options = {
    repo: labRepositoryPath(cli.values.repo),
    base: browserBaseUrl(labBaseUrl(cli.values["base-url"])),
    branch: cli.values.branch,
    shots: cli.values.shots,
    textOut: cli.values["text-out"],
    approve: parseApprove(cli.values.approve),
    timeoutMs: minutesToMs(cli.values["timeout-min"]),
    task: { text, mode, model: cli.values.model },
  };
  if (options.shots) mkdirSync(options.shots, { recursive: true });
  const browser = await chromium.launch({ headless: cli.values.headed !== true });
  try {
    return await driveRun(browser, options);
  } finally {
    await browser.close();
  }
}

if (isMainModule(import.meta.url)) runMain(main);
