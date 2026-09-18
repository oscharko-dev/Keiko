// The SupportIncident contract (#3533): fingerprint preimage stability and closed domain, frame
// normalization, the closed record schema, and the public/private projection boundary.

import { describe, expect, it } from "vitest";
import { ACTIVITY_LOG_FAILURE_SURFACES } from "./activity-log-registry.generated.js";
import {
  DEFECT_FINGERPRINT_ALGORITHM_VERSION,
  SUPPORT_INCIDENT_SCHEMA_VERSION,
  SUPPORT_INCIDENT_SLOT_COUNT,
  UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT,
  defectFingerprintPreimage,
  isSupportIncidentSurface,
  normalizeKeikoFrame,
  normalizeKeikoFrameSignature,
  parseSupportIncidentFileName,
  parseSupportIncidentFingerprintClaimFileName,
  parseSupportIncidentRecord,
  parseSupportIncidentSlotClaimFileName,
  supportIncidentBuild,
  supportIncidentFileName,
  supportIncidentFingerprintClaimFileName,
  supportIncidentPrivateProjection,
  supportIncidentPublicProjection,
  supportIncidentSlotClaimFileName,
  type DefectFingerprintInput,
  type SupportIncident,
  type SupportIncidentRecord,
} from "./support-incident.js";

const INCIDENT_ID = "0123456789abcdef0123456789abcdef";
const FINGERPRINT = "a".repeat(64);

function record(overrides: Partial<SupportIncidentRecord> = {}): SupportIncidentRecord {
  return {
    schemaVersion: SUPPORT_INCIDENT_SCHEMA_VERSION,
    incidentId: INCIDENT_ID,
    trigger: "registered-failure",
    state: "candidate",
    fingerprint: {
      algorithm: DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      defectFingerprint: FINGERPRINT,
      surface: "bff",
      op: "chat.send.rejected",
      errorKind: "internal",
      frameCount: 2,
    },
    correlation: { rootCorrelationId: "root-correlation-1", childCorrelationIds: ["child-corr-1"] },
    build: supportIncidentBuild("1.0.5", "darwin-arm64"),
    window: { fromMs: 1_000, incidentAtMs: 2_000, toMs: 3_000 },
    pin: {
      status: "pinned",
      pinId: "fedcba9876543210fedcba98",
      pinnedSegmentCount: 2,
      pinnedBytes: 4096,
      evidenceLostBeforePin: false,
    },
    slotIndex: 5,
    createdAtMs: 2_000,
    expiresAtMs: 9_000,
    ...overrides,
  };
}

function incident(): SupportIncident {
  return {
    ...record(),
    evidence: {
      segments: [
        { segmentId: "20260918T120000000Z-4242-0a1b2c3d-000001", state: "sealed", sizeBytes: 10 },
      ],
      lineCount: 12,
      integrity: "supported",
      completeness: "complete",
      loss: "none",
    },
    sufficiency: {
      status: "degraded",
      reasons: ["sequence-anomaly"],
      coverage: {
        requiredClassCount: 1,
        presentClassCount: 1,
        completeClassCount: 0,
        degradedClassCount: 1,
        insufficientClassCount: 0,
      },
    },
  };
}

const INPUT: DefectFingerprintInput = {
  surface: "bff",
  op: "chat.send.rejected",
  errorKind: "internal",
  frames: [
    "packages/keiko-server/dist/chat/send.js:120:7",
    "packages/keiko-server/dist/chat/send.js:88:3",
    "packages/keiko-contracts/dist/observability.js:10:1",
  ],
};

describe("defectFingerprintPreimage", () => {
  it("is stable across builds: line, column, dist/src, and extension never enter it", () => {
    const rebuilt: DefectFingerprintInput = {
      ...INPUT,
      frames: [
        "packages/keiko-server/src/chat/send.ts:7:1",
        "packages/keiko-server/dist/chat/send.js:999:99",
        "packages/keiko-contracts/src/observability.ts:4:2",
      ],
    };
    expect(defectFingerprintPreimage(rebuilt)).toBe(defectFingerprintPreimage(INPUT));
  });

  it("changes with every allowlisted input and carries the algorithm version", () => {
    const base = defectFingerprintPreimage(INPUT);
    expect(defectFingerprintPreimage({ ...INPUT, surface: "ui" })).not.toBe(base);
    expect(defectFingerprintPreimage({ ...INPUT, op: "chat.creation.rejected" })).not.toBe(base);
    expect(defectFingerprintPreimage({ ...INPUT, errorKind: "timeout" })).not.toBe(base);
    expect(defectFingerprintPreimage({ ...INPUT, frames: [] })).not.toBe(base);
    expect(JSON.parse(base)).toEqual([
      "keiko-defect-fingerprint",
      DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      "bff",
      "chat.send.rejected",
      "internal",
      "keiko-server/chat/send",
      "keiko-contracts/observability",
    ]);
  });

  it("contains no time, process, host, user, or path value", () => {
    const hostile: DefectFingerprintInput = {
      ...INPUT,
      frames: [
        "/Users/alice/keiko/packages/keiko-server/dist/chat/send.js:1:1",
        "node:internal/process/task_queues:95:5",
        "packages/keiko-server/dist/../../../etc/passwd.js:1:1",
        "C:\\Users\\bob\\keiko\\packages\\keiko-server\\dist\\a.js:1:1",
      ],
    };
    const preimage = defectFingerprintPreimage(hostile);
    expect(JSON.parse(preimage)).toHaveLength(5);
    for (const forbidden of ["Users", "alice", "bob", "node:", "passwd", ":1", "C:"]) {
      expect(preimage).not.toContain(forbidden);
    }
  });

  it("rejects inputs outside the closed domain instead of fingerprinting them", () => {
    expect(() => defectFingerprintPreimage({ ...INPUT, surface: "dashboard" as "ui" })).toThrow(
      RangeError,
    );
    expect(() => defectFingerprintPreimage({ ...INPUT, op: "Chat Send" })).toThrow(RangeError);
    expect(() =>
      defectFingerprintPreimage({ ...INPUT, errorKind: "EACCES" as "internal" }),
    ).toThrow(RangeError);
  });

  it("gives every unattributed report the same fixed inputs", () => {
    expect(JSON.parse(defectFingerprintPreimage(UNATTRIBUTED_DEFECT_FINGERPRINT_INPUT))).toEqual([
      "keiko-defect-fingerprint",
      DEFECT_FINGERPRINT_ALGORITHM_VERSION,
      "unattributed",
      "unattributed",
      "unknown",
    ]);
  });
});

describe("Keiko frame normalization", () => {
  it("keeps module identities only and collapses consecutive repeats", () => {
    expect(normalizeKeikoFrame("dist/cli/bin.js:3:9")).toBe("cli/bin");
    expect(normalizeKeikoFrame("packages/keiko-ui/src/app/page.ts:1:1")).toBe("keiko-ui/app/page");
    expect(normalizeKeikoFrame("packages/keiko-server/dist/a.js")).toBeUndefined();
    expect(normalizeKeikoFrameSignature([42, "packages/keiko-server/dist/a.js:1:1"])).toEqual([
      "keiko-server/a",
    ]);
  });

  it("bounds the signature to the innermost frames", () => {
    const frames = Array.from(
      { length: 20 },
      (_, index) => `packages/keiko-server/dist/m${String(index)}.js:1:1`,
    );
    expect(normalizeKeikoFrameSignature(frames)).toHaveLength(8);
    expect(normalizeKeikoFrameSignature(frames)[0]).toBe("keiko-server/m0");
  });
});

describe("the closed record schema", () => {
  it("accepts a well-formed record and round-trips it through JSON", () => {
    const value = record();
    expect(parseSupportIncidentRecord(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it.each([
    ["an unknown key", { ...record(), note: "free text" }],
    ["an unknown schema version", { ...record(), schemaVersion: 2 }],
    [
      "an unknown fingerprint algorithm",
      { ...record(), fingerprint: { ...record().fingerprint, algorithm: 2 } },
    ],
    ["an unknown trigger", { ...record(), trigger: "telemetry" }],
    ["an unknown state", { ...record(), state: "sent" }],
    ["a non-hex incident id", { ...record(), incidentId: "INC-0001" }],
    [
      "a path-shaped correlation",
      { ...record(), correlation: { rootCorrelationId: "/Users/alice", childCorrelationIds: [] } },
    ],
    [
      "an unbounded child list",
      {
        ...record(),
        correlation: { childCorrelationIds: Array.from({ length: 9 }, () => "child-corr-1") },
      },
    ],
    ["a window out of order", { ...record(), window: { fromMs: 5, incidentAtMs: 4, toMs: 6 } }],
    [
      "a pinned status without a pin id",
      {
        ...record(),
        pin: {
          status: "pinned",
          pinnedSegmentCount: 0,
          pinnedBytes: 0,
          evidenceLostBeforePin: false,
        },
      },
    ],
    [
      "a rejected pin that names a pin id",
      {
        ...record(),
        pin: {
          status: "rejected",
          pinId: "fedcba9876543210fedcba98",
          pinnedSegmentCount: 0,
          pinnedBytes: 0,
          evidenceLostBeforePin: false,
        },
      },
    ],
    [
      "a pin missing the evidenceLostBeforePin signal",
      {
        ...record(),
        pin: {
          status: "pinned",
          pinId: "fedcba9876543210fedcba98",
          pinnedSegmentCount: 0,
          pinnedBytes: 0,
        },
      },
    ],
    [
      "a non-boolean evidenceLostBeforePin",
      {
        ...record(),
        pin: { ...record().pin, evidenceLostBeforePin: "true" },
      },
    ],
    ["an expiry before creation", { ...record(), expiresAtMs: 1 }],
    [
      "an unsafe product version",
      { ...record(), build: { ...record().build, productVersion: "x" } },
    ],
    [
      "a missing slotIndex",
      (function withoutSlotIndex(): Omit<SupportIncidentRecord, "slotIndex"> {
        const { slotIndex: _slotIndex, ...rest } = record();
        return rest;
      })(),
    ],
    ["an out-of-bounds slotIndex", { ...record(), slotIndex: SUPPORT_INCIDENT_SLOT_COUNT }],
    ["a negative slotIndex", { ...record(), slotIndex: -1 }],
  ])("rejects %s", (_label, value) => {
    expect(parseSupportIncidentRecord(value)).toBeUndefined();
  });

  it("rejects non-objects and inherited shapes", () => {
    expect(parseSupportIncidentRecord(null)).toBeUndefined();
    expect(parseSupportIncidentRecord([record()])).toBeUndefined();
    expect(
      parseSupportIncidentRecord(Object.assign(Object.create({ a: 1 }), record())),
    ).toBeUndefined();
  });

  it("names store files by a closed grammar only", () => {
    expect(supportIncidentFileName(INCIDENT_ID)).toBe(`incident-${INCIDENT_ID}.json`);
    expect(parseSupportIncidentFileName(`incident-${INCIDENT_ID}.json`)).toBe(INCIDENT_ID);
    expect(parseSupportIncidentFileName(`incident-${INCIDENT_ID}.json.tmp`)).toBeUndefined();
    expect(parseSupportIncidentFileName("pin-fedcba9876543210fedcba98.json")).toBeUndefined();
    expect(() => supportIncidentFileName("../escape")).toThrow(RangeError);
  });

  it("names the cross-process dedup and quota claim files by their own closed grammars (#3533 review 4050606506)", () => {
    expect(supportIncidentFingerprintClaimFileName(FINGERPRINT)).toBe(
      `fingerprint-${FINGERPRINT}.claim`,
    );
    expect(parseSupportIncidentFingerprintClaimFileName(`fingerprint-${FINGERPRINT}.claim`)).toBe(
      FINGERPRINT,
    );
    expect(parseSupportIncidentFingerprintClaimFileName("fingerprint-short.claim")).toBeUndefined();
    expect(() => supportIncidentFingerprintClaimFileName("not-a-fingerprint")).toThrow(RangeError);

    expect(supportIncidentSlotClaimFileName(0)).toBe("slot-00.claim");
    expect(supportIncidentSlotClaimFileName(31)).toBe("slot-31.claim");
    expect(parseSupportIncidentSlotClaimFileName("slot-07.claim")).toBe(7);
    expect(parseSupportIncidentSlotClaimFileName("slot-99.claim")).toBeUndefined();
    expect(parseSupportIncidentSlotClaimFileName(`incident-${INCIDENT_ID}.json`)).toBeUndefined();
    expect(() => supportIncidentSlotClaimFileName(SUPPORT_INCIDENT_SLOT_COUNT)).toThrow(RangeError);
    expect(() => supportIncidentSlotClaimFileName(-1)).toThrow(RangeError);

    // parseSupportIncidentFileName is the one function state-paths.ts calls for ownership, so both
    // claim grammars must be non-undefined there too -- but never mistakable for a real incident id.
    expect(parseSupportIncidentFileName(`fingerprint-${FINGERPRINT}.claim`)).toBe(FINGERPRINT);
    expect(parseSupportIncidentFileName("slot-07.claim")).toBe("7");
  });

  it("derives the surface vocabulary from the generated registry", () => {
    for (const surface of ACTIVITY_LOG_FAILURE_SURFACES) {
      expect(isSupportIncidentSurface(surface)).toBe(true);
    }
    expect(isSupportIncidentSurface("unattributed")).toBe(true);
    expect(isSupportIncidentSurface("desktop")).toBe(false);
  });
});

describe("public and private projections", () => {
  it("makes the public projection a strict subset of the private one", () => {
    const publicView = supportIncidentPublicProjection(incident());
    const privateView = supportIncidentPrivateProjection(incident());
    for (const [key, value] of Object.entries(publicView)) {
      expect(privateView).toHaveProperty(key, value);
    }
    expect(Object.keys(privateView).length).toBeGreaterThan(Object.keys(publicView).length);
  });

  it("keeps correlations, segments, window, pin, and reasons out of the public projection", () => {
    const publicView = JSON.stringify(supportIncidentPublicProjection(incident()));
    for (const privateValue of [
      "root-correlation-1",
      "child-corr-1",
      "20260918T120000000Z",
      "fedcba9876543210fedcba98",
      "sequence-anomaly",
      "schemaDigest",
    ]) {
      expect(publicView).not.toContain(privateValue);
    }
  });

  it("keeps sufficiency, integrity, completeness, and loss visible in both projections", () => {
    const publicView = supportIncidentPublicProjection(incident());
    const privateView = supportIncidentPrivateProjection(incident());
    expect(publicView).toMatchObject({
      sufficiencyStatus: "degraded",
      integrity: "supported",
      completeness: "complete",
      loss: "none",
      incidentId: INCIDENT_ID,
      defectFingerprint: FINGERPRINT,
    });
    expect(privateView).toMatchObject({
      sufficiencyReasons: ["sequence-anomaly"],
      coverage: { degradedClassCount: 1 },
    });
  });
});
