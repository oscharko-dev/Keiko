import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DEFAULT_SAMPLES = 50;
const HISTORY_CHAIN_LENGTH = 64;
const HISTORY_ROOT_COUNT = 8;
const MAX_WORKSPACE_ROOTS = 32;
const MIB = 1024 * 1024;

export const EDITOR_M11_CLOSEOUT_LIMITS = Object.freeze({
  rootProjectionP95Ms: 15,
  searchFanoutP95Ms: 30,
  editorSessionRoundTripP95Ms: 15,
  historyPruneP95Ms: 100,
  rssPerAdditionalRootBytes: 2 * MIB,
  historyDiskBytes: MIB,
  retainedHistoryVersions: 50,
});

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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceManifest() {
  const roots = Array.from({ length: MAX_WORKSPACE_ROOTS }, (_, index) => ({
    rootRef: `root-m11-${String(index).padStart(2, "0")}`,
    canonicalRoot: `/m11-closeout/root-${String(index).padStart(2, "0")}`,
    displayName: `Root ${String(index + 1)}`,
    identityDigest: digest(`identity-${String(index)}`),
    sourceDigest: { outcome: "unknown" },
  }));
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "mf-m11-closeout",
    manifestDigest: digest("manifest-m11-closeout"),
    workspaceId: "workspace-m11-closeout",
    revision: 1,
    roots,
    focusedRootRef: roots[0]?.rootRef,
  };
}

async function measureSamples(count, worker) {
  const samples = [];
  for (let sample = 0; sample < count; sample += 1) {
    const startedAt = performance.now();
    await worker();
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function measureMultiRootUi(count) {
  const [{ workspaceRootTargets, requestWorkspaceRoots }, rootSessions] = await Promise.all([
    import("../packages/keiko-ui/src/app/components/desktop/workspaceRootTargets.ts"),
    import("../packages/keiko-ui/src/lib/editor-root-sessions.ts"),
  ]);
  const manifest = workspaceManifest();
  const targets = workspaceRootTargets(undefined, manifest);
  const sessions = new Map(
    manifest.roots.map((root) => [
      root.rootRef,
      { rootRef: root.rootRef, root: root.canonicalRoot, layoutJson: '{"active":"src/app.ts"}' },
    ]),
  );
  const projection = await measureSamples(count, () => workspaceRootTargets(undefined, manifest));
  const search = await measureSamples(count, () =>
    requestWorkspaceRoots(targets, (target) => Promise.resolve(target.id)),
  );
  const session = await measureSamples(count, () => {
    const serialized = rootSessions.serializeEditorRootSessions(
      sessions,
      manifest,
      manifest.focusedRootRef,
    );
    return rootSessions.parseEditorRootSessions(serialized, manifest);
  });
  return {
    rootCount: targets.length,
    rootProjection: summarizeSamples(projection),
    searchFanout: summarizeSamples(search),
    editorSessionRoundTrip: summarizeSamples(session),
  };
}

function historyInput(root, scope, content, nowMs) {
  return {
    ...scope,
    realRoot: root,
    relativePath: "src/app.ts",
    absolutePath: join(root, "src", "app.ts"),
    content,
    origin: "user-save",
    nowMs,
  };
}

async function prepareHistoryRoots(root) {
  const roots = [];
  for (let index = 0; index < HISTORY_ROOT_COUNT; index += 1) {
    const path = join(root, `root-${String(index)}`);
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "src", "app.ts"), "initial\n", "utf8");
    roots.push({
      path,
      scope: {
        workspaceId: "workspace-m11-history",
        rootRef: `root-m11-history-${String(index)}`,
        rootIdentityDigest: digest(`history-root-${String(index)}`),
      },
    });
  }
  return roots;
}

async function measureHistory(stateDir, roots, createStore) {
  const store = createStore({
    stateDir,
    env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: Buffer.alloc(32, 0x53).toString("base64") },
    limits: {
      maxVersionsPerFile: EDITOR_M11_CLOSEOUT_LIMITS.retainedHistoryVersions,
      coalesceMs: 0,
    },
  });
  globalThis.gc?.();
  const rssBefore = process.memoryUsage.rss();
  for (const [index, root] of roots.entries()) {
    store.capture(historyInput(root.path, root.scope, `root-${String(index)}\n`, index + 1));
  }
  globalThis.gc?.();
  const rssPerRoot = Math.max(0, process.memoryUsage.rss() - rssBefore) / roots.length;
  const primary = roots[0];
  if (primary === undefined) throw new Error("M11 history measurement root is unavailable.");
  const timings = [];
  for (let index = 0; index < HISTORY_CHAIN_LENGTH; index += 1) {
    const content = `history-version-${String(index).padStart(3, "0")}\n`;
    await writeFile(join(primary.path, "src", "app.ts"), content, "utf8");
    const startedAt = performance.now();
    store.capture(historyInput(primary.path, primary.scope, content, 1_000 + index));
    timings.push(performance.now() - startedAt);
  }
  return {
    historyPrune: summarizeSamples(timings),
    retainedHistoryVersions: store.list(primary.scope, "src/app.ts", 2_000).length,
    rssPerAdditionalRootBytes: Math.round(rssPerRoot),
    historyDiskBytes: await directoryBytes(join(stateDir, "editor-local-history")),
  };
}

export function budgetDisposition(measurement) {
  return {
    rootCount: measurement.rootCount === MAX_WORKSPACE_ROOTS,
    rootProjectionP95:
      measurement.rootProjection.p95Ms <= EDITOR_M11_CLOSEOUT_LIMITS.rootProjectionP95Ms,
    searchFanoutP95: measurement.searchFanout.p95Ms <= EDITOR_M11_CLOSEOUT_LIMITS.searchFanoutP95Ms,
    editorSessionRoundTripP95:
      measurement.editorSessionRoundTrip.p95Ms <=
      EDITOR_M11_CLOSEOUT_LIMITS.editorSessionRoundTripP95Ms,
    historyPruneP95: measurement.historyPrune.p95Ms <= EDITOR_M11_CLOSEOUT_LIMITS.historyPruneP95Ms,
    rssPerAdditionalRoot:
      measurement.rssPerAdditionalRootBytes <= EDITOR_M11_CLOSEOUT_LIMITS.rssPerAdditionalRootBytes,
    historyDisk: measurement.historyDiskBytes <= EDITOR_M11_CLOSEOUT_LIMITS.historyDiskBytes,
    retainedHistoryVersions:
      measurement.retainedHistoryVersions === EDITOR_M11_CLOSEOUT_LIMITS.retainedHistoryVersions,
  };
}

export function shouldFailBudget(disposition, controlled) {
  const deterministicFailed =
    !disposition.rootCount || !disposition.historyDisk || !disposition.retainedHistoryVersions;
  return deterministicFailed || (controlled && Object.values(disposition).some((value) => !value));
}

export async function runEditorM11CloseoutMeasurement(options = {}) {
  const controlled = options.controlled ?? process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1";
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const root = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), "keiko-editor-m11-performance-")),
  );
  const stateDir = join(root, "state");
  try {
    const [{ createEditorLocalHistoryStore }, multiRoot] = await Promise.all([
      import("../packages/keiko-server/dist/editor/localHistory/localHistoryStore.js"),
      measureMultiRootUi(samples),
    ]);
    const roots = await prepareHistoryRoots(root);
    const history = await measureHistory(stateDir, roots, createEditorLocalHistoryStore);
    const measurement = { ...multiRoot, ...history };
    const disposition = budgetDisposition(measurement);
    return {
      schemaVersion: "1",
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      measurementMode: controlled ? "controlled-enforced" : "informational-local",
      samples,
      historyChainLength: HISTORY_CHAIN_LENGTH,
      historyRootCount: HISTORY_ROOT_COUNT,
      limits: EDITOR_M11_CLOSEOUT_LIMITS,
      measurement,
      disposition,
      passed: !shouldFailBudget(disposition, controlled),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runEditorM11CloseoutMeasurement();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) await main();
