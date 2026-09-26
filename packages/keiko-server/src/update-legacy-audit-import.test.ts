import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { closeFileServerLogSinks, listActivityLogFiles } from "./observability/server-log.js";
import { importLegacyUpdateAuditSnapshot } from "./update-legacy-audit-import.js";

function legacyEventId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const LEGACY_MACHINE_TEXT_FIELDS = [
  "eventId",
  "targetVersion",
  "snapshotId",
  "portableStageId",
  "portableActivationId",
  "portableAssetName",
  "portableSidecarName",
  "portableSidecarKind",
  "portableSidecarVersion",
] as const;
const NON_SCHEMA_TEXT = [
  "https://example.invalid/value",
  "../outside/value",
  "human readable prose",
] as const;

const fsFaults = vi.hoisted(() => ({
  monitoredPath: undefined as string | undefined,
  monitoredLstatCalls: 0,
  failFsync: false,
  mutateAfterEof: undefined as (() => void) | undefined,
  trackedRoot: undefined as string | undefined,
  trackedDescriptors: new Set<number>(),
  closedDescriptors: new Set<number>(),
  sourceDescriptor: undefined as number | undefined,
  failSourceFstat: false,
  failSourceRead: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const descriptor = actual.openSync(...args);
      const path = args[0];
      if (
        fsFaults.trackedRoot !== undefined &&
        typeof path === "string" &&
        (path === fsFaults.trackedRoot ||
          path.startsWith(`${fsFaults.trackedRoot}/updates`) ||
          path.startsWith(`${fsFaults.trackedRoot}\\updates`))
      ) {
        fsFaults.trackedDescriptors.add(descriptor);
        if (/[\\/]updates[\\/]update-audit\.jsonl$/u.test(path)) {
          fsFaults.sourceDescriptor = descriptor;
        }
      }
      return descriptor;
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>): void => {
      fsFaults.closedDescriptors.add(args[0]);
      actual.closeSync(...args);
    },
    fstatSync: (
      ...args: Parameters<typeof actual.fstatSync>
    ): ReturnType<typeof actual.fstatSync> => {
      if (fsFaults.failSourceFstat && args[0] === fsFaults.sourceDescriptor) {
        throw Object.assign(new Error("forced source fstat failure"), { code: "EIO" });
      }
      return actual.fstatSync(...args);
    },
    lstatSync: (
      ...args: Parameters<typeof actual.lstatSync>
    ): ReturnType<typeof actual.lstatSync> => {
      if (args[0] === fsFaults.monitoredPath) fsFaults.monitoredLstatCalls += 1;
      return actual.lstatSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>): void => {
      if (fsFaults.failFsync)
        throw Object.assign(new Error("forced fsync failure"), { code: "EIO" });
      actual.fsyncSync(...args);
    },
    readSync: (...args: Parameters<typeof actual.readSync>): number => {
      if (fsFaults.failSourceRead && args[0] === fsFaults.sourceDescriptor) {
        throw Object.assign(new Error("forced source read failure"), { code: "EIO" });
      }
      const count = actual.readSync(...args);
      if (count === 0 && fsFaults.mutateAfterEof !== undefined) {
        const mutate = fsFaults.mutateAfterEof;
        fsFaults.mutateAfterEof = undefined;
        mutate();
      }
      return count;
    },
  };
});

function legacyEvent(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: legacyEventId(1),
    type: "portable-staging-result",
    occurredAt: "2025-01-02T03:04:05.000Z",
    targetVersion: "0.3.17",
    portableStageId: "a".repeat(32),
    portableTarget: "macos-arm64",
    status: "succeeded",
    ...overrides,
  };
}

function writeLegacy(stateDir: string, lines: readonly string[]): string {
  const updates = join(stateDir, "updates");
  mkdirSync(updates, { recursive: true });
  const path = join(updates, "update-audit.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

// The import's own records across the whole logical log (legacy files and segments), in order;
// the store's safe-open, seal and pin evidence is not import evidence.
function canonicalLines(stateDir: string): Record<string, unknown>[] {
  return readPersistedActivityLog(stateDir)
    .split("\n")
    .filter(Boolean)
    .flatMap((line): Record<string, unknown>[] => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((record) => String(record.op).startsWith("update."));
}

// The canonical records one clean import writes, produced in a scratch state directory so a test
// can plant them as a legacy file of an older Keiko.
function importedRecordsFor(lines: readonly string[], scratch: string): Record<string, unknown>[] {
  writeLegacy(scratch, lines);
  if (importLegacyUpdateAuditSnapshot({ stateDir: scratch, level: "info" }).status !== "imported") {
    throw new Error("expected the scratch import to succeed");
  }
  closeFileServerLogSinks();
  return canonicalLines(scratch);
}

function writeLegacyLog(stateDir: string, name: string, records: readonly unknown[]): string {
  const logs = join(stateDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const path = join(logs, name);
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
    mode: 0o600,
  });
  return path;
}

function pinRecords(stateDir: string): readonly string[] {
  const logs = join(stateDir, "logs");
  return existsSync(logs) ? readdirSync(logs).filter((name) => name.startsWith("pin-")) : [];
}

describe("legacy update audit import", () => {
  const roots: string[] = [];
  const fixture = (): string => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-update-audit-import-"));
    roots.push(stateDir);
    return stateDir;
  };

  afterEach(() => {
    closeFileServerLogSinks();
    fsFaults.monitoredPath = undefined;
    fsFaults.monitoredLstatCalls = 0;
    fsFaults.failFsync = false;
    fsFaults.mutateAfterEof = undefined;
    fsFaults.trackedRoot = undefined;
    fsFaults.trackedDescriptors.clear();
    fsFaults.closedDescriptors.clear();
    fsFaults.sourceDescriptor = undefined;
    fsFaults.failSourceFstat = false;
    fsFaults.failSourceRead = false;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports an absent legacy snapshot without creating canonical log output", () => {
    const stateDir = fixture();

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "absent",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("defers an empty regular snapshot before creating canonical log output", () => {
    const stateDir = fixture();
    const updates = join(stateDir, "updates");
    mkdirSync(updates);
    writeFileSync(join(updates, "update-audit.jsonl"), "");

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("defers before touching source or destination when info records are filtered", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const descriptor = openSync(source, "r");
    fsFaults.monitoredPath = source;
    fsFaults.monitoredLstatCalls = 0;

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "warn" })).toStrictEqual({
      status: "deferred",
      reason: "log-level-filtered",
    });
    expect(readFileSync(descriptor, "utf8")).toContain(legacyEventId(1));
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
    expect(fsFaults.monitoredLstatCalls).toBe(0);
    closeSync(descriptor);
  });

  it("imports a validated snapshot as historical canonical records and retains the source", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [
      JSON.stringify(legacyEvent()),
      JSON.stringify(
        legacyEvent({
          eventId: legacyEventId(2),
          type: "remediation-completed",
          store: "local-knowledge",
          remediation: "local-knowledge-reindex-required",
          status: "completed",
          snapshotId: legacyEventId(3),
        }),
      ),
    ]);

    const result = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });
    expect(result).toMatchObject({ status: "imported", importedCount: 2 });
    expect(existsSync(source)).toBe(true);
    const lines = canonicalLines(stateDir);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      op: "update.runtime.event",
      category: "diagnostic",
      historical: true,
      sourceSchemaVersion: 1,
      legacyEventId: legacyEventId(1),
      occurredAt: "2025-01-02T03:04:05.000Z",
      type: "portable-staging-result",
      portableStageId: "a".repeat(32),
      correlationId: "unknown-correlation-id",
      completeness: "complete",
      loss: "none",
    });
    expect(String(lines[0]?.eventId)).toMatch(/^legacy-audit-event-[0-9a-f]{64}$/u);
    expect(lines[0]).not.toHaveProperty("requestId");
    expect(lines[0]).not.toHaveProperty("parentCorrelationId");
    expect(lines[0]?.ts).not.toBe(lines[0]?.occurredAt);
    expect(lines[1]?.snapshotId).toBe(legacyEventId(3));
    expect(lines[2]).toMatchObject({
      op: "update.runtime.legacy-snapshot-imported",
      correlationId: "unknown-correlation-id",
      historical: true,
      sourceSchemaVersion: 1,
      importedCount: 2,
      completeness: "complete",
      loss: "none",
    });
    expect(String(lines[2]?.importId)).toMatch(/^legacy-audit-[0-9a-f]{64}$/u);
    expect(String(lines[2]?.sourceDigest)).toMatch(/^[0-9a-f]{64}$/u);
    expect(String(lines[2]?.importedIdSetDigest)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is semantically idempotent across retries while retaining the source", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);

    const first = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });
    if (first.status !== "imported") throw new Error("expected first import");
    closeFileServerLogSinks();
    const before = readPersistedActivityLog(stateDir);
    const second = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });

    expect(second).toStrictEqual({ status: "already-imported", importId: first.importId });
    expect(readPersistedActivityLog(stateDir)).toBe(before);
    expect(existsSync(source)).toBe(true);
    // The completion lives in a segment pinned for durable batches, so retention never ages it out.
    expect(pinRecords(stateDir)).toHaveLength(1);
  });

  it("resumes a partial batch an older Keiko left in its legacy log without duplicating it", () => {
    const events = [
      JSON.stringify(legacyEvent()),
      JSON.stringify(legacyEvent({ eventId: legacyEventId(2), type: "update-offered" })),
    ];
    const [firstImported] = importedRecordsFor(events, fixture());
    const stateDir = fixture();
    writeLegacy(stateDir, events);
    const legacy = writeLegacyLog(stateDir, "server.log", [firstImported]);
    const legacyBytes = readFileSync(legacy);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 2,
    });
    const lines = canonicalLines(stateDir);
    expect(lines.filter((line) => line.op === "update.runtime.event")).toHaveLength(2);
    expect(
      lines.filter((line) => line.op === "update.runtime.legacy-snapshot-imported"),
    ).toHaveLength(1);
    // Legacy input is read-only: it is never rewritten or repaired.
    expect(readFileSync(legacy).equals(legacyBytes)).toBe(true);
  });

  it("does not credit or repair a torn legacy-log tail when a fresh process imports", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const logs = join(stateDir, "logs");
    mkdirSync(logs, { mode: 0o700 });
    const interrupted = '{"op":"update.runtime.event","historical":true';
    writeFileSync(join(logs, "server.log"), interrupted, { encoding: "utf8", mode: 0o600 });

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
    expect(readFileSync(join(logs, "server.log"), "utf8")).toBe(interrupted);
    const lines = canonicalLines(stateDir);
    expect(lines.filter((line) => line.op === "update.runtime.event")).toHaveLength(1);
    expect(
      lines.filter((line) => line.op === "update.runtime.legacy-snapshot-imported"),
    ).toHaveLength(1);
  });

  it.each([
    ["partial final line", `${JSON.stringify(legacyEvent())}\n{`],
    ["duplicate escaped key", '{"schemaVersion":1,"eventId":"a","\\u0065ventId":"a"}\n'],
    ["unknown field", `${JSON.stringify(legacyEvent({ secret: "must-not-import" }))}\n`],
    [
      "conflicting duplicate event id",
      `${JSON.stringify(legacyEvent())}\n${JSON.stringify(legacyEvent({ type: "update-offered" }))}\n`,
    ],
  ])("defers the whole snapshot for %s", (_label, content) => {
    const stateDir = fixture();
    const updates = join(stateDir, "updates");
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, "update-audit.jsonl"), content, "utf8");

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it.each(
    LEGACY_MACHINE_TEXT_FIELDS.flatMap((field) =>
      NON_SCHEMA_TEXT.map((value) => [field, value] as const),
    ),
  )("rejects non-schema legacy %s text %s", (field, value) => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent({ [field]: value }))]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("rejects a symlinked source and never creates canonical output", () => {
    const stateDir = fixture();
    const target = join(stateDir, "elsewhere.jsonl");
    writeFileSync(target, `${JSON.stringify(legacyEvent())}\n`, "utf8");
    mkdirSync(join(stateDir, "updates"), { recursive: true });
    symlinkSync(target, join(stateDir, "updates", "update-audit.jsonl"));

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-unsafe",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it.each(["updates", "logs"])("rejects a symlinked fixed %s directory", (directory) => {
    const stateDir = fixture();
    const outside = fixture();
    if (directory === "updates") {
      writeLegacy(outside, [JSON.stringify(legacyEvent())]);
      symlinkSync(join(outside, "updates"), join(stateDir, "updates"));
    } else {
      writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
      mkdirSync(join(outside, "logs"));
      symlinkSync(join(outside, "logs"), join(stateDir, "logs"));
    }

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "deferred",
    });
    expect(
      existsSync(join(outside, "logs")) ? readdirSync(join(outside, "logs")) : [],
    ).toStrictEqual([]);
  });

  it("rejects a hard-linked source", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    linkSync(source, join(stateDir, "legacy-alias.jsonl"));

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-unsafe",
    });
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO source without blocking", () => {
    const stateDir = fixture();
    mkdirSync(join(stateDir, "updates"));
    execFileSync("mkfifo", [join(stateDir, "updates", "update-audit.jsonl")]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-unsafe",
    });
  });

  it("rejects source byte, line and event-count caps before creating output", () => {
    const stateDir = fixture();
    const updates = join(stateDir, "updates");
    mkdirSync(updates);
    writeFileSync(join(updates, "update-audit.jsonl"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-too-large",
    });

    writeFileSync(
      join(updates, "update-audit.jsonl"),
      `${JSON.stringify(legacyEvent({ targetVersion: "x".repeat(8_192) }))}\n`,
    );
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });

    writeFileSync(
      join(updates, "update-audit.jsonl"),
      `${JSON.stringify(legacyEvent({ targetVersion: `${"9".repeat(70)}.0.0` }))}\n`,
    );
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });

    const lines = Array.from({ length: 2_049 }, (_unused, index) =>
      JSON.stringify(legacyEvent({ eventId: legacyEventId(index + 1) })),
    );
    writeFileSync(join(updates, "update-audit.jsonl"), `${lines.join("\n")}\n`);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it("accepts exact duplicate source events once", () => {
    const stateDir = fixture();
    const line = JSON.stringify(legacyEvent());
    writeLegacy(stateDir, [line, line]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
    expect(
      canonicalLines(stateDir).filter((record) => record.op === "update.runtime.event"),
    ).toHaveLength(1);
  });

  it("validates and preserves every approved optional schema-1 field", () => {
    const stateDir = fixture();
    const digest = "a".repeat(64);
    writeLegacy(stateDir, [
      JSON.stringify(
        legacyEvent({
          snapshotId: legacyEventId(3),
          portableActivationId: "b".repeat(32),
          portableAssetName: "keiko-macos-arm64.zip",
          portableAssetSha256: digest,
          portableAssetSizeBytes: 42,
          portableSidecarName: "sidecar.json",
          portableSidecarKind: "coding-runtime",
          portableSidecarVersion: "1.18.30",
          portableSidecarTarget: "macos-arm64",
          portableSidecarPayloadSha256: digest,
          portableSidecarPayloadSha256Prefix: digest.slice(0, 12),
          portableSidecarStatus: "failed",
          portableSidecarFailureCode: "sidecar-digest-mismatch",
          store: "server-runtime",
          remediation: "restart-required",
          warningCode: "manual-review-required",
        }),
      ),
    ]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
    expect(canonicalLines(stateDir)[0]).toMatchObject({
      portableAssetSha256: digest,
      portableSidecarPayloadSha256: digest,
      portableSidecarFailureCode: "sidecar-digest-mismatch",
      warningCode: "manual-review-required",
    });
  });

  it("rejects malformed UTF-8 and invalid closed-vocabulary fields", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    writeFileSync(source, Buffer.from([0xc3, 0x28, 0x0a]));
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });

    writeFileSync(source, `${JSON.stringify(legacyEvent({ portableTarget: "linux-x64" }))}\n`);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-invalid",
    });
  });

  it("re-anchors a completion that survives only in a legacy archive into a pinned batch", () => {
    const events = [JSON.stringify(legacyEvent())];
    const previous = importedRecordsFor(events, fixture());
    const stateDir = fixture();
    writeLegacy(stateDir, events);
    writeLegacyLog(stateDir, "server-2025-01-02.log", previous);

    const reanchored = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });
    expect(reanchored).toMatchObject({ status: "imported", importedCount: 1 });
    const lines = canonicalLines(stateDir);
    // The represented event is not appended again; only a fresh completion is.
    expect(lines.filter((line) => line.op === "update.runtime.event")).toHaveLength(1);
    expect(
      lines.filter((line) => line.op === "update.runtime.legacy-snapshot-imported"),
    ).toHaveLength(2);
    expect(pinRecords(stateDir)).toHaveLength(1);

    closeFileServerLogSinks();
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "already-imported",
      importId: reanchored.status === "imported" ? reanchored.importId : "",
    });
  });

  it("rejects a completion marker with extra or conflicting fields", () => {
    const events = [JSON.stringify(legacyEvent())];
    const completion = importedRecordsFor(events, fixture()).at(-1);
    if (completion === undefined) throw new Error("expected completion");
    const stateDir = fixture();
    writeLegacy(stateDir, events);
    writeLegacyLog(stateDir, "server.log", [{ ...completion, snapshotId: "not-an-import-id" }]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-invalid",
    });
  });

  it("does not credit a tampered historical event as represented migration evidence", () => {
    const events = [JSON.stringify(legacyEvent())];
    const imported = importedRecordsFor(events, fixture()).find(
      (line) => line.op === "update.runtime.event",
    );
    if (imported === undefined) throw new Error("expected historical event");
    const stateDir = fixture();
    writeLegacy(stateDir, events);
    writeLegacyLog(stateDir, "server.log", [{ ...imported, status: "failed" }]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-invalid",
    });
  });

  it("bounds allowed canonical log files", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    for (let day = 1; day <= 17; day += 1) {
      writeFileSync(join(logs, `server-2025-01-${String(day).padStart(2, "0")}.log`), "", {
        mode: 0o600,
      });
    }

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-too-large",
    });
  });

  it("bounds total canonical log scan bytes before reading the file", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    const current = join(logs, "server.log");
    writeFileSync(current, "", { mode: 0o600 });
    truncateSync(current, 32 * 1024 * 1024 + 1);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-too-large",
    });
  });

  it("bounds repeated historical migration evidence before appending anything", () => {
    const events = [JSON.stringify(legacyEvent())];
    const imported = importedRecordsFor(events, fixture()).find(
      (line) => line.op === "update.runtime.event",
    );
    if (imported === undefined) throw new Error("expected historical event");
    const stateDir = fixture();
    writeLegacy(stateDir, events);
    const legacy = writeLegacyLog(
      stateDir,
      "server.log",
      Array.from({ length: 2_050 }, () => imported),
    );
    const crowded = readFileSync(legacy);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-invalid",
    });
    expect(readFileSync(legacy).equals(crowded)).toBe(true);
    // Inspection is read-only: nothing is written before the batch is accepted.
    expect(listActivityLogFiles(stateDir).map((file) => file.kind)).toStrictEqual([
      "legacy-current",
    ]);
  });

  it.each(["symlink", "hardlink"])(
    "never reads or changes a %s planted at the legacy log name",
    (kind) => {
      const stateDir = fixture();
      writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
      const logs = join(stateDir, "logs");
      mkdirSync(logs, { mode: 0o700 });
      const target = join(stateDir, "foreign.log");
      writeFileSync(target, "", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, join(logs, "server.log"));
      else linkSync(target, join(logs, "server.log"));

      // A symlink is not Activity Log evidence and is ignored; a hard-linked file at a log name is
      // refused as a scan target and defers the import.
      expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject(
        kind === "symlink"
          ? { status: "imported" }
          : { status: "deferred", reason: "destination-unsafe" },
      );
      expect(readFileSync(target, "utf8")).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores a FIFO at the legacy log name without blocking",
    () => {
      const stateDir = fixture();
      writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
      const logs = join(stateDir, "logs");
      mkdirSync(logs, { mode: 0o700 });
      execFileSync("mkfifo", [join(logs, "server.log")]);

      expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
        status: "imported",
      });
    },
  );

  it("ignores valid unrelated nested log records while scanning only import evidence", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    writeLegacyLog(stateDir, "server.log", [{ op: "unrelated", nested: { value: true } }]);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
  });

  it("defers, retains the source and pins nothing when the appended batch cannot be fsynced", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    fsFaults.failFsync = true;

    const result = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });
    fsFaults.failFsync = false;

    expect(result).toStrictEqual({ status: "deferred", reason: "durability-uncertain" });
    expect(existsSync(source)).toBe(true);
    // An unsynced batch is never credited: nothing is pinned, so the next launch imports again.
    expect(pinRecords(stateDir)).toHaveLength(0);
  });

  it("detects source mutation after the bounded descriptor read", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    fsFaults.mutateAfterEof = (): void => {
      writeFileSync(source, `${JSON.stringify(legacyEvent())}\n `);
    };

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-mutated",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it.each(["fstat", "read"])("closes every source guard when source %s throws", (failure) => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    fsFaults.trackedRoot = stateDir;
    fsFaults.failSourceFstat = failure === "fstat";
    fsFaults.failSourceRead = failure === "read";

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-unsafe",
    });
    expect(fsFaults.sourceDescriptor).toEqual(expect.any(Number));
    expect(fsFaults.trackedDescriptors.size).toBeGreaterThanOrEqual(
      process.platform === "win32" ? 1 : 3,
    );
    expect(
      [...fsFaults.trackedDescriptors].every((descriptor) =>
        fsFaults.closedDescriptors.has(descriptor),
      ),
    ).toBe(true);
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("detects fixed updates-directory rebinding", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const outside = fixture();
    writeLegacy(outside, [JSON.stringify(legacyEvent({ eventId: legacyEventId(4) }))]);
    const updates = join(stateDir, "updates");
    const moved = join(stateDir, "updates-original");
    fsFaults.mutateAfterEof = (): void => {
      renameSync(updates, moved);
      symlinkSync(join(outside, "updates"), updates);
    };

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "source-mutated",
    });
    expect(existsSync(join(stateDir, "logs"))).toBe(false);
  });
});
