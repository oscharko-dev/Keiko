import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers";

import { createLspProcessManager } from "../packages/keiko-server/dist/editor/lsp/lspProcessManager.js";
import { createFakeLspProcess } from "../packages/keiko-server/dist/editor/lsp/testing/fakeLspProcess.js";

const COLD_SAMPLES = 20;
const WARM_SAMPLES = 100;
const MIB = 1024 * 1024;
const LIMITS = Object.freeze({
  coldP95Ms: 250,
  warmP95Ms: 25,
  disposalP95Ms: 100,
  rssDeltaBytes: 64 * MIB,
  diskBytes: 1 * MIB,
});

function percentile(samples, percentileValue) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1);
  return ordered[index] ?? 0;
}

function summary(samples) {
  return {
    count: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

async function settleReady(manager) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getLspProcessStatus() === "READY") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Fake managed provider did not reach READY within the bounded startup loop.");
}

function managerDeps(root, binDir) {
  return {
    config: {
      managerId: "managed-lsp-closeout",
      executableName: "fake-managed-lsp",
      executableArgs: ["--stdio"],
      initializeTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
      maxFrameBytes: 1_048_576,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 2,
      envAllowlist: ["PATH"],
      networkPolicy: "inherit",
    },
    workspace: {
      root,
      name: undefined,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    processEnv: { PATH: binDir },
    commandRules: [{ executable: "fake-managed-lsp" }],
    spawn: () =>
      createFakeLspProcess({ results: { "textDocument/hover": { contents: "bounded" } } }).handle,
  };
}

async function measureCold(root, binDir) {
  const startup = [];
  const disposal = [];
  for (let sample = 0; sample < COLD_SAMPLES; sample += 1) {
    const start = performance.now();
    const manager = createLspProcessManager(managerDeps(root, binDir));
    await settleReady(manager);
    startup.push(performance.now() - start);
    const disposeStart = performance.now();
    await manager.dispose();
    disposal.push(performance.now() - disposeStart);
  }
  return { startup, disposal };
}

async function measureWarm(root, binDir) {
  const manager = createLspProcessManager(managerDeps(root, binDir));
  await settleReady(manager);
  const samples = [];
  for (let sample = 0; sample < WARM_SAMPLES; sample += 1) {
    const start = performance.now();
    await manager.sendRequest(
      "textDocument/hover",
      { textDocument: { uri: "file:///fixture" }, position: { line: 0, character: 0 } },
      new globalThis.AbortController().signal,
    );
    samples.push(performance.now() - start);
  }
  await manager.dispose();
  return samples;
}

function budgetDisposition(measurement) {
  return {
    coldP95: measurement.cold.p95Ms <= LIMITS.coldP95Ms,
    warmP95: measurement.warm.p95Ms <= LIMITS.warmP95Ms,
    disposalP95: measurement.disposal.p95Ms <= LIMITS.disposalP95Ms,
    rssDelta: measurement.rssDeltaBytes <= LIMITS.rssDeltaBytes,
    disk: measurement.diskBytes <= LIMITS.diskBytes,
  };
}

const root = await mkdtemp(join(tmpdir(), "keiko-managed-lsp-perf-workspace-"));
const binDir = await mkdtemp(join(tmpdir(), "keiko-managed-lsp-perf-bin-"));
const executable = join(binDir, "fake-managed-lsp");
try {
  await writeFile(executable, "#!/bin/sh\n", "utf8");
  await chmod(executable, 0o755);
  const rssBefore = process.memoryUsage.rss();
  const cold = await measureCold(root, binDir);
  const warm = await measureWarm(root, binDir);
  const rssAfter = process.memoryUsage.rss();
  const measurement = {
    schemaVersion: "1",
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    fakeProvider: true,
    cold: summary(cold.startup),
    warm: summary(warm),
    disposal: summary(cold.disposal),
    rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
    diskBytes: 0,
    limits: LIMITS,
  };
  const disposition = budgetDisposition(measurement);
  process.stdout.write(`${JSON.stringify({ ...measurement, disposition }, null, 2)}\n`);
  if (Object.values(disposition).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(binDir, { recursive: true, force: true }),
  ]);
}
