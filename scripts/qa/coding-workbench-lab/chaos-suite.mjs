#!/usr/bin/env node
// Runs the gateway resilience scenarios S1 to S7 one after another. Each scenario sets one fault
// on the chaos proxy, runs the short read-only task C1 through wb-run.mjs, resets the proxy and
// records one body-free summary line (scenario, seconds, run id, final state). The runs take
// minutes each: S3 holds a three-minute outage, S6 a seven-minute stall, S7 a ten-minute timeout.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "../../lib/is-main-module.mjs";
import {
  UsageError,
  errorMessage,
  labBaseUrl,
  minutesToMs,
  parseCli,
  runMain,
} from "./lab-common.mjs";

const USAGE = [
  "usage: node chaos-suite.mjs [--proxy http://127.0.0.1:11500] [--scenarios S1,S2,...]",
  "                            [--model gemma-4-31b-it] [--timeout-min 35] [--out-dir <dir>]",
  "",
  "Scenarios (default: all): S1 two 503s, S2 six 503s, S3 three-minute outage, S4 120 s latency,",
  "S5 dropped stream, S6 stalled stream, S7 hung call. Start chaos-proxy.mjs and route the LiteLLM",
  "model route through it first (see README.md).",
  "Per-scenario run logs and summary.log go to --out-dir (default: a new temporary directory).",
  "Environment: KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET (required), KEIKO_LAB_BASE_URL.",
].join("\n");

const SCENARIOS = [
  { id: "S1", name: "two-503", fault: { mode: "status", status: 503, count: 2 } },
  { id: "S2", name: "six-503", fault: { mode: "status", status: 503, count: 6 } },
  { id: "S3", name: "outage-3min", fault: { mode: "status", status: 503, durationMs: 180_000 } },
  { id: "S4", name: "latency-120s", fault: { mode: "latency", delayMs: 120_000, count: 1 } },
  { id: "S5", name: "drop-200b", fault: { mode: "drop", afterBytes: 200, count: 1 } },
  {
    id: "S6",
    name: "stall-7min",
    fault: { mode: "stall", afterBytes: 200, stallMs: 420_000, count: 1 },
  },
  { id: "S7", name: "hang", fault: { mode: "hang", count: 1 } },
];
const WB_RUN = join(dirname(fileURLToPath(import.meta.url)), "wb-run.mjs");
const RUN_OUTPUT_BYTES = 16 * 1024 * 1024;
const GRACE_MS = 120_000;
const execFileAsync = promisify(execFile);

async function setFault(proxy, fault) {
  const response = await globalThis.fetch(`${proxy}/__chaos`, {
    method: "POST",
    body: JSON.stringify(fault),
  });
  if (!response.ok)
    throw new Error(`the chaos proxy refused the fault (HTTP ${String(response.status)})`);
}

async function assertProxyReachable(proxy) {
  try {
    await globalThis.fetch(`${proxy}/__chaos`);
  } catch (error) {
    throw new Error(
      `the chaos proxy is not reachable at ${proxy} (${errorMessage(error)}); start chaos-proxy.mjs`,
      {
        cause: error,
      },
    );
  }
}

function selectScenarios(list) {
  const ids =
    list === undefined ? SCENARIOS.map((s) => s.id) : list.split(",").map((id) => id.trim());
  return ids.map((id) => {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id);
    if (scenario === undefined) {
      throw new UsageError(
        `unknown scenario "${id}"; use ${SCENARIOS.map((s) => s.id).join(", ")}`,
      );
    }
    return scenario;
  });
}

/** Runs wb-run.mjs for the read-only chaos task; a failed run still yields its log. */
async function runTask({ model, timeoutMin, timeoutMs }) {
  const args = [WB_RUN, "--task-id", "C1", "--model", model, "--approve", "all"];
  args.push("--timeout-min", timeoutMin);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      maxBuffer: RUN_OUTPUT_BYTES,
      timeout: timeoutMs + GRACE_MS,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}${errorMessage(error)}\n`;
  }
}

async function runScenario(scenario, { proxy, model, timeoutMin, timeoutMs, outDir }) {
  await setFault(proxy, scenario.fault);
  const startedAt = Date.now();
  let log;
  try {
    log = await runTask({ model, timeoutMin, timeoutMs });
  } finally {
    await setFault(proxy, { mode: "pass" });
  }
  const label = `${scenario.id}-${scenario.name}`;
  writeFileSync(join(outDir, `${label}.log`), log);
  const runId = /run-\d+/u.exec(log)?.[0] ?? "no-run-id";
  const final = /^\S+ final (.*)$/mu.exec(log)?.[1] ?? "no final line";
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return `${label} ${String(seconds)}s ${runId} final ${final}`;
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: {
      proxy: { type: "string", default: "http://127.0.0.1:11500" },
      scenarios: { type: "string" },
      model: { type: "string", default: "gemma-4-31b-it" },
      "timeout-min": { type: "string", default: "35" },
      "out-dir": { type: "string" },
    },
  });
  if (cli.help) return;
  const proxy = labBaseUrl(cli.values.proxy);
  const scenarios = selectScenarios(cli.values.scenarios);
  const timeoutMin = cli.values["timeout-min"];
  const timeoutMs = minutesToMs(timeoutMin);
  const outDir = cli.values["out-dir"]
    ? resolve(cli.values["out-dir"])
    : mkdtempSync(join(tmpdir(), "keiko-chaos-suite-"));
  mkdirSync(outDir, { recursive: true });
  await assertProxyReachable(proxy);
  console.log(`logs: ${outDir}`);
  const lines = [];
  for (const scenario of scenarios) {
    const settings = { proxy, model: cli.values.model, timeoutMin, timeoutMs, outDir };
    const line = await runScenario(scenario, settings);
    console.log(line);
    lines.push(line);
  }
  writeFileSync(join(outDir, "summary.log"), `${lines.join("\n")}\nDONE\n`);
}

if (isMainModule(import.meta.url)) runMain(main);
