import {
  occupySupportIncidentRetentionForTests,
  supportIncidentReservationsForTests,
} from "../../../tests/support/activity-log-test-support.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeFileServerLogSinks, listSupportIncidents } from "@oscharko-dev/keiko-activity-log";
import {
  ACTIVITY_LOG_MANIFEST_DIRECTORY_NAME,
  analyzeLogText,
  analyzeSupportReport,
  createDesktopSupportReport,
  findTimeline,
  parseSupportReport,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanReproductionSeed,
  renderHumanTimeline,
  serializeSupportReport,
  SupportReportError,
  type AnalyzedSupportReport,
  type ReproductionSeed,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { MEMORY_DB_FILENAME, MEMORY_DIR_NAME } from "@oscharko-dev/keiko-memory-vault";
import { UI_DB_FILENAME } from "@oscharko-dev/keiko-server";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { expectActivityLogScenario } from "../../../tests/support/activity-log-scenario.js";
import {
  resealSupportReport,
  resealSupportReportWithParentFanOut,
  supportReportDigest,
} from "../../../tests/support/support-report-fixtures.js";
import * as lazyModules from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { runSupportCli } from "./support.js";
import { publishSupportReportFile, readSupportReportFile } from "./support-export.js";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import { emitSupportReportFailed } from "./support-report-evidence.js";
import { defaultUiDataDir } from "./state-paths.js";

const CORRELATION = "support-report-cli-0001";
let root: string;
let stateDir: string;
let controlStateDir: string;
let path: string;

function capture(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text): void => {
        output.push(text);
      },
      err: (text): void => {
        errors.push(text);
      },
    },
    output,
    errors,
  };
}
function expectCapacityExportEvidence(reportJson: string): void {
  const report = parseSupportReport(reportJson);
  const rejected = persistedActivityLogLines(
    readPersistedActivityLog(stateDir),
    "support.incident.rejected",
  ).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rejected).toContainEqual(
    expect.objectContaining({
      correlationId: CORRELATION,
      rejectionReason: "quota-exhausted",
      completeness: "partial",
      loss: "event-dropped",
    }),
  );
  const completed = persistedActivityLogLines(
    readPersistedActivityLog(stateDir),
    "support.report.completed",
  ).at(-1);
  const line = expectActivityLogProof("support.report.completed.report-lifecycle", completed ?? "");
  expect(line).toMatchObject({
    surface: "export",
    selectedCorrelationId: CORRELATION,
    incidentId: report.incident.incidentId,
    incidentTrigger: report.incident.trigger,
    reportDigest: report.integrity.reportDigest,
    retentionDisposition: "transient",
  });
  expect(line).not.toHaveProperty("pinDisposition");
}

function seed(): void {
  const process = fixtureProcess(4242, "aabbccdd");
  const now = Date.now();
  writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, { op: "client.diagnostic", correlationId: CORRELATION }),
  ]);
}
function seedGatewayFailure(ageMs = 0, level: "warn" | "info" = "warn"): void {
  rmSync(join(stateDir, "logs"), { recursive: true });
  const process = fixtureProcess(4242, "aabbccdd");
  const now = Date.now() - ageMs;
  const segment = writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, {
      op: "gateway.chat.started",
      correlationId: CORRELATION,
      fields: {
        modelId: "test-model",
        costClass: "low",
        timeoutMs: 100,
        maxRetries: 0,
        requestBudgetMs: 100,
        upstreamStreaming: false,
        streaming: false,
      },
    }),
    fixtureLine(process, now + 1, {
      op: "gateway.chat.failed",
      level, // Production gateway.logCallFailed uses warn; info is a negative attribution control.
      correlationId: CORRELATION,
      errorKind: "timeout",
      fields: {
        modelId: "test-model",
        streaming: false,
      },
    }),
    fixtureLine(process, now + 2, {
      op: "support.report.started",
      correlationId: CORRELATION,
      fields: { surface: "analyze", reportSchemaVersion: 1, maxBytes: 10485760 },
    }),
    fixtureLine(process, now + 3, {
      op: "support.report.failed",
      correlationId: CORRELATION,
      errorKind: "validation-failed",
      fields: {
        surface: "analyze",
        reportSchemaVersion: 1,
        frames: ["packages/keiko-model-gateway/src/gateway.ts:1209:3"],
        causeChain: ["Error"],
      },
    }),
  ]);
  utimesSync(segment, now / 1000, now / 1000);
}
async function exportReport(out = root): Promise<ReturnType<typeof capture>> {
  const result = capture();
  const code = await runSupportCli(
    ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", out],
    result.io,
    {},
    { cwd: root, controlActivityStateDir: controlStateDir },
  );
  expect(code, result.errors.join("")).toBe(0);
  const filename = readdirSync(out).find((name) => name.startsWith("keiko-support-v1-"));
  if (filename === undefined) throw new TypeError("missing canonical report");
  path = join(out, filename);
  return result;
}
async function analyze(
  args: readonly string[] = [],
): Promise<{ code: number } & ReturnType<typeof capture>> {
  const result = capture();
  const code = await runSupportCli(
    ["analyze", path, ...args],
    result.io,
    {},
    { cwd: root, controlActivityStateDir: controlStateDir },
  );
  return { code, ...result };
}

// What `shasum -a 256` prints for the bytes: independent of the production digest helper.
function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function runExport(
  out: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<{ code: number } & ReturnType<typeof capture>> {
  const result = capture();
  const code = await runSupportCli(
    ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", out],
    result.io,
    env,
    { cwd: root, controlActivityStateDir: controlStateDir },
  );
  return { code, ...result };
}
// One failed run is one complete started/failed lifecycle in the log that owns it and no further
// completion; its closed kind is the only thing it says about the failure.
function expectFailureEvidence(
  logRoot: string,
  surface: "export" | "analyze",
  errorKind: string,
  completions = 0,
): void {
  const log = readPersistedActivityLog(logRoot);
  const [failed, ...otherFailures] = persistedActivityLogLines(log, "support.report.failed");
  expect(otherFailures).toEqual([]);
  expect(persistedActivityLogLines(log, "support.report.completed")).toHaveLength(completions);
  const record = expectActivityLogProof("support.report.failed.report-lifecycle", failed ?? "");
  expect(record).toMatchObject({
    surface,
    level: "error",
    errorKind,
    completeness: "complete",
    loss: "none",
  });
  expect(record).not.toHaveProperty("reason");
  const started = persistedActivityLogLines(log, "support.report.started").at(-1);
  expect(record.correlationId).toBe(
    (JSON.parse(started ?? "{}") as { readonly correlationId?: unknown }).correlationId,
  );
  expect(failed).not.toContain(root);
}
// The production analysis of the exported report, with the seed a gateway failure always yields.
function analyzedReport(): { artifact: AnalyzedSupportReport; seed: ReproductionSeed } {
  const artifact = analyzeSupportReport(readSupportReportFile(path));
  if (artifact.seed === undefined) throw new TypeError("missing reproduction seed");
  return { artifact, seed: artifact.seed };
}
// An Activity Log entry that must never be read, planted at the name of a valid segment.
const UNSAFE_SEGMENT_ENTRIES = [
  "permissions",
  "symlink",
  "hard-link",
  "dangling-symlink",
  "directory",
] as const;
function plantUnsafeSegment(
  kind: (typeof UNSAFE_SEGMENT_ENTRIES)[number],
  segment: string,
  victim: string,
): void {
  if (kind === "permissions") {
    chmodSync(segment, 0o444);
    return;
  }
  rmSync(segment, { recursive: true, force: true });
  if (kind === "symlink") symlinkSync(victim, segment);
  else if (kind === "hard-link") linkSync(victim, segment);
  else if (kind === "dangling-symlink") symlinkSync(join(root, "missing-victim"), segment);
  else mkdirSync(segment, { mode: 0o700 });
}
// A replay fixture destination that exists or links elsewhere; a dangling link has no victim yet.
function plantFixtureTarget(kind: string, target: string, victim: string): void {
  if (kind !== "dangling-symlink") writeFileSync(victim, "existing-private-work", { mode: 0o600 });
  if (kind === "symlink" || kind === "dangling-symlink") symlinkSync(victim, target);
  else if (kind === "hard-link") linkSync(victim, target);
  else writeFileSync(target, "existing-private-work", { mode: 0o600 });
}

function analyzeBuiltCli(): { code: number; output: string[]; errors: string[] } {
  const cliUrl = new URL("../dist/support.js", import.meta.url).href;
  const program = `
    import { runSupportCli } from ${JSON.stringify(cliUrl)};
    const output = [], errors = [];
    const code = await runSupportCli(["analyze", process.argv[1], "--json"], {
      out: (text) => output.push(text), err: (text) => errors.push(text),
    }, {}, { cwd: process.argv[2], controlActivityStateDir: process.argv[3] });
    process.stdout.write(JSON.stringify({ code, output, errors }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--experimental-sqlite",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        program,
        path,
        root,
        controlStateDir,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ),
  ) as { code: number; output: string[]; errors: string[] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-support-report-cli-"));
  stateDir = join(root, "state");
  controlStateDir = join(root, "control");
  path = join(root, "report.json");
  mkdirSync(stateDir, { mode: 0o700 });
  seed();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeFileServerLogSinks();
  rmSync(root, { recursive: true, force: true });
});

// A shipped product stack has no Vitest caller modules. Keep real throw-site coordinates.
async function withProductStack<T>(operation: () => Promise<T>): Promise<T> {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 3;
  try {
    return await operation();
  } finally {
    Error.stackTraceLimit = previous;
  }
}

describe("support report CLI and private publication", () => {
  it("describes the actual empty bounded manual selection instead of an unbudgeted second window", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    const process = fixtureProcess(4242, "aabbccdd");
    const now = Date.now();
    writeFixtureSegment(
      stateDir,
      segmentIdentity(process, now, 1),
      Array.from({ length: 4100 }, (_, index) =>
        fixtureLine(process, now, {
          op: "client.diagnostic",
          correlationId: `manual-required-${String(index)}`,
        }),
      ),
    );
    const destination = join(root, "bounded-manual-window");
    const captured = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", destination],
        captured.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(0);
    const filename = readdirSync(destination).find((entry) => entry.endsWith(".json"));
    if (filename === undefined) throw new TypeError("Missing bounded report");
    const report = parseSupportReport(readSupportReportFile(join(destination, filename)));
    expect(report.selection.status).toBe("insufficient");
    expect(report.selection.reasons).toContain("report-budget-exceeded");
    expect(report.evidence.recordCount).toBe(0);
    expect(report.incident.lineCount).toBe(0);
    expect(report.incident.sufficiencyStatus).toBe("insufficient");
  });
  it.each([false, true])(
    "keeps CLI and desktop failure identity equal at full quota=%s",
    async (full) => {
      rmSync(join(stateDir, "logs"), { recursive: true });
      const process = fixtureProcess(4242, "aabbccdd");
      const now = Date.now();
      writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
        fixtureLine(process, now, {
          op: "client.diagnostic",
          correlationId: CORRELATION,
          level: "error",
          errorKind: "timeout",
          fields: { frames: ["packages/keiko-server/dist/chat-stream-handlers.js:42:7"] },
        }),
      ]);
      if (full) {
        vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
        occupySupportIncidentRetentionForTests(stateDir);
      }
      const desktop = parseSupportReport(
        createDesktopSupportReport(stateDir, CORRELATION).reportJson,
      );
      await exportReport(join(root, "identity-report"));
      const cli = parseSupportReport(readSupportReportFile(path));
      expect(cli.incident).toMatchObject({
        trigger: "registered-failure",
        op: desktop.incident.op,
        errorKind: desktop.incident.errorKind,
        defectFingerprint: desktop.incident.defectFingerprint,
        fingerprintAlgorithm: desktop.incident.fingerprintAlgorithm,
        frameCount: desktop.incident.frameCount,
      });
      expect(
        analyzeSupportReport(readSupportReportFile(path))
          .analysis.timelines.flatMap((timeline) => timeline.lines)
          .some((line) => line.errorKind === "timeout"),
      ).toBe(true);
    },
  );

  it("exports an honest manual window at a full candidate quota without a selector", async () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const reservations = supportIncidentReservationsForTests(stateDir);
    const retainedIds = listSupportIncidents(stateDir).map((incident) => incident.incidentId);
    const destination = join(root, "manual-quota-report");
    const captured = capture();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", destination],
      captured.io,
      { KEIKO_LOG_RETENTION_BYTES: "65536" },
      { cwd: root, controlActivityStateDir: controlStateDir },
    );
    expect(code).toBe(0);
    const filename = readdirSync(destination).find((entry) => entry.endsWith(".json"));
    if (filename === undefined) throw new TypeError("Missing manual quota report");
    const reportJson = readSupportReportFile(join(destination, filename));
    const analyzed = analyzeSupportReport(reportJson);
    expect(analyzed.selection.status).toBe("complete");
    expect(
      analyzed.analysis.timelines
        .flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "client.diagnostic"),
    ).toBe(true);
    expect(listSupportIncidents(stateDir).map((incident) => incident.incidentId)).toEqual(
      retainedIds,
    );
    expect(parseSupportReport(reportJson).incident.pin.status).toBe("rejected");
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(reservations);
  });

  it("exports an explicitly selected readable failure when candidate storage is unavailable", async () => {
    seedGatewayFailure();
    writeFileSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME), "not a directory");
    const exported = await runExport(join(root, "unavailable-candidate-store"));
    expect(exported.code).toBe(0);
    const file = readdirSync(join(root, "unavailable-candidate-store")).find((entry) =>
      entry.endsWith(".json"),
    );
    if (file === undefined) throw new TypeError("Missing exported report");
    const report = parseSupportReport(
      readSupportReportFile(join(root, "unavailable-candidate-store", file)),
    );
    expect(report.incident.trigger).toBe("registered-failure");
    expect(report.incident.op).toBe("gateway.chat.failed");
    expect(report.evidence.recordCount).toBeGreaterThan(0);
  });

  it("does not attribute an info-only gateway record as a failure when candidate storage is unavailable", async () => {
    seedGatewayFailure(0, "info");
    writeFileSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME), "not a directory");
    const destination = join(root, "unavailable-store-info-control");
    expect((await runExport(destination)).code).toBe(0);
    const file = readdirSync(destination).find((entry) => entry.endsWith(".json"));
    if (file === undefined) throw new TypeError("Missing exported info-control report");
    const text = readSupportReportFile(join(destination, file));
    expect(parseSupportReport(text).incident).toMatchObject({
      trigger: "user-report",
      op: "unattributed",
      errorKind: "unknown",
      frameCount: 0,
    });
    expect(
      analyzeSupportReport(text).analysis.timelines.flatMap((timeline) => timeline.lines),
    ).toContainEqual(
      expect.objectContaining({ op: "gateway.chat.failed", level: "info", errorKind: "timeout" }),
    );
  });

  it.each(["--correlation-id", "--incident", "--defect-fingerprint"] as const)(
    "refuses an unknown %s without selecting another failure when candidate storage is unavailable",
    async (selector) => {
      writeFileSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME), "not a directory");
      const output = join(root, "refused-unavailable-store");
      const result = capture();
      const code = await runSupportCli(
        [
          "export",
          "--state-dir",
          stateDir,
          selector,
          selector === "--correlation-id"
            ? "unknown-correlation"
            : "a".repeat(selector === "--incident" ? 32 : 64),
          "--out",
          output,
        ],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      );
      expect(code).toBe(1);
      expect(existsSync(output) ? readdirSync(output) : []).toEqual([]);
    },
  );

  it("exports the selected retained evidence at a full candidate quota without a browser session", async () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    occupySupportIncidentRetentionForTests(stateDir);
    const reservations = supportIncidentReservationsForTests(stateDir);
    const retainedIds = listSupportIncidents(stateDir).map((incident) => incident.incidentId);
    const destination = join(root, "quota-report");
    const exported = await runExport(destination, { KEIKO_LOG_RETENTION_BYTES: "65536" });
    expect(exported.code).toBe(0);
    const filename = readdirSync(destination).find((entry) => entry.endsWith(".json"));
    if (filename === undefined) throw new TypeError("Missing quota report");
    const reportJson = readSupportReportFile(join(destination, filename));
    expect(
      analyzeSupportReport(reportJson)
        .analysis.timelines.flatMap((timeline) => timeline.lines)
        .some((line) => line.op === "client.diagnostic"),
    ).toBe(true);
    expect(listSupportIncidents(stateDir).map((incident) => incident.incidentId)).toEqual(
      retainedIds,
    );
    expect(parseSupportReport(reportJson).incident.pin.status).toBe("rejected");
    expect(supportIncidentReservationsForTests(stateDir)).toEqual(reservations);
    expectCapacityExportEvidence(reportJson);
  });

  it("assesses a historical selected correlation closure rather than the export-time window", async () => {
    seedGatewayFailure(75 * 60_000);
    await exportReport();
    const exported = readSupportReportFile(path);
    const report = parseSupportReport(exported);
    const decoded = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
    expect(decoded).toContain("gateway.chat.failed");
    expect(report.incident.segments.length).toBeGreaterThan(0);
    expect(report.incident.lineCount).toBeGreaterThan(0);
    expect(report.incident.sufficiencyStatus).toBe("complete");
    expect(analyzeSupportReport(exported).selection.status).toBe("complete");
  });
  it("publishes exactly one private report and a versioned validated machine view", async () => {
    const result = await exportReport();
    expect(result.output.join("")).toContain("Nothing has been sent.");
    expect(readdirSync(root).sort()).toEqual([path.slice(root.length + 1), "state"].sort());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const exported = readSupportReportFile(path);
    const report = parseSupportReport(exported);
    const artifact = analyzeSupportReport(exported);
    expect(artifact.selection.status).toBe("complete");
    expect(artifact.seed?.correlationId).toBe(report.incident.correlation.rootCorrelationId);
    expect(artifact.seed?.correlationId).toMatch(/^id\d{6}$/u);
    expect(exported).not.toContain(CORRELATION);
    expect(
      inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8"),
    ).not.toContain(CORRELATION);
    // The analysis states the SHA-256 of the exact bytes on disk and names the analyzer itself.
    expect(artifact.sourceArtifactDigest).toBe(sha256Of(readFileSync(path)));
    expect(artifact.analyzerVersion).toBe(KEIKO_PRODUCT_VERSION);
    const analyzed = await analyze(["--json"]);
    expect(analyzed.code, analyzed.errors.join("")).toBe(0);
    expect(JSON.parse(analyzed.output.join(""))).toEqual(artifact);
    expect(analyzed.output.join("")).not.toContain(root);
  });

  // #3532 pin: export states the exported directory's readiness, persisted after the report.
  it("reports the exported directory's diagnostic readiness after a successful export", async () => {
    const result = await exportReport();
    expect(result.output.join("")).toMatch(/Diagnostic evidence: (ready|degraded|unavailable)/u);
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    expect(JSON.stringify(artifact.analysis)).not.toContain("activity-log.readiness");
    const readiness = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "activity-log.readiness",
    );
    expect(readiness).toHaveLength(1);
  });

  it("records an unavailable lifecycle validator as a body-free degraded analysis", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    const process = fixtureProcess(4242, "aabbccdd");
    const now = Date.now();
    // An issue-to-PR journey line makes the analysis load the lifecycle validators.
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, {
        op: "coding-repository-handler.started",
        correlationId: CORRELATION,
      }),
    ]);
    await exportReport();
    vi.spyOn(lazyModules, "loadToolLifecycle").mockRejectedValue(
      new TypeError("private-import-token", { cause: new RangeError("private-cause-token") }),
    );
    const result = await analyze(["--json"]);
    expect(result.code, result.errors.join("")).toBe(0);
    expect(result.errors.join("")).toContain("tool lifecycle validator unavailable — TypeError");
    const log = readPersistedActivityLog(controlStateDir);
    const [degraded] = persistedActivityLogLines(log, "support.report.degraded");
    const [completed] = persistedActivityLogLines(log, "support.report.completed");
    const state = expectActivityLogProof(
      "support.report.degraded.lifecycle-validator",
      degraded ?? "",
    );
    expect(state).toMatchObject({
      level: "warn",
      errorKind: "unavailable",
      surface: "analyze",
      reason: "lifecycle-validator-unavailable",
      errorClass: "TypeError",
      causeChain: ["RangeError"],
    });
    // Review #3679: the failing loader site stays reconstructable from dist-anchored frames.
    const frames = (state as { readonly frames?: unknown }).frames;
    expect(Array.isArray(frames) && frames.length > 0).toBe(true);
    for (const frame of frames as readonly unknown[]) {
      expect(frame).toMatch(/^packages\/keiko-[a-z-]+\/(?:dist|src)\/[^:]+:\d+:\d+$/u);
    }
    expect(
      expectActivityLogProof("support.report.completed.report-lifecycle", completed ?? ""),
    ).toMatchObject({ correlationId: state.correlationId, surface: "analyze" });
    expect(log).not.toMatch(/private-(?:import|cause)-token/u);
  });

  // Review #3679: two explicit selectors prepare two reproductions the log tells apart.
  it("binds each prepared reproduction to the digest of its own seed correlation", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    const process = fixtureProcess(4242, "aabbccdd");
    const now = Date.now();
    const child = "support-report-cli-child-01";
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, { op: "client.diagnostic", correlationId: CORRELATION }),
      fixtureLine(process, now + 1, {
        op: "client.diagnostic",
        correlationId: child,
        parentCorrelationId: CORRELATION,
      }),
    ]);
    await exportReport();
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    const parentRef = artifact.incident.correlation.rootCorrelationId;
    const childRef = artifact.analysis.timelines.find((timeline) =>
      timeline.lines.some((line) => line.parentCorrelationId === parentRef),
    )?.correlationId;
    if (parentRef === undefined || childRef === undefined)
      throw new TypeError("missing exported parent/child references");
    for (const selected of [parentRef, childRef]) {
      const result = await analyze(["--seed", "--json", "--correlation-id", selected]);
      expect(result.code, result.errors.join("")).toBe(0);
    }
    const completions = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.completed",
    ).map((line) => expectActivityLogProof("support.report.completed.report-lifecycle", line));
    const digest = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");
    expect(completions.slice(-2)).toEqual([
      expect.objectContaining({
        seedCorrelation: "selected",
        seedCorrelationDigest: digest(parentRef),
      }),
      expect.objectContaining({
        seedCorrelation: "selected",
        seedCorrelationDigest: digest(childRef),
      }),
    ]);
    expect(JSON.stringify(completions)).not.toContain(parentRef);
    expect(JSON.stringify(completions)).not.toContain(childRef);
  });

  // Review #3679: a real native import rejection still leaves a Keiko failure site on the line.
  it("names the Keiko site of a native lifecycle-validator import rejection", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    const process = fixtureProcess(4242, "aabbccdd");
    const now = Date.now();
    writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
      fixtureLine(process, now, {
        op: "coding-repository-handler.started",
        correlationId: CORRELATION,
      }),
    ]);
    await exportReport();
    const missing = pathToFileURL(join(root, "missing-tool-catalog-lifecycle.js")).href;
    vi.spyOn(lazyModules, "loadToolLifecycle").mockImplementation(async () => {
      await import(/* @vite-ignore */ missing);
      throw new TypeError("the missing module unexpectedly loaded");
    });
    const result = await analyze(["--json"]);
    expect(result.code, result.errors.join("")).toBe(0);
    const [degraded] = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.degraded",
    );
    const state = expectActivityLogProof(
      "support.report.degraded.lifecycle-validator",
      degraded ?? "",
    );
    const frames = (state as { readonly frames?: unknown }).frames;
    expect(Array.isArray(frames)).toBe(true);
    expect(
      (frames as readonly string[]).some((frame) =>
        /^packages\/keiko-cli\/(?:dist|src)\/support-report-(?:evidence|cli)\./u.test(frame),
      ),
    ).toBe(true);
    expect(degraded).not.toContain(root);
  });

  // Review #3679: the completion distinguishes reading a report from creating a replay fixture.
  it("records which view an analysis produced and a published replay fixture", async () => {
    seedGatewayFailure();
    await exportReport();
    expect((await analyze(["--json"])).code).toBe(0);
    const fixture = await analyze(["--seed", "--json", "--emit-fixture", "replay-outcome.ts"]);
    expect(fixture.code, fixture.errors.join("")).toBe(0);
    const completions = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.completed",
    ).map((line) => expectActivityLogProof("support.report.completed.report-lifecycle", line));
    expect(completions.at(-2)).toMatchObject({ surface: "analyze", analysisView: "analysis" });
    expect(completions.at(-2)).not.toHaveProperty("fixture");
    expect(completions.at(-1)).toMatchObject({
      surface: "analyze",
      analysisView: "seed",
      seedCorrelation: "incident",
      fixture: "published",
    });
    expect(JSON.stringify(completions)).not.toContain("replay-outcome");
  });

  // Review #3679: a redirected default directory is refused before anything changes its target.
  it.skipIf(process.platform === "win32")(
    "refuses a symlinked default report directory without changing its target",
    async () => {
      const target = join(root, "elsewhere");
      mkdirSync(target);
      chmodSync(target, 0o755);
      symlinkSync(target, join(stateDir, "support-reports"));
      const result = capture();
      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      );
      // The target keeps its own permissions: nothing was changed through the link.
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(readdirSync(target)).toEqual([]);
      expect(code).toBe(1);
      expect(result.errors.join("")).toContain("keiko support: unsafe-target");
    },
  );

  it("persists the started and completed proofs against the committed digest and byte count", async () => {
    await exportReport();
    const raw = readPersistedActivityLog(stateDir);
    const [started] = persistedActivityLogLines(raw, "support.report.started");
    const [completed] = persistedActivityLogLines(raw, "support.report.completed");
    const start = expectActivityLogProof("support.report.started.report-lifecycle", started ?? "");
    const end = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      completed ?? "",
    );
    const bytes = readFileSync(path);
    expect(end).toMatchObject({
      correlationId: start.correlationId,
      surface: "export",
      reportBytes: bytes.length,
      reportDigest: parseSupportReport(bytes.toString()).integrity.reportDigest,
      incidentId: parseSupportReport(bytes.toString()).incident.incidentId,
      incidentTrigger: parseSupportReport(bytes.toString()).incident.trigger,
      selectedCorrelationId: CORRELATION,
      retentionDisposition: "stored",
      pinDisposition: parseSupportReport(bytes.toString()).incident.pin.status,
      sufficiency: "complete",
      sufficiencyReasons: [],
      completeness: "complete",
      loss: "none",
      // Export states how the one file was committed and what the platform could assure for it.
      publication: "published",
      permissionAssurance: process.platform === "win32" ? "platform-inherited" : "verified-private",
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
    });
    expect(completed).not.toContain(path);
  });

  it("persists a fully evidenced validation failure before any hostile report is rendered", async () => {
    const startedAtMs = Date.now();
    writeFileSync(path, '{"$section":"config-snapshot","secret":"customer-private"}\n', {
      mode: 0o600,
    });
    const result = await withProductStack(() => analyze(["--json"]));
    expect(result.code).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("")).not.toContain("customer-private");
    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.failed",
    );
    expect(
      expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
    ).toMatchObject({
      surface: "analyze",
      errorKind: "validation-failed",
      reason: "legacy-input",
      completeness: "complete",
      loss: "none",
    });
    const trace = await expectActivityLogScenario("runtime-packages.rejection", {
      stateDir: controlStateDir,
      startedAtMs,
      expectedOps: ["support.report.started", "support.report.failed"],
    });
    expect(trace.failureClasses).toContain("support-report");
  });

  it("emits only a body-free failure for amplified timelines in the built CLI under a 128 MiB heap", async () => {
    await exportReport();
    const report = parseSupportReport(readSupportReportFile(path));
    const hostile = resealSupportReportWithParentFanOut(report);
    writeFileSync(path, serializeSupportReport(hostile), { mode: 0o600 });
    const result = analyzeBuiltCli();
    expect(result.code).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("\n")).toContain("report-budget-exceeded");
    const raw = readPersistedActivityLog(controlStateDir);
    const [line] = persistedActivityLogLines(raw, "support.report.failed");
    expect(
      expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
    ).toMatchObject({
      errorKind: "validation-failed",
      completeness: "complete",
      loss: "none",
    });
    expect(persistedActivityLogLines(raw, "support.report.completed")).toEqual([]);
  });

  it("uses the closed default filename and owner-private output directory", async () => {
    const result = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION],
        result.io,
        {},
        { cwd: root },
      ),
    ).toBe(0);
    const directory = join(stateDir, "support-reports");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual([
      expect.stringMatching(/^keiko-support-v1-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}\.json$/u),
    ]);
  });

  it("never overwrites a destination or creates a sidecar", () => {
    writeFileSync(path, "existing-work", { mode: 0o600 });
    expect(() => {
      publishSupportReportFile(path, "new-report");
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe("existing-work");
    expect(existsSync(`${path}.sha256`)).toBe(false);
  });

  it.each(["live-symlink", "dangling-symlink", "hard-link"])(
    "refuses an unsafe %s output without changing a victim",
    (kind) => {
      const victim = join(root, "victim");
      writeFileSync(victim, "customer-private", { mode: 0o600 });
      if (kind === "hard-link") linkSync(victim, path);
      else symlinkSync(kind === "live-symlink" ? victim : join(root, "missing"), path);
      expect(() => {
        publishSupportReportFile(path, "report");
      }).toThrow();
      expect(readFileSync(victim, "utf8")).toBe("customer-private");
    },
  );

  it.each(["symlink", "hard-link", "public-permissions"])(
    "refuses a %s input before reading it",
    (kind) => {
      const victim = join(root, "victim");
      writeFileSync(victim, "customer-private", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(victim, path);
      else if (kind === "hard-link") linkSync(victim, path);
      else {
        writeFileSync(path, "customer-private");
        chmodSync(path, 0o644);
      }
      expect(() => readSupportReportFile(path)).toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "explains how to analyze a public-permission browser download without changing it",
    async () => {
      await exportReport();
      const original = readSupportReportFile(path);
      path = join(root, "download.json.gz");
      const bytes = gzipSync(original);
      writeFileSync(path, bytes, { mode: 0o644 });
      chmodSync(path, 0o644);
      const result = await analyze(["--json"]);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe(
        "keiko support: permission-unsafe\n" +
          "Analyze a copy owned by your account in a private directory. On macOS/Linux, " +
          "use chmod 700 on that directory and chmod 600 on the copied report, then retry.\n",
      );
      expect(readFileSync(path)).toEqual(bytes);
      expect(statSync(path).mode & 0o777).toBe(0o644);
      expectFailureEvidence(controlStateDir, "analyze", "unsafe-target");
    },
  );

  it("ignores private environment values, raw UI output and arbitrary files structurally", async () => {
    writeFileSync(join(stateDir, "ui.log"), "raw-customer-ui");
    writeFileSync(join(stateDir, "document.txt"), "private-document");
    const result = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", root],
        result.io,
        { KEIKO_AZURE_APIKEY: "private-credential" },
        { cwd: root },
      ),
    ).toBe(0);
    const filename = readdirSync(root).find((name) => name.startsWith("keiko-support-v1-"));
    if (filename === undefined) throw new TypeError("missing canonical report");
    const report = JSON.stringify(
      analyzeSupportReport(readSupportReportFile(join(root, filename))),
    );
    for (const marker of ["raw-customer-ui", "private-document", "private-credential", root])
      expect(report).not.toContain(marker);
  });

  // Relocated from the retired store-fingerprint collector's pins (#3239): export reads only the
  // Activity Log and never opens a store. A corrupt store file therefore stays byte-for-byte as
  // found (no quarantine, repair or WAL sidecar), no vault key is minted, no missing store is
  // created, and no store bytes reach the report.
  it("never opens, repairs, creates or keys a store while exporting", async () => {
    const corrupt = "store-body-marker: not a sqlite header";
    const stores = [
      { directory: defaultUiDataDir(stateDir), file: UI_DB_FILENAME },
      { directory: join(stateDir, MEMORY_DIR_NAME), file: MEMORY_DB_FILENAME },
    ];
    for (const { directory, file } of stores) {
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, file), corrupt);
    }
    const before = new Set(readdirSync(stateDir));
    await exportReport();
    for (const { directory, file } of stores) {
      expect(readdirSync(directory)).toEqual([file]);
      expect(readFileSync(join(directory, file), "utf8")).toBe(corrupt);
    }
    // The only state export adds is the Activity Log's own; no store directory appears.
    const activityLogState = new Set([
      ACTIVITY_LOG_MANIFEST_DIRECTORY_NAME,
      SUPPORT_INCIDENT_DIRECTORY_NAME,
    ]);
    const created = readdirSync(stateDir).filter(
      (name) => !before.has(name) && !activityLogState.has(name),
    );
    expect(created).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain("store-body-marker");
  });

  it("refuses every inclusion option before any output or diagnostic artifact", async () => {
    for (const flag of [
      "--include-evidence",
      "--include-ui-log",
      "--i-understand-this-is-unredacted",
    ]) {
      const result = capture();
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", path, flag, "private"],
          result.io,
        ),
      ).toBe(2);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("fails closed when the Activity Log destination is unavailable", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs"), "not-a-directory");
    const result = capture();
    const out = join(root, "out");
    expect(await runSupportCli(["export", "--state-dir", stateDir, "--out", out], result.io)).toBe(
      1,
    );
    expect(existsSync(out)).toBe(false);
    expect(result.errors.join("")).toMatch(/^keiko support export: Activity Log unavailable \(/u);
    expect(result.errors.join("")).not.toContain(stateDir);
  });

  it.each(["", "reports", "nested/report"])(
    "refuses the Activity Log directory or descendant %s as a destination",
    async (tail) => {
      const result = capture();
      const forbidden = join(stateDir, "logs", tail);
      const before = readdirSync(join(stateDir, "logs"));
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", forbidden],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
      ).toBe(1);
      expect(readdirSync(join(stateDir, "logs"))).toEqual(before);
      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(controlStateDir),
        "support.report.failed",
      );
      expect(
        expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
      ).toMatchObject({
        surface: "export",
        errorKind: "unsafe-target",
      });
      expect(result.errors.join("")).not.toContain(forbidden);
    },
  );

  it("refuses aliases and missing descendants of the Activity Log directory", async () => {
    const alias = join(root, "log-alias");
    symlinkSync(join(stateDir, "logs"), alias, "dir");
    const before = readdirSync(join(stateDir, "logs"));
    for (const target of [alias, join(alias, "nested", "report")]) {
      const result = capture();
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", target],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
      ).toBe(1);
      expect(readdirSync(join(stateDir, "logs"))).toEqual(before);
      expect(existsSync(join(alias, "nested"))).toBe(false);
    }
  });

  it.each(["equal", "parent", "child"])(
    "keeps overlapping control state %s out of a refused target",
    async (relation) => {
      const control =
        relation === "equal"
          ? stateDir
          : relation === "parent"
            ? root
            : join(stateDir, "nested-control");
      const result = capture();
      const forbidden = join(stateDir, "logs");
      const before = readdirSync(forbidden);
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", forbidden],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: control },
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(readdirSync(forbidden)).toEqual(before);
      expect(existsSync(join(stateDir, "nested-control"))).toBe(false);
      expect(existsSync(join(root, "logs"))).toBe(false);
    },
  );

  it("fails closed without report output when rejection evidence cannot be persisted", async () => {
    writeFileSync(controlStateDir, "not-a-directory");
    const result = capture();
    const forbidden = join(stateDir, "logs");
    const before = readdirSync(forbidden);
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", forbidden],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("")).toBe("keiko support: unsafe-target\n");
    expect(readdirSync(forbidden)).toEqual(before);
  });

  it.each([
    [new SafeArtifactFileError("support-report", "target-exists"), "target-exists"],
    [new SafeArtifactFileError("support-report", "unsafe-target"), "unsafe-target"],
    [new SafeArtifactFileError("support-report", "open-failed"), "open-failed"],
    [new SafeArtifactFileError("support-report", "read-failed"), "read-failed"],
    [new SupportReportError("corrupt-report"), "validation-failed"],
    [new SupportReportError("unsupported-report", "9.0.0"), "validation-failed"],
    [new SupportReportError("selection-unavailable"), "invalid-request"],
    [new SupportReportError("seed-unavailable"), "unavailable"],
    [new Error("private message"), "internal"],
  ])("classifies report failures without exposing content (%s)", (error, errorKind) => {
    const events: unknown[] = [];
    emitSupportReportFailed(
      {
        write: (event): void => {
          events.push(event);
        },
      },
      CORRELATION,
      "analyze",
      error,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "support.report.failed", errorKind });
    expect((events[0] as { extra?: Record<string, unknown> }).extra?.reason).toBe(
      error instanceof SupportReportError ? error.reason : undefined,
    );
    expect(JSON.stringify(events)).not.toContain("private message");
  });

  it("reports missing requested correlation without emitting a machine view", async () => {
    await exportReport();
    for (const extra of [[], ["--seed"]]) {
      const result = await analyze(["--json", "--correlation-id", "missing-correlation", ...extra]);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe("keiko support: selection-unavailable\n");
    }
    const failed = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.failed",
    ).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(failed).toHaveLength(2);
    for (const line of failed)
      expect(line).toMatchObject({ errorKind: "invalid-request", reason: "selection-unavailable" });
  });

  it("names an unknown incident or fingerprint selection instead of calling it unsafe", async () => {
    for (const selector of [
      ["--incident", "0".repeat(32)],
      ["--defect-fingerprint", "0".repeat(64)],
    ]) {
      const result = capture();
      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, ...selector, "--out", join(root, "out")],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      );
      expect(code).toBe(1);
      expect(result.errors.join("")).toContain("selection-unavailable");
      expect(readdirSync(join(root, "out"))).toEqual([]);
    }
    expect(existsSync(join(stateDir, "support-incidents"))).toBe(false);
  });
  it("prepares deterministic replay and failure localization solely from a complete report", async () => {
    seedGatewayFailure();
    await exportReport();
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    expect(artifact.selection.status).toBe("complete");
    expect(artifact.seed?.gatewayScript?.attempts).toMatchObject([{ outcome: "timeout" }]);
    expect(artifact.seed?.stackFrames).toContain(
      "packages/keiko-model-gateway/src/gateway.ts:1209:3",
    );
    const result = await analyze(["--seed", "--json", "--emit-fixture", "replay.ts"]);
    expect(result.code, result.errors.join("")).toBe(0);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      seed: artifact.seed,
      fixtureWritten: true,
    });
    // The seed binds to the exact artifact bytes and to the records the analysis supported.
    expect(artifact.seed?.sourceArtifact).toEqual({
      kind: "support-report",
      lineCount: artifact.analysis.evidence.supportedLineCount,
      sha256: sha256Of(readFileSync(path)),
    });
    expect(readFileSync(join(root, "replay.ts"), "utf8")).toContain('"status": 504');
    expect(statSync(join(root, "replay.ts")).mode & 0o777).toBe(0o600);
  });

  it.each(["existing", "symlink", "dangling-symlink", "hard-link"])(
    "settles replay publication failure for a %s destination without success evidence",
    async (kind) => {
      seedGatewayFailure();
      await exportReport();
      const target = join(root, "replay.ts");
      const victim = join(root, "victim.ts");
      plantFixtureTarget(kind, target, victim);
      const result = await analyze(["--seed", "--json", "--emit-fixture", target]);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toContain("keiko support: target-exists\n");
      // Nothing is written through a link: a victim keeps its bytes, a dangling target is never created.
      if (kind === "dangling-symlink") expect(existsSync(victim)).toBe(false);
      else expect(readFileSync(victim, "utf8")).toBe("existing-private-work");
      const log = readPersistedActivityLog(controlStateDir);
      expect(persistedActivityLogLines(log, "support.report.completed")).toEqual([]);
      const failed = persistedActivityLogLines(log, "support.report.failed");
      expect(failed).toHaveLength(1);
      expect(JSON.parse(failed[0] ?? "{}")).toMatchObject({ errorKind: "target-exists" });
      expect(failed[0]).not.toContain('"reason"');
    },
  );

  it("provides thin human cluster, timeline and seed views after validation", async () => {
    seedGatewayFailure();
    await exportReport();
    const { artifact, seed } = analyzedReport();
    const selected = artifact.incident.correlation.rootCorrelationId;
    if (selected === undefined) throw new TypeError("missing report root");
    const timeline = findTimeline(artifact.analysis, selected);
    if (timeline === undefined) throw new TypeError("missing fixture timeline");
    const header = `Support incident ${artifact.incident.incidentId}\nDiagnostic sufficiency: complete\nAuthenticity: unknown\n`;
    // Each argument set selects its own view, and every view is the production renderer's text.
    const views: readonly (readonly [readonly string[], string])[] = [
      [[], header + renderHumanAllTimelines(artifact.analysis)],
      [["--correlation-id", selected], header + renderHumanTimeline(timeline)],
      [["--clusters"], header + renderHumanClusters(artifact.analysis.clusters)],
      [["--seed"], renderHumanReproductionSeed(seed)],
    ];
    for (const [args, expected] of views) {
      const result = await analyze(args);
      const text = result.output.join("");
      expect(result.code, result.errors.join("")).toBe(0);
      expect(text, args.join(" ")).toBe(expected);
      // Human text, never a JSON document.
      expect(() => {
        JSON.parse(text);
      }, args.join(" ")).toThrow(SyntaxError);
    }
    expect(new Set(views.map(([, expected]) => expected)).size).toBe(views.length);
  });
  it("streams a large validated machine projection in bounded chunks", async () => {
    const process = fixtureProcess(5353, "aabbccdd");
    const now = Date.now();
    writeFixtureSegment(
      stateDir,
      segmentIdentity(process, now, 1),
      Array.from({ length: 2000 }, (_, index) =>
        fixtureLine(process, now + index, { op: "client.diagnostic", correlationId: CORRELATION }),
      ),
    );
    await exportReport();
    const result = await analyze(["--json"]);
    expect(result.code).toBe(0);
    expect(result.output.length).toBeGreaterThan(1);
    expect(result.output.every((chunk) => Buffer.byteLength(chunk) <= 32 * 1024 + 1)).toBe(true);
    expect(JSON.parse(result.output.join(""))).toEqual(
      analyzeSupportReport(readSupportReportFile(path)),
    );
  });
  it("uses the closed filename even for an explicitly selected private directory", async () => {
    const directory = join(root, "customer-secret-workspace-host");
    mkdirSync(directory, { mode: 0o700 });
    await exportReport(directory);
    expect(readdirSync(directory)).toEqual([
      expect.stringMatching(/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u),
    ]);
    expect(JSON.stringify(analyzeSupportReport(readSupportReportFile(path)))).not.toContain(
      "customer-secret-workspace-host",
    );
  });
  it.each([
    [["export", "--outt", "dir"], "unknown argument: --outt"],
    [["export", "--out=dir"], "unknown argument: --out=dir"],
    [["export", "stray"], "unknown argument: stray"],
    [["export", "--include-ui-log=true"], "inclusion flags are no longer supported"],
    [["export", "--include-config"], "inclusion flags are no longer supported"],
    [["export", "--out", ""], "--out is missing its value"],
    [["export", "--out", "keiko-support.jsonl"], "--out selects a directory"],
    [["analyze", "report.json", "--jsn"], "unknown argument: --jsn"],
    [["analyze", "report.json", "--emit-fixture", ""], "--emit-fixture is missing its value"],
  ])("refuses %j as a usage error before any side effect", async (args, message) => {
    const result = capture();
    const before = readdirSync(root).sort();
    expect(
      await runSupportCli(
        args,
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(2);
    expect(result.errors.join("")).toContain(message);
    expect(result.output).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("names the minimum analyzer only when a report needs a newer one", async () => {
    await exportReport();
    const report = parseSupportReport(readSupportReportFile(path));
    const newer = resealSupportReport(report, report.incident, "9.0.0");
    writeFileSync(path, serializeSupportReport(newer), { mode: 0o600 });
    const refused = await analyze(["--json"]);
    expect(refused.code).toBe(1);
    expect(refused.errors.join("")).toBe(
      "keiko support: unsupported-report\nMinimum analyzer version: 9.0.0\n",
    );
    const unknownRegistry = resealSupportReport(report, {
      ...report.incident,
      build: { ...report.incident.build, catalogDigest: "f".repeat(64) },
    });
    writeFileSync(path, serializeSupportReport(unknownRegistry), { mode: 0o600 });
    const unknown = await analyze(["--json"]);
    expect(unknown.errors.join("")).toBe("keiko support: unsupported-report\n");
  });

  it("refuses a raw Activity Log as legacy input with the regeneration hint", async () => {
    const line = fixtureLine(fixtureProcess(4242, "aabbccdd"), Date.now(), {
      op: "client.diagnostic",
      correlationId: CORRELATION,
    });
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    const result = await analyze(["--json"]);
    expect(result.code).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("")).toContain("keiko support: legacy-input\n");
    expect(result.errors.join("")).toContain(
      "Regenerate the report on its originating installation",
    );
  });

  it("emits one validated timeline for --correlation-id in the form investigate reads", async () => {
    seedGatewayFailure();
    await exportReport();
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    const selected = artifact.incident.correlation.rootCorrelationId;
    if (selected === undefined) throw new TypeError("missing report root");
    const result = await analyze(["--json", "--correlation-id", selected]);
    expect(result.code, result.errors.join("")).toBe(0);
    const timeline = JSON.parse(result.output.join("")) as Record<string, unknown>;
    expect(timeline).toMatchObject({
      kind: "keiko.support.report-timeline",
      schemaVersion: 1,
      authenticity: "unknown",
      reportDigest: artifact.reportDigest,
      analyzerVersion: KEIKO_PRODUCT_VERSION,
      sourceArtifactDigest: sha256Of(readFileSync(path)),
      correlationId: selected,
    });
    expect(timeline.errorKinds).toContain("timeout");
    expect(Array.isArray(timeline.lines)).toBe(true);
    expect(timeline).not.toHaveProperty("analysis");
  });

  // A window segment that is not a private regular file is never read: it is named unreadable, the
  // report is honestly insufficient, and the export still completes without touching the victim.
  it.each(UNSAFE_SEGMENT_ENTRIES)(
    "publishes an honest insufficient report when a window segment is a %s entry",
    async (kind) => {
      const correlationId = "window-segment-0001";
      const process = fixtureProcess(6161, "c0ffee00");
      const segment = writeFixtureSegment(stateDir, segmentIdentity(process, Date.now(), 1), [
        fixtureLine(process, Date.now(), { op: "client.diagnostic", correlationId }),
      ]);
      const first = capture();
      const out = join(root, "first");
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--correlation-id", correlationId, "--out", out],
          first.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
      ).toBe(0);
      const [name] = readdirSync(out);
      const incidentId = parseSupportReport(readSupportReportFile(join(out, name ?? ""))).incident
        .incidentId;
      const victim = join(root, "victim.jsonl");
      writeFileSync(victim, "customer-private-segment\n", { mode: 0o600 });
      plantUnsafeSegment(kind, segment, victim);
      const result = capture();
      const next = join(root, "unsafe");
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--incident", incidentId, "--out", next],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
        result.errors.join(""),
      ).toBe(0);
      const text = readSupportReportFile(join(next, readdirSync(next)[0] ?? ""));
      expect(text).not.toContain("customer-private-segment");
      const report = parseSupportReport(text);
      expect(report.selection.status).toBe("insufficient");
      expect(report.selection.reasons).toContain("segment-unreadable");
      expect(result.output.join("")).toContain("Diagnostic sufficiency: insufficient (");
      // The victim behind the entry was never read, written or re-moded, and no link target was made.
      expect(readFileSync(victim, "utf8")).toBe("customer-private-segment\n");
      expect(statSync(victim).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, "missing-victim"))).toBe(false);
    },
  );

  it("publishes an honest insufficient report when the legacy current log is a directory", async () => {
    mkdirSync(join(stateDir, "logs", ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME), { mode: 0o700 });
    const out = join(root, "legacy");
    const result = await runExport(out);
    expect(result.code, result.errors.join("")).toBe(0);
    const report = parseSupportReport(readSupportReportFile(join(out, readdirSync(out)[0] ?? "")));
    expect(report.selection.status).toBe("insufficient");
    expect(report.selection.reasons).toContain("segment-unreadable");
  });

  it("keeps the failure evidence above a raised log threshold and settles a refused destination", async () => {
    writeFileSync(path, '{"$section":"manifest"}\n', { mode: 0o600 });
    const result = capture();
    expect(
      await runSupportCli(
        ["analyze", path, "--json"],
        result.io,
        { KEIKO_LOG_LEVEL: "error" },
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(1);
    const failed = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.failed",
    );
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0] ?? "{}")).toMatchObject({ level: "error", reason: "legacy-input" });
    const refused = capture();
    const refusalControl = join(root, "control-refusal");
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", join(stateDir, "logs", "reports")],
        refused.io,
        {},
        { cwd: root, controlActivityStateDir: refusalControl },
      ),
    ).toBe(1);
    // A refused destination still leaves one complete started/failed lifecycle.
    const log = readPersistedActivityLog(refusalControl);
    const [started] = persistedActivityLogLines(log, "support.report.started").slice(-1);
    const [refusal] = persistedActivityLogLines(log, "support.report.failed").slice(-1);
    const correlationOf = (line: string | undefined): unknown =>
      (JSON.parse(line ?? "{}") as { readonly correlationId?: unknown }).correlationId;
    expect(correlationOf(started)).toBe(correlationOf(refusal));
    const reportClass = analyzeLogText(log).sufficiency.classes.find(
      (entry) => entry.failureClass === "support-report",
    );
    expect(reportClass?.status).toBe("complete");
  });

  it("evidences a successful analysis and names the written fixture for a human", async () => {
    seedGatewayFailure();
    await exportReport();
    const human = await analyze(["--seed", "--emit-fixture", "replay-human.ts"]);
    expect(human.code, human.errors.join("")).toBe(0);
    // The human seed and then the confirmation line, nothing else.
    expect(human.output.join("")).toBe(
      `${renderHumanReproductionSeed(analyzedReport().seed)}Wrote replay fixture: ${join(root, "replay-human.ts")}\n`,
    );
    const log = readPersistedActivityLog(controlStateDir);
    const [completed] = persistedActivityLogLines(log, "support.report.completed");
    const record = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      completed ?? "",
    );
    expect(record).toMatchObject({
      surface: "analyze",
      sufficiency: "complete",
      sufficiencyReasons: [],
    });
    // Only an export publishes a file, so only its completion states how it was published.
    for (const field of ["publication", "permissionAssurance", "durabilityAssurance"])
      expect(record).not.toHaveProperty(field);
  });

  it("names a missing replay preparation as seed-unavailable", async () => {
    await exportReport();
    const result = await analyze(["--seed", "--emit-fixture", "replay.ts"]);
    expect(result.code).toBe(1);
    expect(result.errors.join("")).toBe("keiko support: seed-unavailable\n");
    expect(existsSync(join(root, "replay.ts"))).toBe(false);
  });

  it("reports budget insufficiency with its reasons and warns about interrupted stages", async () => {
    await exportReport(join(root, "full"));
    const full = readSupportReportFile(path);
    const directory = join(root, "budget");
    mkdirSync(directory, { mode: 0o700 });
    const stage = `.keiko-publish-${"deadbeef".repeat(3)}-0.stage`;
    writeFileSync(join(directory, stage), "stale", { mode: 0o600 });
    const result = capture();
    expect(
      await runSupportCli(
        [
          "export",
          "--state-dir",
          stateDir,
          "--correlation-id",
          CORRELATION,
          "--max-bytes",
          String(Buffer.byteLength(full) - 1),
          "--out",
          directory,
        ],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(0);
    expect(result.output.join("")).toMatch(/report-budget-exceeded.*bytes required\)/u);
    expect(result.errors.join("")).toContain("1 private .keiko-publish-*.stage file(s)");
  });

  it("exports an existing incident selected by its defect fingerprint", async () => {
    await exportReport(join(root, "first"));
    const fingerprint = parseSupportReport(readSupportReportFile(path)).incident.defectFingerprint;
    const result = capture();
    const out = join(root, "by-fingerprint");
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--defect-fingerprint", fingerprint, "--out", out],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
      result.errors.join(""),
    ).toBe(0);
    expect(readdirSync(out)).toHaveLength(1);
  });

  it("refuses a firmlinked alias of the Activity Log directory (macOS)", async (ctx) => {
    if (process.platform !== "darwin") ctx.skip();
    const alias = join("/System/Volumes/Data", realpathSync(join(stateDir, "logs")));
    if (!existsSync(alias)) ctx.skip();
    const result = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", join(alias, "reports")],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(1);
    expect(result.errors.join("")).toBe("keiko support: unsafe-target\n");
    expect(existsSync(join(stateDir, "logs", "reports"))).toBe(false);
  });

  // ─── State directory resolution ──────────────────────────────────────────────────────────────
  it("resolves the state directory from KEIKO_STATE_DIR when --state-dir is absent", async () => {
    const out = join(root, "from-env");
    const result = capture();
    const code = await runSupportCli(
      ["export", "--correlation-id", CORRELATION, "--out", out],
      result.io,
      { KEIKO_STATE_DIR: stateDir },
      { cwd: root, controlActivityStateDir: controlStateDir },
    );
    expect(code, result.errors.join("")).toBe(0);
    const exported = analyzeSupportReport(
      readSupportReportFile(join(out, readdirSync(out)[0] ?? "")),
    );
    expect(exported.analysis.timelines.map((timeline) => timeline.correlationId)).toContain(
      exported.incident.correlation.rootCorrelationId,
    );
    // The default location was never consulted, let alone created.
    expect(existsSync(join(root, ".keiko"))).toBe(false);
  });

  it("lets --state-dir win over KEIKO_STATE_DIR", async () => {
    const out = join(root, "flag-wins");
    const wrongState = join(root, "wrong-state");
    const result = capture();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", out],
      result.io,
      { KEIKO_STATE_DIR: wrongState },
      { cwd: root, controlActivityStateDir: controlStateDir },
    );
    expect(code, result.errors.join("")).toBe(0);
    expect(readdirSync(out)).toHaveLength(1);
    expect(existsSync(wrongState)).toBe(false);
  });

  it("uses <cwd>/.keiko when neither --state-dir nor KEIKO_STATE_DIR names a state directory", async () => {
    const workdir = join(root, "work");
    const process = fixtureProcess(4343, "bbccddee");
    const now = Date.now();
    writeFixtureSegment(join(workdir, ".keiko"), segmentIdentity(process, now, 1), [
      fixtureLine(process, now, { op: "client.diagnostic", correlationId: "default-state-0001" }),
    ]);
    const out = join(root, "from-default");
    const result = capture();
    const code = await runSupportCli(
      ["export", "--correlation-id", "default-state-0001", "--out", out],
      result.io,
      {},
      { cwd: workdir, controlActivityStateDir: controlStateDir },
    );
    expect(code, result.errors.join("")).toBe(0);
    const exported = analyzeSupportReport(
      readSupportReportFile(join(out, readdirSync(out)[0] ?? "")),
    );
    expect(exported.analysis.timelines.map((timeline) => timeline.correlationId)).toContain(
      exported.incident.correlation.rootCorrelationId,
    );
    // The seeded state directory next to it was not consulted: it holds nothing of this export.
    expect(readdirSync(stateDir)).toEqual(["logs"]);
  });

  // ─── Export publication failures ─────────────────────────────────────────────────────────────
  it("refuses to export the same incident twice into one directory and keeps the first report", async () => {
    const out = join(root, "twice");
    await exportReport(out);
    const first = readFileSync(path);
    const second = await runExport(out);
    expect(second.code).toBe(1);
    expect(second.output).toEqual([]);
    expect(second.errors.join("")).toBe("keiko support: target-exists\n");
    expect(readdirSync(out)).toEqual([basename(path)]);
    expect(readFileSync(path).equals(first)).toBe(true);
    expectFailureEvidence(stateDir, "export", "target-exists", 1);
  });

  it.each(["live-symlink", "dangling-symlink", "hard-link"])(
    "refuses a %s at the fixed report filename without touching what it names",
    async (kind) => {
      // The report filename is closed over the incident, so a first export tells where to plant.
      await exportReport(join(root, "learn"));
      const out = join(root, "planted");
      mkdirSync(out, { mode: 0o700 });
      const target = join(out, basename(path));
      const victim = join(root, "victim");
      writeFileSync(victim, "customer-private", { mode: 0o600 });
      if (kind === "hard-link") linkSync(victim, target);
      else symlinkSync(kind === "live-symlink" ? victim : join(root, "missing-victim"), target);
      const result = await runExport(out);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe("keiko support: target-exists\n");
      // The link is all the directory holds: no report, sidecar or stage was made beside it.
      expect(readdirSync(out)).toEqual([basename(path)]);
      expect(lstatSync(target).isSymbolicLink()).toBe(kind !== "hard-link");
      expect(readFileSync(victim, "utf8")).toBe("customer-private");
      expect(existsSync(join(root, "missing-victim"))).toBe(false);
      expectFailureEvidence(stateDir, "export", "target-exists", 1);
    },
  );

  it.each([
    ["an existing regular file", "plain-file"],
    ["a path below a regular file", join("plain-file", "reports")],
  ])(
    "reports a closed failure when --out names %s, never the raw filesystem error",
    async (_label, out) => {
      writeFileSync(join(root, "plain-file"), "not-a-directory", { mode: 0o600 });
      const result = await runExport(join(root, out));
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe("keiko support: unsafe-target\n");
      expect(readFileSync(join(root, "plain-file"), "utf8")).toBe("not-a-directory");
      expectFailureEvidence(stateDir, "export", "unsafe-target");
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a closed permission failure when the parent of --out is read-only",
    async () => {
      const parent = join(root, "read-only-parent");
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o500);
      try {
        const result = await runExport(join(parent, "reports"));
        expect(result.code).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("")).toBe("keiko support: permission-denied\n");
      } finally {
        chmodSync(parent, 0o700);
      }
      expect(readdirSync(parent)).toEqual([]);
      expectFailureEvidence(stateDir, "export", "permission-denied");
    },
  );

  // ─── Analyze input handling ──────────────────────────────────────────────────────────────────
  it("resolves a relative FILE against the launch directory, never the process directory", async () => {
    await exportReport();
    const absolute = await analyze(["--json"]);
    expect(absolute.code, absolute.errors.join("")).toBe(0);
    for (const [cwd, file] of [
      [root, basename(path)],
      [stateDir, join("..", basename(path))],
    ] as const) {
      const result = capture();
      const code = await runSupportCli(
        ["analyze", file, "--json"],
        result.io,
        {},
        { cwd, controlActivityStateDir: controlStateDir },
      );
      expect(code, `${file}: ${result.errors.join("")}`).toBe(0);
      expect(result.output.join(""), file).toBe(absolute.output.join(""));
    }
  });

  it.each([
    ["a missing file", "missing-report.json", "open-failed"],
    ["a directory", "a-directory", "unsafe-target"],
  ])(
    "settles %s as one closed failure without its path or the raw system error",
    async (_label, name, errorKind) => {
      mkdirSync(join(root, "a-directory"), { mode: 0o700 });
      const result = capture();
      const code = await runSupportCli(
        ["analyze", join(root, name)],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      );
      expect(code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe(`keiko support: ${errorKind}\n`);
      expectFailureEvidence(controlStateDir, "analyze", errorKind);
    },
  );

  // ─── Identity and digest in the machine view ─────────────────────────────────────────────────
  it("states the analyzer's own version and the producing build's registry identity", async () => {
    await exportReport();
    const analyzed = await analyze(["--json"]);
    expect(analyzed.code, analyzed.errors.join("")).toBe(0);
    expect(JSON.parse(analyzed.output.join("")) as Record<string, unknown>).toMatchObject({
      analyzerVersion: KEIKO_PRODUCT_VERSION,
      incident: {
        build: {
          productVersion: KEIKO_PRODUCT_VERSION,
          registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
          schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
          catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
        },
      },
    });
  });

  // The digest every artifact binds to is a plain SHA-256 of the text: the FIPS 180 vectors.
  it.each([
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("digests %j as the NIST SHA-256 vector", (text, digest) => {
    expect(supportReportDigest(text)).toBe(digest);
  });

  // ─── Replay fixture emission ─────────────────────────────────────────────────────────────────
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names the closed failure, not the directory, when the fixture location is not writable",
    async () => {
      seedGatewayFailure();
      await exportReport();
      const directory = join(root, "read-only-fixtures");
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o500);
      try {
        const result = await analyze([
          "--seed",
          "--json",
          "--emit-fixture",
          join(directory, "r.ts"),
        ]);
        expect(result.code).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("")).toBe(
          "keiko support analyze: could not write fixture: open-failed\nkeiko support: open-failed\n",
        );
      } finally {
        chmodSync(directory, 0o700);
      }
      expect(readdirSync(directory)).toEqual([]);
      expectFailureEvidence(controlStateDir, "analyze", "open-failed");
    },
  );

  it("writes a replay fixture without --seed, naming it for a human and flagging it in JSON", async () => {
    seedGatewayFailure();
    await exportReport();
    const { artifact, seed } = analyzedReport();
    const fixture = join(root, "replay-no-seed.ts");
    const human = await analyze(["--emit-fixture", "replay-no-seed.ts"]);
    expect(human.code, human.errors.join("")).toBe(0);
    expect(human.output.join("")).toBe(
      `${renderHumanReproductionSeed(seed)}Wrote replay fixture: ${fixture}\n`,
    );
    expect(readFileSync(fixture, "utf8")).toContain('"status": 504');
    const machine = await analyze(["--json", "--emit-fixture", "replay-no-seed.json.ts"]);
    expect(machine.code, machine.errors.join("")).toBe(0);
    // One JSON document: the analysis, its seed and the flag that a fixture was written.
    expect(JSON.parse(machine.output.join(""))).toEqual({
      ...artifact,
      seed,
      fixtureWritten: true,
    });
    expect(readFileSync(join(root, "replay-no-seed.json.ts"), "utf8")).toBe(
      readFileSync(fixture, "utf8"),
    );
  });
});
