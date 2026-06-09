import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceWriteError } from "../../../errors.js";
import {
  createNodeFigmaSnapshotStore,
  type FigmaSnapshotStore,
  type RecordFigmaSnapshotInput,
} from "../store.js";
import type { FigmaSnapshotRecord, FigmaSnapshotScreenRow } from "../schema.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

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
const PLANTED_SECRET = "AKIAIOSFODNN7EXAMPLE";

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
  integrityHash: "a".repeat(64),
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
    expect(loaded.integrityHash).toBe("a".repeat(64));
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
    store.record({ ...baseInput(), screens: [], skippedScreens: [] });

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
