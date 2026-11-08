// Runs the version-bump regression set (bump-set-oracles.mjs) through the real Workbench UI and
// judges every task on the host. Each task gets a fresh scratch copy of its fixture at its
// baseline, so no task passes or fails on another task's leftovers. The verdict table and
// `verdicts.json` in --work-dir are the result; the exit code is 0 only when every selected task
// ran and every oracle, including the Coding History check, passed.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  flatten,
  readActivityEvents,
  resolveLogDirectory,
  selectRunEvents,
} from "./activity-log-events.mjs";
import { BUMP_SET, historyCheck, judge } from "./bump-set-oracles.mjs";
import {
  labBaseUrl,
  log,
  openApiSession,
  parseCli,
  REPO_ROOT,
  runMain,
  UsageError,
} from "./lab-common.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";

const USAGE = [
  "usage: node bump-set.mjs --work-dir <empty dir outside the checkout> [--only T1,T4]",
  "                         [--model <id>] [--timeout-min 30] [--base-url <origin>] [--log-dir <dir>]",
];
const OPTIONS = {
  "work-dir": { type: "string" },
  only: { type: "string" },
  model: { type: "string" },
  "timeout-min": { type: "string", default: "30" },
  "base-url": { type: "string" },
  "log-dir": { type: "string" },
};
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "coding-workbench-lab");
const FIXTURE_DIRS = { ledger: "ledger-lab", polyglot: "polyglot-mono" };
const PATCHES = {
  initial: "initial-state.patch",
  "head+t7": "head-t7.patch",
  "head+opencode": "head-opencode.patch",
};
const GIT_ID = [
  "-c",
  "user.name=Keiko Lab",
  "-c",
  "user.email=lab@keiko.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function mustRun(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, stdio: "ignore" });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed in ${cwd}`);
}

/** One installed copy per fixture; task copies are cut from it, node_modules included. */
function template(workDir, fixture, cache) {
  if (cache.has(fixture)) return cache.get(fixture);
  const dir = join(workDir, "templates", fixture);
  cpSync(join(FIXTURES, FIXTURE_DIRS[fixture]), dir, { recursive: true });
  mustRun(dir, "npm", ["install", "--no-audit", "--no-fund", "--silent"]);
  cache.set(fixture, dir);
  return dir;
}

/** A fresh Git copy at the entry's baseline, plus a bare origin when the task pushes. */
function prepareTask(workDir, entry, cache) {
  const root = join(workDir, entry.id);
  const repo = join(root, "repo");
  cpSync(template(workDir, entry.fixture, cache), repo, { recursive: true });
  mustRun(repo, "git", ["init", "-q", "-b", "main"]);
  const patch = PATCHES[entry.baseline];
  if (patch !== undefined) mustRun(repo, "git", ["apply", join(FIXTURES, "patches", patch)]);
  mustRun(repo, "git", ["add", "-A"]);
  mustRun(repo, "git", [...GIT_ID, "commit", "-q", "-m", "Baseline"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]).trim();
  let origin;
  if (entry.origin === true) {
    origin = join(root, "origin.git");
    mustRun(root, "git", ["init", "-q", "--bare", "-b", "main", origin]);
    mustRun(repo, "git", ["remote", "add", "origin", origin]);
    mustRun(repo, "git", ["push", "-q", "origin", "main"]);
  }
  return { root, repo: realpathSync(repo), origin, baseline };
}

function driverArgs(entry, task, options) {
  const args = [join(REPO_ROOT, "scripts", "testing", "coding-workbench-lab", "wb-ui.mjs")];
  args.push("--task-id", entry.id, "--approve", entry.approve, "--repo", task.repo);
  args.push("--text-out", join(task.root, "answer.txt"), "--timeout-min", options.timeoutMin);
  if (options.baseUrl !== undefined) args.push("--base-url", options.baseUrl);
  if (options.model !== undefined) args.push("--model", options.model);
  if (entry.awaitWakeMinutes !== undefined)
    args.push("--await-wake", String(entry.awaitWakeMinutes));
  return args;
}

/** Drives the run through the real UI; the driver's last run line names the run. */
function driveTask(entry, task, options) {
  const started = new Date().toISOString();
  const result = spawnSync(process.execPath, driverArgs(entry, task, options), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(task.root, "driver.log"), `${result.stdout}\n${result.stderr}`, {
    mode: 0o600,
  });
  const runs = [...(result.stdout ?? "").matchAll(/^----- run (run-\d+) -----$/gm)];
  return { started, exitCode: result.status, runId: runs[0]?.[1] };
}

function filesContaining(repo, value) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === "target") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.size < 2_000_000 && readFileSync(path, "utf8").includes(value))
        found.push(relative(repo, path));
    }
  };
  walk(repo);
  return found;
}

async function readHistory(session, repo) {
  const list = await session.request("GET", "/api/coding-workbench/history");
  const task = (list.json.tasks ?? []).find((item) => item.projectPath === repo);
  if (task === undefined) return { listed: false, messageCount: 0, status: list.status };
  const detail = await session.request(
    "GET",
    `/api/coding-workbench/history/${encodeURIComponent(task.id)}`,
  );
  return { listed: true, messageCount: detail.json.messages?.length ?? 0, status: detail.status };
}

function oracleContext(task, run, events) {
  const readAnswer = () => {
    try {
      return readFileSync(join(task.root, "answer.txt"), "utf8");
    } catch {
      return "";
    }
  };
  return {
    baseline: task.baseline,
    git: (args) => git(task.repo, args),
    originGit: (args) => (task.origin === undefined ? "" : git(task.origin, args)),
    exec: (command, args) =>
      spawnSync(command, args, { cwd: task.repo, stdio: "ignore", timeout: 900_000 }).status,
    filesContaining: (value) => filesContaining(task.repo, value),
    answer: readAnswer(),
    events:
      run.runId === undefined
        ? []
        : selectRunEvents(events, run.runId).map((event) => flatten(event)),
    wakeEvents: events
      .map((event) => flatten(event))
      .filter((event) => (event.ts ?? "") >= run.started),
  };
}

async function runEntry(entry, options, session, cache) {
  log("bump-set", `${entry.id}: preparing`);
  const task = prepareTask(options.workDir, entry, cache);
  log("bump-set", `${entry.id}: running (approve ${entry.approve})`);
  const run = driveTask(entry, task, options);
  const events = await readActivityEvents(options.logDir);
  const checks =
    run.runId === undefined
      ? [{ name: "run", ok: false, reason: "no run started" }]
      : judge(entry, oracleContext(task, run, events));
  const history = await readHistory(session, task.repo);
  checks.push({ name: "history", ...historyCheck(history) });
  return {
    id: entry.id,
    runId: run.runId,
    driverExit: run.exitCode,
    history,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function selectEntries(only) {
  if (only === undefined) return BUMP_SET;
  const ids = new Set(only.split(",").map((id) => id.trim()));
  const entries = BUMP_SET.filter((entry) => ids.has(entry.id));
  if (entries.length !== ids.size)
    throw new UsageError(`--only names a task outside the set: ${only}`);
  return entries;
}

async function preflight(session) {
  const readiness = await session.request(
    "GET",
    "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery",
  );
  if (readiness.json.runtimeAvailable !== true) {
    throw new Error(
      `the coding runtime is not available (HTTP ${String(readiness.status)}); nothing ran`,
    );
  }
}

function printTable(results) {
  for (const result of results) {
    const failed = result.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.reason}`);
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.id.padEnd(4)} ${result.runId ?? "-"} driver=${String(result.driverExit)} ${failed.join("; ")}`,
    );
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`bump-set: ${String(passed)} of ${String(results.length)} passed`);
}

async function main() {
  const cli = parseCli({ usage: USAGE, options: OPTIONS });
  if (cli.help) return 0;
  if (cli.values["work-dir"] === undefined) throw new UsageError("pass --work-dir <empty dir>");
  const workDir = resolve(cli.values["work-dir"]);
  if (workDir.startsWith(REPO_ROOT))
    throw new UsageError("--work-dir must be outside the checkout");
  mkdirSync(workDir, { recursive: true });
  const options = {
    workDir,
    timeoutMin: cli.values["timeout-min"],
    model: cli.values.model,
    baseUrl: cli.values["base-url"],
    logDir: resolveLogDirectory(cli.values["log-dir"]),
  };
  const entries = selectEntries(cli.values.only);
  const session = await openApiSession(labBaseUrl(options.baseUrl));
  await preflight(session);
  const cache = new Map();
  // One task at a time: the dev server holds one checkout, and the lab runs one model.
  const results = await entries.reduce(
    async (previous, entry) => [
      ...(await previous),
      await runEntry(entry, options, session, cache),
    ],
    Promise.resolve([]),
  );
  writeFileSync(join(workDir, "verdicts.json"), `${JSON.stringify(results, null, 2)}\n`, {
    mode: 0o600,
  });
  printTable(results);
  return results.every((result) => result.ok) ? 0 : 1;
}

if (isMainModule(import.meta.url)) runMain(main);
