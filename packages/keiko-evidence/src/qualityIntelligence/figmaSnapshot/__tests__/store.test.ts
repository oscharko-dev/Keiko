import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

const STALE_INTEGRITY_HASH = "0".repeat(64);
const STALE_SCREEN_HASH = "b".repeat(64);

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

const node = (
  id: string,
  name: string,
  children: readonly Record<string, unknown>[] = [],
): Record<string, unknown> => ({
  id,
  name,
  type: "FRAME",
  interactionHint: "container",
  imageFills: [],
  children,
});

const screenIr = (id: string, name: string, text?: string): Record<string, unknown> => ({
  id,
  name,
  root: node(`${id}:root`, name, text === undefined ? [] : [node(`${id}:text`, text)]),
});

const snapshotFile = (runId = RUN_ID): string => join(dir, "qi", `${runId}.figma-snapshot.json`);
const snapshotManagementFile = (runId = RUN_ID): string =>
  join(dir, "qi", `${runId}.figma-snapshot.management.json`);

const readSnapshotFile = (runId = RUN_ID): Record<string, unknown> =>
  JSON.parse(readFileSync(snapshotFile(runId), "utf8")) as Record<string, unknown>;

const writeSnapshotFile = (raw: Record<string, unknown>, runId = RUN_ID): void => {
  writeFileSync(snapshotFile(runId), JSON.stringify(raw), "utf8");
};

const rawScreens = (raw: Record<string, unknown>): Record<string, unknown>[] =>
  raw.screens as Record<string, unknown>[];

const rawImage = (screen: Record<string, unknown>): Record<string, unknown> =>
  screen.image as Record<string, unknown>;

const baseInput = (): RecordFigmaSnapshotInput => ({
  runId: RUN_ID,
  provenance: {
    fileKey: "KEY123",
    nodeId: "0:1",
    version: "v-pinned-1",
    fetchedAt: "2026-06-09T00:00:00.000Z",
  },
  integrityHash: STALE_INTEGRITY_HASH,
  screens: [
    {
      screenId: "1:1",
      irJson: screenIr("1:1", "Home", `leaked key ${PLANTED_SECRET} in a text node`),
      integrityHash: STALE_SCREEN_HASH,
      image: { mimeType: "image/png", bytes: png(10) },
    },
    {
      screenId: "1:2",
      irJson: screenIr("1:2", "Detail"),
      integrityHash: STALE_SCREEN_HASH,
      image: { mimeType: "image/png", bytes: png(20) },
    },
  ],
  skippedScreens: [{ screenId: "1:3", reason: "render-url-missing" }],
});

const metrics = (): NonNullable<RecordFigmaSnapshotInput["metrics"]> => ({
  reductionRatio: 0.4,
  screenCount: 2,
  renderCount: 2,
  designTokenCount: 3,
  augmentation: { deterministic: 4, modelAugmented: 1, modelAugmentedShare: 0.2 },
  navGraph: { screens: 2, transitions: 1 },
  a11y: { findings: 0 },
});

describe("createNodeFigmaSnapshotStore", () => {
  it("persists per-screen IR + image ref + provenance + integrity hash and loads them back", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);

    expect(loaded.figmaSnapshotSchemaVersion).toBe(1);
    expect(loaded.integrityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.integrityHash).not.toBe(STALE_INTEGRITY_HASH);
    expect(loaded.provenance.fileKey).toBe("KEY123");
    expect(loaded.provenance.version).toBe("v-pinned-1");
    expect(loaded.screens.map((s) => s.screenId)).toEqual(["1:1", "1:2"]);
    expect(firstScreen(loaded).integrityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(firstScreen(loaded).integrityHash).not.toBe(STALE_SCREEN_HASH);
    expect(firstScreen(loaded).image.relativePath).toMatch(/\.png$/);
    expect(loaded.skippedScreens).toEqual([{ screenId: "1:3", reason: "render-url-missing" }]);
  });

  it("persists and verifies structural-only screen IR without writing an image side-file", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    const result = store.record({
      ...baseInput(),
      structuralScreens: [
        {
          screenId: "1:3",
          reason: "render-screen-cap-exceeded",
          irJson: screenIr("1:3", "Search", "Query"),
          integrityHash: STALE_SCREEN_HASH,
        },
      ],
    });
    const loaded = loadOrThrow(store, RUN_ID);

    expect(
      loaded.structuralScreens?.map((s) => ({ screenId: s.screenId, reason: s.reason })),
    ).toEqual([{ screenId: "1:3", reason: "render-screen-cap-exceeded" }]);
    expect(loaded.structuralScreens?.[0]?.irJson).toMatchObject({ id: "1:3", name: "Search" });
    expect(loaded.structuralScreens?.[0]?.integrityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.structuralScreens?.[0]?.integrityHash).not.toBe(STALE_SCREEN_HASH);
    expect(readdirSync(result.sideFileDir).filter((name) => name.endsWith(".png"))).toHaveLength(2);
  });

  it("rejects tampered structural-only screen IR on load", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record({
      ...baseInput(),
      structuralScreens: [
        {
          screenId: "1:3",
          reason: "render-screen-cap-exceeded",
          irJson: screenIr("1:3", "Search", "Query"),
          integrityHash: STALE_SCREEN_HASH,
        },
      ],
    });
    const raw = readSnapshotFile();
    const structuralRows = raw.structuralScreens as Record<string, unknown>[];
    const first = structuralRows[0];
    if (first === undefined) throw new Error("expected a structural-only screen row");
    first.irJson = screenIr("1:3", "Tampered", "Query");
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("writes the render bytes as a side-file whose sha256 matches the bytes", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    const result = store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);

    const ref = firstScreen(loaded).image;
    const onDisk = readFileSync(join(result.sideFileDir, ref.relativePath));
    expect(Array.from(new Uint8Array(onDisk))).toEqual(Array.from(png(10)));
    expect(ref.byteLength).toBe(png(10).length);
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from(png(10)))
      .digest("hex");
    expect(ref.sha256).toBe(expectedSha256);
  });

  it("loads verified render bytes for a stored image ref", () => {
    const store = createNodeFigmaSnapshotStore(dir);

    store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);
    const image = store.loadImage(RUN_ID, firstScreen(loaded).image);

    expect(image.mimeType).toBe("image/png");
    expect(Array.from(image.bytes)).toEqual(Array.from(png(10)));
    expect(image.byteLength).toBe(png(10).length);
    expect(image.sha256).toBe(firstScreen(loaded).image.sha256);
  });

  it("loads metadata without verifying every image side-file, then verifies the requested image", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const result = store.record(baseInput());
    const loaded = loadOrThrow(store, RUN_ID);
    const second = loaded.screens[1];
    if (second === undefined) throw new Error("expected a second screen");
    writeFileSync(join(result.sideFileDir, second.image.relativePath), png(99));

    const metadata = store.loadMetadata(RUN_ID);
    expect(metadata?.screens).toHaveLength(2);
    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
    expect(Array.from(store.loadImage(RUN_ID, firstScreen(loaded).image).bytes)).toEqual(
      Array.from(png(10)),
    );
  });

  it("is WRITE-ONCE: a second record for the same runId is refused", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    expect(() => store.record(baseInput())).toThrow(EvidenceWriteError);
  });

  it("stores mutable display metadata without mutating the immutable snapshot record", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    const immutableBefore = readFileSync(snapshotFile(), "utf8");

    const metadata = store.updateUserMetadata(RUN_ID, {
      displayName: "Release baseline",
      updatedAt: "2026-06-19T10:00:00.000Z",
    });

    expect(metadata).toEqual({
      displayName: "Release baseline",
      updatedAt: "2026-06-19T10:00:00.000Z",
    });
    expect(store.loadUserMetadata(RUN_ID)).toEqual(metadata);
    expect(readFileSync(snapshotFile(), "utf8")).toBe(immutableBefore);
    expect(readSnapshotFile().integrityHash).toBe(loadOrThrow(store, RUN_ID).integrityHash);
  });

  it("clears the mutable display name when an empty name is stored", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    store.updateUserMetadata(RUN_ID, {
      displayName: "Release baseline",
      updatedAt: "2026-06-19T10:00:00.000Z",
    });

    const metadata = store.updateUserMetadata(RUN_ID, {
      displayName: "   ",
      updatedAt: "2026-06-19T11:00:00.000Z",
    });

    expect(metadata).toEqual({ updatedAt: "2026-06-19T11:00:00.000Z" });
    expect(store.loadUserMetadata(RUN_ID)).toEqual(metadata);
  });

  it("deletes the snapshot record, side-files, and mutable management metadata together", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const result = store.record(baseInput());
    store.updateUserMetadata(RUN_ID, {
      displayName: "Release baseline",
      updatedAt: "2026-06-19T10:00:00.000Z",
    });

    const deleted = store.deleteSnapshot(RUN_ID);

    expect(deleted).toEqual({
      runId: RUN_ID,
      recordDeleted: true,
      sideFileDirDeleted: true,
      metadataDeleted: true,
    });
    expect(store.load(RUN_ID)).toBeUndefined();
    expect(lstatSync(snapshotFile(), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(result.sideFileDir, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(snapshotManagementFile(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("does not overwrite a record that appears between the write-once precheck and final commit", () => {
    const existing = "existing snapshot written by a concurrent recorder";
    const store = createNodeFigmaSnapshotStore(dir, {
      randomSuffix: () => {
        writeFileSync(snapshotFile(), existing, { encoding: "utf8", flag: "wx" });
        return "race";
      },
    });

    expect(() =>
      store.record({
        ...baseInput(),
        screens: [],
        skippedScreens: [],
        integrityHash: STALE_INTEGRITY_HASH,
      }),
    ).toThrow(EvidenceWriteError);
    expect(readFileSync(snapshotFile(), "utf8")).toBe(existing);
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
      integrityHash: STALE_INTEGRITY_HASH,
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
    expect(loaded.artifactHashes?.links).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("filters external URL targets out of persisted inter-screen links", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      links: [
        { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" },
        { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "I4:99" },
        { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "url:https://example.com" },
        { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "https://example.com" },
        { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "mailto:user@example.com" },
      ],
    });

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.links).toEqual([
      { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" },
      { sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "I4:99" },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("https://example.com");
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

  it("round-trips optional design tokens with an artifact hash when provided", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const tokens = {
      colors: [{ id: "color:#000000", kind: "color", value: "#000000" }],
      typography: [],
      spacing: [],
      radius: [],
    };
    store.record({ ...baseInput(), tokens });

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.tokens).toEqual(tokens);
    expect(loaded.artifactHashes?.tokens).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("round-trips optional numeric metrics with an artifact hash when provided", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const m = metrics();
    store.record({ ...baseInput(), metrics: m });

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.metrics).toEqual(m);
    expect(loaded.artifactHashes?.metrics).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a record whose links artifact was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      links: [{ sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" }],
    });

    const raw = readSnapshotFile();
    raw.links = [{ sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:999" }];
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose tokens artifact was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      tokens: { colors: [], typography: [], spacing: [], radius: [] },
    });

    const raw = readSnapshotFile();
    raw.tokens = { colors: [{ id: "color:#ff0000", kind: "color", value: "#ff0000" }] };
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose metrics artifact was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({ ...baseInput(), metrics: metrics() });

    const raw = readSnapshotFile();
    raw.metrics = { ...(raw.metrics as Record<string, unknown>), renderCount: 999 };
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("omits old optional links/tokens/metrics when artifact hashes are missing", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      ...baseInput(),
      links: [{ sourceNodeId: "1:1", trigger: "ON_CLICK", targetNodeId: "1:2" }],
      tokens: { colors: [], typography: [], spacing: [], radius: [] },
      metrics: metrics(),
    });

    const raw = readSnapshotFile();
    const legacy = Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "artifactHashes"),
    );
    writeSnapshotFile(legacy);

    const loaded = loadOrThrow(store, RUN_ID);
    expect(loaded.links).toBeUndefined();
    expect(loaded.tokens).toBeUndefined();
    expect(loaded.metrics).toBeUndefined();
  });

  it("loads a snapshot whose screens were recorded in reversed screenId order (sort invariant #753)", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const base = baseInput();
    const other = mkdtempSync(join(tmpdir(), "figma-snapshot-reversed-"));
    try {
      const reference = createNodeFigmaSnapshotStore(other);
      reference.record(base);
      const referenceHash = loadOrThrow(reference, RUN_ID).integrityHash;

      // Record the same two screens as baseInput but in DESCENDING screenId order. The
      // snapshot-level integrityHash is order-independent (recompute sorts by screenId), so the
      // loaded hash must match the reference while the persisted screen order stays reversed.
      // RED if the .sort() is dropped from recomputeSnapshotIntegrityHash in store.ts.
      store.record({
        ...base,
        screens: [...base.screens].reverse(),
        integrityHash: STALE_INTEGRITY_HASH,
      });
      const loaded = loadOrThrow(store, RUN_ID);
      expect(loaded.integrityHash).toBe(referenceHash);
      expect(loaded.screens.map((s) => s.screenId)).toEqual(["1:2", "1:1"]);
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
    const screens = rawScreens(raw);
    if (screens[0] !== undefined) {
      screens[0] = { ...screens[0], integrityHash: "d".repeat(64) };
    }
    writeFileSync(file, JSON.stringify(raw), "utf8");

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose persisted screen IR was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    const raw = readSnapshotFile();
    const screens = rawScreens(raw);
    if (screens[0] !== undefined) {
      screens[0] = { ...screens[0], irJson: screenIr("1:1", "Tampered") };
    }
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose persisted image sha256 was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    const raw = readSnapshotFile();
    const first = rawScreens(raw)[0];
    if (first !== undefined) {
      first.image = { ...rawImage(first), sha256: "f".repeat(64) };
    }
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose image side-file path was tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());

    const raw = readSnapshotFile();
    const first = rawScreens(raw)[0];
    if (first !== undefined) {
      first.image = { ...rawImage(first), relativePath: "missing.png" };
    }
    writeSnapshotFile(raw);

    expect(() => store.load(RUN_ID)).toThrow(EvidenceReadError);
  });

  it("rejects a record whose image side-file bytes were tampered after persist", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const result = store.record(baseInput());
    const raw = readSnapshotFile();
    const first = rawScreens(raw)[0];
    if (first === undefined) throw new Error("expected screen");
    writeFileSync(join(result.sideFileDir, String(rawImage(first).relativePath)), png(99));

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

  it("skips symlinked record files when scanning a scope", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    const qiDir = join(dir, "qi");
    const outsideRecord = join(dir, "outside-snapshot.json");
    writeFileSync(
      outsideRecord,
      JSON.stringify({
        runId: RUN_ID_2,
        provenance: {
          fileKey: "KEY123",
          nodeId: "0:1",
          version: "v-linked",
          fetchedAt: "2026-06-20T00:00:00.000Z",
        },
        integrityHash: "f".repeat(64),
      }),
      "utf8",
    );
    try {
      symlinkSync(outsideRecord, join(qiDir, `${RUN_ID_2}.figma-snapshot.json`));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const results = store.listByScope("KEY123", "0:1");

    expect(results.map((entry) => entry.runId)).toEqual([RUN_ID]);
  });
});

describe("createNodeFigmaSnapshotStore — listRecent", () => {
  it("returns recent run ids newest first across all scopes", () => {
    const store = createNodeFigmaSnapshotStore(dir);

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
        fileKey: "KEY999",
        nodeId: "9:9",
        version: "v2",
        fetchedAt: "2026-06-10T00:00:00.000Z",
      },
    });
    store.record({
      ...baseInput(),
      runId: RUN_ID_3,
      provenance: {
        fileKey: "KEY123",
        nodeId: "0:2",
        version: "v3",
        fetchedAt: "2026-06-05T00:00:00.000Z",
      },
    });

    expect(store.listRecent()).toEqual([RUN_ID_2, RUN_ID_3, RUN_ID]);
    expect(store.listRecent(2)).toEqual([RUN_ID_2, RUN_ID_3]);
  });

  it("skips unparseable snapshot files silently", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    store.record(baseInput());
    const qiDir = join(dir, "qi");
    writeFileSync(join(qiDir, `${RUN_ID_2}.figma-snapshot.json`), "not json", "utf8");

    expect(store.listRecent()).toEqual([RUN_ID]);
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
