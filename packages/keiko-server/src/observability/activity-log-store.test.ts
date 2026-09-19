// Store-policy unit tests (#3554, review comment 4050604711 on PR #3554): the pure primitives and
// the orchestration decision in activity-log-store.ts that give a shared `<stateDir>/logs/`
// directory ONE governing retention/pin-quota policy, whatever each cooperating process's own env
// says. Multi-process, real-writer coverage of the byte bound itself lives in
// `server-log.test.ts` ("activity log store policy"); the registered conflict-evidence line is
// proven through the production formatter in `server-log.activity-log-proof.test.ts`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import {
  ACTIVITY_LOG_STORE_POLICY_FILE_NAME,
  activityLogSegmentFileName,
  parseActivityLogFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  ACTIVITY_LOG_POLICY_SETTINGS,
  applyActivityLogRetention,
  isSoleActivityLogWriter,
  readActivityLogPolicyRecord,
  resolveActivityLogStorageConfig,
  resolveActivityLogStorePolicy,
  writeActivityLogPolicyRecord,
  type ActivityLogFileEntry,
  type ActivityLogPolicyValues,
  type ActivityLogWriterIdentity,
} from "./activity-log-store.js";

const tempDirs: string[] = [];

function makeLogsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-activity-log-store-"));
  tempDirs.push(root);
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VALUES_A: ActivityLogPolicyValues = {
  retentionBytes: 8 * 1024 * 1024,
  retentionDays: 14,
  pinQuotaBytes: 2 * 1024 * 1024,
};
const VALUES_B: ActivityLogPolicyValues = {
  retentionBytes: 32 * 1024 * 1024,
  retentionDays: 30,
  pinQuotaBytes: 4 * 1024 * 1024,
};

function identity(
  pid: number,
  instanceId: string,
  isAlive: (peerPid: number) => boolean,
): ActivityLogWriterIdentity {
  return { pid, instanceId, isAlive };
}

function policyPath(dir: string): string {
  return join(dir, ACTIVITY_LOG_STORE_POLICY_FILE_NAME);
}

function segmentEntry(
  state: "active" | "sealed",
  pid: number,
  instanceId: string,
): ActivityLogFileEntry {
  const name = activityLogSegmentFileName(
    { startMs: Date.now(), pid, instanceId, index: 1 },
    state,
  );
  const file = parseActivityLogFileName(name);
  if (file === undefined) throw new Error("expected a parseable segment name");
  return { file, path: name, sizeBytes: 0, mtimeMs: Date.now() };
}

// A real active-segment file on disk, so `resolveActivityLogStorePolicy`'s own directory listing
// (not a fixture-supplied one) sees the "peer".
function seedActiveSegment(dir: string, pid: number, instanceId: string): void {
  const name = activityLogSegmentFileName(
    { startMs: Date.now(), pid, instanceId, index: 1 },
    "active",
  );
  writeFileSync(join(dir, name), "", { mode: 0o600 });
}

describe("Activity Log store policy record I/O (#3554)", () => {
  it("publishes the first record exclusively; a second creator loses the race", () => {
    const dir = makeLogsDir();
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_A });
    expect(() => {
      writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_B });
    }).toThrow(SafeArtifactFileError);
    try {
      writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_B });
      throw new Error("expected the second create to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SafeArtifactFileError);
      expect((error as SafeArtifactFileError).kind).toBe("target-exists");
    }
    // Exactly one record survives, and it is the first writer's.
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_A });
  });

  it("rejects any record outside the closed schema as unreadable, never a thrown error", () => {
    const dir = makeLogsDir();
    const invalid: unknown[] = [
      { schemaVersion: 2, ...VALUES_A },
      { schemaVersion: 1, ...VALUES_A, extra: 1 },
      {
        schemaVersion: 1,
        retentionBytes: VALUES_A.retentionBytes,
        retentionDays: VALUES_A.retentionDays,
      },
      { schemaVersion: 1, ...VALUES_A, retentionBytes: 1 },
      { schemaVersion: 1, ...VALUES_A, retentionDays: 0 },
      { schemaVersion: 1, ...VALUES_A, pinQuotaBytes: -1 },
      { schemaVersion: 1, ...VALUES_A, retentionBytes: String(VALUES_A.retentionBytes) },
      { schemaVersion: "1", ...VALUES_A },
      [1, 2, 3],
      "not an object",
    ];
    for (const record of invalid) {
      writeFileSync(policyPath(dir), JSON.stringify(record), { mode: 0o600 });
      expect(readActivityLogPolicyRecord(dir, dir), JSON.stringify(record)).toBeUndefined();
    }
    writeFileSync(policyPath(dir), "not json at all", { mode: 0o600 });
    expect(readActivityLogPolicyRecord(dir, dir)).toBeUndefined();
  });
});

describe("isSoleActivityLogWriter (#3554)", () => {
  const self = { pid: 10, instanceId: "10101010" };

  it("is true with no segments at all", () => {
    expect(
      isSoleActivityLogWriter(
        [],
        identity(self.pid, self.instanceId, () => true),
      ),
    ).toBe(true);
  });

  it("ignores this process's own active segment", () => {
    const files = [segmentEntry("active", self.pid, self.instanceId)];
    expect(
      isSoleActivityLogWriter(
        files,
        identity(self.pid, self.instanceId, () => true),
      ),
    ).toBe(true);
  });

  it("ignores sealed segments regardless of owner liveness", () => {
    const files = [segmentEntry("sealed", 999, "99999999")];
    expect(
      isSoleActivityLogWriter(
        files,
        identity(self.pid, self.instanceId, () => true),
      ),
    ).toBe(true);
  });

  it("is true only when every foreign active segment's owner is confirmed gone", () => {
    const files = [segmentEntry("active", 999, "99999999")];
    expect(
      isSoleActivityLogWriter(
        files,
        identity(self.pid, self.instanceId, () => false),
      ),
    ).toBe(true);
  });

  it("is false while any foreign active segment's owner is confirmed alive", () => {
    const files = [segmentEntry("active", 999, "99999999")];
    expect(
      isSoleActivityLogWriter(
        files,
        identity(self.pid, self.instanceId, () => true),
      ),
    ).toBe(false);
  });
});

describe("resolveActivityLogStorePolicy (#3554)", () => {
  it("establishes the first process's own values when nothing is stored yet", () => {
    const dir = makeLogsDir();
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      VALUES_A,
      identity(1, "aaaaaaaa", () => true),
    );
    expect(outcome).toStrictEqual({ ...VALUES_A, conflict: undefined });
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_A });
  });

  it("adopts the stored record silently when a later process's env already matches it", () => {
    const dir = makeLogsDir();
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_A });
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      { ...VALUES_A },
      identity(2, "bbbbbbbb", () => true),
    );
    expect(outcome).toStrictEqual({ ...VALUES_A, conflict: undefined });
  });

  it("adopts the stored record and reports a conflict while a live peer holds the directory", () => {
    const dir = makeLogsDir();
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_A });
    seedActiveSegment(dir, 999_999, "cccccccc");
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      VALUES_B,
      identity(42, "dddddddd", (pid) => pid === 999_999),
    );
    expect(outcome).toStrictEqual({
      ...VALUES_A,
      conflict: {
        resolution: "adopted",
        conflictingSettings: [...ACTIVITY_LOG_POLICY_SETTINGS],
        stored: VALUES_A,
        requested: VALUES_B,
      },
    });
    // Adoption never mutates the stored record.
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_A });
  });

  it("reports only the settings that actually differ, never the ones that already match", () => {
    const dir = makeLogsDir();
    const stored = { ...VALUES_A };
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...stored });
    seedActiveSegment(dir, 999_999, "cccccccc");
    const requested = { ...stored, pinQuotaBytes: VALUES_B.pinQuotaBytes };
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      requested,
      identity(42, "dddddddd", (pid) => pid === 999_999),
    );
    expect(outcome.conflict?.conflictingSettings).toStrictEqual(["pinQuotaBytes"]);
  });

  it("replaces a stale record once this process is the store's sole live writer", () => {
    const dir = makeLogsDir();
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_A });
    // A leftover active-segment name from a peer that has since exited.
    seedActiveSegment(dir, 999_999, "cccccccc");
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      VALUES_B,
      identity(42, "dddddddd", () => false),
    );
    expect(outcome).toStrictEqual({
      ...VALUES_B,
      conflict: {
        resolution: "replaced",
        conflictingSettings: [...ACTIVITY_LOG_POLICY_SETTINGS],
        stored: VALUES_A,
        requested: VALUES_B,
      },
    });
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_B });
  });

  it("refuses to replace while a live peer's active segment is present, even repeatedly", () => {
    const dir = makeLogsDir();
    writeActivityLogPolicyRecord(dir, dir, { schemaVersion: 1, ...VALUES_A });
    seedActiveSegment(dir, 999_999, "cccccccc");
    const requester = identity(42, "dddddddd", (pid) => pid === 999_999);
    resolveActivityLogStorePolicy(dir, dir, VALUES_B, requester);
    resolveActivityLogStorePolicy(dir, dir, VALUES_B, requester);
    // Neither attempt replaced the stored record: it is still the peer's.
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_A });
  });

  it("treats a corrupt record as absent and silently republishes this process's own values", () => {
    const dir = makeLogsDir();
    writeFileSync(policyPath(dir), "not json", { mode: 0o600 });
    const outcome = resolveActivityLogStorePolicy(
      dir,
      dir,
      VALUES_A,
      identity(1, "eeeeeeee", () => true),
    );
    expect(outcome).toStrictEqual({ ...VALUES_A, conflict: undefined });
    expect(readActivityLogPolicyRecord(dir, dir)).toStrictEqual({ schemaVersion: 1, ...VALUES_A });
  });

  it("never throws and falls back to the requested values when the directory is unusable", () => {
    const missing = join(tmpdir(), `keiko-activity-log-store-missing-${String(Date.now())}`);
    let outcome: ReturnType<typeof resolveActivityLogStorePolicy> | undefined;
    expect(() => {
      outcome = resolveActivityLogStorePolicy(
        missing,
        missing,
        VALUES_A,
        identity(1, "ffffffff", () => true),
      );
    }).not.toThrow();
    expect(outcome).toStrictEqual({ ...VALUES_A, conflict: undefined });
  });
});

// #3557 review: a writer rotating make-before-break holds, for a moment, its full segment and its next
// one, created empty and admitted by its own re-check before it writes a byte. A peer must count that
// writer once: at the minimum budget two writers fit, and no event is dropped.
describe("applyActivityLogRetention active reservations (#3557)", () => {
  const segmentBytes = 32 * 1024;
  const config = resolveActivityLogStorageConfig({
    KEIKO_LOG_RETENTION_BYTES: String(64 * 1024),
    KEIKO_LOG_SEGMENT_BYTES: String(segmentBytes),
  });

  function active(instanceId: string, index: number, sizeBytes: number): ActivityLogFileEntry {
    const name = activityLogSegmentFileName(
      { startMs: Date.now(), pid: 4242, instanceId, index },
      "active",
    );
    const file = parseActivityLogFileName(name);
    if (file === undefined) throw new Error("expected a parseable segment name");
    return { file, path: name, sizeBytes, mtimeMs: Date.now() };
  }

  function admitsAnotherSegment(files: readonly ActivityLogFileEntry[]): boolean {
    return applyActivityLogRetention(
      {
        files,
        pins: [],
        pinRecordBytes: 0,
        config,
        nowMs: Date.now(),
        reserveBytes: segmentBytes,
        skipNames: new Set(),
      },
      () => true,
    ).admitted;
  }

  it("pins the fixture: the minimum budget holds exactly two segments", () => {
    expect(config).toMatchObject({ retentionBytes: 64 * 1024, segmentBytes });
  });

  it("counts a rotating writer once while its next segment is still empty", () => {
    expect(
      admitsAnotherSegment([active("0a0b0c0d", 1, segmentBytes - 512), active("0a0b0c0d", 2, 0)]),
    ).toBe(true);
  });

  it("reserves a rotating writer's next segment in full once it holds bytes", () => {
    expect(
      admitsAnotherSegment([active("0a0b0c0d", 1, segmentBytes - 512), active("0a0b0c0d", 2, 100)]),
    ).toBe(false);
  });

  it("reserves another writer's empty segment in full", () => {
    expect(
      admitsAnotherSegment([active("0a0b0c0d", 1, segmentBytes - 512), active("0e0e0e0e", 1, 0)]),
    ).toBe(false);
  });
});
