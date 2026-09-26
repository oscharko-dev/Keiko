import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  activityLogEvent,
  activityLogOperationSchema,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import fixture from "./activity-log-compatibility-3558.fixture.json" with { type: "json" };
import {
  activeActivityLogPins,
  applyActivityLogRetention,
  listActivityLogDirectory,
  readActivityLogPins,
  readActivityLogPolicyRecord,
  resolveActivityLogStorePolicy,
} from "./activity-log-store.js";
import { ActivityLogScanner, listActivityLogStoreFiles } from "./reader/support-segment-scan.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  listActivityLogFiles,
} from "./server-log.js";

const FIXED_CLOCK = Date.parse("2026-09-26T12:00:00.000Z");
const roots: string[] = [];

interface FixtureFile {
  readonly name: string;
  readonly bytes: string;
}

interface CompatibilityFixture {
  readonly provenance: {
    readonly git: string;
    readonly node: string;
    readonly fixedClock: string;
  };
  readonly files: readonly FixtureFile[];
}

function decodedFixture(): CompatibilityFixture {
  if (fixture.encoding !== "gzip-base64") throw new Error("unexpected #3558 fixture encoding");
  return JSON.parse(
    gunzipSync(Buffer.from(fixture.payload, "base64")).toString("utf8"),
  ) as CompatibilityFixture;
}

function restoreFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-activity-3558-"));
  roots.push(root);
  const logs = join(root, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (const file of decodedFixture().files) {
    const path = join(logs, file.name);
    writeFileSync(path, Buffer.from(file.bytes, "base64"), { mode: 0o600 });
    if (file.name.endsWith(".jsonl")) chmodSync(path, 0o400);
  }
  return root;
}

type CompleteLossOperation = ActivityLogOperationRegistration & {
  readonly fields: ActivityLogOperationRegistration["fields"] & {
    readonly completeness: {
      readonly type: "string";
      readonly dataClass: "completeness-state";
      readonly required: true;
    };
    readonly loss: {
      readonly type: "string";
      readonly dataClass: "loss-state";
      readonly required: true;
    };
  };
};

function isCompleteLossOperation(
  operation: ActivityLogOperationRegistration | undefined,
): operation is CompleteLossOperation {
  return (
    operation?.fields.completeness?.type === "string" &&
    operation.fields.completeness.dataClass === "completeness-state" &&
    operation.fields.completeness.required &&
    operation.fields.loss?.type === "string" &&
    operation.fields.loss.dataClass === "loss-state" &&
    operation.fields.loss.required
  );
}

function registeredEvent(correlationId: string): ReturnType<typeof activityLogEvent> {
  const operation = activityLogOperationSchema("client.diagnostic");
  if (!isCompleteLossOperation(operation)) {
    throw new Error("client.diagnostic registration lacks required evidence fields");
  }
  return activityLogEvent(
    operation,
    { correlationId },
    { clientNoteDigest: "a".repeat(64), completeness: "complete", loss: "none" },
  );
}

type ScannedActivityLogLine =
  ReturnType<ActivityLogScanner["scan"]> extends Iterable<infer Line> ? Line : never;

function expectCapturedV2Evidence(
  lines: readonly ScannedActivityLogLine[],
  expectedEvidence: "supported" | "unsupported",
): void {
  expect(lines).toHaveLength(2);
  if (expectedEvidence === "unsupported") {
    expect(lines.map((line) => line.classification)).toEqual([
      { kind: "rejected", evidence: "unsupported" },
      { kind: "rejected", evidence: "unsupported" },
    ]);
    return;
  }
  for (const line of lines) {
    expect(line.classification).toMatchObject({ kind: "line", evidence: "supported" });
    if (line.classification.kind !== "line") throw new Error("supported line was rejected");
    expect(line.classification.parsed).toBeDefined();
  }
}

afterEach(() => {
  closeFileServerLogSinks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pre-move Activity Log compatibility fixture (#3558)", () => {
  it("reads fixed pre-move active, sealed, and legacy bytes without reclassifying the legacy line", () => {
    const stateDir = restoreFixture();
    const captured = decodedFixture();
    expect(captured.provenance).toMatchObject({
      git: "5cc94e89a25a2cb98c233732dfba9916ce5b9498",
      node: "v24.18.0",
      fixedClock: "2026-09-26T12:00:00.000Z",
    });

    const files = listActivityLogStoreFiles(stateDir);
    expect(files.map((file) => file.kind)).toEqual([
      "legacy-archive",
      "sealed",
      "sealed",
      "active",
    ]);

    const scanned = files.flatMap((file) => [...new ActivityLogScanner(stateDir).scan(file)]);
    const legacy = scanned.find((line) => line.text.includes("legacy.compatibility-3558"));
    expect(legacy?.classification).toMatchObject({ kind: "line", evidence: "legacy" });

    const capturedIdentity = JSON.parse(
      Buffer.from(
        captured.files.find((file) => file.name.endsWith("-000001.jsonl"))?.bytes ?? "",
        "base64",
      )
        .toString("utf8")
        .split("\n")[0] ?? "{}",
    ) as {
      readonly catalogDigest?: unknown;
      readonly registryVersion?: unknown;
      readonly schemaDigest?: unknown;
    };
    const expectedV2Evidence =
      capturedIdentity.catalogDigest === ACTIVITY_LOG_CATALOG_DIGEST &&
      capturedIdentity.registryVersion === ACTIVITY_LOG_REGISTRY_VERSION &&
      capturedIdentity.schemaDigest === ACTIVITY_LOG_SCHEMA_DIGEST
        ? "supported"
        : "unsupported";
    const v2 = scanned.filter((line) => line.text.includes("compatibility-3558-sealed"));
    expectCapturedV2Evidence(v2, expectedV2Evidence);
  });

  it("recovers the captured pre-move active segment without changing its persisted bytes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXED_CLOCK));
    const stateDir = restoreFixture();
    const [activeBefore] = listActivityLogFiles(stateDir).filter((file) => file.kind === "active");
    if (activeBefore === undefined) throw new Error("fixture has no active segment");
    const bytesBefore = readFileSync(activeBefore.path);

    createFileServerLogSink(stateDir, { level: "debug" }).write(
      registeredEvent("compatibility-3558-recovery"),
    );

    expect(listActivityLogFiles(stateDir).some((file) => file.name === activeBefore.name)).toBe(
      false,
    );
    const recovered = listActivityLogFiles(stateDir).find(
      (file) => file.name === activeBefore.name.replace(".active.jsonl", ".jsonl"),
    );
    expect(recovered).toBeDefined();
    expect(readFileSync(recovered?.path ?? "")).toEqual(bytesBefore);
    const recoveryFiles = listActivityLogStoreFiles(stateDir);
    if (recoveryFiles.length === 0)
      throw new Error("recovery did not leave a readable Activity Log file");
    expect(
      recoveryFiles
        .flatMap((file) => [...new ActivityLogScanner(stateDir).scan(file)])
        .some((line) => line.text.includes('"op":"activity-log.segment.recovered"')),
    ).toBe(true);
  });

  it("preserves the pre-move pin and store policy while retention removes only unpinned history", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FIXED_CLOCK));
    const stateDir = restoreFixture();
    const logs = join(stateDir, "logs");
    const listing = listActivityLogDirectory(logs);
    const pins = activeActivityLogPins(readActivityLogPins(listing, stateDir), FIXED_CLOCK);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ reason: "incident", scope: { kind: "window" } });

    const policy = readActivityLogPolicyRecord(logs, stateDir);
    expect(policy).toEqual({
      schemaVersion: 1,
      retentionBytes: 256 * 1024 * 1024,
      retentionDays: 14,
      pinQuotaBytes: 64 * 1024 * 1024,
    });
    const adopted = resolveActivityLogStorePolicy(
      logs,
      stateDir,
      { retentionBytes: 64 * 1024, retentionDays: 1, pinQuotaBytes: 32 * 1024 },
      { pid: process.pid, instanceId: "3558c0de", isAlive: () => true },
    );
    expect(adopted).toMatchObject({
      retentionBytes: policy?.retentionBytes,
      retentionDays: policy?.retentionDays,
      pinQuotaBytes: policy?.pinQuotaBytes,
      conflict: { resolution: "adopted" },
    });

    const removed: string[] = [];
    const outcome = applyActivityLogRetention(
      {
        files: listing.files,
        pins,
        pinRecordBytes: listing.pins.reduce((total, pin) => total + pin.sizeBytes, 0),
        config: {
          segmentBytes: 32 * 1024,
          segmentSeconds: 60,
          retentionBytes: 1,
          retentionDays: 1,
          pinQuotaBytes: 64 * 1024,
        },
        nowMs: FIXED_CLOCK,
        reserveBytes: 0,
        skipNames: new Set(),
      },
      (entry) => {
        removed.push(entry.file.name);
        return true;
      },
    );

    expect(outcome.protection.protectedNames.size).toBe(2);
    expect(removed).toEqual(["server-2026-09-01.log"]);
  });
});
