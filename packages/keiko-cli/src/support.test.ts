import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  activityLogSegmentFileName,
  type ActivityLogSegmentState,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createInMemoryEvidenceStore,
  type EvidenceManifest,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  createNodeUiStore,
  SERVER_LOG_SCHEMA_VERSION,
  UI_DB_FILENAME,
} from "@oscharko-dev/keiko-server";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import type { AuditResult } from "./audit.js";
import type { CliIo } from "./runner.js";
import { analyzeLogText } from "./support-analyze.js";
import {
  parseSupportArgs,
  resolveOutPath,
  runSupportCli as runSupportCliImpl,
  supportPublicationErrorKind,
  supportPublicationContext,
  type SupportCliDeps,
} from "./support.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
} from "./install-layout.js";
const runSupportCli = runSupportCliImpl;

const BUILT_CLI_ENTRY = fileURLToPath(new URL("../../../dist/cli/index.js", import.meta.url));

function validV2AnalysisRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    ts: "2026-08-21T00:00:00.000Z",
    level: "info",
    category: "gateway",
    op: "gateway.instance.reused",
    generation: 1,
    completeness: "complete",
    loss: "none",
    schemaVersion: 2,
    registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
    schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
    catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
    buildClass: "node-esm",
    releaseClass: "stable",
    platformClass: "linux-x64",
    productVersion: "1.0.0",
    compatibilityState: "supported",
    writerCapability: "active",
    pid: 1,
    instanceId: "aaaaaaaa",
    seq: 1,
    ...overrides,
  };
}

function runBuiltSupportCli(
  cwd: string,
  stateDir: string,
  nodeArgs: readonly string[] = [],
): SpawnSyncReturns<string> {
  if (!existsSync(BUILT_CLI_ENTRY)) {
    throw new Error("Built CLI entry is missing; run npm run build:packages before this test");
  }
  return spawnSync(
    process.execPath,
    [...nodeArgs, BUILT_CLI_ENTRY, "support", "export", "--state-dir", stateDir],
    { cwd, encoding: "utf8", env: { ...process.env, KEIKO_HOME: dirname(stateDir) } },
  );
}

interface DirectoryMutationInvocation {
  readonly operation: "link" | "unlink";
  readonly sourcePath: string;
  readonly targetPath: string | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isDirectoryMutationOperation(value: unknown): value is "link" | "unlink" {
  return value === "link" || value === "unlink";
}

function directoryMutationInvocation(options: unknown): DirectoryMutationInvocation | undefined {
  if (!isRecord(options)) return undefined;
  const { input, cwd } = options;
  if (typeof input !== "string" || typeof cwd !== "string") return undefined;
  const request: unknown = JSON.parse(input);
  if (!isRecord(request)) return undefined;
  const { operation, source, target } = request;
  if (!isDirectoryMutationOperation(operation)) return undefined;
  if (typeof source !== "string") return undefined;
  if (operation === "link" && typeof target !== "string") return undefined;
  return {
    operation,
    sourcePath: join(cwd, source),
    targetPath: typeof target === "string" ? join(cwd, target) : undefined,
  };
}

function mutationProcessResult(
  status: number | null,
  signal: NodeJS.Signals | null = null,
): ReturnType<(typeof import("node:child_process"))["spawnSync"]> {
  return {
    pid: 0,
    output: [null, null, null],
    stdout: null,
    stderr: null,
    status,
    signal,
  } as unknown as ReturnType<(typeof import("node:child_process"))["spawnSync"]>;
}

async function crashDirectoryMutationAtLink(linkOrdinal: number): Promise<void> {
  const actualChild =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  let links = 0;
  vi.doMock("node:child_process", () => ({
    ...actualChild,
    spawnSync: (
      ...args: Parameters<typeof actualChild.spawnSync>
    ): ReturnType<typeof actualChild.spawnSync> => {
      const invocation = directoryMutationInvocation(args[2]);
      if (invocation === undefined) {
        return Reflect.apply(actualChild.spawnSync, actualChild, args);
      }
      if (invocation.operation === "link") {
        links += 1;
        if (links === linkOrdinal) return mutationProcessResult(null, "SIGKILL");
        if (invocation.targetPath === undefined) throw new Error("expected mutation target");
        actualFs.linkSync(invocation.sourcePath, invocation.targetPath);
      } else {
        actualFs.unlinkSync(invocation.sourcePath);
      }
      return mutationProcessResult(0);
    },
  }));
}

// The server's writer (and `keiko start` for ui.log) always creates these files owner-private, and
// the export reads them only through a descriptor verified to be exactly that shape.
function writePrivateFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

// Segment names come from the shared closed grammar (keiko-contracts `activity-log-files.ts`),
// never from a hand-written spelling that could drift from what the writer creates.
function segmentName(index: number, state: ActivityLogSegmentState = "sealed", pid = 4242): string {
  return activityLogSegmentFileName(
    { startMs: Date.parse("2026-08-21T10:00:00.000Z"), pid, instanceId: "a1b2c3d4", index },
    state,
  );
}

// The newest file of a live Activity Log: the writer's active segment.
const CURRENT_SEGMENT = segmentName(2, "active");

function makeIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const HEALTHY_AUDIT: AuditResult = {
  ok: true,
  stateDir: "/irrelevant/.keiko",
  classes: [{ id: "creds", title: "Credential references", status: "pass", findings: [] }],
};

const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

function healthyAuditDeps(): SupportCliDeps["auditDeps"] {
  return { loadAuditor: () => Promise.resolve({ auditLocalState: () => HEALTHY_AUDIT }) };
}

function minimalEvidenceManifest(runId: string): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "0.1.5",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 150,
      durationMs: 50,
    },
    model: { modelId: "m1", costClass: "low" },
    usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

function seededEvidenceStore(runIds: readonly string[]): EvidenceStore {
  const store = createInMemoryEvidenceStore();
  for (const runId of runIds) {
    store.put(runId, JSON.stringify(minimalEvidenceManifest(runId)));
  }
  return store;
}

describe("parseSupportArgs", () => {
  it("treats no args, --help, and -h as help", () => {
    expect(parseSupportArgs([])).toEqual({ kind: "help" });
    expect(parseSupportArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseSupportArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("rejects an unknown subcommand as usage", () => {
    const parsed = parseSupportArgs(["bogus"]);
    expect(parsed.kind).toBe("usage");
  });

  it("parses export flags, defaulting absent ones to undefined/false/empty", () => {
    expect(parseSupportArgs(["export"])).toEqual({
      kind: "export",
      value: {
        out: undefined,
        stateDir: undefined,
        maxBytes: undefined,
        includeEvidenceRunIds: [],
      },
    });
    expect(
      parseSupportArgs([
        "export",
        "--out",
        "/tmp/x.jsonl",
        "--state-dir",
        "/tmp/.keiko",
        "--max-bytes",
        "100",
        "--include-evidence",
        "run-a, run-b,,run-c",
      ]),
    ).toEqual({
      kind: "export",
      value: {
        out: "/tmp/x.jsonl",
        stateDir: "/tmp/.keiko",
        maxBytes: 100,
        includeEvidenceRunIds: ["run-a", "run-b", "run-c"],
      },
    });
  });

  // #3532: raw UI output can never be part of a report. The retired consent flags are refused
  // explicitly instead of being silently ignored, alone or together.
  it.each([
    [["--include-ui-log"]],
    [["--i-understand-this-is-unredacted"]],
    [["--include-ui-log", "--i-understand-this-is-unredacted"]],
  ])("refuses the retired ui.log flags %j as a usage error", (flags) => {
    const parsed = parseSupportArgs(["export", ...flags]);
    expect(parsed.kind).toBe("usage");
    expect(parsed.kind === "usage" && parsed.message).toContain(
      "--include-ui-log is no longer supported",
    );
  });

  it("rejects a --max-bytes that is not a positive integer", () => {
    expect(parseSupportArgs(["export", "--max-bytes", "0"]).kind).toBe("usage");
    expect(parseSupportArgs(["export", "--max-bytes", "abc"]).kind).toBe("usage");
    expect(parseSupportArgs(["export", "--max-bytes", "-5"]).kind).toBe("usage");
  });

  it("rejects a flag missing its value", () => {
    expect(parseSupportArgs(["export", "--out"]).kind).toBe("usage");
  });

  it("requires a FILE for analyze", () => {
    expect(parseSupportArgs(["analyze"]).kind).toBe("usage");
    expect(parseSupportArgs(["analyze", "--json"]).kind).toBe("usage");
  });

  it("parses analyze flags", () => {
    expect(
      parseSupportArgs(["analyze", "bundle.jsonl", "--correlation-id", "req-1", "--json"]),
    ).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: "req-1",
        json: true,
        clusters: false,
        seed: false,
        emitFixture: undefined,
      },
    });
    expect(parseSupportArgs(["analyze", "bundle.jsonl"])).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: undefined,
        json: false,
        clusters: false,
        seed: false,
        emitFixture: undefined,
      },
    });
  });

  // Wave 6 (epic #3233 closeout, gap #1): --clusters/--seed/--emit-fixture now parse.
  it("parses --clusters, --seed, and --emit-fixture", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--clusters"])).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: undefined,
        json: false,
        clusters: true,
        seed: false,
        emitFixture: undefined,
      },
    });
    expect(
      parseSupportArgs([
        "analyze",
        "bundle.jsonl",
        "--correlation-id",
        "req-1",
        "--seed",
        "--emit-fixture",
        "out.ts",
      ]),
    ).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: "req-1",
        json: false,
        clusters: false,
        seed: true,
        emitFixture: "out.ts",
      },
    });
  });

  it("rejects --seed without --correlation-id", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--seed"]).kind).toBe("usage");
  });

  it("rejects --emit-fixture without --correlation-id", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--emit-fixture", "out.ts"]).kind).toBe(
      "usage",
    );
  });

  it("rejects --emit-fixture missing its value", () => {
    expect(
      parseSupportArgs(["analyze", "bundle.jsonl", "--correlation-id", "req-1", "--emit-fixture"])
        .kind,
    ).toBe("usage");
  });
});

describe("runSupportCli export", () => {
  let stateDir: string;
  let outDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-cli-state-"));
    outDir = mkdtempSync(join(tmpdir(), "keiko-support-cli-out-"));
    mkdirSync(join(stateDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.doUnmock("@oscharko-dev/keiko-security/fs-hardening");
    vi.doUnmock("./audit.js");
    vi.resetModules();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("maps non-primitive publication failures to the closed unknown kind", () => {
    const error = Object.assign(new Error("private path /customer/report.jsonl"), { code: "EIO" });
    expect(supportPublicationErrorKind(error)).toBe("unknown");
  });

  // #3530: every name in the Activity Log directory belongs to the store's closed grammar and its
  // retention, so a report may be written nowhere in that directory: not over a legacy name, not
  // under a segment's spelling, and not under any other name either.
  it("rejects any destination inside the Activity Log directory", async () => {
    for (const name of [ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME, CURRENT_SEGMENT, "report.jsonl"]) {
      const outPath = join(stateDir, "logs", name);
      const c = makeIo();

      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        c.io,
        AUDIT_ENV,
        { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
      );

      expect(code).toBe(1);
      expect(c.err()).toContain("destination collides with the Activity Log");
      expect(existsSync(outPath)).toBe(false);
      expect(existsSync(`${outPath}.sha256`)).toBe(false);
    }
  });

  it("fails before publication when the required Activity Log directory is unavailable", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs"), "not-a-directory");
    const outPath = join(outDir, "unlogged-report.jsonl");
    const c = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("Activity Log unavailable: open-failed");
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.sha256`)).toBe(false);
  });

  it("writes a bundle whose first line is the manifest and whose remaining lines are the log content, verbatim", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-19T00:00:00.000Z",
      category: "http",
      op: "req.a",
      correlationId: "req-1",
    });
    const currentLine = JSON.stringify({
      ts: "2026-08-20T00:00:00.000Z",
      category: "http",
      op: "req.b",
      correlationId: "req-1",
    });
    writePrivateFile(join(stateDir, "logs", "server-2026-08-19.log"), `${rotatedLine}\n`);
    writePrivateFile(join(stateDir, "logs", "server.log"), `${currentLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, AUDIT_ENV, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: seededEvidenceStore(["run-a", "run-b"]),
    });

    expect(code).toBe(0);
    // manifest + config-snapshot (always attached, Wave 6) + the two raw content lines.
    expect(c.out()).toContain("Wrote 4 lines to");
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, "utf8");
    const [manifestLine, configSnapshotLine, ...logLines] = written.trimEnd().split("\n");
    expect(logLines).toEqual([rotatedLine, currentLine]);
    const configSnapshot = JSON.parse(configSnapshotLine ?? "{}") as Record<string, unknown>;
    expect(configSnapshot.$section).toBe("config-snapshot");
    const manifest: Record<string, unknown> = JSON.parse(manifestLine ?? "{}") as Record<
      string,
      unknown
    >;
    expect(manifest.$section).toBe("manifest");
    expect(manifest.schemaVersion).toBe(SERVER_LOG_SCHEMA_VERSION);
    expect(manifest.bundleFormatVersion).toBe(1);
    expect(manifest.stateDirSource).toBe("env-override");
    expect(manifest.redactionAttested).toBe(true);
    expect(manifest.sourceLogFiles).toEqual(["server-2026-08-19.log", "server.log"]);
    expect(manifest.truncatedLogFiles).toEqual([]);
    expect(manifest.skippedLogFiles).toEqual([]);
    // #3532: a legacy ui.log is never part of a report, so the manifest always names it excluded.
    expect(manifest.sectionsExcluded).toEqual(["ui-log"]);
    expect(manifest.evidenceIndexCount).toBe(2);
    // The manifest's auditSummary must carry the audit result MINUS the raw stateDir path (which
    // embeds the operator's OS username on a real machine): stateDirSource above already says
    // "default vs. override" without the absolute path.
    expect(manifest.auditSummary).toEqual({ ok: HEALTHY_AUDIT.ok, classes: HEALTHY_AUDIT.classes });
    expect(written).not.toContain(HEALTHY_AUDIT.stateDir);
  });

  it("publishes a fresh default report on two normal built-CLI runs", () => {
    const first = runBuiltSupportCli(outDir, stateDir);
    expect(first.status).toBe(0);
    const firstReports = readdirSync(outDir).filter((name) => name.endsWith(".jsonl"));
    expect(firstReports).toHaveLength(1);
    writePrivateFile(
      join(stateDir, "logs", ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME),
      `${JSON.stringify({ op: "between-built-runs", correlationId: "built-proof" })}\n`,
    );

    const second = runBuiltSupportCli(outDir, stateDir);
    expect(second.status).toBe(0);
    const secondReports = readdirSync(outDir).filter((name) => name.endsWith(".jsonl"));
    expect(secondReports).toHaveLength(2);
    expect(new Set(secondReports).size).toBe(2);
    expect(second.stdout).toContain("Wrote ");
    expect(readdirSync(outDir).filter((name) => name.endsWith(".consumed"))).toHaveLength(1);
  });

  it("recovers exact built-CLI bytes after death before acknowledgement", () => {
    const preload = join(outDir, "crash-before-ack.mjs");
    // Dies at the acknowledgement's first directory mutation (linking the `.complete` receipt to
    // `.consumed`): the publication is durable but unacknowledged, and nothing has claimed success.
    writeFileSync(
      preload,
      `
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const spawnSync = childProcess.spawnSync;
        childProcess.spawnSync = (command, args, options) => {
          if (String(options?.input ?? "").includes('.consumed"')) process.kill(process.pid, "SIGKILL");
          return spawnSync(command, args, options);
        };
        syncBuiltinESMExports();
      `,
    );
    const interrupted = runBuiltSupportCli(outDir, stateDir, ["--import", preload]);
    expect(interrupted.signal).toBe("SIGKILL");
    const [reportName] = readdirSync(outDir).filter((name) => name.endsWith(".jsonl"));
    expect(reportName).toBeDefined();
    if (reportName === undefined) throw new Error("expected interrupted report");
    const reportPath = join(outDir, reportName);
    const priorBytes = readFileSync(reportPath);
    expect(readdirSync(outDir).filter((name) => name.endsWith(".complete"))).toHaveLength(1);
    writePrivateFile(
      join(stateDir, "logs", ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME),
      `${JSON.stringify({ op: "after-built-crash", correlationId: "built-proof" })}\n`,
    );

    const resumed = runBuiltSupportCli(outDir, stateDir);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("Recovered support report at ");
    expect(readdirSync(outDir).filter((name) => name.endsWith(".jsonl"))).toEqual([reportName]);
    expect(readFileSync(reportPath).equals(priorBytes)).toBe(true);
    expect(readdirSync(outDir).filter((name) => name.endsWith(".consumed"))).toHaveLength(1);
  });

  it("refuses to replace a pre-existing support report or create its integrity sidecar", async () => {
    const outPath = join(outDir, "existing-report.jsonl");
    writeFileSync(outPath, "operator-owned\n", { mode: 0o640 });
    chmodSync(outPath, 0o640);
    const c = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(readFileSync(outPath, "utf8")).toBe("operator-owned\n");
    expect(existsSync(`${outPath}.sha256`)).toBe(false);
    expect(c.err()).toContain("could not write the bundle: target-exists");
    expect(c.err()).not.toContain(outPath);
    const failure = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.op === "support.export.publication");
    expect(failure).toMatchObject({
      errorKind: "target-exists",
      publicationArtifactClass: "support-report",
      publicationPersistenceStatus: "failed",
      publicationCompleteness: "unknown",
      publicationLoss: "publication-unavailable",
      failedArtifactClass: "support-report",
      failureKind: "target-exists",
    });
    expect(failure?.visibleArtifactCount).toBeUndefined();
    expect(String(failure?.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses unsafe report targets without changing their victim", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const victim = join(outDir, "victim.txt");
    writeFileSync(victim, "operator-owned\n", { mode: 0o640 });
    chmodSync(victim, 0o640);

    for (const kind of ["symlink", "hard-link", "fifo"] as const) {
      const outPath = join(outDir, `${kind}.jsonl`);
      if (kind === "symlink") symlinkSync(victim, outPath);
      else if (kind === "hard-link") linkSync(victim, outPath);
      else execFileSync("mkfifo", [outPath]);
      const c = makeIo();

      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        c.io,
        AUDIT_ENV,
        { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
      );

      expect(code).toBe(1);
      expect(readFileSync(victim, "utf8")).toBe("operator-owned\n");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
      expect(existsSync(`${outPath}.sha256`)).toBe(false);
      expect(c.err()).toContain("could not write the bundle: target-exists");
      expect(c.err()).not.toContain(outPath);
      rmSync(outPath);
    }
  });

  it("does not publish a report when the integrity destination already exists", async () => {
    const outPath = join(outDir, "sidecar-conflict.jsonl");
    const sidecarPath = `${outPath}.sha256`;
    writeFileSync(sidecarPath, "operator-integrity\n", { mode: 0o600 });
    const c = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(readFileSync(sidecarPath, "utf8")).toBe("operator-integrity\n");
    expect(c.err()).toContain("could not write the bundle: target-exists");
  });

  it("refuses hostile integrity destinations without touching their victim or report", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const victim = join(outDir, "integrity-victim");
    writeFileSync(victim, "operator-integrity\n", { mode: 0o640 });
    chmodSync(victim, 0o640);

    for (const kind of ["symlink", "hard-link", "fifo"] as const) {
      const outPath = join(outDir, `${kind}-sidecar.jsonl`);
      const sidecarPath = `${outPath}.sha256`;
      if (kind === "symlink") symlinkSync(victim, sidecarPath);
      else if (kind === "hard-link") linkSync(victim, sidecarPath);
      else execFileSync("mkfifo", [sidecarPath]);
      const c = makeIo();

      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", outPath],
          c.io,
          AUDIT_ENV,
          { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
        ),
      ).toBe(1);
      expect(existsSync(outPath)).toBe(false);
      expect(readFileSync(victim, "utf8")).toBe("operator-integrity\n");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
      expect(readdirSync(outDir).some((name) => name.endsWith(".intent"))).toBe(false);
      expect(c.err()).toContain("could not write the bundle: target-exists");
      rmSync(sidecarPath);
    }
  });

  it("recovers the durable prior report before reading a changed clock or activity log", async () => {
    const outPath = join(outDir, "recoverable-report.jsonl");
    const context = supportPublicationContext(outDir, outPath);
    vi.resetModules();
    await crashDirectoryMutationAtLink(2);
    const interrupted = await import("./support.js");
    const firstIo = makeIo();

    expect(
      await interrupted.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        firstIo.io,
        AUDIT_ENV,
        {
          cwd: outDir,
          now: () => new Date("2026-09-01T01:02:03.000Z"),
          auditDeps: healthyAuditDeps(),
          evidenceStore: createInMemoryEvidenceStore(),
        },
      ),
    ).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.sha256`)).toBe(true);
    expect(readdirSync(context.root).some((name) => name.includes(context.slot))).toBe(true);

    vi.doUnmock("node:child_process");
    vi.resetModules();
    writePrivateFile(
      join(stateDir, "logs", ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME),
      `${JSON.stringify({ op: "post-interruption-log", correlationId: "post-interruption" })}\n`,
    );
    const resumed = await import("./support.js");
    const secondIo = makeIo();
    expect(
      await resumed.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        secondIo.io,
        AUDIT_ENV,
        {
          cwd: outDir,
          now: () => {
            throw new Error("recovery must precede clock access");
          },
          auditDeps: healthyAuditDeps(),
          evidenceStore: createInMemoryEvidenceStore(),
        },
      ),
    ).toBe(0);

    const report = readFileSync(outPath, "utf8");
    expect(report).not.toContain("post-interruption-log");
    expect(secondIo.out()).toContain(`Recovered support report at ${outPath}`);
    expect(readdirSync(context.root).filter((name) => name.includes(context.slot))).toEqual([
      `.keiko-publish-${context.slot}.consumed`,
    ]);
    const expectedDigest = createHash("sha256").update(report).digest("hex");
    expect(readFileSync(`${outPath}.sha256`, "utf8").trim()).toBe(expectedDigest);
    const evidence = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.op === "support.export.publication")
      .at(-1);
    expect(evidence).toMatchObject({
      publicationPersistenceStatus: "recovered",
      publicationStatus: "recovered",
      recoveryState: "recovered",
      reportBytes: Buffer.byteLength(report),
      reportSha256: expectedDigest,
      publicationCompleteness: "complete",
      publicationLoss: "none",
    });
  });

  it("records rolled-back recovery before a later audit failure exits", async () => {
    const outPath = join(outDir, "rolled-back-report.jsonl");
    const context = supportPublicationContext(outDir, outPath);
    vi.resetModules();
    await crashDirectoryMutationAtLink(1);
    const firstRun = await import("./support.js");

    expect(
      await firstRun.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        makeIo().io,
        AUDIT_ENV,
        { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
      ),
    ).toBe(1);
    expect(readdirSync(context.root).some((name) => name.includes(context.slot))).toBe(true);

    vi.doUnmock("node:child_process");
    vi.resetModules();
    const resumed = await import("./support.js");
    const secondIo = makeIo();
    expect(
      await resumed.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        secondIo.io,
        AUDIT_ENV,
        {
          auditDeps: { loadAuditor: () => Promise.resolve({} as never) },
          evidenceStore: createInMemoryEvidenceStore(),
        },
      ),
    ).toBe(1);
    expect(secondIo.err()).toContain("local-state audit could not produce a result");
    const recovery = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.op === "support.export.publication")
      .at(-1);
    expect(recovery).toMatchObject({
      publicationPersistenceStatus: "rolled-back",
      recoveryState: "rolled-back",
      visibleArtifactCount: 0,
      publicationCompleteness: "complete",
      publicationLoss: "none",
    });
  });

  it("recovers the default output slot without consulting a replacement clock", async () => {
    const firstNow = new Date("2026-09-02T03:04:05.000Z");
    const outPath = resolveOutPath(outDir, undefined, firstNow);
    const context = supportPublicationContext(outDir, undefined);
    vi.resetModules();
    await crashDirectoryMutationAtLink(2);
    const interrupted = await import("./support.js");
    expect(
      await interrupted.runSupportCli(["export", "--state-dir", stateDir], makeIo().io, AUDIT_ENV, {
        cwd: outDir,
        now: () => firstNow,
        auditDeps: healthyAuditDeps(),
        evidenceStore: createInMemoryEvidenceStore(),
      }),
    ).toBe(1);
    expect(readdirSync(context.root).some((name) => name.includes(context.slot))).toBe(true);

    vi.doUnmock("node:child_process");
    vi.resetModules();
    const resumed = await import("./support.js");
    const resumedIo = makeIo();
    expect(
      await resumed.runSupportCli(["export", "--state-dir", stateDir], resumedIo.io, AUDIT_ENV, {
        cwd: outDir,
        now: () => {
          throw new Error("default recovery must precede clock access");
        },
        auditDeps: healthyAuditDeps(),
        evidenceStore: createInMemoryEvidenceStore(),
      }),
    ).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(resumedIo.out()).toContain(`Recovered support report at ${outPath}`);
    expect(readdirSync(context.root).filter((name) => name.includes(context.slot))).toEqual([
      `.keiko-publish-${context.slot}.consumed`,
    ]);
  });

  it("captures install-layout normalization before snapshotting support logs", async () => {
    const c = makeIo();
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const currentLog = join(stateDir, "logs", "server.log");
    writePrivateFile(currentLog, "");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir],
      c.io,
      {
        ...AUDIT_ENV,
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
      },
      {
        cwd: outDir,
        now: () => new Date("2026-08-21T12:00:00.000Z"),
        auditDeps: healthyAuditDeps(),
        evidenceStore: seededEvidenceStore([]),
        activityLogSinkFactory: (selectedStateDir) => {
          expect(selectedStateDir).toBe(stateDir);
          return {
            write: (event): void => {
              appendFileSync(currentLog, `${JSON.stringify(event)}\n`, "utf8");
            },
          };
        },
      },
    );

    expect(code).toBe(0);
    const bundle = readFileSync(
      join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl"),
      "utf8",
    );
    expect(bundle).toContain('"op":"cli.install-layout.normalized"');
    expect(bundle).toContain(`"correlationId":"${correlationId}"`);
  });

  it("refuses a pending install-layout correction before reading a symlinked state root", async () => {
    const realStateDir = join(outDir, "real-state");
    mkdirSync(realStateDir);
    rmSync(stateDir, { recursive: true });
    symlinkSync(realStateDir, stateDir, "dir");
    let factoryCalls = 0;
    let auditorLoaded = false;
    const controlStateDir = join(outDir, "control-state");
    const events: SecurityLogEvent[] = [];
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };
    const refusedOut = join(outDir, "refused.jsonl");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", refusedOut],
      makeIo().io,
      env,
      {
        cwd: outDir,
        controlActivityStateDir: controlStateDir,
        activityLogSinkFactory: (sinkRoot) => {
          expect(sinkRoot).toBe(controlStateDir);
          factoryCalls += 1;
          return { write: (event): void => void events.push(event) };
        },
        auditDeps: {
          loadAuditor: () => {
            auditorLoaded = true;
            return Promise.resolve({ auditLocalState: () => HEALTHY_AUDIT });
          },
        },
      },
    );

    expect(code).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(auditorLoaded).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "cli.support.export.failed",
      correlationId: env[INSTALL_LAYOUT_CORRELATION_ID_ENV],
      errorKind: "unsafe-target",
    });
    expect(events[0]?.extra?.reason).toBe("unsafe-state-root");
    expect(events[0]?.extra?.failureKind).toBe("SupportStateRootSymlinkError");
    expect(events[0]?.extra?.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(events)).not.toContain(stateDir);
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBe("local-state-auditor");
    expect(existsSync(refusedOut)).toBe(false);
  });

  it("refuses a pending install-layout correction when no durable sink is available", async () => {
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };
    let auditorLoaded = false;

    const code = await runSupportCli(["export", "--state-dir", stateDir], makeIo().io, env, {
      cwd: outDir,
      auditDeps: {
        loadAuditor: () => {
          auditorLoaded = true;
          return Promise.resolve({ auditLocalState: () => HEALTHY_AUDIT });
        },
      },
    });

    expect(code).toBe(1);
    expect(auditorLoaded).toBe(false);
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBe("local-state-auditor");
  });

  // Regression pin: `redactLogFields`'s field-NAME denylist matches only an exact normalized
  // whole name (`log-redaction.ts`'s `DENIED_FIELD_NAMES`/`normalizeLogFieldName`). Every
  // config-snapshot field name is collected with the literal `KEIKO_` prefix still attached
  // (`keikoConfigEnvFields`), so normalization fuses the prefix into the rest of the name —
  // `KEIKO_LOCAL_KNOWLEDGE_KEY` normalizes to `keikolocalknowledgekey`, which can never equal the
  // denylist's `key` entry. Safety then falls entirely to the VALUE-shape heuristics, which do not
  // catch a hex-only secret (lowercase + digits only never sees the uppercase class the
  // high-entropy check requires) or any other operator-chosen credential shape those heuristics
  // were never designed to enumerate. `keikoConfigEnvFields` must refuse to even collect a
  // credential-shaped KEY/SECRET/TOKEN/CREDENTIAL(S) env name, independent of its value.
  it("never embeds a KEIKO_*_KEY/_SECRET/_TOKEN/_CREDENTIALS env value in config-snapshot, even one the value-shape redactor cannot catch", async () => {
    writeFileSync(join(stateDir, "logs", "server.log"), "");

    const hexOnlyEnvValue = "a1b2c3d4e5f6".repeat(5).slice(0, 64);
    const secretEnv = {
      ...AUDIT_ENV,
      KEIKO_LOCAL_KNOWLEDGE_KEY: hexOnlyEnvValue,
      KEIKO_PROVIDER_TOKEN_GITHUB: hexOnlyEnvValue,
      KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: hexOnlyEnvValue,
      KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: hexOnlyEnvValue,
    };

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, secretEnv, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: seededEvidenceStore([]),
    });

    expect(code).toBe(0);
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const written = readFileSync(outPath, "utf8");
    // The raw secret value must never reach the bundle, and none of the credential-shaped field
    // names may even be attached (excluded entirely, not merely redacted-to-a-marker).
    expect(written).not.toContain(hexOnlyEnvValue);
    const [, configSnapshotLine] = written.trimEnd().split("\n");
    const configSnapshot = JSON.parse(configSnapshotLine ?? "{}") as {
      fields: Record<string, unknown>;
    };
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_LOCAL_KNOWLEDGE_KEY");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_PROVIDER_TOKEN_GITHUB");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY");
  });

  // The name gate split on `_` and required an exact segment match, so a credential word fused
  // onto a qualifier (`CLIENTSECRET`, `APITOKEN`, `ACCESSTOKEN`) slipped into the always-attached
  // snapshot. A tokenizer MODE is not a token and must stay visible.
  it("never embeds a fused credential-shaped KEIKO_* name, but keeps a non-secret one", async () => {
    const hexOnlyEnvValue = "a1b2c3d4e5f6".repeat(5).slice(0, 64);
    const env = {
      ...AUDIT_ENV,
      KEIKO_CLIENTSECRET: hexOnlyEnvValue,
      KEIKO_APITOKEN: hexOnlyEnvValue,
      KEIKO_ACCESSTOKEN: hexOnlyEnvValue,
      KEIKO_LOCAL_KNOWLEDGE_TOKENIZER: "heuristic",
    };
    const outPath = join(outDir, "fused-credential-names.jsonl");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      makeIo().io,
      env,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const written = readFileSync(outPath, "utf8");
    expect(written).not.toContain(hexOnlyEnvValue);
    const [, configSnapshotLine] = written.trimEnd().split("\n");
    const { fields } = JSON.parse(configSnapshotLine ?? "{}") as {
      readonly fields: Record<string, unknown>;
    };
    expect(fields).not.toHaveProperty("KEIKO_CLIENTSECRET");
    expect(fields).not.toHaveProperty("KEIKO_APITOKEN");
    expect(fields).not.toHaveProperty("KEIKO_ACCESSTOKEN");
    expect(fields.KEIKO_LOCAL_KNOWLEDGE_TOKENIZER).toBe("heuristic");
  });

  // Every other failure line in this command is body-free; this one echoed `error.message`, which
  // for an auditor failure can quote the state tree it was reading.
  it("reports an unexpected audit failure by its kind, never its message", async () => {
    const privateDetail = join(stateDir, "private-customer-file.db");
    vi.resetModules();
    vi.doMock("./audit.js", async () => {
      const actual = await vi.importActual<typeof import("./audit.js")>("./audit.js");
      return {
        ...actual,
        auditLocalStateResult: (): Promise<never> =>
          Promise.reject(new Error(`cannot read ${privateDetail}`)),
      };
    });
    const isolated = await import("./support.js");
    const c = makeIo();
    const outPath = join(outDir, "audit-message.jsonl");

    const code = await isolated.runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("local-state audit could not produce a result (Error)");
    expect(c.err()).not.toContain(privateDetail);
    expect(c.err()).not.toContain("private-customer-file");
    expect(existsSync(outPath)).toBe(false);
  });

  it("records a log file that vanishes between discovery and read as skipped, not aborted", async () => {
    // A directory sitting where `server.log` belongs — the same "not the file discovery expected"
    // shape concurrent operator cleanup can produce, exercised deterministically instead of via a
    // real race. It used to pass a `statSync` probe and fail only at `readFileSync` (EISDIR); the
    // verified open now refuses any non-regular entry up front, with the closed `unsafe-target`
    // kind. Either way the export must record the skip by name and still succeed.
    mkdirSync(join(stateDir, "logs", "server.log"), { recursive: true });

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, AUDIT_ENV, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: createInMemoryEvidenceStore(),
    });

    expect(code).toBe(0);
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.sourceLogFiles).toEqual([]);
    expect(manifest.skippedLogFiles).toEqual([{ name: "server.log", errorKind: "unsafe-target" }]);
  });

  // #3528: the only state-dir symlink check is gated on an install-layout override, so a normal
  // export used to `statSync`/`readFileSync` straight through a link named like a log (or ui.log)
  // and embed the target — any file this user can read — in a bundle meant to be shared. Every
  // exported file is now read through a no-follow, single-link, private regular-file descriptor.
  it("never exports a symlinked or hard-linked log or ui.log target, and leaves the victim unchanged", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const victimContent = "VICTIM-7f3a-must-never-reach-the-bundle\n";
    const victim = join(outDir, "victim.txt");
    writePrivateFile(victim, victimContent);
    symlinkSync(victim, join(stateDir, "logs", CURRENT_SEGMENT));
    linkSync(victim, join(stateDir, "logs", segmentName(1)));
    symlinkSync(victim, join(stateDir, "logs", "server-2026-08-19.log"));
    linkSync(victim, join(stateDir, "logs", "server-2026-08-18.log"));
    symlinkSync(victim, join(stateDir, "ui.log"));
    const outPath = join(outDir, "linked-logs.jsonl");
    const c = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const bundle = readFileSync(outPath, "utf8");
    expect(bundle).not.toContain("VICTIM-7f3a");
    expect(readFileSync(victim, "utf8")).toBe(victimContent);
    const manifest = JSON.parse(bundle.split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(manifest.sourceLogFiles).toEqual([]);
    expect(manifest.skippedLogFiles).toEqual([
      { name: "server-2026-08-18.log", errorKind: "unsafe-target" },
      { name: "server-2026-08-19.log", errorKind: "unsafe-target" },
      { name: segmentName(1), errorKind: "unsafe-target" },
      { name: CURRENT_SEGMENT, errorKind: "unsafe-target" },
    ]);
    expect(manifest.sectionsExcluded).toEqual(["ui-log"]);
  });

  it("defaults stateDirSource to 'default' when neither --state-dir nor KEIKO_STATE_DIR is set", async () => {
    const cwdWithDefaultState = mkdtempSync(join(tmpdir(), "keiko-support-cli-default-"));
    mkdirSync(join(cwdWithDefaultState, ".keiko", "logs"), { recursive: true });

    const c = makeIo();
    const code = await runSupportCli(["export"], c.io, AUDIT_ENV, {
      cwd: cwdWithDefaultState,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: createInMemoryEvidenceStore(),
    });

    expect(code).toBe(0);
    const outPath = join(cwdWithDefaultState, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.stateDirSource).toBe("default");
    expect(manifest.evidenceIndexCount).toBe(0);

    rmSync(cwdWithDefaultState, { recursive: true, force: true });
  });

  it("drops the oldest log files under a tiny --max-bytes and records them as truncated", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-18T00:00:00.000Z",
      category: "http",
      op: "old",
    });
    const currentLine = JSON.stringify({
      ts: "2026-08-20T00:00:00.000Z",
      category: "http",
      op: "new",
    });
    writePrivateFile(
      join(stateDir, "logs", "server-2026-08-18.log"),
      `${rotatedLine}\n`.repeat(50),
    );
    writePrivateFile(join(stateDir, "logs", "server.log"), `${currentLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--out",
        join(outDir, "tiny.jsonl"),
        "--max-bytes",
        "100",
      ],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "tiny.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.truncatedLogFiles).toEqual(["server-2026-08-18.log"]);
    expect(manifest.sourceLogFiles).toEqual(["server.log"]);
  });

  it("preserves an unterminated crash fragment for bundle analysis", async () => {
    writePrivateFile(join(stateDir, "logs", CURRENT_SEGMENT), '{"ts":');
    const outPath = join(outDir, "terminal-fragment.jsonl");
    const c = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const bundle = readFileSync(outPath, "utf8");
    expect(bundle.endsWith("\n")).toBe(false);
    expect(analyzeLogText(bundle).evidence).toMatchObject({
      classification: "truncated",
      truncatedLineCount: 1,
      corruptLineCount: 0,
    });
  });

  // #3530: recovery seals a crashed writer's segment with its torn tail intact, and newer segments
  // follow it in the bundle, so that fragment becomes a terminated line in the MIDDLE of the report.
  // The manifest's per-file boundaries let analysis classify it as truncated, never as corruption.
  it("classifies a torn segment tail in the middle of a bundle as truncated, not corrupt", async () => {
    const crashedSegment = segmentName(1);
    const newerSegment = segmentName(2);
    const firstRecord = JSON.stringify(validV2AnalysisRecord());
    const newerRecord = JSON.stringify(validV2AnalysisRecord({ seq: 2 }));
    writePrivateFile(join(stateDir, "logs", crashedSegment), `${firstRecord}\n{"ts":`);
    writePrivateFile(join(stateDir, "logs", newerSegment), `${newerRecord}\n`);
    const outPath = join(outDir, "mid-bundle-fragment.jsonl");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      makeIo().io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const bundle = readFileSync(outPath, "utf8");
    expect(bundle.endsWith(`${newerRecord}\n`)).toBe(true);
    const manifest = JSON.parse(bundle.split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(manifest.sourceLogFileLines).toEqual([
      { name: crashedSegment, lineCount: 2, terminalFragment: true },
      { name: newerSegment, lineCount: 1, terminalFragment: false },
    ]);
    expect(analyzeLogText(bundle).evidence).toMatchObject({
      classification: "truncated",
      truncatedLineCount: 1,
      corruptLineCount: 0,
    });
  });

  // Regression for #2902 PR review, follow-up finding: a single oversized CURRENT server.log was
  // exported in full (never dropped, per the rule above), exceeding --max-bytes outright, and read
  // via a whole-file readFileSync. Combines both effects of a tiny budget in one export: an older
  // rotated file is dropped whole (still recorded in truncatedLogFiles, per (d) above) AND the
  // current file alone still exceeds what's left of the budget, so only its tail is exported.
  it("drops older files first and ALSO tail-truncates the current file when both are needed to fit --max-bytes", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-18T00:00:00.000Z",
      category: "http",
      op: "old",
    });
    writePrivateFile(
      join(stateDir, "logs", "server-2026-08-18.log"),
      `${rotatedLine}\n`.repeat(50),
    );
    // 20 fixed-width lines (11 bytes + "\n" = 12 bytes each, 240 bytes total) so the tail cut lands
    // at a byte offset that can be reasoned about exactly, the same fixture shape
    // support-export.test.ts uses for the same scenario.
    const currentLine = (i: number): string => `{"seq":${String(i).padStart(3, "0")}}`;
    const currentText = `${Array.from({ length: 20 }, (_, i) => currentLine(i)).join("\n")}\n`;
    writePrivateFile(join(stateDir, "logs", CURRENT_SEGMENT), currentText);

    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "tail.jsonl"), "--max-bytes", "50"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const written = readFileSync(join(outDir, "tail.jsonl"), "utf8");
    // Skip the always-attached config-snapshot $section line (Wave 6) between the manifest and
    // the raw log content.
    const [manifestLine, , ...logLines] = written.trimEnd().split("\n");
    const manifest: Record<string, unknown> = JSON.parse(manifestLine ?? "{}") as Record<
      string,
      unknown
    >;

    expect(manifest.truncatedLogFiles).toEqual(["server-2026-08-18.log"]);
    expect(manifest.sourceLogFiles).toEqual([CURRENT_SEGMENT]);
    expect(manifest.currentFileTailTruncated).toEqual({
      name: CURRENT_SEGMENT,
      droppedBytes: 192,
    });
    // The tail strategy brought the export back within budget, so budgetExceeded must be false.
    expect(manifest.budgetExceeded).toBe(false);
    // Every surviving line is one of the file's own complete lines — the newest ones, in order.
    expect(logLines).toEqual([currentLine(16), currentLine(17), currentLine(18), currentLine(19)]);
  });

  it("fails closed with exit 1 when the local-state audit cannot run, and writes no bundle", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "should-not-exist.jsonl")],
      c.io,
      {},
      { evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("keiko support export");
    expect(existsSync(join(outDir, "should-not-exist.jsonl"))).toBe(false);
  });

  it("sets stateDirSource to 'env-override' from a non-empty KEIKO_STATE_DIR alone, without --state-dir", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--out", join(outDir, "env-override.jsonl")],
      c.io,
      { ...AUDIT_ENV, KEIKO_STATE_DIR: stateDir },
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "env-override.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.stateDirSource).toBe("env-override");
  });

  // AuditLoadError (thrown once the auditor was actually located and tried) is a distinct branch
  // from the plain Error thrown when KEIKO_LOCAL_STATE_AUDITOR is unset at all (tested above) —
  // both must fail closed with exit 1 and a clear message, never a raw stack.
  it("fails closed with exit 1 when the located auditor module is malformed (AuditLoadError)", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "audit-load-error.jsonl")],
      c.io,
      AUDIT_ENV,
      {
        auditDeps: { loadAuditor: () => Promise.resolve({} as never) },
        evidenceStore: createInMemoryEvidenceStore(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("local-state audit could not produce a result");
    expect(existsSync(join(outDir, "audit-load-error.jsonl"))).toBe(false);
  });

  it("reports evidenceIndexCount 0 (never throwing) when the evidence directory does not exist, using the real evidence package", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "real-evidence.jsonl")],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "real-evidence.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.evidenceIndexCount).toBe(0);
  });

  // Regression: `writeFileSync` was unguarded, so a bad `--out` path (here, one whose parent
  // directory does not exist) threw the raw fs error straight out of the CLI — no exit-1 message,
  // no handling, and (per AGENTS.md §7) an fs error's message quotes the absolute path it tried to
  // write. `readAnalyzeSource` already follows this discipline for the read side; the write side
  // must match it.
  it("exits 1 with a content-free message, never the raw fs error, when --out's parent directory does not exist", async () => {
    const c = makeIo();
    const badOutPath = join(outDir, "missing-parent", "bundle.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", badOutPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    // The hardened publisher classifies the missing trusted parent without exposing its path.
    expect(c.err()).toContain("keiko support export: could not write the bundle: unsafe-ancestor");
    expect(c.err()).not.toContain(badOutPath);
    expect(existsSync(badOutPath)).toBe(false);
  });

  // Wave 4a (epic #3233 §6.2/§8): none of the three stores has ever been created under this
  // state dir, so the export must still succeed — each store is named in storesUnavailable with
  // reasonKind "missing", and none of their (nonexistent) db files or directories are created as
  // a side effect of merely running an export.
  it("reports all three stores as missing, never creating them, when none exist under --state-dir", async () => {
    const c = makeIo();
    const outPath = join(outDir, "no-stores.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      {
        auditDeps: healthyAuditDeps(),
        evidenceStore: createInMemoryEvidenceStore(),
      },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storeFingerprints).toEqual([]);
    expect(manifest.storesUnavailable).toEqual(
      expect.arrayContaining([
        { store: "ui", reasonKind: "missing" },
        { store: "local-knowledge", reasonKind: "missing" },
        { store: "memory-vault", reasonKind: "missing" },
      ]),
    );
    expect(existsSync(join(stateDir, "ui"))).toBe(false);
    expect(existsSync(join(stateDir, "memory"))).toBe(false);
    expect(existsSync(join(stateDir, "local-knowledge"))).toBe(false);
  });

  // Wave 4a: a store whose db path exists but cannot be opened as a database (here, a directory
  // sitting where the db file is expected — not classified as SQLite corruption, so the store's
  // own quarantine-and-recover path never kicks in) reports reasonKind "open-failed", and the
  // export still succeeds for the other two stores.
  it("reports open-failed (never throwing) when a store's db path exists but cannot be opened", async () => {
    mkdirSync(join(stateDir, "ui", UI_DB_FILENAME), { recursive: true });

    const c = makeIo();
    const outPath = join(outDir, "open-failed.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storesUnavailable).toEqual(
      expect.arrayContaining([{ store: "ui", reasonKind: "open-failed" }]),
    );
    expect(manifest.storeFingerprints).toEqual([]);
  });

  // RED (before fix): computing the ui store's fingerprint called `openNodeUiDatabase`, the
  // mutating production open path — which unconditionally runs `sqlRecoverInterruptedClientTurns`,
  // flipping any `client_turn_state = 'pending'` row to `'failed'`. That is exactly the evidence an
  // operator running `keiko support export` to diagnose a stuck chat turn needs preserved. This
  // goes through the real, on-disk ui store (no mock of the open path) so a regression in which
  // fingerprint collection touches the production open path again cannot hide behind a fixture.
  it("does not flip a pending client turn to failed as a side effect of computing the ui store fingerprint", async () => {
    const uiDataDir = join(stateDir, "ui");
    mkdirSync(uiDataDir, { recursive: true });
    const dbPath = join(uiDataDir, UI_DB_FILENAME);
    const projectDir = mkdtempSync(join(stateDir, "pending-turn-project-"));
    const store = createNodeUiStore(dbPath);
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Chat", "example-chat-model");
    const admission = store.admitChatTurn("turn-stuck-in-flight", {
      chatId: chat.id,
      role: "user",
      content: "message stuck in flight",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("expected canonical admission");
    store.close();

    const c = makeIo();
    const outPath = join(outDir, "pending-turn.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );
    expect(code).toBe(0);

    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const stored = inspector
      .prepare("SELECT client_turn_state FROM chat_messages WHERE id = ?")
      .get(admission.userMessage.id) as { client_turn_state: string };
    inspector.close();
    expect(stored.client_turn_state).toBe("pending");

    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storesUnavailable).toEqual(
      expect.not.arrayContaining([{ store: "ui", reasonKind: "open-failed" }]),
    );
  });

  // Finding 1 (minor): store fingerprint collection runs a synchronous full-DB quick_check plus
  // per-table row counts with nothing printed while it runs, so a slow run against a large
  // local-knowledge index looks hung to the operator. A stderr progress line before the call
  // fixes that. RED (before fix): no such line was ever written to stderr.
  it("prints a stderr progress line before computing store fingerprints", async () => {
    const c = makeIo();
    const outPath = join(outDir, "progress-line.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    expect(c.err()).toContain(
      "keiko support export: computing store fingerprints (may take a while on a large local-knowledge index)...",
    );
  });

  // #3532: a legacy ui.log carries raw, unredacted UI process output, so it is never read into a
  // report — there is no flag that attaches it any more.
  function bundleLines(outPath: string): readonly Record<string, unknown>[] {
    return readFileSync(outPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("never reads a legacy ui.log into the report, and names it excluded", async () => {
    writePrivateFile(join(stateDir, "ui.log"), "TypeError: boom at /Users/jsmith/app\n");
    const c = makeIo();
    const outPath = join(outDir, "default-no-ui-log.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const bundle = readFileSync(outPath, "utf8");
    expect(bundle).not.toContain("TypeError: boom");
    const lines = bundleLines(outPath);
    expect(lines.some((line) => line.$section === "ui-log")).toBe(false);
    expect(lines[0]?.sectionsExcluded).toEqual(["ui-log"]);
  });

  it("refuses the retired ui.log flags before exporting anything", async () => {
    writePrivateFile(join(stateDir, "ui.log"), "TypeError: boom at /Users/jsmith/app\n");
    const c = makeIo();
    const outPath = join(outDir, "refused-ui-log.jsonl");
    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--out",
        outPath,
        "--include-ui-log",
        "--i-understand-this-is-unredacted",
      ],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(2);
    expect(existsSync(outPath)).toBe(false);
    expect(c.err()).toContain("--include-ui-log is no longer supported");
  });

  it("reports the exported directory's diagnostic readiness after a successful export", async () => {
    const c = makeIo();
    const outPath = join(outDir, "with-readiness.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    expect(c.out()).toMatch(/Diagnostic evidence: (ready|degraded|unavailable)/u);
    // The readiness line is persisted AFTER the report, so the report stays exactly the evidence
    // that existed when it was taken.
    expect(readFileSync(outPath, "utf8")).not.toContain("activity-log.readiness");
    const readiness = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "activity-log.readiness",
    );
    expect(readiness).toHaveLength(1);
  });

  it("attaches a full evidence manifest per --include-evidence runId, beyond the index count", async () => {
    const c = makeIo();
    const outPath = join(outDir, "with-evidence.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath, "--include-evidence", "run-a"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: seededEvidenceStore(["run-a", "run-b"]) },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    const evidenceSection = lines.find((line) => line.$section === "evidence-manifest");
    expect(evidenceSection?.runId).toBe("run-a");
    expect(evidenceSection?.manifest).toEqual(minimalEvidenceManifest("run-a"));
  });

  // Wave 6, design doc §6.2 closing addendum: a cheap integrity story for an artifact crossing a
  // customer-machine-to-agent trust boundary. RED before this wave: no .sha256 sidecar existed.
  it("writes a <output>.sha256 sidecar matching an independently-computed digest of the bundle bytes", async () => {
    const c = makeIo();
    const outPath = join(outDir, "digest.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const sidecarPath = `${outPath}.sha256`;
    expect(existsSync(sidecarPath)).toBe(true);
    const expectedDigest = createHash("sha256").update(readFileSync(outPath)).digest("hex");
    expect(readFileSync(sidecarPath, "utf8").trim()).toBe(expectedDigest);
    if (process.platform !== "win32") {
      expect(statSync(outPath).mode & 0o777).toBe(0o600);
      expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
    }
  });

  it("records body-free support publication evidence with correlation and assurance", async () => {
    const c = makeIo();
    const outPath = join(outDir, "evidence.jsonl");

    expect(
      await runSupportCli(["export", "--state-dir", stateDir, "--out", outPath], c.io, AUDIT_ENV, {
        auditDeps: healthyAuditDeps(),
        evidenceStore: createInMemoryEvidenceStore(),
      }),
    ).toBe(0);

    const report = readFileSync(outPath);
    const reportSha256 = createHash("sha256").update(report).digest("hex");
    const records = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const publication = records.find((record) => record.op === "support.export.publication");
    expect(publication).toMatchObject({
      category: "diagnostic",
      publicationArtifactClass: "support-report",
      artifactCount: 2,
      publicationPersistenceStatus: "published",
      publicationStatus: "published",
      permissionAssurance: process.platform === "win32" ? "platform-inherited" : "verified-private",
      durabilityAssurance: process.platform === "win32" ? "directory-sync-unavailable" : "verified",
      publicationCompleteness: "complete",
      publicationLoss: "none",
      visibleArtifactCount: 2,
      reportBytes: report.length,
      reportSha256,
    });
    expect(String(publication?.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(publication)).not.toContain(outPath);
  });

  it("preserves a per-entry integrity-artifact failure in publication evidence", async () => {
    vi.resetModules();
    vi.doMock("@oscharko-dev/keiko-security/fs-hardening", async () => {
      const actual = await vi.importActual<
        typeof import("@oscharko-dev/keiko-security/fs-hardening")
      >("@oscharko-dev/keiko-security/fs-hardening");
      return {
        ...actual,
        publishSafeArtifactFileSet: (): never => {
          throw new actual.SafeArtifactFileError("integrity-artifact", "write-failed");
        },
      };
    });
    const isolated = await import("./support.js");
    const outPath = join(outDir, "integrity-write-failure.jsonl");

    expect(
      await isolated.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        makeIo().io,
        AUDIT_ENV,
        { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
      ),
    ).toBe(1);
    const failure = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.op === "support.export.publication");
    expect(failure).toMatchObject({
      errorKind: "write-failed",
      failedArtifactClass: "integrity-artifact",
      failureKind: "write-failed",
    });
  });

  it("records acknowledgement failure as the sole terminal publication evidence", async () => {
    vi.resetModules();
    vi.doMock("@oscharko-dev/keiko-security/fs-hardening", async () => {
      const actual = await vi.importActual<
        typeof import("@oscharko-dev/keiko-security/fs-hardening")
      >("@oscharko-dev/keiko-security/fs-hardening");
      return {
        ...actual,
        acknowledgeSafeArtifactFileSet: (): never => {
          throw new actual.SafeArtifactFileError("manifest", "durability-failed");
        },
      };
    });
    const isolated = await import("./support.js");
    const c = makeIo();
    const outPath = join(outDir, "ack-failure.jsonl");

    expect(
      await isolated.runSupportCli(
        ["export", "--state-dir", stateDir, "--out", outPath],
        c.io,
        AUDIT_ENV,
        { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
      ),
    ).toBe(1);
    // Success is claimed only after the receipt is acknowledged; the success line used to be
    // printed first, contradicting the exit code.
    expect(c.out()).not.toContain("Wrote ");
    expect(c.err()).toContain("could not acknowledge publication: durability-failed");
    const records = readPersistedActivityLog(stateDir)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.op === "support.export.publication");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      errorKind: "durability-failed",
      publicationPersistenceStatus: "acknowledgement-failed",
      publicationStatus: "published",
      receiptState: "acknowledgement-uncertain",
      publicationCompleteness: "complete",
      publicationLoss: "none",
      visibleArtifactCount: 2,
      failedArtifactClass: "manifest",
    });
    expect(String(records[0]?.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(records[0])).not.toContain(outPath);
  });

  // `resolveIncludedEvidenceSections`'s `deps.evidenceStore ?? evidence.createNodeEvidenceStore(...)`
  // fallback: every other evidence test in this file injects `evidenceStore`, so the real
  // node-backed store construction never ran. Deliberately omits it here, and requests a runId
  // that was never written under this fresh state dir, so `evidence.loadEvidence` returns
  // undefined and no section is attached — the same "count, don't fail" discipline
  // `resolveEvidenceIndexCount`'s own real-store test already proves for the index count.
  it("attaches no evidence-manifest section for a --include-evidence runId that does not exist, using the real evidence store", async () => {
    const c = makeIo();
    const outPath = join(outDir, "real-evidence-missing-run.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath, "--include-evidence", "run-missing"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps() },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    expect(lines.some((line) => line.$section === "evidence-manifest")).toBe(false);
    expect(lines[0]?.evidenceIndexCount).toBe(0);
  });

  // `resolveIncludedEvidenceSections`'s catch: `evidence.loadEvidence` throws (not merely returns
  // undefined) when a stored manifest's `evidenceSchemaVersion` is unrecognised — the export must
  // still succeed with no evidence-manifest section, never propagate the parse failure.
  it("never fails the export when a requested evidence manifest is malformed", async () => {
    const badStore = createInMemoryEvidenceStore();
    badStore.put("bad-run", JSON.stringify({ evidenceSchemaVersion: "not-a-real-version" }));

    const c = makeIo();
    const outPath = join(outDir, "malformed-evidence.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath, "--include-evidence", "bad-run"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: badStore },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    expect(lines.some((line) => line.$section === "evidence-manifest")).toBe(false);
  });
});

describe("runSupportCli analyze", () => {
  let dir: string;

  const runSupportCli: typeof runSupportCliImpl = (args, io, env, deps) =>
    runSupportCliImpl(args, io, env ?? {}, { ...deps, cwd: deps?.cwd ?? dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-cli-analyze-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function analyzeAndReadClassification(
    fileName: string,
    text: string,
  ): Promise<{
    readonly filePath: string;
    readonly evidence: Record<string, unknown> | undefined;
  }> {
    const stateDir = join(dir, "state");
    const filePath = join(dir, fileName);
    writeFileSync(filePath, text);

    const code = await runSupportCli(
      ["analyze", filePath, "--json"],
      makeIo().io,
      { KEIKO_STATE_DIR: stateDir },
      { cwd: dir },
    );

    expect(code).toBe(0);
    const evidence = readPersistedActivityLog(stateDir)
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find((record) => record.op === "support.analyze.classified");
    return { filePath, evidence };
  }

  // A truncated bundle is not complete evidence: its final record never finished persisting. The
  // event used to hard-code `complete`/`none` for every input, contradicting its own
  // classification in the same line.
  it("records body-free classification counts with a correlation id", async () => {
    const { filePath, evidence } = await analyzeAndReadClassification(
      "truncated-bundle.jsonl",
      `${JSON.stringify({ $section: "manifest" })}\n{"ts":`,
    );

    expect(evidence).toMatchObject({
      category: "diagnostic",
      sourceKind: "bundle",
      evidenceClassification: "truncated",
      truncatedLineCount: 1,
      corruptLineCount: 0,
      malformedLineCount: 1,
      completeness: "partial",
      loss: "event-dropped",
    });
    expect(String(evidence?.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(evidence)).not.toContain(filePath);
  });

  it("records complete, loss-free classification evidence only for a clean analyzed log", async () => {
    const { evidence } = await analyzeAndReadClassification(
      "clean-server.log",
      `${JSON.stringify(validV2AnalysisRecord())}\n`,
    );

    expect(evidence).toMatchObject({
      sourceKind: "raw-log",
      evidenceClassification: "supported",
      malformedLineCount: 0,
      completeness: "complete",
      loss: "none",
    });
  });

  it("auto-detects a raw log and emits the minimal LogTimeline JSON for one correlation id", async () => {
    const filePath = join(dir, "server.log");
    const l1 = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
    });
    writeFileSync(filePath, `${l1}\nnot-json\n`);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--json"],
      c.io,
    );

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    // #3531: the machine form names itself and its version; every earlier field is unchanged.
    expect(parsed).toMatchObject({ kind: "keiko.support.analyze-timeline", schemaVersion: 1 });
    expect(parsed.correlationId).toBe("req-1");
    expect(parsed.malformedLineCount).toBe(1);
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.frames).toBeUndefined();
    expect(parsed.clusters).toBeUndefined();
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.gatewayScript).toBeUndefined();
  });

  it("emits all timelines when --correlation-id is absent", async () => {
    const filePath = join(dir, "server.log");
    const l1 = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
    });
    const l2 = JSON.stringify({
      ts: "2026-08-21T00:00:01.000Z",
      category: "http",
      op: "b",
      correlationId: "req-2",
    });
    writeFileSync(filePath, `${l1}\n${l2}\n`);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--json"],
      c.io,
      {},
      {
        now: () => new Date("2026-08-21T00:00:02.000Z"),
      },
    );

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ kind: "keiko.support.analyze", schemaVersion: 1 });
    expect((parsed.timelines as { correlationId: string }[]).map((t) => t.correlationId)).toEqual([
      "req-1",
      "req-2",
    ]);
    // The whole-file `processes`/`legacyLineCount`/`warnings` fields (ADR-0173 D9/D10) travel
    // through the CLI's --json output alongside `timelines` — none of these lines has full v2
    // identity, so both are legacy and the analyzer says so.
    expect(parsed.processes).toEqual([]);
    expect(parsed.legacyLineCount).toBe(2);
    expect(parsed.warnings).toEqual([
      "2 line(s) predate the v2 envelope and were ordered by file position",
    ]);
  });

  it("identifies the analyzed raw-log context and warns when it is obviously stale", async () => {
    const stateDir = join(dir, ".keiko");
    const logDir = join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const filePath = join(logDir, "server.log");
    writeFileSync(filePath, `${JSON.stringify(validV2AnalysisRecord({ pid: 4242 }))}\n`);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--json"],
      c.io,
      {},
      {
        now: () => new Date("2026-08-21T00:10:01.000Z"),
      },
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as {
      readonly analysisContext: Readonly<Record<string, unknown>>;
      readonly warnings: readonly string[];
    };
    expect(parsed.analysisContext).toEqual({
      sourceKind: "raw-log",
      inputFile: filePath,
      stateDir,
      latestTimestamp: "2026-08-21T00:00:00.000Z",
      latestInstanceId: "aaaaaaaa",
      freshness: "stale",
      processActivity: "inactive",
    });
    expect(parsed.warnings).toContain(
      "analyzed log is stale: its newest valid event is older than 5 minutes",
    );
  });

  it("reports unknown process activity when the newest raw-log record has a non-positive pid", async () => {
    // Regression pin: `process.kill(0, 0)` on POSIX can succeed for the caller's process group, so
    // a malformed raw-log line with `pid: 0` used to be reported as `apparently-active`. The pid
    // guard must run BEFORE the running-process probe, and the probe must never be reached for a
    // non-positive or non-safe-integer pid.
    const stateDir = join(dir, ".keiko");
    const logDir = join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const filePath = join(logDir, "server.log");
    writeFileSync(filePath, `${JSON.stringify(validV2AnalysisRecord({ pid: 0 }))}\n`);

    let probeCalls = 0;
    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--json"],
      c.io,
      {},
      {
        now: () => new Date("2026-08-21T00:00:01.000Z"),
        processIsRunning: () => {
          probeCalls += 1;
          return true;
        },
      },
    );

    expect(code).toBe(0);
    expect(probeCalls).toBe(0);
    const parsed = JSON.parse(c.out()) as {
      readonly analysisContext: { readonly processActivity: string };
      readonly warnings: readonly string[];
    };
    expect(parsed.analysisContext.processActivity).toBe("unknown");
    expect(parsed.warnings).toContain("1 corrupt Activity Log line(s)");
  });

  it("renders the analyzed log context before the human-readable timeline", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify(validV2AnalysisRecord({ instanceId: "bbbbbbbb" }))}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath],
      c.io,
      {},
      {
        now: () => new Date("2026-08-21T00:00:01.000Z"),
      },
    );

    expect(code).toBe(0);
    expect(c.out()).toContain(`Analyzed log: ${filePath}`);
    expect(c.out()).toContain("Newest event: 2026-08-21T00:00:00.000Z");
    expect(c.out()).toContain("Newest instance: bbbbbbbb");
  });

  it("auto-detects a bundle (manifest first line) and analyzes only the log content", async () => {
    const filePath = join(dir, "bundle.jsonl");
    const manifestLine = JSON.stringify({ $section: "manifest", schemaVersion: 2 });
    const logLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
    });
    writeFileSync(filePath, `${manifestLine}\n${logLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--json"], c.io);

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    expect(parsed.malformedLineCount).toBe(0);
  });

  it("exits 1 with a clear message for a correlation id that is not present", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id", "missing"], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("no lines found for correlation id: missing");
  });

  it("renders human-readable text by default", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath], c.io);

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
  });

  it("renders a single timeline as human-readable text when --correlation-id is given without --json", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id", "req-1"], c.io);

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
    expect(c.out()).not.toContain("{");
  });

  it("resolves a relative FILE argument against the launch cwd", async () => {
    writeFileSync(
      join(dir, "server.log"),
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", "server.log"], c.io, {}, { cwd: dir });

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
  });

  it("exits 2 when --correlation-id is missing its value", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(filePath, "");

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id"], c.io);

    expect(code).toBe(2);
    expect(c.err()).toContain("--correlation-id is missing its value");
  });

  it("exits 1 without leaking the underlying fs error message for an unreadable file", async () => {
    const c = makeIo();
    const code = await runSupportCli(["analyze", join(dir, "does-not-exist.jsonl")], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("could not read");
    expect(c.err()).not.toContain("ENOENT:");
  });

  // Wave 6 (epic #3233 closeout, disclosed gap #1): --clusters/--seed/--emit-fixture were
  // implemented and exported from support-analyze.ts but never wired into the CLI dispatch path —
  // these fail before that wiring and pass after.
  function writeGatewayLog(filePath: string): void {
    const line = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "gateway",
      op: "gateway.chat.completed",
      correlationId: "req-1",
      durationMs: 120,
      modelId: "gpt-x",
      finishReason: "stop",
    });
    const other = JSON.stringify({
      ts: "2026-08-21T00:00:01.000Z",
      category: "http",
      op: "request",
      correlationId: "req-2",
      errorKind: "HTTP_TIMEOUT",
    });
    writeFileSync(filePath, `${line}\n${other}\n`);
  }

  it("prints whole-file clusters via --clusters, independent of --correlation-id", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const jsonRun = makeIo();
    const jsonCode = await runSupportCli(["analyze", filePath, "--clusters", "--json"], jsonRun.io);
    expect(jsonCode).toBe(0);
    const clusters = JSON.parse(jsonRun.out()) as { readonly op: string }[];
    expect(clusters.map((cluster) => cluster.op).sort()).toEqual([
      "gateway.chat.completed",
      "request",
    ]);

    const humanRun = makeIo();
    const humanCode = await runSupportCli(["analyze", filePath, "--clusters"], humanRun.io);
    expect(humanCode).toBe(0);
    expect(humanRun.out()).toContain("Clusters: 2");
    expect(humanRun.out()).toContain("gateway.chat.completed");
  });

  it("prints a ReproductionSeed via --seed", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const jsonRun = makeIo();
    const jsonCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed", "--json"],
      jsonRun.io,
    );
    expect(jsonCode).toBe(0);
    const seed = JSON.parse(jsonRun.out()) as {
      readonly correlationId: string;
      readonly gatewayScript?: { readonly attempts: readonly unknown[] };
      readonly warnings: readonly string[];
    };
    expect(seed.correlationId).toBe("req-1");
    expect(seed.gatewayScript?.attempts).toHaveLength(1);
    expect(seed.warnings.length).toBeGreaterThan(0);

    const humanRun = makeIo();
    const humanCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed"],
      humanRun.io,
    );
    expect(humanCode).toBe(0);
    expect(humanRun.out()).toContain("correlationId=req-1");
    expect(humanRun.out()).toContain("gatewayScript:");
  });

  // #3531: --seed streams the artifact instead of loading it whole, and its digest is taken from
  // the same pass as its analysis: the SHA-256 of the file's exact bytes, which is what `shasum`
  // and a report's .sha256 sidecar state. A whole-file read hashed the decoded text instead, a
  // different value whenever the artifact held a byte sequence that is not UTF-8.
  it("states the SHA-256 of the artifact's exact bytes and its line count in a --seed", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    appendFileSync(filePath, Buffer.from([0xff, 0xfe, 0x0a]));

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed", "--json"],
      c.io,
    );
    expect(code).toBe(0);
    const seed = JSON.parse(c.out()) as { readonly sourceArtifact: unknown };
    expect(seed.sourceArtifact).toEqual({
      kind: "raw-log",
      lineCount: 3,
      sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    });
  });

  it("exits 1 for --seed when the correlation id has no timeline", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "missing", "--seed"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("no lines found for correlation id: missing");
  });

  it("writes a fixture via --emit-fixture, fail-closed against an existing file", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "fixtures", "gateway.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toContain(`Wrote fixture to ${fixturePath}`);
    const contents = readFileSync(fixturePath, "utf8");
    expect(contents).toContain("GatewayReplayScriptEntry");
    expect(contents).toContain("gatewayReplayScript");

    // Fail-closed: a second run against the same path must refuse to overwrite it.
    const rerun = makeIo();
    const rerunCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
      rerun.io,
    );
    expect(rerunCode).toBe(1);
    expect(rerun.err()).toContain("refusing to overwrite existing file");
    // The original fixture content must survive the refused overwrite attempt.
    expect(readFileSync(fixturePath, "utf8")).toBe(contents);
    if (process.platform !== "win32") expect(statSync(fixturePath).mode & 0o777).toBe(0o600);
  });

  // #3528: `existsSync` follows a symlink, so a DANGLING link at PATH read as "absent" and the plain
  // `writeFileSync` then created the file at the link's target. The fixture is now published
  // exclusively through the hardened primitive: any link at PATH is an existing entry, refused.
  it("refuses a dangling or live symlink at --emit-fixture without touching its target", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const victim = join(dir, "victim.ts");
    writeFileSync(victim, "operator-owned\n", { mode: 0o640 });
    chmodSync(victim, 0o640);
    const danglingTarget = join(dir, "created-through-link.ts");

    for (const [linkName, target] of [
      ["dangling.fixture.ts", danglingTarget],
      ["live.fixture.ts", victim],
    ] as const) {
      const fixturePath = join(dir, linkName);
      symlinkSync(target, fixturePath);
      const c = makeIo();

      const code = await runSupportCli(
        ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
        c.io,
      );

      expect(code).toBe(1);
      expect(c.err()).toContain("refusing to overwrite existing file");
      expect(c.out()).not.toContain("Wrote fixture");
    }
    expect(existsSync(danglingTarget)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("operator-owned\n");
    expect(statSync(victim).mode & 0o777).toBe(0o640);
  });

  it("combines --seed and --emit-fixture into one JSON object under --json", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "gateway.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      [
        "analyze",
        filePath,
        "--correlation-id",
        "req-1",
        "--seed",
        "--emit-fixture",
        fixturePath,
        "--json",
      ],
      c.io,
    );
    expect(code).toBe(0);
    // Exactly one JSON document on stdout (the seed with `fixturePath` folded in), never a
    // separate plain-text "wrote fixture" line alongside it — --json stays a single JSON object.
    const seed = JSON.parse(c.out()) as {
      readonly fixturePath: string;
      readonly correlationId: string;
    };
    expect(seed.fixturePath).toBe(fixturePath);
    expect(seed.correlationId).toBe("req-1");
  });

  it("exits 1 with a clear message when --emit-fixture has no gateway script to write", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        ts: "2026-08-21T00:00:00.000Z",
        category: "http",
        op: "request",
        correlationId: "req-1",
      })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", join(dir, "out.ts")],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("no gateway replay script to write for correlationId=req-1");
  });

  it("exits 2 when --seed is given without --correlation-id", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--seed"], c.io);
    expect(code).toBe(2);
  });

  // `resolveFixturePath`'s relative branch: every other --emit-fixture test in this file passes an
  // already-absolute path (built via `join(dir, ...)` off an absolute mkdtemp root), so the
  // `resolve(cwd, path)` arm never ran. A relative FILE argument and a relative --emit-fixture
  // value, both resolved against the injected launch cwd.
  it("resolves a relative --emit-fixture path against the launch cwd", async () => {
    writeGatewayLog(join(dir, "server.log"));

    const c = makeIo();
    const code = await runSupportCli(
      [
        "analyze",
        "server.log",
        "--correlation-id",
        "req-1",
        "--emit-fixture",
        "relative.fixture.ts",
      ],
      c.io,
      {},
      { cwd: dir },
    );

    expect(code).toBe(0);
    const expectedPath = join(dir, "relative.fixture.ts");
    expect(c.out()).toContain(`Wrote fixture to ${expectedPath}`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  // `writeFixtureOrExitCode`'s write-failure path: the target's parent directory exists but is
  // read-only, so `writeFileSync` fails with EACCES after the (no-op, already-exists) recursive
  // mkdirSync. Skipped as root, where chmod does not restrict writes (mirrors the same skip guard
  // used elsewhere in this package for permission-based failure tests).
  it("exits 1 with a content-free message when the fixture cannot be written", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    if (typeof process.getuid === "function" && process.getuid() === 0) ctx.skip();

    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const readOnlyDir = join(dir, "readonly");
    mkdirSync(readOnlyDir, { recursive: true });
    chmodSync(readOnlyDir, 0o500);
    const fixturePath = join(readOnlyDir, "gateway.fixture.ts");

    try {
      const c = makeIo();
      const code = await runSupportCli(
        ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
        c.io,
      );
      expect(code).toBe(1);
      expect(c.err()).toContain("keiko support analyze: could not write fixture:");
      // Content-free (AGENTS.md §7): the fs error's message may quote the absolute path it was
      // writing, but this CLI's own reported message must not.
      expect(c.err()).not.toContain(readOnlyDir);
      expect(existsSync(fixturePath)).toBe(false);
    } finally {
      chmodSync(readOnlyDir, 0o700);
    }
  });

  // `reportFixtureOnly`'s json branch: every other --emit-fixture-without---seed test in this file
  // renders text ("Wrote fixture to ..."); this is the --json sibling.
  it("emits fixturePath as a JSON object when --emit-fixture is combined with --json but not --seed", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "json-only.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath, "--json"],
      c.io,
    );

    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual({ fixturePath });
  });

  // `emitSeedResult`'s human-mode fixturePath branch: the existing "--seed" human-mode test never
  // passes --emit-fixture, so `fixturePath` there is always undefined and the trailing "Wrote
  // fixture to ..." line never prints. --json mode combining both flags is covered separately
  // (folds fixturePath into the seed object); this is the non-json sibling of that combination.
  it("prints both the human seed and the fixture confirmation when --seed and --emit-fixture are combined without --json", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "human-seed.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed", "--emit-fixture", fixturePath],
      c.io,
    );

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
    expect(c.out()).toContain(`Wrote fixture to ${fixturePath}`);
  });
});

describe("runSupportCli usage and help", () => {
  it("prints usage and exits 0 for --help", async () => {
    const c = makeIo();
    expect(await runSupportCli(["--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support export");
  });

  // Regression: the help text claimed timelines are "ordered by (pid, instanceId, seq)", but
  // support-analyze.ts ranks process lifetimes by file position (never by pid value) and orders
  // each lifetime's own lines by seq — an operator reading the old text would draw the wrong
  // conclusion about a reconstructed timeline.
  it("describes the analyzer's real ordering: seq within a lifetime, file position across lifetimes", async () => {
    const c = makeIo();
    await runSupportCli(["--help"], c.io);
    expect(c.out()).toContain("Each process lifetime is ordered by");
    expect(c.out()).toContain("seq");
    expect(c.out()).not.toContain("(pid, instanceId, seq)");
  });

  it("prints usage and exits 0 for 'export --help', without requiring any export flags", async () => {
    const c = makeIo();
    expect(await runSupportCli(["export", "--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support export");
  });

  it("prints usage and exits 0 for 'analyze --help', without requiring a FILE argument", async () => {
    const c = makeIo();
    expect(await runSupportCli(["analyze", "--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support analyze");
  });

  it("exits 2 for an unknown subcommand", async () => {
    const c = makeIo();
    expect(await runSupportCli(["bogus"], c.io)).toBe(2);
    expect(c.err()).toContain("unknown subcommand");
  });

  it("exits 2 when analyze is missing its FILE argument", async () => {
    const c = makeIo();
    expect(await runSupportCli(["analyze"], c.io)).toBe(2);
  });
});
