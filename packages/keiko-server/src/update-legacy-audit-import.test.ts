import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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

import { closeFileServerLogSinks } from "./observability/server-log.js";
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

function canonicalLines(stateDir: string): Record<string, unknown>[] {
  const path = join(stateDir, "logs", "server.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    });
    expect(String(lines[0]?.eventId)).toMatch(/^legacy-audit-event-[0-9a-f]{64}$/u);
    expect(lines[0]).not.toHaveProperty("correlationId");
    expect(lines[0]).not.toHaveProperty("requestId");
    expect(lines[0]).not.toHaveProperty("parentCorrelationId");
    expect(lines[0]?.ts).not.toBe(lines[0]?.occurredAt);
    expect(lines[1]?.snapshotId).toBe(legacyEventId(3));
    expect(lines[2]).toMatchObject({
      op: "update.runtime.legacy-snapshot-imported",
      historical: true,
      sourceSchemaVersion: 1,
      importedCount: 2,
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
    const before = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
    const second = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });

    expect(second).toStrictEqual({ status: "already-imported", importId: first.importId });
    expect(readFileSync(join(stateDir, "logs", "server.log"), "utf8")).toBe(before);
    expect(existsSync(source)).toBe(true);
  });

  it("resumes a partial canonical batch without duplicating a represented event", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [
      JSON.stringify(legacyEvent()),
      JSON.stringify(legacyEvent({ eventId: legacyEventId(2), type: "update-offered" })),
    ]);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" }).status).toBe("imported");
    closeFileServerLogSinks();
    const [firstImported] = canonicalLines(stateDir);
    writeFileSync(
      join(stateDir, "logs", "server.log"),
      `${JSON.stringify(firstImported)}\n`,
      "utf8",
    );

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 2,
    });
    const lines = canonicalLines(stateDir);
    expect(lines.filter((line) => line.op === "update.runtime.event")).toHaveLength(2);
    expect(
      lines.filter((line) => line.op === "update.runtime.legacy-snapshot-imported"),
    ).toHaveLength(1);
  });

  it("does not credit a malformed current-log tail when a fresh process resumes import", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    const interrupted = '{"op":"update.runtime.event","historical":true';
    writeFileSync(join(logs, "server.log"), interrupted, "utf8");
    closeFileServerLogSinks();

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
    const raw = readFileSync(join(logs, "server.log"), "utf8");
    expect(raw.startsWith(`${interrupted}\n`)).toBe(true);
    const parsed = raw.split("\n").flatMap((line): Record<string, unknown>[] => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(parsed.filter((line) => line.op === "update.runtime.event")).toHaveLength(1);
    expect(
      parsed.filter((line) => line.op === "update.runtime.legacy-snapshot-imported"),
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
    expect(existsSync(join(outside, "logs", "server.log"))).toBe(false);
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

  it("recognizes an exact completion in a rotated allowed log", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const first = importLegacyUpdateAuditSnapshot({ stateDir, level: "info" });
    if (first.status !== "imported") throw new Error("expected first import");
    closeFileServerLogSinks();
    renameSync(
      join(stateDir, "logs", "server.log"),
      join(stateDir, "logs", "server-2025-01-02.log"),
    );

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "already-imported",
      importId: first.importId,
    });
  });

  it("rejects a completion marker with extra or conflicting fields", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" }).status).toBe("imported");
    closeFileServerLogSinks();
    const lines = canonicalLines(stateDir);
    const completion = lines.at(-1);
    if (completion === undefined) throw new Error("expected completion");
    writeFileSync(
      join(stateDir, "logs", "server.log"),
      `${JSON.stringify({ ...completion, snapshotId: "not-an-import-id" })}\n`,
    );

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-invalid",
    });
  });

  it("does not credit a tampered historical event as represented migration evidence", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" }).status).toBe("imported");
    closeFileServerLogSinks();
    const imported = canonicalLines(stateDir).find((line) => line.op === "update.runtime.event");
    if (imported === undefined) throw new Error("expected historical event");
    const tampered = { ...imported, status: "failed" };
    writeFileSync(join(stateDir, "logs", "server.log"), `${JSON.stringify(tampered)}\n`);

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
    for (let day = 1; day <= 16; day += 1) {
      writeFileSync(join(logs, `server-2025-01-${String(day).padStart(2, "0")}.log`), "");
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
    writeFileSync(current, "");
    truncateSync(current, 32 * 1024 * 1024 + 1);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-too-large",
    });
  });

  it("bounds repeated historical migration evidence before appending", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" }).status).toBe("imported");
    closeFileServerLogSinks();
    const imported = canonicalLines(stateDir).find((line) => line.op === "update.runtime.event");
    if (imported === undefined) throw new Error("expected historical event");
    const crowdedLog = `${Array.from({ length: 2_050 }, () => JSON.stringify(imported)).join("\n")}\n`;
    const logPath = join(stateDir, "logs", "server.log");
    writeFileSync(logPath, crowdedLog);

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toStrictEqual({
      status: "deferred",
      reason: "destination-invalid",
    });
    expect(readFileSync(logPath, "utf8")).toBe(crowdedLog);
  });

  it.each(["symlink", "hardlink"])("rejects a %s canonical current file", (kind) => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    const logs = join(stateDir, "logs");
    mkdirSync(logs);
    const target = join(stateDir, "foreign.log");
    writeFileSync(target, "");
    if (kind === "symlink") symlinkSync(target, join(logs, "server.log"));
    else linkSync(target, join(logs, "server.log"));

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "deferred",
    });
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO canonical current file without blocking",
    () => {
      const stateDir = fixture();
      writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
      const logs = join(stateDir, "logs");
      mkdirSync(logs);
      execFileSync("mkfifo", [join(logs, "server.log")]);

      expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
        status: "deferred",
      });
    },
  );

  it("ignores valid unrelated nested log records while scanning only import evidence", () => {
    const stateDir = fixture();
    writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    mkdirSync(join(stateDir, "logs"));
    writeFileSync(
      join(stateDir, "logs", "server.log"),
      `${JSON.stringify({ op: "unrelated", nested: { value: true } })}\n`,
    );

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "imported",
      importedCount: 1,
    });
  });

  it("defers and retains the source when a scanned log descriptor cannot be fsynced", () => {
    const stateDir = fixture();
    const source = writeLegacy(stateDir, [JSON.stringify(legacyEvent())]);
    fsFaults.failFsync = true;

    expect(importLegacyUpdateAuditSnapshot({ stateDir, level: "info" })).toMatchObject({
      status: "deferred",
    });
    expect(existsSync(source)).toBe(true);
    expect(canonicalLines(stateDir)).toHaveLength(0);
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
