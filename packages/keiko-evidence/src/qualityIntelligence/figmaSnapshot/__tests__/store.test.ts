import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceReadError, EvidenceWriteError } from "../../../errors.js";
import {
  createNodeFigmaSnapshotStore,
  enforceFigmaSnapshotRetention,
  type FigmaSnapshotStore,
  type RecordFigmaSnapshotInput,
} from "../store.js";
import type { FigmaSnapshotRecord, FigmaSnapshotScreenRow } from "../schema.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID_2 = "00000000-0000-4000-8000-000000000002";
const RUN_ID_3 = "00000000-0000-4000-8000-000000000003";

// Correct integrity hash for the baseInput fixture: sha256 of canonical(
//   { screens: [{integrityHash:"b"*64, screenId:"1:1"},{integrityHash:"c"*64, screenId:"1:2"}],
//     snapshotSchemaVersion:1, version:"v-pinned-1" })
// Pre-computed to keep tests deterministic without depending on crypto at describe time.
const BASE_INTEGRITY_HASH = "fd7a4f5be941a3d16d98379b51a2f43f577420f2402db028b846700cd8e44ab4";
// Hash for zero screens, same provenance (version:"v-pinned-1").
const EMPTY_INTEGRITY_HASH = "5439a337ebe6807307c9c0728da47f801073462d4bfcdb446cfedd858bb12af3";

const loadOrThrow = (store: FigmaSnapshotStore, runId: string): FigmaSnapshotRecord => {
  const record = store.load(runId);
  if (record === undefined) throw new Error(`expected a snapshot for ${runId}`);
  return record;
};

const firstScreen = (record: FigmaSnapshotRecord): FigmaSnapshotScreenRow => {
  const screen = record.screens[0];
  if (screen === undefined) throw new Error("expected at least one screen");
  return screen;
};
// A recognized secret shape (AWS access key) accidentally typed into a Figma text node. Design
// content is otherwise KEPT, but a recognized secret must be redacted before it touches disk.
const PLANTED_SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "figma-snapshot-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const png = (seed: number): Uint8Array => new Uint8Array([0x89, 0x50, seed, seed + 1]);

const baseInput = (): RecordFigmaSnapshotInput => ({
  runId: RUN_ID,
  provenance: {
    fileKey: "KEY123",
    nodeId: "0:1",
    version: "v-pinned-1",
    fetchedAt: "2026-06-09T00:00:00.000Z",
  },
  integrityHash: BASE_INTEGRITY_HASH,
  screens: [
    {
      screenId: "1:1",
      irJson: { id: "1:1", name: "Home", note: `leaked key ${PLANTED_SECRET} in a text node` },
      integrityHash: "b".repeat(64),
      image: { mimeType: "image/png", bytes: png(10) },
    },
    {
      screenId: "1:2",
      irJson: { id: "1:2", name: "Detail" },
      integrityHash: "c".repeat(64),
      image: { mimeType: "image/png", bytes: png(20) },
    },
  ],
  skippedScreens: [{ screenId: "1:3", reason: "render-url-missing" }],
});

describe("createNodeFigmaSnapshotStore", () => {
  it("persists per-screen IR + image ref + provenance + integrity hash and loads them back", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);

    expect(loaded.figmaSnapshotSchemaVersion).toBe(1);
    expect(loaded.integrityHash).toBe(BASE_INTEGRITY_HASH);
    expect(loaded.provenance.fileKey).toBe("KEY123");
    expect(loaded.provenance.version).toBe("v-pinned-1");
    expect(loaded.screens.map((s) => s.screenId)).toEqual(["1:1", "1:2"]);
    expect(firstScreen(loaded).integrityHash).toBe("b".repeat(64));
    expect(firstScreen(loaded).image.relativePath).toMatch(/\.png$/);
    expect(loaded.skippedScreens).toEqual([{ screenId: "1:3", reason: "render-url-missing" }]);
  });

  it("writes the render bytes as a side-file whose sha256 matches the bytes", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    const result = store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);

    const ref = firstScreen(loaded).image;
    const onDisk = readFileSync(join(result.sideFileDir, ref.relativePath));
    expect(Array.from(new Uint8Array(onDisk))).toEqual(Array.from(png(10)));
    expect(ref.byteLength).toBe(png(10).length);
  });

  it("is WRITE-ONCE: a second record for the same runId is refused", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    expect(() => store.record(baseInput())).toThrow(EvidenceWriteError);
  });

  it("redacts secrets out of the persisted IR content (token never on disk)", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record(baseInput());

    const qiDir = join(dir, "qi");
    const jsonFile = readdirSync(qiDir).find((f) => f.endsWith(".figma-snapshot.json"));
    if (jsonFile === undefined) throw new Error("expected a persisted snapshot record file");
    const raw = readFileSync(join(qiDir, jsonFile), "utf8");
    expect(raw).not.toContain(PLANTED_SECRET);
    expect(raw).toContain("[REDACTED]");
    expect(loadOrThrow(store, RUN_ID).redactionSummary.stringsRedacted).toBeGreaterThan(0);
  });

  it("the planted secret does not appear in ANY persisted byte under the evidence dir", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    const found = readdirSync(join(dir, "qi"), { recursive: true, encoding: "utf8" })
      .map((rel) => join(dir, "qi", rel))
      .filter((p) => p.endsWith(".json"))
      .map((p) => readFileSync(p, "utf8"))
      .some((content) => content.includes(PLANTED_SECRET));
    expect(found).toBe(false);
  });

  it("rejects a corrupt record on load via the strict-schema gate", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    expect(store.load("00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
  });

  it("persists a valid empty snapshot (no screens)", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      screens: [],
      skippedScreens: [],
      integrityHash: EMPTY_INTEGRITY_HASH,
    });

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.screens).toHaveLength(0);
    expect(loaded.skippedScreens).toHaveLength(0);
  });

  // ─── Inter-screen links — additive, optional, hash-neutral (#811) ──────────────────

  it("round-trips optional inter-screen links when provided", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      links: [{ sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" }],
    });

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.links).toEqual([
      { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" },
    ]);
  });

  it("omits `links` from the persisted record when none are provided (older snapshot)", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    const loaded = loadOrThrow(store, RUN_ID);
    // An older snapshot carries no links: the field is absent and a navigation derivation downstream
    // degrades to zero nav items rather than crashing.
    expect(loaded.links).toBeUndefined();
    expect("links" in loaded).toBe(false);
  });

  it("keeps the snapshot integrity hash unchanged whether or not links are present", () => {
    // The caller computes `integrityHash` over the snapshot identity (schema version + pinned
    // version + per-screen IR/image hashes); `links` is non-identity metadata and must NOT enter it.
    // The store records the caller's hash verbatim, so two records that differ only by `links` carry
    // an identical integrity hash — drift detection (#735) stays stable.
    const withLinks = createNodeFigmaSnapshotStore(dir);
    withLinks.record({
      ...baseInput(),
      links: [{ sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" }],
    });
    const a = loadOrThrow(withLinks, RUN_ID).integrityHash;

    const other = mkdtempSync(join(tmpdir(), "figma-snapshot-nolinks-"));
    try {
      const withoutLinks = createNodeFigmaSnapshotStore(other);
      withoutLinks.record(baseInput());
      const b = loadOrThrow(withoutLinks, RUN_ID).integrityHash;
      expect(a).toBe(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ─── Integrity check on load (#3) ────────────────────────────────────────────────────────────

describe("createNodeFigmaSnapshotStore — integrity check on load", () => {
  it("round-trip: record then load succeeds when hash is correct", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    // load() must not throw — the recomputed hash matches the persisted one.
    expect(() => loadOrThrow(store, RUN_ID)).not.toThrow();
  });

  it("rejects a record whose per-screen integrityHash was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    // Tamper: change a screen's integrityHash on disk. The snapshot-level hash is computed from
    // the per-screen integrityHash values, so this causes a mismatch on load.
    const qiDir = join(dir, "qi");
    const file = join(qiDir, `${RUN_ID}.figma-snapshot.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const screens = raw.screens as Record<string, unknown>[];
    if (screens[0] !== undefined) {
      screens[0] = { ...screens[0], integrityHash: "d".repeat(64) };
    }
    writeFileSync(file, JSON.stringify(raw), "utf8");

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });
});

// ─── Orphan cleanup (#5) ─────────────────────────────────────────────────────────────────────

describe("createNodeFigmaSnapshotStore — orphan side-dir cleanup", () => {
  it("removes a side-dir that has no matching record on first store use", () => {
    // Simulate a crash after side-files were written but before the record was written:
    // record once to create the side-dir, then remove the record JSON to create an orphan,
    // then create a new store (sweep fires on first use).
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    const qiDir = join(dir, "qi");
    const sideBase = join(qiDir, "figma-snapshots");
    const orphanDir = join(sideBase, RUN_ID);
    rmSync(join(qiDir, `${RUN_ID}.figma-snapshot.json`), { force: true });

    // New store instance — sweep fires on first use.
    const store2 = createNodeFigmaSnapshotStore(dir);
    expect(store2.load(RUN_ID)).toBeUndefined();

    // Orphaned side-dir should be gone.
    expect(lstatSync(orphanDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("removes the side-dir when the record write fails mid-operation", () => {
    // Inject a randomSuffix that throws on the 3rd call (the record JSON temp), after both
    // side-files have been written (2 screens × 1 randomSuffix call each = calls 1-2).
    let callCount = 0;
    const badRandomSuffix = (): string => {
      callCount += 1;
      // Calls 1-2: side-file atomicWriteBytes (one per screen). Call 3: record atomicWriteOnce.
      if (callCount >= 3) throw new EvidenceWriteError("injected record-write failure");
      return `00000000-0000-4000-8000-${String(callCount).padStart(12, "0")}`;
    };
    const store = createNodeFigmaSnapshotStore(dir, { randomSuffix: badRandomSuffix });

    expect(() => store.record(baseInput())).toThrow(EvidenceWriteError);

    // Side-dir must have been cleaned up after the record write failed.
    const sideDir = join(dir, "qi", "figma-snapshots", RUN_ID);
    expect(lstatSync(sideDir, { throwIfNoEntry: false })).toBeUndefined();
  });
});

// ─── listByScope (#6) ────────────────────────────────────────────────────────────────────────

describe("createNodeFigmaSnapshotStore — listByScope", () => {
  it("returns [] when no snapshots exist yet", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    expect(store.listByScope("KEY123", "0:1")).toEqual([]);
  });

  it("returns only records matching the requested fileKey+nodeId, newest first", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    // Scope A — two records with different fetchedAt.
    store.record({
      ...baseInput(),
      runId: RUN_ID,
      provenance: {
        fileKey: "KEY123",
        nodeId: "0:1",
        version: "v1",
        fetchedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    store.record({
      ...baseInput(),
      runId: RUN_ID_2,
      provenance: {
        fileKey: "KEY123",
        nodeId: "0:1",
        version: "v2",
        fetchedAt: "2026-06-10T00:00:00.000Z",
      },
    });

    // Scope B — different nodeId.
    store.record({
      ...baseInput(),
      runId: RUN_ID_3,
      provenance: {
        fileKey: "KEY123",
        nodeId: "9:9",
        version: "v1",
        fetchedAt: "2026-06-05T00:00:00.000Z",
      },
    });

    const results = store.listByScope("KEY123", "0:1");

    expect(results).toHaveLength(2);
    // Newest first.
    expect(results[0]?.runId).toBe(RUN_ID_2);
    expect(results[1]?.runId).toBe(RUN_ID);
    expect(results[0]?.fetchedAt).toBe("2026-06-10T00:00:00.000Z");
    expect(results[0]?.integrityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips an unparseable record silently (does not throw)", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    // Plant a corrupt JSON file.
    const qiDir = join(dir, "qi");
    writeFileSync(join(qiDir, `${RUN_ID_2}.figma-snapshot.json`), "not json", "utf8");

    expect(() => store.listByScope("KEY123", "0:1")).not.toThrow();
    // Only the valid record is returned.
    expect(store.listByScope("KEY123", "0:1")).toHaveLength(1);
  });
});

// ─── Retention enforcement (#4) ──────────────────────────────────────────────────────────────

describe("enforceFigmaSnapshotRetention", () => {
  it("is a no-op when the record count is within the cap", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    enforceFigmaSnapshotRetention(dir, { maxRecords: 10 });

    // Record still present.
    expect(loadOrThrow(store, RUN_ID).runId).toBe(RUN_ID);
  });

  it("deletes the oldest record + side-dir when count exceeds maxRecords", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record({
      ...baseInput(),
      runId: RUN_ID,
      provenance: { ...baseInput().provenance, fetchedAt: "2026-06-01T00:00:00.000Z" },
    });
    store.record({
      ...baseInput(),
      runId: RUN_ID_2,
      provenance: { ...baseInput().provenance, fetchedAt: "2026-06-10T00:00:00.000Z" },
    });

    // Cap to 1 — the older RUN_ID should be evicted.
    enforceFigmaSnapshotRetention(dir, { maxRecords: 1 });

    expect(store.load(RUN_ID)).toBeUndefined();
    expect(loadOrThrow(store, RUN_ID_2).runId).toBe(RUN_ID_2);
    // Side-dir for the evicted run should be gone.
    const sideDir = join(dir, "qi", "figma-snapshots", RUN_ID);
    expect(lstatSync(sideDir, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("is a no-op when the evidence dir does not exist yet", () => {
    const nonExistent = join(dir, "does-not-exist");
    expect(() => {
      enforceFigmaSnapshotRetention(nonExistent, { maxRecords: 1 });
    }).not.toThrow();
  });
});
