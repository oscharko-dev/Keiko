#!/usr/bin/env node
// #4370 AC2: one real browser run of at least two hours, with reloads at irregular intervals, that
// needs no re-pairing. This is live qualification, not a hermetic test: it drives the built product
// with a real Chromium, waits in real time, and proves from the product's own Activity Log that the
// browser paired exactly once and was never refused.
//
// Prerequisites: a built tree (`npm run build && npm run prepare:bin && npm run build:ui`), Playwright
// with Chromium, and the server's loopback port free. The run needs no model and little CPU.
//
//   node scripts/qualify-browser-session-run.mjs --out <directory> [--minutes 125] [--port 32610]
//        [--schedule 4,11,19,26,31,38,47,55,63,70,78,86,93,101,109,117,125] [--prepare]
//
// `--prepare` runs the three build steps first; `--smoke` (with a short `--minutes` and `--schedule`)
// only exercises the harness and is never qualification evidence. The schedule is minutes after pairing; it must contain
// 26 and 31 (the incident's shape), keep every gap under the 30-minute idle lifetime and end at or
// after `--minutes`. The report (`session-run-report.json`) and a copy of the matching log lines
// (`session-run-activity.jsonl`) are written to `--out`; the exit code is 0 only for a PASS.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINUTE_MS = 60_000;
const IDLE_LIFETIME_MIN = 30;
export const DEFAULT_SCHEDULE = [
  4, 11, 19, 26, 31, 38, 47, 55, 63, 70, 78, 86, 93, 101, 109, 117, 125,
];
const SECRET_ENV = "KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET";
const INSPECT_PATH = "/api/coding-workbench/app-session/browser";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const out = resolve(argument("out", ""));
export const DEFAULT_MINUTES = 125;
const minutes = Number(argument("minutes", String(DEFAULT_MINUTES)));
const port = Number(argument("port", "32610"));
const schedule = argument("schedule", DEFAULT_SCHEDULE.join(",")).split(",").map(Number);

function gapProblem(sorted) {
  let previous = 0;
  for (const point of sorted) {
    if (point === previous) return "duplicate schedule point";
    if (point - previous >= IDLE_LIFETIME_MIN) return "a gap reaches the idle lifetime";
    previous = point;
  }
  return undefined;
}

export function validateSchedule(points, runMinutes, smoke = false) {
  if (points.some((point) => !Number.isFinite(point) || point <= 0))
    return "invalid schedule value";
  // A smoke run only proves the harness; the qualification run must contain the incident's reloads.
  const missing = (smoke ? [] : [26, 31]).find((required) => !points.includes(required));
  if (missing !== undefined) return `schedule lacks the ${String(missing)}-minute reload`;
  const sorted = [...points].sort((a, b) => a - b);
  return (
    gapProblem(sorted) ??
    ((sorted.at(-1) ?? 0) >= runMinutes ? undefined : "the schedule ends before the run does")
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // The server is still starting; retry until the deadline.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(500);
  }
}

function activityLines(stateDir, sinceIso) {
  const directory = join(stateDir, "logs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^activity-.*\.jsonl$/u.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(directory, name), "utf8").split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((event) => event !== undefined && typeof event.ts === "string" && event.ts >= sinceIso);
}

/** The verdict from the log alone: one pairing, and not one refusal, expiry or failed repair. */
export function judge(events, reloads) {
  const count = (predicate) => events.filter(predicate).length;
  const op = (name) => (event) => event.op === name;
  const refusals = count(op("coding-app-session.proof.refused"));
  const expiries = count(op("coding-app-session.expired"));
  const denials = events
    .filter(op("coding-app-session.local-session.denied"))
    .filter((event) => event.extra?.windowClosed !== false)
    .reduce((total, event) => total + Number(event.extra?.count ?? 0), 0);
  const repairFailures = count(op("client.session-repair.failed"));
  const pairings = count(op("coding-app-session.paired"));
  const failures = [];
  if (pairings !== 1) failures.push(`expected exactly one pairing, saw ${String(pairings)}`);
  if (refusals > 0) failures.push(`${String(refusals)} refused session proof(s)`);
  if (expiries > 0) failures.push(`${String(expiries)} observed session expiry`);
  if (denials > 0) failures.push(`${String(denials)} refused local-session repair(s)`);
  if (repairFailures > 0)
    failures.push(`${String(repairFailures)} failed client session repair(s)`);
  for (const reload of reloads)
    if (reload.session !== "active" || reload.connectControlVisible)
      failures.push(`reload at minute ${String(reload.minute)} found the session lost`);
  return { pairings, refusals, expiries, denials, repairFailures, failures };
}

function startServer(secret) {
  const stateDir = join(out, "state");
  const config = join(out, "keiko.e2e.config.json");
  mkdirSync(join(stateDir, "ui"), { recursive: true });
  copyFileSync(join(repoRoot, "tests", "e2e", "fixtures", "keiko.e2e.config.json"), config);
  const args = [
    join(repoRoot, "dist", "cli", "index.js"),
    "ui",
    "--port",
    String(port),
    "--config",
    config,
    "--ui-db",
    join(stateDir, "ui", "ui.sqlite"),
  ];
  return spawn(process.execPath, args, {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      [SECRET_ENV]: secret,
      KEIKO_OS_KEYCHAIN: "off",
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
      KEIKO_LOG_LEVEL: "info",
    },
  });
}

async function pairingFragment(secret) {
  const serverModule = await import(
    pathToFileURL(join(repoRoot, "packages", "keiko-server", "dist", "index.js")).href
  );
  const contracts = await import(
    pathToFileURL(join(repoRoot, "packages", "keiko-contracts", "dist", "coding-app-session.js"))
      .href
  );
  return contracts.encodeCodingAppSessionPairingFragment(
    serverModule.mintLauncherPairingAttestation({
      secret,
      requestId: `req_run-${randomUUID()}`,
      issuedAtMs: Date.now(),
    }),
  );
}

/** One reload as a person does it, and what the page then shows. */
async function reloadEntry(page, inspect, minute, pairedAt) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(4_000);
  const connectControlVisible = await page
    .getByRole("button", { name: /connect browser/iu })
    .first()
    .isVisible()
    .catch(() => false);
  return {
    minute,
    at: new Date().toISOString(),
    elapsedMinutes: Math.round((Date.now() - pairedAt) / MINUTE_MS),
    session: await inspect().catch(() => "unreachable"),
    connectControlVisible,
  };
}

async function drive(report, baseUrl, secret) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const inspect = () =>
      page.evaluate(async (path) => {
        const response = await globalThis.fetch(path, {
          credentials: "same-origin",
          cache: "no-store",
        });
        return (await response.json()).state;
      }, INSPECT_PATH);
    const pairedAt = Date.now();
    await page.goto(`${baseUrl}/${await pairingFragment(secret)}`);
    await waitFor(async () => (await inspect()) === "active", 60_000, "the paired session");
    report.pairedAt = new Date(pairedAt).toISOString();
    for (const minute of [...schedule].sort((a, b) => a - b)) {
      const due = pairedAt + minute * MINUTE_MS;
      while (Date.now() < due) await sleep(Math.min(due - Date.now(), 30_000));
      const entry = await reloadEntry(page, inspect, minute, pairedAt);
      report.reloads.push(entry);
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
    const remaining = pairedAt + minutes * MINUTE_MS - Date.now();
    if (remaining > 0) await sleep(remaining);
    report.session = await inspect().catch(() => "unreachable");
  } finally {
    await browser.close();
  }
}

function conclude(report, smoke) {
  const events = activityLines(join(out, "state"), report.startedAt).filter(
    (event) =>
      String(event.op).startsWith("coding-app-session.") ||
      String(event.op).startsWith("client.session-repair."),
  );
  writeFileSync(
    join(out, "session-run-activity.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  report.activity = judge(events, report.reloads);
  report.smoke = smoke;
  const passed = report.activity.failures.length === 0 && report.session === "active";
  report.verdict = verdictOf(passed, smoke);
  writeFileSync(join(out, "session-run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.verdict}: ${JSON.stringify(report.activity)}\n`);
  return passed;
}

/** A smoke run proves only the harness: it can pass as SMOKE-PASS but never as qualification evidence. */
export function verdictOf(passed, smoke) {
  if (!passed) return "FAIL";
  return smoke ? "SMOKE-PASS" : "PASS";
}

async function main() {
  const smoke = process.argv.includes("--smoke");
  const problem = validateSchedule(schedule, minutes, smoke);
  if (out === "" || problem !== undefined) {
    process.stderr.write(`usage error: ${problem ?? "--out is required"}\n`);
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  if (process.argv.includes("--prepare")) {
    run("npm", ["run", "build"]);
    run("npm", ["run", "prepare:bin"]);
    run("npm", ["run", "build:ui"]);
  }
  const secret = randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const server = startServer(secret);
  const report = { startedAt: new Date().toISOString(), baseUrl, schedule, reloads: [] };
  try {
    await waitFor(
      async () => (await globalThis.fetch(`${baseUrl}/api/health`)).status === 200,
      180_000,
      "the server",
    );
    await drive(report, baseUrl, secret);
  } finally {
    server.kill("SIGTERM");
    await sleep(3_000);
  }
  report.finishedAt = new Date().toISOString();
  process.exit(conclude(report, smoke) ? 0 : 1);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
