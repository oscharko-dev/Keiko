import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers";
import { pathToFileURL } from "node:url";

const DEFAULT_COLD_SAMPLES = 20;
const DEFAULT_WARM_SAMPLES = 100;
const MIB = 1024 * 1024;

export const MANAGED_LSP_CLOSEOUT_LIMITS = Object.freeze({
  coldP95Ms: 250,
  warmP95Ms: 25,
  disposalP95Ms: 100,
  rssDeltaBytes: 64 * MIB,
  diskBytes: 1 * MIB,
});

const PROVIDER_PROFILES = Object.freeze([
  { id: "python-lsp", label: "Pyright", language: "python", executableName: "pyright-langserver" },
  { id: "go-lsp", label: "gopls", language: "go", executableName: "gopls" },
  {
    id: "shell-lsp",
    label: "Bash Language Server",
    language: "shell",
    executableName: "bash-language-server",
  },
  { id: "java-lsp", label: "Eclipse JDT LS", language: "java", executableName: "jdtls" },
  { id: "rust-lsp", label: "rust-analyzer", language: "rust", executableName: "rust-analyzer" },
]);

export function percentile(samples, percentileValue) {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1);
  return ordered[index] ?? 0;
}

export function summarizeSamples(samples) {
  return {
    count: samples.length,
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(0, ...samples).toFixed(3)),
  };
}

export async function directoryBytes(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await lstat(path)).size;
  }
  return bytes;
}

export function budgetDisposition(measurement) {
  return {
    coldP95: measurement.cold.p95Ms <= MANAGED_LSP_CLOSEOUT_LIMITS.coldP95Ms,
    warmP95: measurement.warm.p95Ms <= MANAGED_LSP_CLOSEOUT_LIMITS.warmP95Ms,
    disposalP95: measurement.disposal.p95Ms <= MANAGED_LSP_CLOSEOUT_LIMITS.disposalP95Ms,
    rssDelta: measurement.rssDeltaBytes <= MANAGED_LSP_CLOSEOUT_LIMITS.rssDeltaBytes,
    disk: measurement.diskBytes <= MANAGED_LSP_CLOSEOUT_LIMITS.diskBytes,
  };
}

export function shouldFailBudget(disposition, controlled) {
  if (!disposition.disk) return true;
  return controlled && Object.values(disposition).some((passed) => !passed);
}

async function settleReady(manager) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getLspProcessStatus() === "READY") return;
    await new Promise((resolveReady) => setImmediate(resolveReady));
  }
  throw new Error("Fake managed provider did not reach READY within the bounded startup loop.");
}

function managerDeps(profile, workspaceRoot, binDir, createFakeLspProcess) {
  return {
    config: {
      managerId: profile.id,
      executableName: profile.executableName,
      executableArgs: [],
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
      root: workspaceRoot,
      name: `M6 ${profile.label} closeout`,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [profile.language],
      ignoreLines: [],
    },
    processEnv: { PATH: binDir },
    commandRules: [{ executable: profile.executableName }],
    spawn: () =>
      createFakeLspProcess({
        results: { "textDocument/hover": { contents: `${profile.id}-bounded` } },
      }).handle,
  };
}

async function measureCold(createManager, deps, count) {
  const startup = [];
  const disposal = [];
  for (let sample = 0; sample < count; sample += 1) {
    const start = performance.now();
    const manager = createManager(deps);
    await settleReady(manager);
    startup.push(performance.now() - start);
    const disposeStart = performance.now();
    await manager.dispose();
    disposal.push(performance.now() - disposeStart);
  }
  return { startup, disposal };
}

async function measureWarm(createManager, deps, count) {
  const manager = createManager(deps);
  await settleReady(manager);
  const samples = [];
  for (let sample = 0; sample < count; sample += 1) {
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

async function measureProfile(profile, context) {
  const workspaceRoot = join(context.root, profile.language);
  await mkdir(workspaceRoot, { recursive: true });
  const diskBefore = await directoryBytes(workspaceRoot);
  globalThis.gc?.();
  const rssBefore = process.memoryUsage.rss();
  const deps = managerDeps(profile, workspaceRoot, context.binDir, context.createFakeLspProcess);
  const cold = await measureCold(context.createManager, deps, context.coldSamples);
  const warm = await measureWarm(context.createManager, deps, context.warmSamples);
  globalThis.gc?.();
  const rssAfter = process.memoryUsage.rss();
  const diskAfter = await directoryBytes(workspaceRoot);
  const measurement = {
    providerId: profile.id,
    providerLabel: profile.label,
    language: profile.language,
    workspaceId: `closeout-${profile.language}`,
    fakeProvider: true,
    cold: summarizeSamples(cold.startup),
    warm: summarizeSamples(warm),
    disposal: summarizeSamples(cold.disposal),
    rssDeltaBytes: Math.max(0, rssAfter - rssBefore),
    diskBytes: Math.max(0, diskAfter - diskBefore),
  };
  return { ...measurement, disposition: budgetDisposition(measurement) };
}

async function prepareExecutables(binDir) {
  for (const profile of PROVIDER_PROFILES) {
    const executable = join(binDir, profile.executableName);
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
  }
}

function aggregateMeasurement(profiles) {
  return {
    providerCount: profiles.length,
    maximumColdP50Ms: Math.max(0, ...profiles.map((profile) => profile.cold.p50Ms)),
    maximumColdP95Ms: Math.max(0, ...profiles.map((profile) => profile.cold.p95Ms)),
    maximumWarmP50Ms: Math.max(0, ...profiles.map((profile) => profile.warm.p50Ms)),
    maximumWarmP95Ms: Math.max(0, ...profiles.map((profile) => profile.warm.p95Ms)),
    maximumDisposalP50Ms: Math.max(0, ...profiles.map((profile) => profile.disposal.p50Ms)),
    maximumDisposalP95Ms: Math.max(0, ...profiles.map((profile) => profile.disposal.p95Ms)),
    maximumRssDeltaBytes: Math.max(0, ...profiles.map((profile) => profile.rssDeltaBytes)),
    totalDiskBytes: profiles.reduce((total, profile) => total + profile.diskBytes, 0),
  };
}

export async function runManagedLspCloseoutMeasurement(options = {}) {
  const controlled = options.controlled ?? process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1";
  const coldSamples = options.coldSamples ?? DEFAULT_COLD_SAMPLES;
  const warmSamples = options.warmSamples ?? DEFAULT_WARM_SAMPLES;
  const root = await mkdtemp(join(tmpdir(), "keiko-managed-lsp-perf-workspaces-"));
  const binDir = await mkdtemp(join(tmpdir(), "keiko-managed-lsp-perf-bin-"));
  try {
    const [{ createLspProcessManager }, { createFakeLspProcess }] = await Promise.all([
      import("../packages/keiko-server/dist/editor/lsp/lspProcessManager.js"),
      import("../packages/keiko-server/dist/editor/lsp/testing/fakeLspProcess.js"),
    ]);
    await prepareExecutables(binDir);
    const profiles = [];
    for (const profile of PROVIDER_PROFILES) {
      profiles.push(
        await measureProfile(profile, {
          root,
          binDir,
          coldSamples,
          warmSamples,
          createManager: createLspProcessManager,
          createFakeLspProcess,
        }),
      );
    }
    return {
      schemaVersion: "2",
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      measurementMode: controlled ? "controlled-enforced" : "informational-local",
      samplesPerProvider: { cold: coldSamples, warm: warmSamples, disposal: coldSamples },
      limits: MANAGED_LSP_CLOSEOUT_LIMITS,
      profiles,
      aggregate: aggregateMeasurement(profiles),
      passed: !profiles.some((profile) => shouldFailBudget(profile.disposition, controlled)),
    };
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(binDir, { recursive: true, force: true }),
    ]);
  }
}

async function main() {
  const result = await runManagedLspCloseoutMeasurement();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) await main();
