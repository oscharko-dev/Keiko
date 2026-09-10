import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_HEALTH_LABELS } from "@oscharko-dev/keiko-contracts/runtime/update-local-state";
import {
  createUpdateLocalStateManager,
  UpdateRuntimeStateError,
  type UpdateLocalStateManager,
} from "./update-local-state.js";
import { digestUpdateCandidate } from "./update-candidate-authority.js";

const tempRoots: string[] = [];
const NOW = Date.parse("2026-06-30T12:00:00.000Z");

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-update-state-"));
  tempRoots.push(root);
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function touch(path: string, content = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function manager(stateDir: string, ids: readonly string[]): UpdateLocalStateManager {
  let index = 0;
  return createUpdateLocalStateManager({
    stateDir,
    now: () => NOW,
    idFactory: () => ids[index++] ?? `id-${String(index)}`,
  });
}

function cancellablePreparedState(
  localState: UpdateLocalStateManager,
): ReturnType<UpdateLocalStateManager["readRuntimeState"]> {
  const candidate = {
    schemaVersion: "1" as const,
    candidateId: "candidate-0.2.12",
    currentVersion: "0.2.11",
    targetVersion: "0.2.12",
    channel: "stable" as const,
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "package-manager" as const,
      packageManager: "npm" as const,
      installIdentitySha256: "e".repeat(64),
    },
    release: { source: "github-release" as const, tag: "v0.2.12" },
    releaseImpactDigest: "f".repeat(64),
    issuedAt: "2026-06-30T11:00:00.000Z",
    expiresAt: "2026-06-30T13:00:00.000Z",
  };
  const activeSession = {
    schemaVersion: "1" as const,
    sessionId: "session-1",
    candidateId: candidate.candidateId,
    candidateDigest: digestUpdateCandidate(candidate),
    correlationId: "corr-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion: candidate.targetVersion,
    phase: "running" as const,
    lifecycle: {
      phase: "staging" as const,
      progress: { completedBytes: 1, totalBytes: 2 },
      cancellationCutoff: "not-reached" as const,
    },
    failureReason: "none" as const,
    packageManager: "npm" as const,
    startedAt: "2026-06-30T11:00:00.000Z",
    updatedAt: "2026-06-30T11:00:00.000Z",
    cancelable: true,
    retryable: false,
    restartRequired: false,
    message: "Preparing handoff.",
  };
  const initial = localState.readRuntimeState();
  return localState.writeRuntimeState({
    ...initial,
    activeSession,
    activeCandidate: candidate,
    activationWal: {
      activationId: "a".repeat(32),
      planSha256: "b".repeat(64),
      coordinatorSha256: "c".repeat(64),
      intentRevision: initial.revision + 1,
      checkpoint: "prepared",
      receiptSequence: 0,
    },
  });
}

function seedTerminalCompletedState(
  stateDir: string,
  localState: UpdateLocalStateManager,
): ReturnType<UpdateLocalStateManager["readRuntimeState"]> {
  const prepared = cancellablePreparedState(localState);
  const activeSession = prepared.activeSession;
  const activationWal = prepared.activationWal;
  if (activeSession === undefined || activationWal === undefined) {
    throw new TypeError("expected prepared handoff state");
  }
  const terminalSession = {
    ...activeSession,
    phase: "succeeded" as const,
    lifecycle: {
      ...activeSession.lifecycle,
      phase: "succeeded" as const,
      cancellationCutoff: "handoff-committed" as const,
    },
    cancelable: false,
    retryable: false,
    restartRequired: false,
  };
  const complete = {
    ...prepared,
    activeSession: undefined,
    activeCandidate: undefined,
    lastSession: terminalSession,
    activationWal: {
      ...activationWal,
      checkpoint: "complete" as const,
      receiptSequence: 14,
      receiptSha256: "4".repeat(64),
      coordinatorId: activationWal.coordinatorSha256,
    },
    recovery: {
      status: "reconciling" as const,
      sessionId: terminalSession.sessionId,
      updatedAt: "2026-06-30T12:00:00.000Z",
    },
  };
  writeFileSync(
    join(stateDir, "updates", "runtime-state.json"),
    `${JSON.stringify(complete, null, 2)}\n`,
    "utf8",
  );
  return localState.readRuntimeState();
}

function seedSensitiveState(stateDir: string): void {
  touch(join(stateDir, "keiko.config.json"), '{"path":"/Users/alice/private-bank-repo"}');
  touch(join(stateDir, "credentials", "provider-credentials.vault"), "sk-secret-from-vault");
  touch(join(stateDir, "memory", "keiko-memory.db"), "PROMPT: customer prompt text");
  touch(join(stateDir, "local-knowledge", "default", "capsules.db"), "MODEL OUTPUT BODY");
  touch(join(stateDir, "ui.log"), "npm install @oscharko-dev/keiko raw package-manager output");
  touch(join(stateDir, "evidence", "run-1.json"), '{"modelOutput":"raw model output"}');
  touch(join(stateDir, "customer-repo", "secret.txt"), "customer repository file");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("update local state compatibility scan", () => {
  it("maps release impact to plain health labels without reading model credentials", () => {
    const stateDir = makeStateDir();
    touch(join(stateDir, "credentials", "provider-credentials.vault"), "sk-do-not-read");
    touch(join(stateDir, "memory", "keiko-memory.db"));
    touch(join(stateDir, "local-knowledge", "default", "capsules.db"));

    const scan = manager(stateDir, ["scan-id"]).scanCompatibility({
      affectedStateStores: ["package-install"],
      userActionRequired: true,
      stateImpact: [
        {
          store: "memory",
          description: "Memory requires a reviewed carry-forward action.",
          remediation: "repair-required",
          userActionRequired: true,
        },
        {
          store: "local knowledge",
          description: "Local Knowledge must be refreshed.",
          remediation: "local-knowledge-reindex-required",
          userActionRequired: false,
        },
      ],
    });

    const memory = scan.stores.find((store) => store.store === "memory-vault");
    const knowledge = scan.stores.find((store) => store.store === "local-knowledge");
    const packageInstall = scan.stores.find((store) => store.store === "package-install");
    expect(memory?.health).toBe("needs-action");
    expect(memory?.healthLabel).toBe(UPDATE_HEALTH_LABELS["needs-action"]);
    expect(knowledge?.health).toBe("ready");
    expect(knowledge?.healthLabel).toBe(UPDATE_HEALTH_LABELS.ready);
    expect(packageInstall?.health).toBe("needs-action");
    expect(scan.stores.map((store) => store.healthLabel)).toEqual(
      expect.arrayContaining(["Ready", "Needs action", "Not affected"]),
    );
    expect(JSON.stringify(scan)).not.toContain("sk-do-not-read");
  });

  it("retains unreadable owned subtrees instead of throwing", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const stateDir = makeStateDir();
    const memoryDir = join(stateDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    chmodSync(memoryDir, 0);
    try {
      const scan = manager(stateDir, ["scan-id"]).scanCompatibility({
        affectedStateStores: ["memory-vault"],
        userActionRequired: true,
      });
      const memory = scan.stores.find((store) => store.store === "memory-vault");

      expect(scan.stateDirStatus).toBe("directory");
      expect(memory).toMatchObject({
        health: "manual-review-required",
        retainedEntryCount: 1,
      });
    } finally {
      chmodSync(memoryDir, 0o700);
    }
  });

  it("fails affected compatibility closed when the bounded scan cannot finish", () => {
    const stateDir = makeStateDir();
    let nested = join(stateDir, "memory");
    for (let depth = 0; depth <= 64; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested, { recursive: true });
    }

    const scan = manager(stateDir, ["scan-id"]).scanCompatibility({
      affectedStateStores: ["memory-vault"],
      remediation: "repair-required",
      userActionRequired: true,
    });

    expect(scan.stores.find((store) => store.store === "memory-vault")?.health).toBe(
      "manual-review-required",
    );
    expect(scan.warnings).toEqual([
      expect.stringMatching(/scan stopped after reaching the depth safety limit/i),
    ]);
    expect(scan.warnings.join(" ")).not.toMatch(/corrupt/i);
  });
});

describe("update recovery snapshots", () => {
  it("writes content-free manifests without customer files, secrets, raw logs, or private paths", () => {
    const stateDir = makeStateDir();
    seedSensitiveState(stateDir);

    const snapshot = manager(stateDir, ["snap-privacy"]).createRecoverySnapshot({
      fromVersion: "0.2.11",
      toVersion: "0.2.12",
      impact: {
        affectedStateStores: [
          "durable-config",
          "memory-vault",
          "local-knowledge",
          "evidence",
          "package-install",
        ],
      },
    });

    const manifestPath = join(stateDir, "updates", "snapshots", "snap-privacy", "manifest.json");
    const manifest = readFileSync(manifestPath, "utf8");
    expect(snapshot.status).toBe("created");
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.every((entry) => !Object.hasOwn(entry, "relativePath"))).toBe(true);
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-privacy", "files"))).toBe(false);
    for (const forbidden of [
      stateDir,
      "/Users/alice/private-bank-repo",
      "sk-secret-from-vault",
      "PROMPT: customer prompt text",
      "MODEL OUTPUT BODY",
      "raw package-manager output",
      "raw model output",
      "customer repository file",
    ]) {
      expect(manifest).not.toContain(forbidden);
    }
    expect(manager(stateDir, ["unused"]).validateRecoverySnapshot("snap-privacy")).toBe(true);
  });

  it("retains only the latest valid previous-version snapshot", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, ["snap-old", "snap-new"]);

    localState.createRecoverySnapshot({ fromVersion: "0.2.10", toVersion: "0.2.11" });
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-old"))).toBe(true);
    localState.createRecoverySnapshot({ fromVersion: "0.2.11", toVersion: "0.2.12" });

    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-old"))).toBe(false);
    expect(existsSync(join(stateDir, "updates", "snapshots", "snap-new"))).toBe(true);
    expect(localState.validateRecoverySnapshot("snap-new")).toBe(true);
  });

  it("fails closed on a symlinked state root", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = mkdtempSync(join(tmpdir(), "keiko-update-symlink-"));
    tempRoots.push(root);
    const target = join(root, "outside-state");
    const stateDir = join(root, ".keiko");
    mkdirSync(target, { recursive: true });
    touch(join(target, "memory", "keiko-memory.db"), "outside");
    symlinkSync(target, stateDir, "dir");

    const localState = manager(stateDir, ["snap-symlink"]);
    const snapshot = localState.createRecoverySnapshot({
      fromVersion: "0.2.11",
      toVersion: "0.2.12",
      impact: { affectedStateStores: ["memory"] },
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.stateDirStatus).toBe("symlink");
    expect(snapshot.entries).toHaveLength(0);
    expect(localState.validateRecoverySnapshot("snap-symlink")).toBe(false);
  });

  it("does not publish or prune snapshots from an incomplete scan", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, ["snap-valid", "snap-incomplete"]);
    const valid = localState.createRecoverySnapshot({
      fromVersion: "0.2.10",
      toVersion: "0.2.11",
    });
    let nested = join(stateDir, "memory");
    for (let depth = 0; depth <= 64; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested, { recursive: true });
    }

    const incomplete = localState.createRecoverySnapshot({
      fromVersion: "0.2.11",
      toVersion: "0.2.12",
      impact: { affectedStateStores: ["memory-vault"] },
    });

    expect(valid.status).toBe("created");
    expect(incomplete).toMatchObject({ status: "failed", entries: [] });
    expect(incomplete.warnings).toEqual([
      expect.stringMatching(/scan stopped after reaching the depth safety limit/i),
    ]);
    expect(localState.validateRecoverySnapshot("snap-valid")).toBe(true);
    expect(localState.validateRecoverySnapshot("snap-incomplete")).toBe(false);
  });
});

describe("update local-state repair", () => {
  it("performs no partial permission repair when the scan is incomplete", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const stateDir = makeStateDir();
    const memoryDir = join(stateDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    chmodSync(memoryDir, 0o755);
    let nested = memoryDir;
    for (let depth = 0; depth <= 64; depth += 1) {
      nested = join(nested, "d");
      mkdirSync(nested, { recursive: true });
    }

    const repair = manager(stateDir, ["unused"]).repairStores(["memory-vault"]);

    expect(repair).toMatchObject({
      status: "manual-review-required",
      repairedArtifactCount: 0,
      retainedEntryCount: 0,
    });
    expect(repair.warnings).toEqual([
      expect.stringMatching(/scan stopped after reaching the depth safety limit/i),
    ]);
    expect(statSync(memoryDir).mode & 0o777).toBe(0o755);
  });
});

describe("update runtime state and audit events", () => {
  it("keeps a fresh remediation lease when PID liveness is temporarily unavailable", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(
      leasePath,
      JSON.stringify({
        pid: 42_424,
        token: "current-lease",
        acquiredAt: "2026-06-30T11:59:59.500Z",
      }),
    );
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      pidAlive: () => false,
      remediationLeaseStaleMs: 1_000,
    });

    expect(localState.acquireRemediationLease(actionId)).toBeUndefined();
    expect(existsSync(leasePath)).toBe(true);
  });

  it("reclaims an aged remediation lease even when its pid was reused", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(
      leasePath,
      JSON.stringify({
        pid: 42_424,
        token: "abandoned-lease",
        acquiredAt: "2026-06-30T11:59:00.000Z",
      }),
    );
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      pidAlive: () => true,
      remediationLeaseStaleMs: 1_000,
    });

    const release = localState.acquireRemediationLease(actionId);

    expect(release).toBeTypeOf("function");
    release?.();
    expect(existsSync(leasePath)).toBe(false);
  });

  it("keeps a fresh malformed remediation lease during its publication grace window", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(leasePath, "{");
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      remediationLeaseStaleMs: 1_000,
    });

    expect(localState.acquireRemediationLease(actionId)).toBeUndefined();
    expect(existsSync(leasePath)).toBe(true);
  });

  it("quarantines an aged malformed remediation lease before continuing", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(leasePath, "{");
    const old = new Date(NOW - 2_000);
    utimesSync(leasePath, old, old);
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      remediationLeaseStaleMs: 1_000,
    });

    const release = localState.acquireRemediationLease(actionId);

    expect(release).toBeTypeOf("function");
    expect(existsSync(`${leasePath}.corrupt.2026-06-30T12-00-00-000Z`)).toBe(true);
    release?.();
  });

  it("trusts same-process lease ownership over a failed liveness probe", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(
      leasePath,
      JSON.stringify({
        pid: process.pid,
        token: "current-process-lease",
        acquiredAt: "2026-06-30T11:00:00.000Z",
        processIdentity: "current-process-instance",
      }),
    );
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      pidAlive: () => false,
      processIdentity: "current-process-instance",
      remediationLeaseStaleMs: 1_000,
    });

    expect(localState.acquireRemediationLease(actionId)).toBeUndefined();
    expect(existsSync(leasePath)).toBe(true);
  });

  it("reclaims an aged lease from a prior process instance with the same pid", () => {
    const stateDir = makeStateDir();
    const actionId = "local-state-repair:memory-vault";
    const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
    const leasePath = join(stateDir, "updates", "remediation-leases", `${digest}.json`);
    touch(
      leasePath,
      JSON.stringify({
        pid: process.pid,
        token: "prior-process-lease",
        acquiredAt: "2026-06-30T11:00:00.000Z",
        processIdentity: "prior-process-instance",
      }),
    );
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      pidAlive: () => true,
      processIdentity: "replacement-process-instance",
      remediationLeaseStaleMs: 1_000,
    });

    const release = localState.acquireRemediationLease(actionId);

    expect(release).toBeTypeOf("function");
    release?.();
  });

  it("surfaces audit persistence failure without discarding recovery runtime state", () => {
    const stateDir = makeStateDir();
    const record = vi.fn();
    const localState = createUpdateLocalStateManager({
      stateDir,
      now: () => NOW,
      idFactory: () => "event-1",
      activityLog: {
        write: () => {
          throw new Error("sink unavailable");
        },
      },
      diagnostics: { record },
    });
    localState.writeRuntimeState({
      ...localState.readRuntimeState(),
      targetVersion: "0.2.12",
    });

    const result = localState.recordAuditEvent("user-confirmed", {
      targetVersion: "0.2.12",
      status: "succeeded",
    });

    expect(result.warning).toBe("Update activity event could not be emitted.");
    expect(result.event).toMatchObject({
      eventId: "event-1",
      type: "user-confirmed",
      targetVersion: "0.2.12",
      status: "succeeded",
    });
    expect(localState.readRuntimeState().targetVersion).toBe("0.2.12");
    expect(existsSync(join(stateDir, "updates", "update-audit.jsonl"))).toBe(false);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update.runtime.activity-log",
        source: "update-local-state",
      }),
    );
  });

  it("migrates legacy runtime facts without fabricating a terminal session", () => {
    const stateDir = makeStateDir();
    touch(
      join(stateDir, "updates", "runtime-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-06-30T11:00:00.000Z",
        targetVersion: "0.2.12",
        snapshotId: "snapshot-legacy",
        remediations: [],
        warnings: [],
      }),
    );
    const localState = manager(stateDir, []);

    expect(localState.inspectRuntimeState()).toMatchObject({
      status: "migrated",
      state: {
        schemaVersion: 2,
        revision: 1,
        targetVersion: "0.2.12",
        snapshotId: "snapshot-legacy",
        recovery: { status: "none" },
      },
    });
    expect(localState.readRuntimeState()).not.toHaveProperty("lastSession");
  });

  it("distinguishes corrupt, incompatible, and unwritable runtime state", () => {
    const corruptDir = makeStateDir();
    touch(join(corruptDir, "updates", "runtime-state.json"), "{broken");
    expect(manager(corruptDir, []).inspectRuntimeState()).toEqual({ status: "corrupt" });

    const incompatibleDir = makeStateDir();
    touch(
      join(incompatibleDir, "updates", "runtime-state.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    expect(manager(incompatibleDir, []).inspectRuntimeState()).toEqual({ status: "incompatible" });

    const unwritableDir = makeStateDir();
    mkdirSync(join(unwritableDir, "updates", "runtime-state.json"), { recursive: true });
    const unwritable = manager(unwritableDir, []);
    expect(unwritable.inspectRuntimeState()).toEqual({ status: "unwritable" });
    expect(() => unwritable.readRuntimeState()).toThrow(UpdateRuntimeStateError);
  });

  it.each([
    ["session lock", "update-session.lock"],
    ["legacy portable recovery", "portable-activation-recovery.json"],
  ])("fails closed when runtime state is missing beside a surviving %s", (_label, name) => {
    const stateDir = makeStateDir();
    touch(join(stateDir, "updates", name));

    expect(manager(stateDir, []).inspectRuntimeState()).toEqual({ status: "corrupt" });
    expect(() => manager(stateDir, []).readRuntimeState()).toThrow(UpdateRuntimeStateError);
  });

  it.each(["plan.khp", join("receipts", "000001.khr")])(
    "fails closed when runtime state is missing beside a surviving handoff %s",
    (relativeArtifact) => {
      const stateDir = makeStateDir();
      touch(join(stateDir, "updates", "handoff", "a".repeat(32), relativeArtifact));

      expect(manager(stateDir, []).inspectRuntimeState()).toEqual({ status: "corrupt" });
    },
  );

  it("initializes a truly fresh store when no interrupted ownership artifact survives", () => {
    const stateDir = makeStateDir();
    mkdirSync(join(stateDir, "updates", "handoff"), { recursive: true });

    expect(manager(stateDir, []).inspectRuntimeState()).toMatchObject({
      status: "missing",
      state: { revision: 0, recovery: { status: "none" } },
    });
  });

  it("binds each validated aggregate to the exact bytes read from its descriptor", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const first = localState.writeRuntimeState(localState.readRuntimeState());
    const path = join(stateDir, "updates", "runtime-state.json");
    const firstRaw = readFileSync(path, "utf8");
    const firstInspection = localState.inspectRuntimeState();
    expect(firstInspection).toMatchObject({ status: "ok", state: first });
    if (firstInspection.status !== "ok") throw new TypeError("expected validated aggregate");
    expect(firstInspection.contentSha256).toBe(
      createHash("sha256").update(firstRaw, "utf8").digest("hex"),
    );

    const second = localState.writeRuntimeState({
      ...first,
      targetVersion: "0.2.12",
      snapshotId: "récovery-snapshot",
    });
    const secondRaw = readFileSync(path, "utf8");
    const secondInspection = localState.inspectRuntimeState();
    expect(secondInspection).toMatchObject({ status: "ok", state: second });
    if (secondInspection.status !== "ok") throw new TypeError("expected validated aggregate");
    expect(secondInspection.contentSha256).toBe(
      createHash("sha256").update(secondRaw, "utf8").digest("hex"),
    );
    expect(secondInspection.contentSha256).not.toBe(firstInspection.contentSha256);

    const malformedUtf8 = Buffer.from(secondRaw, "utf8");
    const accent = malformedUtf8.indexOf(Buffer.from("é", "utf8"));
    expect(accent).toBeGreaterThanOrEqual(0);
    malformedUtf8[accent + 1] = 0x28;
    writeFileSync(path, malformedUtf8);
    expect(localState.inspectRuntimeState()).toEqual({ status: "corrupt" });
  });

  it("atomically advances the aggregate revision without retaining a temporary file", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const initial = localState.readRuntimeState();
    const first = localState.writeRuntimeState({ ...initial, targetVersion: "0.2.12" });
    const second = localState.writeRuntimeState({ ...first, targetVersion: "0.2.13" });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(localState.readRuntimeState()).toMatchObject({
      revision: 2,
      targetVersion: "0.2.13",
    });
    expect(readdirSync(join(stateDir, "updates"))).toEqual(["runtime-state.json"]);
  });

  it("rejects stale revision writes instead of silently losing a concurrent update", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const stale = localState.readRuntimeState();
    localState.writeRuntimeState({ ...stale, targetVersion: "0.2.12" });

    expect(() => localState.writeRuntimeState({ ...stale, targetVersion: "0.2.13" })).toThrow(
      UpdateRuntimeStateError,
    );
    expect(localState.readRuntimeState().targetVersion).toBe("0.2.12");
  });

  it("persists only a closed, digest-bound activation WAL intent", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const initial = localState.readRuntimeState();
    const activationWal = {
      activationId: "a".repeat(32),
      planSha256: "b".repeat(64),
      coordinatorSha256: "c".repeat(64),
      intentRevision: 1,
      checkpoint: "prepared" as const,
      receiptSequence: 0,
    };
    const written = localState.writeRuntimeState({
      ...initial,
      activationWal,
    });

    expect(localState.readRuntimeState().activationWal).toEqual(written.activationWal);
    expect(() =>
      localState.writeRuntimeState({
        ...written,
        activationWal: { ...activationWal, checkpoint: "fabricated-success" as "complete" },
      }),
    ).toThrow(UpdateRuntimeStateError);
    expect(() =>
      localState.writeRuntimeState({
        ...written,
        activationWal: { ...activationWal, checkpoint: "old-exited" },
      }),
    ).toThrow(UpdateRuntimeStateError);

    const firstReceipt = localState.writeRuntimeState({
      ...written,
      activationWal: {
        ...activationWal,
        checkpoint: "old-exited",
        receiptSequence: 1,
        receiptSha256: "d".repeat(64),
      },
    });
    const firstWal = firstReceipt.activationWal;
    expect(firstWal).toBeDefined();
    if (firstWal === undefined) throw new Error("Expected the first activation receipt WAL.");
    expect(() =>
      localState.writeRuntimeState({
        ...firstReceipt,
        activationWal: {
          ...firstWal,
          receiptSequence: 2,
          receiptSha256: "d".repeat(64),
        },
      }),
    ).toThrow(UpdateRuntimeStateError);
  });

  it("settles only an unchanged pre-ACK prepared WAL as absent", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const prepared = cancellablePreparedState(localState);

    const settled = localState.writeRuntimeState({ ...prepared, activationWal: undefined });

    expect(settled.activationWal).toBeUndefined();
    expect(settled.activeSession).toEqual(prepared.activeSession);
    expect(settled.activeCandidate).toEqual(prepared.activeCandidate);
  });

  it.each([
    [
      "receipt exists",
      { checkpoint: "old-exited" as const, receiptSequence: 1, receiptSha256: "d".repeat(64) },
    ],
    ["coordinator accepted", { coordinatorId: "c".repeat(64) }],
  ])("refuses prepared-WAL removal when %s", (_label, walPatch) => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const prepared = cancellablePreparedState(localState);
    const activationWal = prepared.activationWal;
    if (activationWal === undefined) throw new TypeError("expected prepared activation WAL");
    const advanced = localState.writeRuntimeState({
      ...prepared,
      activationWal: { ...activationWal, ...walPatch },
    });

    expect(() => localState.writeRuntimeState({ ...advanced, activationWal: undefined })).toThrow(
      UpdateRuntimeStateError,
    );
  });

  it("refuses prepared-WAL removal when the active session is removed", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const prepared = cancellablePreparedState(localState);

    expect(() =>
      localState.writeRuntimeState({
        ...prepared,
        activeSession: undefined,
        activeCandidate: undefined,
        activationWal: undefined,
      }),
    ).toThrow(UpdateRuntimeStateError);
  });

  it("refuses prepared-WAL removal after the cancellation cutoff", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const prepared = cancellablePreparedState(localState);
    const activeSession = prepared.activeSession;
    if (activeSession === undefined) throw new TypeError("expected active session");

    expect(() =>
      localState.writeRuntimeState({
        ...prepared,
        activeSession: {
          ...activeSession,
          cancelable: false,
          lifecycle: {
            ...activeSession.lifecycle,
            cancellationCutoff: "handoff-committed",
          },
        },
        activationWal: undefined,
      }),
    ).toThrow(UpdateRuntimeStateError);
  });

  it("refuses to clear a complete WAL without its exact successful settlement projection", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const prepared = cancellablePreparedState(localState);
    const activationWal = prepared.activationWal;
    if (activationWal === undefined) throw new TypeError("expected prepared activation WAL");
    const complete = {
      ...prepared,
      activationWal: {
        ...activationWal,
        checkpoint: "complete" as const,
        receiptSequence: 14,
        receiptSha256: "4".repeat(64),
        coordinatorId: "5".repeat(64),
      },
    };
    writeFileSync(
      join(stateDir, "updates", "runtime-state.json"),
      JSON.stringify(complete),
      "utf8",
    );

    expect(() => localState.writeRuntimeState({ ...complete, activationWal: undefined })).toThrow(
      UpdateRuntimeStateError,
    );
  });

  it("clears a receipt-bound complete WAL for an unchanged terminal session", () => {
    const stateDir = makeStateDir();
    const localState = manager(stateDir, []);
    const complete = seedTerminalCompletedState(stateDir, localState);

    const settled = localState.writeRuntimeState({
      ...complete,
      activationWal: undefined,
      recovery: {
        status: "settled",
        sessionId: complete.lastSession?.sessionId,
        updatedAt: "2026-06-30T12:00:00.000Z",
      },
    });

    expect(settled.activationWal).toBeUndefined();
    expect(settled.activeSession).toBeUndefined();
    expect(settled.activeCandidate).toBeUndefined();
    expect(settled.lastSession).toEqual(complete.lastSession);
    expect(settled.recovery).toEqual({
      status: "settled",
      sessionId: complete.lastSession?.sessionId,
      updatedAt: "2026-06-30T12:00:00.000Z",
    });
  });

  it.each(["cleanup-pending", "missing-receipt", "stale-recovery", "altered-last"] as const)(
    "refuses terminal handoff settlement with %s authority",
    (mismatch) => {
      const stateDir = makeStateDir();
      const localState = manager(stateDir, []);
      let complete = seedTerminalCompletedState(stateDir, localState);
      if (mismatch === "cleanup-pending" || mismatch === "missing-receipt") {
        const activationWal = complete.activationWal;
        if (activationWal === undefined) throw new TypeError("expected complete activation WAL");
        complete = {
          ...complete,
          activationWal:
            mismatch === "cleanup-pending"
              ? { ...activationWal, checkpoint: "cleanup-pending" }
              : { ...activationWal, receiptSequence: 0, receiptSha256: undefined },
        };
        writeFileSync(
          join(stateDir, "updates", "runtime-state.json"),
          `${JSON.stringify(complete, null, 2)}\n`,
          "utf8",
        );
        complete = localState.readRuntimeState();
      }
      const lastSession = complete.lastSession;
      if (lastSession === undefined) throw new TypeError("expected terminal session");
      const next = {
        ...complete,
        activationWal: undefined,
        recovery: {
          status: "settled" as const,
          sessionId: mismatch === "stale-recovery" ? "other-session" : lastSession.sessionId,
          updatedAt: "2026-06-30T12:00:00.000Z",
        },
        ...(mismatch === "altered-last"
          ? { lastSession: { ...lastSession, message: "altered terminal session" } }
          : {}),
      };

      expect(() => localState.writeRuntimeState(next)).toThrow(UpdateRuntimeStateError);
    },
  );

  it.each(["dropped", "swapped", "modified"] as const)(
    "refuses remediation settlement with a %s accepted candidate",
    (candidateChange) => {
      const stateDir = makeStateDir();
      const localState = manager(stateDir, []);
      const prepared = cancellablePreparedState(localState);
      const activationWal = prepared.activationWal;
      const originalCandidate = prepared.activeCandidate;
      const originalSession = prepared.activeSession;
      if (activationWal === undefined) throw new TypeError("expected prepared activation WAL");
      if (originalCandidate === undefined) throw new TypeError("expected active candidate");
      if (originalSession === undefined) throw new TypeError("expected active session");
      const complete = {
        ...prepared,
        activationWal: {
          ...activationWal,
          checkpoint: "complete" as const,
          receiptSequence: 14,
          receiptSha256: "4".repeat(64),
          coordinatorId: "5".repeat(64),
        },
      };
      writeFileSync(
        join(stateDir, "updates", "runtime-state.json"),
        JSON.stringify(complete),
        "utf8",
      );
      const activeCandidate =
        candidateChange === "dropped"
          ? undefined
          : candidateChange === "swapped"
            ? { ...originalCandidate, candidateId: "candidate-swapped" }
            : { ...originalCandidate, targetVersion: "0.2.99" };
      const activeSession = {
        ...originalSession,
        phase: "restart-required" as const,
        lifecycle: {
          ...originalSession.lifecycle,
          phase: "remediation-required" as const,
          cancellationCutoff: "handoff-committed" as const,
        },
        cancelable: false,
        restartRequired: false,
      };

      expect(() =>
        localState.writeRuntimeState({
          ...complete,
          activeSession,
          activeCandidate,
          activationWal: undefined,
          recovery: {
            status: "settled",
            sessionId: activeSession.sessionId,
            updatedAt: "2026-06-30T12:00:00.000Z",
          },
        }),
      ).toThrow(UpdateRuntimeStateError);
    },
  );

  it("rejects linked, oversized, and structurally unbounded runtime state", () => {
    const linkedDir = makeStateDir();
    const external = join(dirname(linkedDir), "external-runtime-state.json");
    touch(external, JSON.stringify({ schemaVersion: 2 }));
    mkdirSync(join(linkedDir, "updates"), { recursive: true });
    symlinkSync(external, join(linkedDir, "updates", "runtime-state.json"));
    expect(manager(linkedDir, []).inspectRuntimeState()).toEqual({ status: "unwritable" });

    const oversizedDir = makeStateDir();
    touch(join(oversizedDir, "updates", "runtime-state.json"), "x".repeat(1_048_577));
    expect(manager(oversizedDir, []).inspectRuntimeState()).toEqual({ status: "corrupt" });

    const malformedDir = makeStateDir();
    touch(
      join(malformedDir, "updates", "runtime-state.json"),
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        updatedAt: "2026-06-30T12:00:00.000Z",
        recovery: { status: "success", updatedAt: "2026-06-30T12:00:00.000Z" },
        remediations: [],
        warnings: [],
        arbitraryBody: "must not persist",
      }),
    );
    expect(manager(malformedDir, []).inspectRuntimeState()).toEqual({ status: "corrupt" });
  });
});
