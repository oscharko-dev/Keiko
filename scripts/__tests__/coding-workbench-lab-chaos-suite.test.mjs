// Tests for the scenario suite of the Coding Workbench live lab
// (scripts/testing/coding-workbench-lab/chaos-suite.mjs): the command line it builds for every
// scenario (the approval policy and the lab repository are passed through, never defaulted), the
// run id and final line it reads from a driver log, and what a campaign reports when a scenario was
// refused before a run could start. The suite is started as a child process against a stub proxy on
// loopback, with no launcher secret, so its driver refuses before it touches any dev server.

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  NO_RUN_ID,
  SCENARIOS,
  campaignVerdict,
  summarizeRunLog,
  wbRunArguments,
} from "../testing/coding-workbench-lab/chaos-suite.mjs";

const LAB = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "coding-workbench-lab");
const SUITE = join(LAB, "chaos-suite.mjs");
const LAB_ENVIRONMENT = new Set([
  "KEIKO_LAB_REPO",
  "KEIKO_LAB_BASE_URL",
  "KEIKO_LAB_LOG_DIR",
  "KEIKO_STATE_DIR",
  "KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET",
]);
const TEMP_DIRECTORIES = [];
const SERVERS = [];

afterEach(() => {
  while (SERVERS.length > 0) {
    const server = SERVERS.pop();
    server.close();
    server.closeAllConnections();
  }
  while (TEMP_DIRECTORIES.length > 0) {
    rmSync(TEMP_DIRECTORIES.pop(), { recursive: true, force: true });
  }
});

function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

function labCopy() {
  const directory = tempDirectory("keiko-lab-suite-repo-");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "ledger-lab" }));
  return directory;
}

/** A stand-in for chaos-proxy.mjs: answers every call and records the fault bodies it was given. */
async function stubProxy() {
  const faults = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") faults.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  SERVERS.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { faults, url: `http://127.0.0.1:${String(server.address().port)}` };
}

/** Runs the suite with none of the lab environment set, so no secret or repository leaks in. */
function runSuite(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !LAB_ENVIRONMENT.has(name)),
  );
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SUITE, ...args],
      { env, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({ status: error === null ? 0 : error.code, stdout, stderr });
      },
    );
  });
}

describe("the command line of one scenario run", () => {
  const settings = { model: "gemma-4-31b-it", timeoutMin: "35", repo: "/lab/ledger" };

  it("forwards the approval policy it was given, whatever it is, and never a policy of its own", () => {
    for (const approve of ["all", "none", "ask"]) {
      const args = wbRunArguments({ ...settings, approve });
      expect(args[args.indexOf("--approve") + 1]).toBe(approve);
    }
  });

  it("names the lab repository, the model, the timeout and the read-only task C1", () => {
    const args = wbRunArguments({ ...settings, approve: "none" });
    expect(args.slice(1)).toEqual([
      "--task-id",
      "C1",
      "--model",
      "gemma-4-31b-it",
      "--approve",
      "none",
      "--repo",
      "/lab/ledger",
      "--timeout-min",
      "35",
    ]);
    expect(args[0]).toBe(join(LAB, "wb-run.mjs"));
  });
});

describe("what the suite reads from a driver log", () => {
  const DRIVER_LOG = [
    "10:00:01 driver wb-run: approvals none (the driver denies every permission ask)",
    "10:00:02 local checkout 200",
    "10:00:03 started run-2026100710000012345 mode Ask for approval model gemma-4-31b-it state running",
    "10:09:40 final {}",
    "----- run run-2026100710000012345 -----",
  ].join("\n");

  it("takes the run id and the final line from the driver's own lines", () => {
    expect(summarizeRunLog(DRIVER_LOG)).toEqual({
      runId: "run-2026100710000012345",
      final: "{}",
    });
  });

  it("takes the run id from the started line when the driver died before it printed its last line", () => {
    const died = DRIVER_LOG.split("\n").slice(0, 3).join("\n");
    expect(summarizeRunLog(died).runId).toBe("run-2026100710000012345");
  });

  it("names the closed placeholders for a driver that was refused before it started a run", () => {
    const refused = "lab: the dev server did not select the lab repository (HTTP 400)";
    expect(summarizeRunLog(refused)).toEqual({ runId: "no-run-id", final: "no final line" });
  });

  it("does not take text that merely looks like a run id for the run of a refused driver", () => {
    const refused = [
      "Command failed: node wb-run.mjs --repo /home/engineer/run-2026-lab --timeout-min 35",
      "lab: the dev server did not select the lab repository (HTTP 400)",
    ].join("\n");
    expect(summarizeRunLog(refused).runId).toBe("no-run-id");
  });
});

describe("campaignVerdict", () => {
  const started = (id) => ({ runId: `run-2026100710000012${id}`, line: `S${id} 60s run-${id}` });
  const refused = { runId: NO_RUN_ID, line: "S9 1s no-run-id final no final line" };

  it("reports DONE and exits 0 only when every scenario started a run", () => {
    expect(campaignVerdict([started("1"), started("2")])).toEqual({ marker: "DONE", exitCode: 0 });
  });

  it("is incomplete, and exits 1, when any scenario started no run, however many others did", () => {
    const verdict = campaignVerdict([started("1"), refused, started("3")]);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.marker).toBe("INCOMPLETE 1 of 3 scenarios started no run (see their logs)");
    expect(campaignVerdict([refused, refused]).marker).toMatch(/^INCOMPLETE 2 of 2 scenarios/u);
  });
});

describe("a campaign in which no scenario could start a run", () => {
  it("exits non-zero, says so, and does not report DONE (the review repro)", async () => {
    const proxy = await stubProxy();
    const outDir = tempDirectory("keiko-lab-suite-out-");
    const result = await runSuite([
      "--approve",
      "none",
      "--repo",
      labCopy(),
      "--proxy",
      proxy.url,
      "--scenarios",
      "S1,S2",
      "--out-dir",
      outDir,
    ]);
    expect(result.status).toBe(1);
    const summary = readFileSync(join(outDir, "summary.log"), "utf8");
    expect(summary).not.toMatch(/^DONE$/mu);
    expect(summary.split("\n").filter((line) => line.includes(" no-run-id "))).toHaveLength(2);
    expect(result.stderr).toMatch(/2 of 2 scenarios started no run/u);
  });

  it("sets the fault of each scenario and puts the proxy back to pass after it, refused or not", async () => {
    const proxy = await stubProxy();
    await runSuite([
      "--approve",
      "none",
      "--repo",
      labCopy(),
      "--proxy",
      proxy.url,
      "--scenarios",
      "S1,S5",
      "--out-dir",
      tempDirectory("keiko-lab-suite-out-"),
    ]);
    const byId = (id) => SCENARIOS.find((scenario) => scenario.id === id).fault;
    expect(proxy.faults).toEqual([byId("S1"), { mode: "pass" }, byId("S5"), { mode: "pass" }]);
  });
});
