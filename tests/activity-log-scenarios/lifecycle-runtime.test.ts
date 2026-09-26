// Activity Log scenario matrix (#3532): the lifecycle-crash storage lifecycle (dependency-failure,
// loss) and the runtime-packages surface (dependency-failure, loss, rejection).
//
// Each scenario drives a real production entry point with the real production file writer under a
// temporary directory and reconstructs the persisted log through `keiko support analyze` to a
// complete report (tests/support/activity-log-scenario.ts). The lifecycle-crash scenarios call
// keiko-server's observability module directly by relative source path — the same module graph the
// production writer runs on. The runtime-packages scenarios that originate in keiko-cli (audit,
// the security-log sink wiring) reach keiko-server exactly as the CLI's own production composition
// root does: through the `@oscharko-dev/keiko-server` dist package (see `packages/keiko-cli/src/
// runner.ts`), so the aliased `createPackagedActivityLogSink` import below is deliberate, not a
// stray duplicate of the relative-path `createActivityLogSink` the lifecycle-crash scenarios use.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateInstallMode, UpdatePreflightReport } from "@oscharko-dev/keiko-contracts";
import { activityLogSegmentFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  closeFileServerLogSinks as closePackagedFileServerLogSinks,
  createActivityLogSink as createPackagedActivityLogSink,
  recordRegisteredFailureIncident as recordPackagedRegisteredFailureIncident,
  recordUserReportedIncident as recordPackagedUserReportedIncident,
} from "@oscharko-dev/keiko-server";
import {
  emitSecurityLogEvent,
  type SecurityLogEvent,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";

import { runAuditCli } from "../../packages/keiko-cli/src/audit.js";
import type { CliIo } from "../../packages/keiko-cli/src/runner.js";
import { createCliSecurityLogSink } from "../../packages/keiko-cli/src/security-log.js";
import { logMemoryAuditStateCacheSeeded } from "../../packages/keiko-server/src/deps-activity.js";
import {
  closeFileServerLogSinks,
  createActivityLogSink,
  createFileServerLogSink,
  formatServerLogLine,
  serverLogProcessIdentity,
  type ServerLogEnv,
} from "../../packages/keiko-server/src/observability/index.js";
import { createUpdateCandidateAuthority } from "../../packages/keiko-server/src/update-candidate-authority.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import {
  expectActivityLogScenario,
  type ScenarioIncidentRecorders,
} from "../support/activity-log-scenario.js";

// The two runtime-packages scenarios below write through the built package, so their incidents
// come from it too: one Activity Log writer instance per process (activity-log-scenario.ts).
const PACKAGED_INCIDENTS: ScenarioIncidentRecorders = {
  recordRegisteredFailureIncident: recordPackagedRegisteredFailureIncident,
  recordUserReportedIncident: recordPackagedUserReportedIncident,
};

function tempStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function silentIo(): CliIo {
  return {
    out: (_text: string): void => undefined,
    err: (_text: string): void => undefined,
  };
}

// A pid guaranteed not alive: a synchronously-spawned child has already exited by the time this
// returns, so the segment-recovery scenario's orphan is owned by a real, dead process rather than a
// fabricated number that could collide with one still running.
function exitedProcessId(): number {
  return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}

function minimalInstallMode(): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "package-manager",
    packageManager: "npm",
    installRoot: "/opt/keiko",
  };
}

// Mirrors packages/keiko-server/src/update-candidate-authority.test.ts's own minimal fixture: the
// exact field set `candidateSnapshot` requires to accept an update as a real, issuable candidate.
function minimalPreflightReport(): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-09-04T12:00:00.000Z",
    currentVersion: "0.3.17",
    targetVersion: "0.3.18",
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    installabilitySource: "npm-registry",
    userActionRequired: false,
    affectedStateStores: ["server-runtime"],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    release: {
      source: "github-release",
      tag: "v0.3.18",
      title: "Keiko 0.3.18",
      summary: "Reviewed update",
      notes: ["Reviewed update"],
    },
    impact: {
      entries: [],
      releaseNoteBullets: [],
      stateImpact: [],
      affectedStateStores: ["server-runtime"],
      userActionRequired: false,
      remediations: [],
    },
    warnings: [],
  };
}

describe("Activity Log scenario: lifecycle-crash storage lifecycle", () => {
  let stateDir: string;

  afterEach(() => {
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("prunes a stale legacy archive on the first segment open, fully evidenced", async () => {
    stateDir = tempStateDir("keiko-scenario-retention-");
    const logsDir = join(stateDir, "logs");
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const archive = join(logsDir, "server-2020-01-01.log");
    writeFileSync(archive, "legacy archive content\n".repeat(20), "utf8");
    const aged = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(archive, aged, aged);

    const startedAtMs = Date.now();
    const env: ServerLogEnv = { KEIKO_LOG_LEVEL: "debug" };
    const sink = createFileServerLogSink(stateDir, { env });
    logMemoryAuditStateCacheSeeded(sink, undefined, 3);

    const trace = await expectActivityLogScenario("lifecycle-crash.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["activity-log.retention.pruned"],
    });
    expect(trace.failureClasses).toContain("activity-log-retention");

    const raw = readPersistedActivityLog(stateDir);
    const [line] = persistedActivityLogLines(raw, "activity-log.retention.pruned");
    expect(
      expectActivityLogProof("activity-log.retention.pruned.emitted-line", line ?? ""),
    ).toMatchObject({
      retentionStatus: "pruned",
      prunedLegacyFileCount: 1,
      prunedByAgeCount: 1,
      failedDeletionCount: 0,
    });
  });

  // A crash recovery whose seal COMPLETED (the atomic link to the sealed name already landed) but
  // whose cleanup (unlinking the now-redundant .active twin) was interrupted is the one loss-lifecycle
  // condition on this surface that loses nothing: the full, terminated seal line is already on disk,
  // so recovery only finishes the unlink and reports `loss: none`. Fabricated here exactly as the
  // production crash-recovery path finds it on next startup: a sealed name and an `.active` twin of
  // the same segment, both already carrying the segment's real content (server-log.ts's own
  // `recoverOrphanedSegments` fault-injection tests build the fixture the same way).
  it("finishes a seal interrupted between its link and its unlink, evidenced as a lossless recovery", async () => {
    stateDir = tempStateDir("keiko-scenario-segment-recovery-");
    const logsDir = join(stateDir, "logs");
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const identity = {
      startMs: Date.now() - 1_000,
      pid: exitedProcessId(),
      instanceId: "5ea1ed00",
      index: 1,
    };
    // A real, build-conformant v2 envelope with every field `activity-log.segment.sealed` requires
    // (the production formatter, not a hand-rolled object) so the analyzer's evidence classification
    // sees "supported" — a torn/minimal or field-incomplete line here would make the WHOLE artifact
    // less than fully supported evidence, independent of what recovery itself reports.
    const sealLine = formatServerLogLine(
      {
        category: "diagnostic",
        op: "activity-log.segment.sealed",
        level: "info",
        // This op's causal:"correlation" registration requires the envelope's own correlationId
        // field to be present (not merely a `extra` field), so an omitted one is a missing-field
        // classification, not an absent-but-optional one.
        correlationId: "unknown-correlation-id",
        extra: {
          sealReason: "close",
          segmentIndex: identity.index,
          segmentFirstSeq: 1,
          segmentLastSeq: 7,
          segmentLineCount: 1,
          segmentBytes: 256,
          segmentDurationMs: 0,
          droppedEventCount: 0,
          segmentByteLimit: 8 * 1024 * 1024,
          segmentSecondsLimit: 3_600,
          completeness: "complete",
          loss: "none",
        },
      },
      new Date(identity.startMs),
      { ...serverLogProcessIdentity(), pid: identity.pid, instanceId: identity.instanceId, seq: 7 },
    );
    const activePath = join(logsDir, activityLogSegmentFileName(identity, "active"));
    const sealedPath = join(logsDir, activityLogSegmentFileName(identity, "sealed"));
    writeFileSync(activePath, sealLine, { mode: 0o600 });
    linkSync(activePath, sealedPath);

    const startedAtMs = Date.now();
    const env: ServerLogEnv = { KEIKO_LOG_LEVEL: "debug" };
    logMemoryAuditStateCacheSeeded(createFileServerLogSink(stateDir, { env }), undefined, 1);

    expect(lstatSync(sealedPath).nlink).toBe(1);
    const trace = await expectActivityLogScenario("lifecycle-crash.loss", {
      stateDir,
      startedAtMs,
      expectedOps: ["activity-log.segment.recovered"],
    });
    expect(trace.failureClasses).toContain("activity-log-segment");

    const raw = readPersistedActivityLog(stateDir);
    const [line] = persistedActivityLogLines(raw, "activity-log.segment.recovered");
    expect(
      expectActivityLogProof("activity-log.segment.recovered.emitted-line", line ?? ""),
    ).toMatchObject({
      recoveryStatus: "sealed",
      recoveryKind: "interrupted-seal",
      tailState: "terminated",
      completeness: "complete",
      loss: "none",
    });
  });
});

describe("Activity Log scenario: runtime-packages", () => {
  it("fails a local-state audit whose module has no export, fully evidenced", async () => {
    const root = tempStateDir("keiko-scenario-cli-audit-");
    const activityStateDir = join(root, "control");
    try {
      const startedAtMs = Date.now();
      const code = await runAuditCli(
        ["local-state"],
        silentIo(),
        { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" },
        {
          cwd: root,
          activityStateDir,
          activityLogSinkFactory: (dir: string): ReturnType<typeof createPackagedActivityLogSink> =>
            createPackagedActivityLogSink(dir, { level: "debug" }),
          loadAuditor: () => Promise.resolve({} as never),
        },
      );
      expect(code).toBe(1);

      const trace = await expectActivityLogScenario("runtime-packages.dependency-failure", {
        incidents: PACKAGED_INCIDENTS,
        stateDir: activityStateDir,
        startedAtMs,
        expectedOps: ["cli.audit.started", "cli.audit.failed"],
      });
      expect(trace.failureClasses).toContain("cli-audit");

      const raw = readPersistedActivityLog(activityStateDir);
      const [failed] = persistedActivityLogLines(raw, "cli.audit.failed");
      expect(expectActivityLogProof("cli.audit.failed.real-sink-line", failed ?? "")).toMatchObject(
        { reason: "missing-export", failureKind: "AuditLoadError" },
      );
    } finally {
      // Seals what the packaged graph opened here while the directory still exists.
      closePackagedFileServerLogSinks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function flakyOnceSinkFactory(dir: string): SecurityLogSink {
    const real = createPackagedActivityLogSink(dir, { level: "debug" });
    let calls = 0;
    return {
      write(event: SecurityLogEvent): void {
        calls += 1;
        if (calls === 1) throw new Error("scenario-fault-injection");
        real.write(event);
      },
    };
  }

  it("self-reports a keiko-security log sink failure as a fully evidenced loss", async () => {
    const stateDir = tempStateDir("keiko-scenario-security-log-sink-");
    try {
      const sink = createCliSecurityLogSink(stateDir, flakyOnceSinkFactory);
      const startedAtMs = Date.now();
      emitSecurityLogEvent(sink, {
        category: "security",
        op: "security.scenario.probe",
        level: "warn",
      });

      const trace = await expectActivityLogScenario("runtime-packages.loss", {
        incidents: PACKAGED_INCIDENTS,
        stateDir,
        startedAtMs,
        expectedOps: ["security.log.sink-failed"],
      });
      expect(trace.failureClasses).toContain("activity-log-sink");

      const raw = readPersistedActivityLog(stateDir);
      const [line] = persistedActivityLogLines(raw, "security.log.sink-failed");
      expect(
        expectActivityLogProof("security.log.sink-failed.body-free", line ?? ""),
      ).toMatchObject({ droppedOpDigest: expect.stringMatching(/^[0-9a-f]{16}$/u) as unknown });
    } finally {
      closePackagedFileServerLogSinks();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // `update.candidate.rejected` is a causal "failure": the analyzer requires a KNOWN correlation on
  // this line AND a matching `update.candidate.issued` start on that same correlation, so an
  // "unknown candidate" rejection (no prior issue at all) cannot itself be a complete scenario — its
  // own line would need either an unknown correlation (failing the causal-known check) or a known
  // one with no matching start (failing lifecycle-start-missing). Issuing a real candidate first and
  // rejecting it with a mismatched execution token gives the rejection a genuine causal parent.
  it("rejects a claim-mismatch consume on a known candidate, fully evidenced as a rejection", async () => {
    const stateDir = tempStateDir("keiko-scenario-update-candidate-");
    try {
      const authority = createUpdateCandidateAuthority({
        activityLog: createActivityLogSink(stateDir, { level: "debug" }),
      });
      const installMode = minimalInstallMode();
      const issueCorrelationId = randomUUID();

      const startedAtMs = Date.now();
      const claim = authority.issue(minimalPreflightReport(), installMode, issueCorrelationId);
      expect(claim).toBeDefined();
      if (claim === undefined) throw new Error("expected an issued update candidate claim");
      const outcome = authority.consume(
        {
          candidateId: claim.candidateId,
          confirmationDigest: claim.confirmationDigest,
          executionToken: "f".repeat(64),
          requestId: issueCorrelationId,
        },
        "0.3.17",
        installMode,
      );
      expect(outcome).toEqual({ ok: false, reason: "claim-mismatch" });

      const trace = await expectActivityLogScenario("runtime-packages.rejection", {
        stateDir,
        startedAtMs,
        expectedOps: ["update.candidate.issued", "update.candidate.rejected"],
      });
      expect(trace.failureClasses).toContain("update-candidate-authority");

      const raw = readPersistedActivityLog(stateDir);
      const [line] = persistedActivityLogLines(raw, "update.candidate.rejected");
      expect(expectActivityLogProof("update.candidate.rejected.reason", line ?? "")).toMatchObject({
        reason: "claim-mismatch",
      });
    } finally {
      closeFileServerLogSinks();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
