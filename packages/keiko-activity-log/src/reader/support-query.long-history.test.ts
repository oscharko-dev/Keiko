// Long-history performance evidence for #3531: a deterministic multi-segment history far larger
// than the V8 heap the query may use, a peak-memory budget enforced by the runtime itself, and
// instrumented reads proving that manifest-pruned segment bodies are never opened.
//
// The memory proof runs the real `keiko support query` code (the built package) in child Node
// processes under one old-space cap (HEAP_BUDGET_MB). Each child reports its peak resident set. A
// query over an EMPTY state directory calibrates the baseline (the module graph the command loads
// anyway); the long-history queries may exceed that baseline by at most RSS_GROWTH_BUDGET_MB while
// the history itself is several times larger than that budget, so an implementation that held the
// history (or even its raw text) could not pass. The fixture is generated from one
// production-formatted template line per operation, so every line is a valid registered v2 record.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLogSegmentFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import { openSafeArtifactFile } from "@oscharko-dev/keiko-security/fs-hardening";
import { DEFAULT_SUPPORT_QUERY_LIMITS, runSupportQuery } from "./support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "./support-segment-scan.js";
import {
  correlationKey,
  filterKeyHashes,
  manifestMayContainAnyKey,
  parentCorrelationKey,
} from "./support-segment-manifest.js";
import { fixtureLine, fixtureProcess } from "../../../../tests/support/activity-log-segments.js";

const SEGMENT_COUNT = 40;
const SEGMENT_BYTES = 2 * 1024 * 1024;
const HEAP_BUDGET_MB = 112;
const RSS_GROWTH_BUDGET_MB = 32;
const TARGET_SEGMENT = 23;
const CHILD_SEGMENT = 29;
const ROOT_ID = "corr-lh-target-root-00001";
const CHILD_ID = "corr-lh-target-child-0001";
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const BUILT_SUPPORT_MODULE = fileURLToPath(
  new URL("../../../keiko-cli/dist/support.js", import.meta.url),
);

// Template tokens: every variable part of a line is a unique, fixed placeholder.
const TOKEN_TS = "2026-01-01T00:00:00.000Z";
const TOKEN_CORRELATION = "corr-lh-template-token-0001";

interface Template {
  readonly correlated: string;
  readonly child: string;
  readonly signal: string;
}

function templates(): Template {
  const process = fixtureProcess(1, "00000000");
  const at = Date.parse(TOKEN_TS);
  const correlated = fixtureLine(process, at, {
    op: "client.diagnostic",
    correlationId: TOKEN_CORRELATION,
  });
  const child = fixtureLine(process, at, {
    op: "client.diagnostic",
    correlationId: CHILD_ID,
    parentCorrelationId: ROOT_ID,
  });
  const signal = fixtureLine(process, at, { op: "cli.lifecycle.stop-requested" });
  return { correlated, child, signal };
}

function stamp(
  template: string,
  values: { ts: string; pid: number; instanceId: string; seq: number; correlationId?: string },
): string {
  let line = template
    .replace(`"ts":"${TOKEN_TS}"`, `"ts":"${values.ts}"`)
    .replace('"pid":1,', `"pid":${String(values.pid)},`)
    .replace('"instanceId":"00000000"', `"instanceId":"${values.instanceId}"`)
    .replace(/"seq":\d+,/u, `"seq":${String(values.seq)},`);
  if (values.correlationId !== undefined) {
    line = line.replace(TOKEN_CORRELATION, values.correlationId);
  }
  return line;
}

interface SegmentPlan {
  readonly index: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly startMs: number;
}

function segmentLines(template: Template, plan: SegmentPlan): string {
  const parts: string[] = [];
  let bytes = 0;
  let seq = 0;
  const push = (line: string): void => {
    parts.push(line);
    bytes += line.length + 1;
  };
  while (bytes < SEGMENT_BYTES) {
    seq += 1;
    const ts = new Date(plan.startMs + seq * 10).toISOString();
    const identity = { ts, pid: plan.pid, instanceId: plan.instanceId, seq };
    if (plan.index === TARGET_SEGMENT && seq === 500) {
      push(stamp(template.correlated, { ...identity, correlationId: ROOT_ID }));
    } else if (plan.index === CHILD_SEGMENT && seq === 700) {
      push(stamp(template.child, identity));
    } else if (seq % 5 === 0) {
      push(stamp(template.signal, identity));
    } else {
      const correlationId = `corr-lh-${String(plan.index).padStart(3, "0")}-${String(
        Math.floor(seq / 4),
      ).padStart(10, "0")}`;
      push(stamp(template.correlated, { ...identity, correlationId }));
    }
  }
  return `${parts.join("\n")}\n`;
}

let stateDir: string;
let historyBytes = 0;

function writeHistory(): void {
  const template = templates();
  const logs = join(stateDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    const plan: SegmentPlan = {
      index,
      pid: 20_000 + index,
      instanceId: (0x10000000 + index).toString(16),
      startMs: T0 + index * 3_600_000,
    };
    const text = segmentLines(template, plan);
    historyBytes += Buffer.byteLength(text);
    const name = activityLogSegmentFileName(
      { startMs: plan.startMs, pid: plan.pid, instanceId: plan.instanceId, index: 1 },
      "sealed",
    );
    writeFileSync(join(logs, name), text, { mode: 0o400 });
  }
}

interface ChildRun {
  readonly status: number | null;
  readonly elapsedMs: number;
  readonly peakRssMb: number;
  readonly result: {
    readonly segments: Readonly<Record<string, number>>;
    readonly metrics: Readonly<Record<string, number>>;
    readonly closure: { readonly correlationCount: number } | null;
    readonly diagnosticSufficiency: { readonly status: string };
  };
}

const DRIVER = `
const { runSupportCli } = await import(process.argv[1]);
const io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };
const code = await runSupportCli(JSON.parse(process.argv[2]), io, {});
process.stderr.write("KEIKO_PEAK_RSS_KB=" + String(process.resourceUsage().maxRSS) + "\\n");
process.exitCode = code;
`;

function runBuiltQuery(queriedStateDir: string = stateDir): ChildRun {
  const args = ["query", "--state-dir", queriedStateDir, "--correlation-id", ROOT_ID, "--json"];
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${String(HEAP_BUDGET_MB)}`,
      "--input-type=module",
      "-e",
      DRIVER,
      pathToFileURL(BUILT_SUPPORT_MODULE).href,
      JSON.stringify(args),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const elapsedMs = Date.now() - started;
  const peak = Number(/KEIKO_PEAK_RSS_KB=(\d+)/u.exec(run.stderr)?.[1] ?? Number.NaN);
  // macOS reports maxRSS in bytes-per-1024 units like Linux (KiB) through resourceUsage().
  return {
    status: run.status,
    elapsedMs,
    peakRssMb: peak / 1024,
    result: JSON.parse(run.stdout === "" ? "{}" : run.stdout) as ChildRun["result"],
  };
}

beforeAll(() => {
  if (!existsSync(BUILT_SUPPORT_MODULE)) {
    throw new Error("Built keiko-cli is missing; run npm run build:packages before this test");
  }
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-long-history-"));
  writeHistory();
}, 120_000);

afterAll(() => {
  closeFileServerLogSinks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("support query over a long history (#3531)", () => {
  it("answers within the peak-memory budget over a history far larger than the budget", async ({
    annotate,
  }) => {
    expect(historyBytes).toBeGreaterThan(2 * RSS_GROWTH_BUDGET_MB * 1024 * 1024);
    const emptyStateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-long-history-empty-"));
    const baseline = runBuiltQuery(emptyStateDir);
    rmSync(emptyStateDir, { recursive: true, force: true });

    const cold = runBuiltQuery();
    const warm = runBuiltQuery();

    expect(baseline.status).toBe(0);
    for (const run of [cold, warm]) {
      expect(run.status).toBe(0);
      expect(run.result.closure?.correlationCount).toBe(2);
      expect(run.result.metrics.closureEventCount).toBe(2);
      expect(run.peakRssMb - baseline.peakRssMb).toBeLessThan(RSS_GROWTH_BUDGET_MB);
    }
    expect(cold.result.segments).toMatchObject({
      total: SEGMENT_COUNT,
      manifestsBuilt: SEGMENT_COUNT,
    });
    expect(warm.result.segments.manifestsReused).toBeGreaterThanOrEqual(SEGMENT_COUNT);
    // The warm query opens only the segments its manifests cannot exclude.
    expect(warm.result.segments.opened).toBeLessThanOrEqual(4);
    expect(warm.elapsedMs).toBeLessThan(cold.elapsedMs);
    await annotate(
      `[#3531 long-history] history=${(historyBytes / 1048576).toFixed(1)} MiB in ${String(
        SEGMENT_COUNT,
      )} segments, heap cap ${String(HEAP_BUDGET_MB)} MiB; baseline ${String(baseline.elapsedMs)} ms / ` +
        `${baseline.peakRssMb.toFixed(0)} MiB RSS; cold ${String(cold.elapsedMs)} ms / ` +
        `${cold.peakRssMb.toFixed(0)} MiB RSS; warm ${String(warm.elapsedMs)} ms / ` +
        `${warm.peakRssMb.toFixed(0)} MiB RSS, opened ${String(warm.result.segments.opened)}`,
    );
  }, 180_000);

  it("never opens a manifest-pruned segment body (instrumented reads)", () => {
    const files = listActivityLogStoreFiles(stateDir);
    const pass = ensureSegmentManifests(stateDir, files, new ActivityLogScanner(stateDir), {
      trigger: "query",
      persist: true,
      rebuild: false,
    });
    const opened: string[] = [];
    const scanner = new ActivityLogScanner(stateDir, {
      openFile: (file, root): number => {
        opened.push(file.name);
        return openSafeArtifactFile(file.path, {
          artifactClass: "activity-log",
          mode: "read",
          trustedRoot: root,
        });
      },
    });
    const result = runSupportQuery({
      files,
      manifests: pass.manifests,
      manifestStats: pass.stats,
      scanner,
      selection: {
        kind: "closure",
        queryClass: "correlation",
        roots: [ROOT_ID],
        windows: [],
        requiredClasses: { kind: "observed" },
        unresolved: false,
      },
      limits: DEFAULT_SUPPORT_QUERY_LIMITS,
    });
    const holders = new Set(
      result.events.filter((event) => event.role === "closure").map((event) => event.file.name),
    );
    // A segment is pruned when its own manifest (asked through the production filter) excludes
    // every correlation key any pass looked for, and its time range misses the closure context.
    const keys = [
      correlationKey(ROOT_ID),
      parentCorrelationKey(ROOT_ID),
      correlationKey(CHILD_ID),
      parentCorrelationKey(CHILD_ID),
    ].map(filterKeyHashes);
    const closureMs = result.events.map((event) => Date.parse(event.parsed.view.ts));
    const contextFrom = Math.min(...closureMs) - DEFAULT_SUPPORT_QUERY_LIMITS.contextMs;
    const contextTo = Math.max(...closureMs) + DEFAULT_SUPPORT_QUERY_LIMITS.contextMs;
    const pruned = files.filter((file) => {
      const loaded = pass.manifests.get(file.name);
      if (file.kind !== "sealed" || loaded === undefined) return false;
      const time = loaded.manifest.time;
      const overlaps =
        time !== null &&
        Date.parse(time.firstTs) <= contextTo &&
        Date.parse(time.lastTs) >= contextFrom;
      return !overlaps && !manifestMayContainAnyKey(loaded, keys);
    });

    expect(pass.stats.reusedCount).toBeGreaterThanOrEqual(SEGMENT_COUNT);
    expect(holders.size).toBe(2);
    expect(pruned.length).toBeGreaterThanOrEqual(SEGMENT_COUNT - 10);
    for (const file of pruned) expect(opened).not.toContain(file.name);
    expect(new Set(opened).size).toBe(result.segments.candidate);
  }, 120_000);
});
