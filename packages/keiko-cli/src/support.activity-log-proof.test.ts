// Activity Log proofs for four still-pending `keiko support` operations (#3532 proof backlog,
// partition p4-cli): the install-layout refusal, the analysis classification evidence, and the two
// publication-evidence fields. None of the owning emitters (`emitSupportInstallLayoutRefusal`,
// `emitSupportAnalysisEvidence`, `emitSupportPublicationEvidence`) are exported, so each proof
// drives the real CLI entry point `runSupportCli`. The publication and analysis emitters build
// their OWN file sink via `server.createFileServerLogSink(stateDir)` with no injection seam at all
// (see support.ts), so those two proofs read back the REAL persisted Activity Log under a temp
// state dir — the "preferred for the CLI" real-sink path the task brief calls out.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-server";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import type { AuditResult } from "./audit.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
} from "./install-layout.js";
import type { CliIo } from "./runner.js";
import { resolveOutPath, runSupportCli, type SupportCliDeps } from "./support.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const tempRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(REAL_TMPDIR, prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  // The real file sink is a process-wide singleton per log directory (support.ts's publication and
  // analysis evidence build one directly, with no injection seam); a suite that leaves one
  // registered leaves its segment open past this test's own temp dir being removed below.
  closeFileServerLogSinks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeIo(): { readonly io: CliIo; readonly err: () => string } {
  const errChunks: string[] = [];
  return {
    io: { out: (): void => undefined, err: (text): void => void errChunks.push(text) },
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

// A minimal, structurally valid v2 Activity Log input line for `keiko support analyze` to classify
// as "supported" — this is fixture INPUT data for the analyzer under test, not the
// `support.analyze.classified` proof event itself (which only `emitSupportAnalysisEvidence` may
// produce), so building it here restates no production formula the proof depends on.
function supportedV2InputLine(): string {
  return JSON.stringify({
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
  });
}

describe("support activity log proofs", () => {
  it("persists cli.support.export.failed when a pending install-layout correction meets a symlinked state root", async () => {
    const outDir = makeRoot("keiko-support-proof-out-");
    const stateRoot = makeRoot("keiko-support-proof-state-");
    const stateDir = join(stateRoot, "state");
    const realStateDir = join(stateRoot, "real-state");
    mkdirSync(realStateDir, { recursive: true });
    symlinkSync(realStateDir, stateDir, "dir");
    const controlStateDir = join(outDir, "control-state");
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
    };
    const events: SecurityLogEvent[] = [];
    const { io } = makeIo();

    const code = await runSupportCli(["export", "--state-dir", stateDir], io, env, {
      cwd: outDir,
      controlActivityStateDir: controlStateDir,
      activityLogSinkFactory: () => ({ write: (event): void => void events.push(event) }),
      auditDeps: healthyAuditDeps(),
    });

    expect(code).toBe(1);
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof("cli.support.export.failed.install-layout-refusal", line);
    expect(record).toMatchObject({
      correlationId,
      errorKind: "unsafe-target",
      reason: "unsafe-state-root",
      failureKind: "SupportStateRootSymlinkError",
    });
    expect(record.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(events)).not.toContain(stateDir);
  });

  it("persists support.export.publication with evidence that matches the actually-committed bundle", async () => {
    const outDir = makeRoot("keiko-support-proof-out-");
    const stateDir = makeRoot("keiko-support-proof-state-");
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    const generatedAt = new Date("2026-08-21T12:00:00.000Z");
    const { io } = makeIo();

    const code = await runSupportCli(["export", "--state-dir", stateDir], io, AUDIT_ENV, {
      cwd: outDir,
      now: () => generatedAt,
      auditDeps: healthyAuditDeps(),
      evidenceStore: createInMemoryEvidenceStore(),
    });

    expect(code).toBe(0);
    const outPath = resolveOutPath(outDir, undefined, generatedAt);
    const committed = readFileSync(outPath);
    const committedSha256 = createHash("sha256").update(committed).digest("hex");

    const raw = readPersistedActivityLog(stateDir);
    const [publicationLine] = persistedActivityLogLines(raw, "support.export.publication");

    const evidenceRecord = expectActivityLogProof(
      "support.export.publication.publication-evidence",
      publicationLine ?? "",
    );
    expect(evidenceRecord).toMatchObject({
      publicationArtifactClass: "support-report",
      artifactCount: 2,
      persistenceStatus: "published",
      recoveryState: "none",
      receiptState: "consumed",
    });

    // "commit-last": the persisted line's digest/byte-count evidence must match the file that was
    // actually committed to disk, proving this line was written from the real post-commit outcome
    // rather than a value guessed before the artifact set was durably in place.
    const commitRecord = expectActivityLogProof(
      "support.export.publication.commit-last",
      publicationLine ?? "",
    );
    expect(commitRecord.reportSha256).toBe(committedSha256);
    expect(commitRecord.reportBytes).toBe(committed.byteLength);
  });

  it("persists support.analyze.classified for a supported v2 input line", async () => {
    const outDir = makeRoot("keiko-support-proof-out-");
    const stateDir = makeRoot("keiko-support-proof-state-");
    const analyzeFile = join(outDir, "input.jsonl");
    writeFileSync(analyzeFile, `${supportedV2InputLine()}\n`, "utf8");
    const { io } = makeIo();

    const code = await runSupportCli(
      ["analyze", analyzeFile],
      io,
      { KEIKO_STATE_DIR: stateDir },
      {
        cwd: outDir,
      },
    );

    expect(code).toBe(0);
    const raw = readPersistedActivityLog(stateDir);
    const [classifiedLine] = persistedActivityLogLines(raw, "support.analyze.classified");
    const record = expectActivityLogProof(
      "support.analyze.classified.classification-evidence",
      classifiedLine ?? "",
    );
    expect(record).toMatchObject({
      sourceKind: "raw-log",
      evidenceClassification: "supported",
      supportedLineCount: 1,
      completeness: "complete",
      loss: "none",
    });
  });
});
