// KEIKO-0375 — parity test for the Figma-snapshot integrity hash.
//
// The canonical stringify, HASH_NEUTRAL_IR_KEYS set, and every recompute helper are duplicated
// verbatim between:
//   packages/keiko-server/src/qualityIntelligence/figma/figmaSnapshotHash.ts (this test's neighbour)
//   packages/keiko-evidence/src/qualityIntelligence/figmaSnapshot/store.ts   (verifier on load)
// A silent drift between the two would let the builder produce a hash the loader rejects (a false
// tamper alarm), or worse, let the loader accept a shape the builder no longer produces (a real
// tamper drift that the load-time recompute misses). This test computes the hash via BOTH producers
// on the same input and asserts they match: any HASH_NEUTRAL_IR_KEYS drift, canonical() drift, or
// stripHashNeutralFields projection drift makes at least one lane red.
//
// Living here on the server side keeps the fixture-parity rule (§7) intact: the assertion derives
// from the production entry points on both sides — it never re-implements the formula.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeFigmaSnapshotStore,
  type RecordFigmaSnapshotInput,
} from "@oscharko-dev/keiko-evidence";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import { hashScreen, hashSnapshot } from "../figmaSnapshotHash.js";

type ScreenIr = QualityIntelligenceFigma.ScreenIr;

// A structural Screen-IR built as a plain JSON object (evidence stores it as `unknown`). No text
// secrets so the evidence-side redaction pass never mutates the bytes we hash on the server side.
const RUN_ID = "00000000-0000-4000-8000-000000000010";
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");
const PINNED_VERSION = "v-pinned-parity-1";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "figma-snapshot-parity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface IrNodeLike {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly interactionHint: string;
  readonly imageFills: readonly string[];
  readonly children: readonly IrNodeLike[];
}

interface ScreenIrLike {
  readonly id: string;
  readonly name: string;
  readonly root: IrNodeLike;
}

const leaf = (id: string, name: string): IrNodeLike => ({
  id,
  name,
  type: "TEXT",
  interactionHint: "text",
  imageFills: [],
  children: [],
});

// A Screen-IR that both producers hash. We build ONE JSON literal and hand it to both sides:
// the evidence store as opaque `irJson`, the server hasher as its typed ScreenIr. The `as` cast
// is safe because IrNodeLike / ScreenIrLike exactly mirror the fields the server hasher touches
// after stripHashNeutralFields — no field is invented for the test.
const buildIr = (screenId: string, name: string): ScreenIrLike => ({
  id: screenId,
  name,
  root: {
    id: `${screenId}:root`,
    name,
    type: "FRAME",
    interactionHint: "container",
    imageFills: [],
    children: [leaf(`${screenId}:label`, "Label")],
  },
});

describe("Figma-snapshot integrity hash: server and evidence producers must agree (KEIKO-0375)", () => {
  it("per-screen and snapshot hashes computed by keiko-server match those persisted by keiko-evidence", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const irA = buildIr("1:1", "Home");
    const irB = buildIr("1:2", "Detail");

    const input: RecordFigmaSnapshotInput = {
      runId: RUN_ID,
      provenance: {
        fileKey: "PARITY123",
        nodeId: "0:1",
        version: PINNED_VERSION,
        fetchedAt: "2026-06-09T00:00:00.000Z",
      },
      integrityHash: "0".repeat(64),
      screens: [
        {
          screenId: "1:1",
          irJson: irA,
          integrityHash: "0".repeat(64),
          image: { mimeType: "image/png", bytes: IMAGE_BYTES },
        },
        {
          screenId: "1:2",
          irJson: irB,
          integrityHash: "0".repeat(64),
          image: { mimeType: "image/png", bytes: IMAGE_BYTES },
        },
      ],
      skippedScreens: [],
    };

    store.record(input);
    const loaded = store.load(RUN_ID);
    if (loaded === undefined) throw new Error("expected a persisted snapshot");

    // ScreenIrLike mirrors the fields hashScreen consumes; the cast to the canonical ScreenIr type
    // is scoped to this parity test and never invents a field the server hasher does not read.
    const expectedScreenAHash = hashScreen("1:1", irA as unknown as ScreenIr, IMAGE_SHA256);
    const expectedScreenBHash = hashScreen("1:2", irB as unknown as ScreenIr, IMAGE_SHA256);
    const expectedSnapshotHash = hashSnapshot(
      loaded.figmaSnapshotSchemaVersion,
      loaded.provenance.version,
      [
        { screenId: "1:1", integrityHash: expectedScreenAHash },
        { screenId: "1:2", integrityHash: expectedScreenBHash },
      ],
    );

    expect(loaded.screens.find((s) => s.screenId === "1:1")?.integrityHash).toBe(
      expectedScreenAHash,
    );
    expect(loaded.screens.find((s) => s.screenId === "1:2")?.integrityHash).toBe(
      expectedScreenBHash,
    );
    expect(loaded.integrityHash).toBe(expectedSnapshotHash);
  });
});
