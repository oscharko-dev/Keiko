import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  correlationKey,
  filterKeyHashes,
  loadSegmentManifest,
  manifestMayContainAnyKey,
  parentCorrelationKey,
  parseSegmentManifest,
  segmentManifestDirectory,
  serializeSegmentManifest,
  type SegmentManifest,
} from "./support-segment-manifest.js";
import {
  isSegmentManifestFileName,
  parseSegmentManifestFileName,
  segmentManifestFileName,
} from "./support-segment-manifest-names.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
  verifySegmentManifests,
} from "./support-segment-scan.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";

const T0 = Date.UTC(2026, 8, 18, 9, 0, 0);
const INCIDENT_ID = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "f".repeat(64);

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-segment-manifest-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function incidentCreatedLine(process: ReturnType<typeof fixtureProcess>, atMs: number): string {
  return fixtureLine(process, atMs, {
    op: "support.incident.created",
    correlationId: "corr-incident-00001",
    fields: {
      incidentId: INCIDENT_ID,
      defectFingerprint: FINGERPRINT,
      fingerprintAlgorithm: 1,
      descriptorSchemaVersion: 1,
      trigger: "registered-failure",
      frameCount: 0,
      pinStatus: "pinned",
      pinnedSegmentCount: 1,
      pinnedBytes: 10,
      evidenceLostBeforePin: false,
      windowSeconds: 1200,
      expiresInSeconds: 1_209_600,
      openIncidentCount: 1,
    },
  });
}

function writeHistory(): readonly string[] {
  const a = fixtureProcess(3101, "abcdef01");
  const b = fixtureProcess(3202, "abcdef02");
  return [
    writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), [
      fixtureLine(a, T0, { op: "cli.lifecycle.stop-requested" }),
      fixtureLine(a, T0 + 10, { op: "client.diagnostic", correlationId: "corr-first-000001" }),
      fixtureLine(a, T0 + 20, {
        op: "client.diagnostic",
        correlationId: "corr-second-00001",
        parentCorrelationId: "corr-first-000001",
        level: "error",
        errorKind: "timeout",
      }),
      incidentCreatedLine(a, T0 + 30),
    ]),
    writeFixtureSegment(
      stateDir,
      segmentIdentity(b, T0 + 1000, 1),
      [fixtureLine(b, T0 + 1000, { op: "client.diagnostic", correlationId: "corr-third-000001" })],
      { tail: '{"ts":"2026-09-18T09:00:01' },
    ),
  ];
}

function manifestTexts(): Record<string, string> {
  const directory = segmentManifestDirectory(stateDir);
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

function ensure(rebuild = false): ReturnType<typeof ensureSegmentManifests> {
  return ensureSegmentManifests(
    stateDir,
    listActivityLogStoreFiles(stateDir),
    new ActivityLogScanner(stateDir),
    { trigger: rebuild ? "rebuild" : "query", persist: true, rebuild },
  );
}

function onlyManifest(): SegmentManifest {
  const [text] = Object.values(manifestTexts());
  const name = Object.keys(manifestTexts())[0] ?? "";
  const manifest = parseSegmentManifest(text ?? "", parseSegmentManifestFileName(name) ?? "");
  if (manifest === undefined) throw new Error("fixture manifest did not parse");
  return manifest;
}

describe("segment manifests (#3531)", () => {
  it("rebuilds byte-for-byte identical canonical manifests after the store is deleted", () => {
    writeHistory();
    const first = ensure();
    const before = manifestTexts();
    rmSync(segmentManifestDirectory(stateDir), { recursive: true, force: true });
    ensure();
    const rebuilt = manifestTexts();
    ensure(true);

    expect(first.stats).toMatchObject({ segmentCount: 2, builtCount: 2, reusedCount: 0 });
    expect(Object.keys(before)).toHaveLength(2);
    expect(rebuilt).toEqual(before);
    expect(manifestTexts()).toEqual(before);
  });

  it("reuses a valid manifest without opening its segment body", () => {
    writeHistory();
    ensure();
    const scanner = new ActivityLogScanner(stateDir);
    const pass = ensureSegmentManifests(stateDir, listActivityLogStoreFiles(stateDir), scanner, {
      trigger: "query",
      persist: true,
      rebuild: false,
    });

    expect(pass.stats).toMatchObject({ reusedCount: 2, builtCount: 0 });
    expect(scanner.opened.size).toBe(0);
  });

  it("records safe ranges, registered counts, integrity and lifecycle references only", () => {
    writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    const name = readdirSync(directory).find((entry) => entry.includes("-3101-")) ?? "";
    const manifest = parseSegmentManifest(
      readFileSync(join(directory, name), "utf8"),
      parseSegmentManifestFileName(name) ?? "",
    );

    expect(manifest).toMatchObject({
      kind: "keiko.activity-log.segment-manifest",
      schemaVersion: 1,
      time: { firstTs: new Date(T0).toISOString(), lastTs: new Date(T0 + 30).toISOString() },
      processes: {
        complete: true,
        entries: [{ pid: 3101, instanceId: "abcdef01", firstSeq: 1, lastSeq: 4, lineCount: 4 }],
      },
      evidence: { classification: "supported", supportedLineCount: 4, corruptLineCount: 0 },
      errorKinds: [{ name: "timeout", count: 1 }],
      uncorrelatedLineCount: 1,
      lifecycleReferences: {
        complete: true,
        incidentIds: [INCIDENT_ID],
        defectFingerprints: [FINGERPRINT],
      },
    });
    expect(manifest?.ops.map((entry) => entry.name)).toEqual([
      "cli.lifecycle.stop-requested",
      "client.diagnostic",
      "support.incident.created",
    ]);
    const text = readFileSync(join(directory, name), "utf8");
    for (const id of ["corr-first-000001", "corr-second-00001", stateDir]) {
      expect(text).not.toContain(id);
    }
  });

  it("classifies a torn tail as truncated and never as a line of evidence", () => {
    writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    const name = readdirSync(directory).find((entry) => entry.includes("-3202-")) ?? "";
    const manifest = parseSegmentManifest(
      readFileSync(join(directory, name), "utf8"),
      parseSegmentManifestFileName(name) ?? "",
    );

    expect(manifest?.segment.terminated).toBe(false);
    expect(manifest?.evidence).toMatchObject({
      classification: "truncated",
      truncatedLineCount: 1,
      completeness: "partial",
      loss: "event-dropped",
    });
  });

  it("filters correlation keys without a false negative", () => {
    writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    const name = readdirSync(directory).find((entry) => entry.includes("-3101-")) ?? "";
    const manifest = parseSegmentManifest(
      readFileSync(join(directory, name), "utf8"),
      parseSegmentManifestFileName(name) ?? "",
    );
    if (manifest === undefined) throw new Error("manifest missing");
    const loaded = loadSegmentManifest(manifest);
    const present = [
      correlationKey("corr-first-000001"),
      correlationKey("corr-second-00001"),
      parentCorrelationKey("corr-first-000001"),
    ];

    for (const key of present) {
      expect(manifestMayContainAnyKey(loaded, [filterKeyHashes(key)])).toBe(true);
    }
    expect(manifest.correlations.distinctKeyCount).toBe(4);
    expect(manifestMayContainAnyKey(loaded, [])).toBe(false);
  });

  it("rejects a tampered, reordered or foreign-catalog manifest and rebuilds it", () => {
    writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    const [name = ""] = readdirSync(directory).sort();
    const path = join(directory, name);
    const segmentId = parseSegmentManifestFileName(name) ?? "";
    const text = readFileSync(path, "utf8");
    const value = JSON.parse(text) as SegmentManifest;
    const tampered = text.replace('"lineCount":', '"lineCount":1');
    const { digest, ...body } = value;
    const reordered = `${JSON.stringify({ digest, ...body })}\n`;
    const foreignBody = { ...body, catalog: { ...body.catalog, catalogDigest: "0".repeat(64) } };
    const foreign = `${JSON.stringify({
      ...foreignBody,
      digest: createHash("sha256").update(JSON.stringify(foreignBody)).digest("hex"),
    })}\n`;

    expect(parseSegmentManifest(text, segmentId)).toEqual(value);
    expect(parseSegmentManifest(tampered, segmentId)).toBeUndefined();
    expect(parseSegmentManifest(reordered, segmentId)).toBeUndefined();
    expect(parseSegmentManifest(text, "20260918T090000000Z-1-abcdef01-000009")).toBeUndefined();
    expect(parseSegmentManifest("not json", segmentId)).toBeUndefined();
    expect(parseSegmentManifest(foreign, segmentId)).toBeDefined();
    const shortBody = {
      ...body,
      correlations: { ...body.correlations, data: body.correlations.data.slice(0, 4) },
    };
    const short = `${JSON.stringify({
      ...shortBody,
      digest: createHash("sha256").update(JSON.stringify(shortBody)).digest("hex"),
    })}\n`;
    expect(parseSegmentManifest(short, segmentId)).toBeUndefined();

    chmodSync(path, 0o600);
    writeFileSync(path, foreign);
    const pass = ensure();
    expect(pass.stats).toMatchObject({ replacedCount: 1, reusedCount: 1 });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("removes manifests of deleted segments but never an operator file", () => {
    const [first] = writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    writeFileSync(join(directory, "notes.txt"), "operator file");
    rmSync(first ?? "", { force: true });
    const pass = ensure();

    expect(pass.stats.removedOrphanCount).toBe(1);
    expect(readdirSync(directory).sort()).toHaveLength(2);
    expect(existsSync(join(directory, "notes.txt"))).toBe(true);
  });

  it("verifies stored manifests without writing, separating missing from corrupt ones", () => {
    writeHistory();
    ensure();
    const directory = segmentManifestDirectory(stateDir);
    const [missing = "", corrupt = ""] = readdirSync(directory).sort();
    rmSync(join(directory, missing));
    chmodSync(join(directory, corrupt), 0o600);
    writeFileSync(join(directory, corrupt), "{}\n");
    const verify = (): ReturnType<typeof verifySegmentManifests> =>
      verifySegmentManifests(
        stateDir,
        listActivityLogStoreFiles(stateDir),
        new ActivityLogScanner(stateDir),
      );

    expect(verify()).toMatchObject({
      segmentCount: 2,
      verifiedCount: 0,
      missingCount: 1,
      mismatchCount: 1,
    });
    expect(existsSync(join(directory, missing))).toBe(false);
    expect(readFileSync(join(directory, corrupt), "utf8")).toBe("{}\n");
    ensure();
    expect(verify()).toMatchObject({ verifiedCount: 2, missingCount: 0, mismatchCount: 0 });
  });

  it("serializes canonically so parse and serialize round-trip", () => {
    writeHistory();
    ensure();
    const manifest = onlyManifest();
    expect(parseSegmentManifest(serializeSegmentManifest(manifest), manifest.segmentId)).toEqual(
      manifest,
    );
  });
});

describe("segment manifest file grammar (#3531)", () => {
  it("accepts exactly manifest-<segmentId>.json", () => {
    const segmentId = "20260918T090000000Z-3101-abcdef01-000001";
    expect(segmentManifestFileName(segmentId)).toBe(`manifest-${segmentId}.json`);
    expect(parseSegmentManifestFileName(`manifest-${segmentId}.json`)).toBe(segmentId);
    for (const name of [
      "notes.txt",
      `manifest-${segmentId}.json.tmp`,
      "manifest-../x.json",
      "manifest-20260918T090000000Z-3101-abcdef01-1.json",
      `Manifest-${segmentId}.json`,
    ]) {
      expect(isSegmentManifestFileName(name)).toBe(false);
    }
    expect(() => segmentManifestFileName("../escape")).toThrow(RangeError);
  });
});
