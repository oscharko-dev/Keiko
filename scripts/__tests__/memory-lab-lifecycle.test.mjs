// The real runner with a real Keiko instance (#4207): whatever ends a run, a killed instance, an
// interrupt during start-up or during a turn, no Keiko process, port or state directory stays behind.
// The tests look at the process tree from outside and take the instance's port from the operating
// system, because a runner that forgets its child cannot be asked about it.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../testing/memory-lab/run.mjs");
const CURATED = resolve(HERE, "../testing/memory-lab/scenarios");
const POLL_MS = 50;
const WAIT_MS = 60_000;

function processTable() {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
    });
}

function descendantsOf(pid) {
  const table = processTable();
  const found = [];
  const visit = (parent) => {
    for (const row of table.filter((entry) => entry.ppid === parent)) {
      found.push(row);
      visit(row.pid);
    }
  };
  visit(pid);
  return found;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listeningPorts(pid) {
  try {
    const output = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn", "-P"],
      {
        encoding: "utf8",
      },
    );
    return [...output.matchAll(/^n.*:(\d+)$/gmu)].map((match) => Number(match[1]));
  } catch {
    return [];
  }
}

function portAnswers(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

async function until(condition, what) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
}

function startRunner(root, ids, execArgv = []) {
  const scenarios = join(root, "scenarios");
  mkdirSync(scenarios);
  for (const id of ids)
    writeFileSync(join(scenarios, `${id}.json`), readFileSync(join(CURATED, `${id}.json`)));
  const out = join(root, "out");
  const child = spawn(
    process.execPath,
    [
      ...execArgv,
      RUNNER,
      "--mode",
      "offline",
      "--out",
      out,
      "--scenarios",
      scenarios,
      "--arms",
      "product",
      "--repetitions",
      "1",
      "--quiet-ms",
      "200",
      "--max-wait-ms",
      "20000",
      "--generated-at",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const state = { out, child, output: "", exit: undefined };
  child.stdout.on("data", (chunk) => (state.output += String(chunk)));
  child.stderr.on("data", (chunk) => (state.output += String(chunk)));
  state.exited = new Promise((settle) => {
    child.once("exit", (code, signal) => {
      state.exit = { code, signal };
      settle(state.exit);
    });
  });
  return state;
}

function instanceOf(runner) {
  return descendantsOf(runner.child.pid).find((row) => row.command.includes("node"));
}

// The instance has started when a process below the runner listens on a port.
function listeningInstance(runner) {
  for (const row of descendantsOf(runner.child.pid)) {
    const ports = listeningPorts(row.pid);
    if (ports.length > 0) return { pid: row.pid, ports };
  }
  return undefined;
}

async function expectNothingLeft(runner, tree, ports) {
  await runner.exited;
  await until(
    () => tree.every((row) => !isAlive(row.pid)),
    `the instance tree to end: ${runner.output}`,
  );
  for (const port of ports) expect(await portAnswers(port), `port ${String(port)}`).toBe(false);
  const left = existsSync(join(runner.out, "state")) ? readdirSync(join(runner.out, "state")) : [];
  expect(left, `state directories; the runner said: ${runner.output}`).toEqual([]);
  expect(existsSync(join(runner.out, "state")), "state root").toBe(false);
}

describe.skipIf(process.platform === "win32")("what a run leaves behind", () => {
  let root;
  let runner;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-lifecycle-"));
  });
  afterEach(() => {
    if (runner?.exit === undefined) runner?.child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  it("records a killed instance as a failed unit, goes on to the next unit, and leaves nothing", async () => {
    runner = startRunner(root, ["forget-explicit-de", "multi-turn-de"]);
    const instance = await until(() => listeningInstance(runner), "the first instance to listen");
    const tree = descendantsOf(runner.child.pid);
    expect(await portAnswers(instance.ports[0]), "positive control").toBe(true);
    process.kill(instance.pid, "SIGKILL");
    const { code } = await runner.exited;
    await expectNothingLeft(runner, tree, instance.ports);
    expect(code, runner.output).toBe(5);
    const summary = JSON.parse(readFileSync(join(runner.out, "summary.json"), "utf8"));
    expect(summary.failedUnits).toBe(1);
    expect(summary.runs).toBe(2);
  }, 180_000);

  it.each(["SIGINT", "SIGTERM"])(
    "ends on %s during the start of an instance and leaves nothing",
    async (signal) => {
      runner = startRunner(root, ["multi-turn-de"]);
      const starting = await until(() => instanceOf(runner), "the instance process to appear");
      const tree = descendantsOf(runner.child.pid);
      runner.child.kill(signal);
      await expectNothingLeft(runner, [starting, ...tree], []);
    },
    180_000,
  );

  it.each(["SIGINT", "SIGTERM"])(
    "ends on %s while an instance serves and leaves nothing",
    async (signal) => {
      runner = startRunner(root, ["multi-turn-de"]);
      const instance = await until(() => listeningInstance(runner), "the instance to listen");
      const tree = descendantsOf(runner.child.pid);
      runner.child.kill(signal);
      await expectNothingLeft(runner, tree, instance.ports);
    },
    180_000,
  );

  // What really happened under load: a socket of the runner's own fetch raised an uncaught error
  // while the instance went down, the runner died on it, and the state stayed behind.
  it("cleans up when the runner meets an uncaught error", async () => {
    const hook = join(root, "uncaught-on-signal.mjs");
    writeFileSync(
      hook,
      'process.on("SIGUSR2", () => { setImmediate(() => { throw new Error("injected"); }); });\n',
    );
    runner = startRunner(root, ["multi-turn-de"], ["--import", hook]);
    const instance = await until(() => listeningInstance(runner), "the instance to listen");
    const tree = descendantsOf(runner.child.pid);
    runner.child.kill("SIGUSR2");
    await expectNothingLeft(runner, tree, instance.ports);
    expect(runner.exit.code).toBe(1);
    expect(runner.output).toContain("injected");
  }, 180_000);

  // After an interrupt the unit in progress fails, and a loop that counted that as an ordinary
  // failed unit would start the next instance after the cleanup, with nobody left to end it.
  it("starts no further unit after an interrupt", async () => {
    runner = startRunner(root, ["multi-turn-de", "preference-tables-de", "update-lists-de"]);
    const instance = await until(() => listeningInstance(runner), "the instance to listen");
    const tree = descendantsOf(runner.child.pid);
    runner.child.kill("SIGINT");
    await expectNothingLeft(runner, tree, instance.ports);
    expect(runner.exit.code).toBe(130);
    expect(runner.output).not.toContain("run preference-tables-de");
    // An instance started behind the cleanup's back would have written its state by now.
    await new Promise((settle) => setTimeout(settle, 3000));
    expect(existsSync(join(runner.out, "state")), "state root").toBe(false);
  }, 180_000);
});
