// Unit tests for figma-snapshot QI source ingestion (Epic #750, Issue #754).
//
// Mutation-robust: each structural-baseline category, the per-screen attribution, vision-additive
// behaviour (never overrides the IR), graceful IR-only degradation, the missing-snapshot coded
// error, redaction-before-persist, and multi-source composition each has a dedicated case.
// Deterministic — no network, no filesystem: the snapshot LOADER is injected as a pure stub so the
// tests synthesise a FigmaSnapshotRecord directly (synthetic fixtures only, never a real board).

import { describe, expect, it } from "vitest";
import { ingestInlineSources, QiIngestionError } from "../runIngestion.js";
import type { IngestInlineSourcesInput, QiIngestionResult } from "../runIngestion.js";
import type { FigmaSnapshotLoader, FigmaVisionHintProvider } from "../figmaSnapshotAdapter.js";
import type { FigmaSnapshotRecord } from "@oscharko-dev/keiko-evidence";
import type { QualityIntelligenceStartRunRequest } from "@oscharko-dev/keiko-contracts";

const RUN_ID = "run-figma-001";
const TS = "2026-06-01T12:00:00.000Z";

// ─── Synthetic Screen-IR + snapshot-record fixtures ───────────────────────────────

const irNode = (
  id: string,
  interactionHint: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: over.name ?? id,
  type: over.type ?? "FRAME",
  interactionHint,
  ...(over.text !== undefined ? { text: over.text } : {}),
  imageFills: over.imageFills ?? [],
  children: over.children ?? [],
});

const screenIr = (id: string, name: string, root: Record<string, unknown>): unknown => ({
  id,
  name,
  root,
});

const screenRow = (screenId: string, irJson: unknown): FigmaSnapshotRecord["screens"][number] => ({
  screenId,
  irJson,
  image: {
    mimeType: "image/png",
    relativePath: `screen-${screenId}.png`,
    sha256: "0".repeat(64),
    byteLength: 4,
  },
  integrityHash: "hash-".concat(screenId),
});

const record = (
  screens: readonly FigmaSnapshotRecord["screens"][number][],
): FigmaSnapshotRecord => ({
  figmaSnapshotSchemaVersion: 1,
  runId: "snap-1",
  provenance: { fileKey: "fk", nodeId: "1:2", version: undefined, fetchedAt: TS },
  screens,
  skippedScreens: [],
  integrityHash: "root-hash",
  redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
});

const loaderFor =
  (rec: FigmaSnapshotRecord | undefined): FigmaSnapshotLoader =>
  () =>
    rec;

function input(
  sources: QualityIntelligenceStartRunRequest["sources"],
  over: Partial<IngestInlineSourcesInput> = {},
): IngestInlineSourcesInput {
  return { request: { sources }, runId: RUN_ID, registeredAt: TS, ...over };
}

const figmaSource = (label = "My snapshot", snapshotRunId = "snap-1") =>
  ({ kind: "figma-snapshot", label, snapshotRunId }) as const;

// A login screen with an input field, a submit button, a help link, and a stateful variant node.
const loginScreen = (): unknown =>
  screenIr(
    "screen-login",
    "Login",
    irNode("root", "container", {
      children: [
        irNode("email", "input", { text: "Email" }),
        irNode("submit", "button", { text: "Sign in" }),
        irNode("forgot", "link", { text: "Forgot password" }),
        irNode("btn", "button", { name: "CTA, state=disabled", text: "Pay" }),
      ],
    }),
  );

// ─── Structural baseline → atoms ─────────────────────────────────────────────────

describe("figma-snapshot ingestion — deterministic structural baseline", () => {
  it("ingests one citation-ready atom per screen with the structural baseline text", () => {
    const result: QiIngestionResult = ingestInlineSources(
      input([figmaSource()], {
        figmaSnapshotLoader: loaderFor(record([screenRow("screen-login", loginScreen())])),
      }),
    );

    expect(result.ingestedAtoms).toHaveLength(1);
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";
    expect(text).toContain("Screen: Login [screen-login]");
    expect(text).toContain("(field-presence)");
    expect(text).toContain("(field-validation)");
    expect(text).toContain("(control-action)");
    expect(text).toContain("(screen-render)");
    expect(text).toContain("(state)");
  });

  it("produces one atom per screen for a multi-screen snapshot (per-screen attribution)", () => {
    const rec = record([
      screenRow(
        "s-a",
        screenIr("s-a", "Home", irNode("r", "container", { children: [irNode("b", "button")] })),
      ),
      screenRow(
        "s-b",
        screenIr(
          "s-b",
          "Settings",
          irNode("r2", "container", { children: [irNode("i", "input")] }),
        ),
      ),
    ]);

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
    );

    expect(result.ingestedAtoms).toHaveLength(2);
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("[s-a]");
    expect(result.ingestedAtoms[1]?.canonicalText).toContain("[s-b]");
    expect(result.envelopes[0]?.provenance.origin).toBe("figma-snapshot:snap-1");
  });

  it("skips a screen whose irJson is unparseable but ingests the parseable ones", () => {
    const rec = record([
      screenRow("bad", { not: "a screen ir" }),
      screenRow(
        "ok",
        screenIr("ok", "Ok", irNode("r", "container", { children: [irNode("b", "button")] })),
      ),
    ]);

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
    );

    expect(result.ingestedAtoms).toHaveLength(1);
    expect(result.ingestedAtoms[0]?.canonicalText).toContain("[ok]");
  });
});

// ─── Coded error paths ────────────────────────────────────────────────────────────

describe("figma-snapshot ingestion — coded errors", () => {
  it("throws QI_FIGMA_SNAPSHOT_UNAVAILABLE when the snapshot is missing", () => {
    try {
      ingestInlineSources(input([figmaSource()], { figmaSnapshotLoader: loaderFor(undefined) }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_FIGMA_SNAPSHOT_UNAVAILABLE");
    }
  });

  it("throws QI_FIGMA_SNAPSHOT_UNAVAILABLE when no loader is configured at all", () => {
    try {
      ingestInlineSources(input([figmaSource()]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_FIGMA_SNAPSHOT_UNAVAILABLE");
    }
  });

  it("throws QI_SOURCE_EMPTY when the snapshot has no screens", () => {
    try {
      ingestInlineSources(input([figmaSource()], { figmaSnapshotLoader: loaderFor(record([])) }));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });

  it("throws QI_SOURCE_EMPTY when no screen has a parseable IR", () => {
    const rec = record([screenRow("bad", { not: "ir" }), screenRow("bad2", 42)]);
    try {
      ingestInlineSources(input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as QiIngestionError).code).toBe("QI_SOURCE_EMPTY");
    }
  });
});

// ─── Vision augmentation (additive, never overrides IR) + graceful degradation ─────

describe("figma-snapshot ingestion — vision augmentation", () => {
  const rec = (): FigmaSnapshotRecord => record([screenRow("screen-login", loginScreen())]);

  it("appends vision hints additively while preserving the structural baseline", () => {
    const vision: FigmaVisionHintProvider = () => [
      "The CTA is visually de-emphasised when disabled",
    ];

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec()), figmaVision: vision }),
    );
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";

    // Structural baseline lines are STILL present (vision never overrides the IR) ...
    expect(text).toContain("(field-presence)");
    expect(text).toContain("(control-action)");
    // ... and the additive hint appears below them.
    expect(text).toContain("The CTA is visually de-emphasised when disabled");
    expect(text.indexOf("(field-presence)")).toBeLessThan(
      text.indexOf("The CTA is visually de-emphasised when disabled"),
    );
  });

  it("degrades to IR-only when no vision provider is supplied", () => {
    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec()) }),
    );
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";

    expect(text).toContain("(screen-render)");
    expect(text).not.toContain("Vision-derived");
  });

  it("ignores a vision provider that returns garbage (still ships the baseline)", () => {
    const garbage: FigmaVisionHintProvider = () => ["", "   "];

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec()), figmaVision: garbage }),
    );
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";

    expect(text).toContain("(screen-render)");
    expect(text).not.toContain("Vision-derived");
  });
});

// ─── Redaction before persist ─────────────────────────────────────────────────────

describe("figma-snapshot ingestion — redaction", () => {
  it("redacts a secret planted in the screen IR text before it reaches an atom", () => {
    const ir = screenIr(
      "s-secret",
      "Config",
      irNode("root", "container", {
        children: [irNode("token", "text", { text: "AKIAIOSFODNN7EXAMPLE secret value" })],
      }),
    );
    // The text node is not interactive, but the secret reaches the rendered baseline via a vision
    // hint here to prove the redact() pass covers the full atom text.
    const vision: FigmaVisionHintProvider = () => ["leaked AKIAIOSFODNN7EXAMPLE token in mock"];

    const result = ingestInlineSources(
      input([figmaSource()], {
        figmaSnapshotLoader: loaderFor(record([screenRow("s-secret", ir)])),
        figmaVision: vision,
      }),
    );

    expect(result.ingestedAtoms[0]?.canonicalText ?? "").not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

// ─── Composition with multi-source (#729) ────────────────────────────────────────

describe("figma-snapshot ingestion — multi-source composition", () => {
  it("composes a figma-snapshot source alongside a requirements source with a fair budget", () => {
    const rec = record([
      screenRow(
        "s-a",
        screenIr("s-a", "A", irNode("r", "container", { children: [irNode("b", "button")] })),
      ),
    ]);
    const requirements = {
      kind: "requirements" as const,
      label: "Reqs",
      text:
        "The system shall allow login.\nThe system shall lock after five attempts.\n" +
        "The system shall show an error on bad input.",
    };

    const result = ingestInlineSources(
      input([requirements, figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
    );

    const kinds = result.sourceSummaries.map((s) => s.kind);
    expect(kinds).toContain("figma-snapshot");
    expect(kinds).toContain("requirements");
    expect(result.envelopes).toHaveLength(2);
  });
});
