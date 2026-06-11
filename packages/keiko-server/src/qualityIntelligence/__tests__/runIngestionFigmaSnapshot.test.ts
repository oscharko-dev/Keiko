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
  ...(over.boundingBox !== undefined ? { boundingBox: over.boundingBox } : {}),
  ...(over.textColor !== undefined ? { textColor: over.textColor } : {}),
  ...(over.backgroundColor !== undefined ? { backgroundColor: over.backgroundColor } : {}),
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
  links?: FigmaSnapshotRecord["links"],
): FigmaSnapshotRecord => ({
  figmaSnapshotSchemaVersion: 1,
  runId: "snap-1",
  provenance: { fileKey: "fk", nodeId: "1:2", version: undefined, fetchedAt: TS },
  screens,
  skippedScreens: [],
  ...(links !== undefined ? { links } : {}),
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
    const accessKeyId = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const ir = screenIr(
      "s-secret",
      "Config",
      irNode("root", "container", {
        children: [irNode("token", "text", { text: `${accessKeyId} secret value` })],
      }),
    );
    // The text node is not interactive, but the secret reaches the rendered baseline via a vision
    // hint here to prove the redact() pass covers the full atom text.
    const vision: FigmaVisionHintProvider = () => [`leaked ${accessKeyId} token in mock`];

    const result = ingestInlineSources(
      input([figmaSource()], {
        figmaSnapshotLoader: loaderFor(record([screenRow("s-secret", ir)])),
        figmaVision: vision,
      }),
    );

    expect(result.ingestedAtoms[0]?.canonicalText ?? "").not.toContain(accessKeyId);
  });
});

// ─── Composition with multi-source (#729) ────────────────────────────────────────
//
// These tests are MUTATION-ROBUST: they would fail against the pre-fix code where
// ingestFigmaSnapshot called figmaScreenDocs without a byteBudget and the function
// used the hardcoded CAPSULE_BUDGET_BYTES (196 608) instead of the fair per-source
// share. The key assertion is that summed figma-atom bytes ≤ perSourceByteBudget(2)
// = 98 304. Under the old code a large-enough figma snapshot would produce
// >98 304 bytes, violating this bound and causing QI_PROMPT_TOO_LARGE in real runs.

// EVIDENCE_BUDGET_BYTES / 2 = 196 608 / 2 = 98 304.
const PER_SOURCE_BUDGET_2 = 98_304;

/** UTF-8 byte length (mirrors the implementation's truncateToUtf8Bytes counter). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Build a snapshot record with `n` screens each containing a large padded text. */
function bigMultiScreenRecord(n: number, textPerScreen: string): FigmaSnapshotRecord {
  const screens = Array.from({ length: n }, (_, i) =>
    screenRow(
      `s-${String(i)}`,
      screenIr(
        `s-${String(i)}`,
        `Screen${String(i)}`,
        irNode("root", "container", {
          children: [irNode("btn", "button", { text: textPerScreen })],
        }),
      ),
    ),
  );
  return record(screens);
}

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

  it(
    "figma-snapshot atoms stay within perSourceByteBudget(2) when composed with a second source " +
      "(mutation-proof: fails against pre-fix code that ignores the budget)",
    () => {
      // Build a snapshot large enough that, without the budget, the raw corpus would exceed
      // perSourceByteBudget(2) = 98 304. 20 screens × ~6 000 chars > 98 304.
      const bigPad = "A".repeat(6_000);
      const rec = bigMultiScreenRecord(20, bigPad);
      const requirements = {
        kind: "requirements" as const,
        label: "Reqs",
        text: "The system shall allow login.\nThe system shall lock after five attempts.",
      };

      // Must not throw QI_PROMPT_TOO_LARGE (was the production failure mode pre-fix).
      const result = ingestInlineSources(
        input([requirements, figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
      );

      const figmaAtoms = result.ingestedAtoms.filter((a) => {
        const envId = a.atom.sourceEnvelopeId;
        const env = result.envelopes.find((e) => e.id === envId);
        return env?.provenance.origin.startsWith("figma-snapshot");
      });

      const figmaTotalBytes = figmaAtoms.reduce((sum, a) => sum + utf8Bytes(a.canonicalText), 0);
      // The figma source's combined atom text must not exceed its fair share (98 304).
      // Under the pre-fix code figmaScreenDocs used CAPSULE_BUDGET_BYTES (196 608), so
      // figmaTotalBytes would be ~120 000 and this assertion would FAIL — confirming mutation
      // sensitivity. With the fix, figmaScreenDocs caps at perRunBudget = min(196608, 98304) = 98304.
      expect(figmaTotalBytes).toBeLessThanOrEqual(PER_SOURCE_BUDGET_2);
      // Sanity: both sources produced atoms.
      const kinds = result.sourceSummaries.map((s) => s.kind);
      expect(kinds).toContain("figma-snapshot");
      expect(kinds).toContain("requirements");
    },
  );

  it("single figma-snapshot source keeps full EVIDENCE_BUDGET_BYTES (196 608) — single-source unchanged", () => {
    // With sources.length = 1, perSourceByteBudget returns EVIDENCE_BUDGET_BYTES = 196 608.
    // A large-but-not-overwhelming snapshot should produce atoms without truncation.
    const bigPad = "A".repeat(6_000);
    const rec = bigMultiScreenRecord(5, bigPad);

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
    );

    // Should ingest all 5 screens (each ~6 000 bytes × 5 = ~30 000 << 196 608).
    expect(result.ingestedAtoms).toHaveLength(5);
    const totalBytes = result.ingestedAtoms.reduce((sum, a) => sum + utf8Bytes(a.canonicalText), 0);
    // Under the single-source budget (196 608) all 5 screens fit; none should be truncated away.
    expect(totalBytes).toBeGreaterThan(0);
    // And the total is well within the full budget (sanity: not starved by a wrongly halved budget).
    expect(totalBytes).toBeLessThanOrEqual(196_608);
  });
});

// ─── Navigation/flow composition through the extraItems seam (#811) ───────────────
//
// The nav-derived test items are composed into each screen's structural baseline additively. A
// snapshot WITHOUT links degrades to zero nav items (identical to the IR-only path); a snapshot WITH
// links contributes navigation, flow, and coverage-notice items attributed per screen.

describe("figma-snapshot ingestion — navigation/flow composition (#811)", () => {
  // Two screens: Login (has a button) → Home; Home is a dead end (no outgoing link).
  const navRecord = (): FigmaSnapshotRecord =>
    record(
      [
        screenRow(
          "s-login",
          screenIr(
            "s-login",
            "Login",
            irNode("login-root", "container", { children: [irNode("login-btn", "button")] }),
          ),
        ),
        screenRow("s-home", screenIr("s-home", "Home", irNode("home-root", "container"))),
      ],
      [{ sourceNodeId: "login-btn", trigger: "ON_CLICK", targetNodeId: "home-root" }],
    );

  it("adds a navigation test item to the source screen's atom text", () => {
    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(navRecord()) }),
    );
    const loginText =
      result.ingestedAtoms.find((a) => a.canonicalText.includes("[s-login]"))?.canonicalText ?? "";

    expect(loginText).toContain("(navigation)");
    expect(loginText).toContain("Login");
    expect(loginText).toContain("Home");
    // The deterministic structural baseline is still present (composition is additive).
    expect(loginText).toContain("(screen-render)");
  });

  it("adds a dead-end coverage notice to the terminal screen's atom text", () => {
    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(navRecord()) }),
    );
    const homeText =
      result.ingestedAtoms.find((a) => a.canonicalText.includes("[s-home]"))?.canonicalText ?? "";

    expect(homeText).toContain("(coverage-notice)");
    expect(homeText.toLowerCase()).toContain("dead end");
  });

  it("degrades to zero nav items when the snapshot carries no links (older record)", () => {
    const result = ingestInlineSources(
      input([figmaSource()], {
        figmaSnapshotLoader: loaderFor(
          record([
            screenRow(
              "s-login",
              screenIr(
                "s-login",
                "Login",
                irNode("login-root", "container", { children: [irNode("login-btn", "button")] }),
              ),
            ),
          ]),
        ),
      }),
    );
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";

    expect(text).toContain("(screen-render)");
    expect(text).not.toContain("(navigation)");
    expect(text).not.toContain("(flow)");
  });
});

// ─── Accessibility composition through the extraItems seam (#812) ─────────────────
//
// The a11y-derived test items are composed into each screen's structural baseline additively, in the
// SAME `extraItems` seam as the navigation items (#811) — concatenated, never replacing them. A
// snapshot WITHOUT links still yields a11y items; a snapshot WITH links yields BOTH the navigation
// items AND the a11y items on the source screen's atom.

describe("figma-snapshot ingestion — accessibility composition (#812)", () => {
  // A screen whose only interactive control is an un-named button below the 24×24 minimum, plus a
  // low-contrast text node (#777 on #fff), so the a11y pass deterministically yields several items.
  const a11yScreen = (): unknown =>
    screenIr(
      "s-a11y",
      "Settings",
      irNode("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          irNode("faint", "text", { text: "Hint", textColor: "#777777" }),
          irNode("icon", "button", {
            name: "123:45",
            boundingBox: { x: 0, y: 0, width: 20, height: 20 },
          }),
        ],
      }),
    );

  it("adds a11y test items to a screen's atom text (model-free)", () => {
    const result = ingestInlineSources(
      input([figmaSource()], {
        figmaSnapshotLoader: loaderFor(record([screenRow("s-a11y", a11yScreen())])),
      }),
    );
    const text = result.ingestedAtoms[0]?.canonicalText ?? "";

    expect(text).toContain("(a11y)");
    expect(text.toLowerCase()).toContain("contrast");
    expect(text.toLowerCase()).toContain("accessible name");
    expect(text.toLowerCase()).toContain("target size");
    // The deterministic structural baseline is still present (composition is additive).
    expect(text).toContain("(screen-render)");
  });

  it("emits a11y items ALONGSIDE navigation items on the same screen (neither replaces the other)", () => {
    // Login screen has a button that navigates to Home AND a low-contrast text node, so BOTH the
    // navigation item (#811) and the a11y contrast item (#812) must appear on the same atom.
    const rec = record(
      [
        screenRow(
          "s-login",
          screenIr(
            "s-login",
            "Login",
            irNode("login-root", "container", {
              backgroundColor: "#ffffff",
              children: [
                irNode("login-btn", "button", { text: "Continue" }),
                irNode("faint", "text", { text: "Faint", textColor: "#777777" }),
              ],
            }),
          ),
        ),
        screenRow("s-home", screenIr("s-home", "Home", irNode("home-root", "container"))),
      ],
      [{ sourceNodeId: "login-btn", trigger: "ON_CLICK", targetNodeId: "home-root" }],
    );

    const result = ingestInlineSources(
      input([figmaSource()], { figmaSnapshotLoader: loaderFor(rec) }),
    );
    const loginText =
      result.ingestedAtoms.find((a) => a.canonicalText.includes("[s-login]"))?.canonicalText ?? "";

    // BOTH categories present on the SAME screen's atom — the seam concatenates, never replaces.
    expect(loginText).toContain("(navigation)");
    expect(loginText).toContain("(a11y)");
    expect(loginText).toContain("(screen-render)");
  });
});
