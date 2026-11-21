// Preloaded with `node --import` into a measured child process: on exit it writes the process's
// peak resident set size, in bytes, to the file named by KEIKO_PEAK_RSS_FILE. Node reports
// `maxRSS` in kibibytes on every platform. Without the variable it does nothing.
//
// With KEIKO_PEAK_RSS_BUDGET_BYTES as well, the budget is enforced while the process runs, not only
// read after it exits: a worker thread samples the whole process's resident memory four times a
// second and, the moment it exceeds the budget, writes that size to the same file and kills the
// process. The worker has its own event loop, so it keeps sampling while the main thread is busy in
// a long synchronous TypeScript program build, which is exactly when the lint grows.

import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const target = process.env.KEIKO_PEAK_RSS_FILE;
const budget = Number(process.env.KEIKO_PEAK_RSS_BUDGET_BYTES);

const SAMPLE_INTERVAL_MS = 250;

// CommonJS, because an eval worker is not a module. The kill ends every thread at once, so the
// process cannot outgrow the budget by finishing the work in hand.
const WATCHDOG = String.raw`
const { writeFileSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss <= workerData.budget) return;
  writeFileSync(workerData.target, rss + "\n");
  // A worker's process.stderr is relayed through the busy main thread; write the descriptor itself.
  writeSync(2, "peak-rss: resident memory " + rss + " bytes exceeded the budget of " + workerData.budget + "; stopping\n");
  process.kill(process.pid, "SIGKILL");
}, workerData.interval);
`;

if (typeof target === "string" && target !== "") {
  process.on("exit", () => {
    writeFileSync(target, `${process.resourceUsage().maxRSS * 1024}\n`);
  });
  if (Number.isFinite(budget) && budget > 0) {
    const watchdog = new Worker(WATCHDOG, {
      eval: true,
      workerData: { budget, target, interval: SAMPLE_INTERVAL_MS },
    });
    // The watchdog never keeps a finished process alive.
    watchdog.unref();
  }
}
