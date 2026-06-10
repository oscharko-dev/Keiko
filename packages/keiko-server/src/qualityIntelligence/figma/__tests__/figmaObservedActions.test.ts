// Observed connector-action hook tests (Epic #750, Issue #760). Synthetic only; no live Figma.
// Asserts: consent gates the first snapshot; a successful snapshot audits with counts and yields
// metrics; a failing snapshot audits the coded error and re-raises; revoke audits without consent;
// and no token / board id / link reaches the audit artifact through the wrapper.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaProvenance } from "../figmaConnector.js";
import type { FigmaSnapshot } from "../figmaSnapshotTypes.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import { loadFigmaConnectorAudit } from "../figmaConnectorAudit.js";
import { recordReadOnlyConsent } from "../figmaConsent.js";
import { deriveFigmaScopeRef } from "../figmaScopeRef.js";
import { observeFigmaRevoke, observeFigmaSnapshot } from "../figmaObservedActions.js";

const PLANTED_TOKEN = "figd_planted-secret-pat-DO-NOT-LEAK-9999";
const PLANTED_BOARD_ID = "abcXYZfileKey789";
const PLANTED_NODE_ID = "12:34";
const NOW = "2026-06-09T12:00:00.000Z";

const provenance: FigmaProvenance = {
  fileKey: PLANTED_BOARD_ID,
  nodeId: PLANTED_NODE_ID,
  version: "v1",
  fetchedAt: NOW,
};

const screen = (id: string): QualityIntelligenceFigma.ScreenIr => ({
  id,
  name: "Onboarding · Personal Details",
  root: { id, name: id, type: "FRAME", interactionHint: "container", imageFills: [], children: [] },
});

const ir = (): QualityIntelligenceFigma.ScreenIrResult => ({
  screens: [screen("a"), screen("b")],
  tokens: {
    colors: [{ id: "c", kind: "color", value: "#fff" }],
    typography: [],
    spacing: [],
    radius: [],
  },
  links: [{ sourceNodeId: "a", trigger: "ON_CLICK", targetNodeId: "b" }],
  reduction: { inputNodeCount: 10, keptNodeCount: 4, removedNodeCount: 6, removedRatio: 0.6 },
});

const snapshot: FigmaSnapshot = {
  snapshotSchemaVersion: 1,
  provenance,
  screens: [
    {
      screenId: "a",
      ir: screen("a"),
      image: { mimeType: "image/png", bytes: new Uint8Array([1]), byteLength: 1, sha256: "h" },
      integrityHash: "ih",
    },
  ],
  skippedScreens: [{ screenId: "b", reason: "render-url-missing" }],
  integrityHash: "snap",
};

let evidenceDir: string;
beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-figma-observed-"));
});
afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

const ref = (): string => deriveFigmaScopeRef(PLANTED_BOARD_ID, PLANTED_NODE_ID);
const consent = (): void => {
  recordReadOnlyConsent({ scopeRef: ref(), evidenceDir, acknowledgedBy: "op", now: NOW });
};

describe("observeFigmaSnapshot", () => {
  it("rejects the snapshot when consent has not been recorded", async () => {
    await expect(
      observeFigmaSnapshot({
        ctx: { evidenceDir, now: NOW },
        provenance,
        ir: ir(),
        augmentation: { deterministic: 1, modelAugmented: 0 },
        run: () => Promise.resolve(snapshot),
      }),
    ).rejects.toMatchObject({ code: "FIGMA_CONSENT_REQUIRED" });
    // No build ran, so no audit entry was written.
    expect(loadFigmaConnectorAudit(ref(), evidenceDir)).toBeUndefined();
  });

  it("audits with counts and returns metrics on a successful snapshot", async () => {
    consent();
    const result = await observeFigmaSnapshot({
      ctx: { evidenceDir, now: NOW },
      provenance,
      ir: ir(),
      augmentation: { deterministic: 3, modelAugmented: 1 },
      extras: { a11yFindings: 2 },
      run: () => Promise.resolve(snapshot),
    });
    expect(result.metrics.screenCount).toBe(2);
    expect(result.metrics.renderCount).toBe(1);
    expect(result.metrics.designTokenCount).toBe(1);
    expect(result.metrics.augmentation.modelAugmentedShare).toBe(0.25);
    expect(result.metrics.navGraph).toEqual({ screens: 2, transitions: 1 });
    expect(result.metrics.a11y).toEqual({ findings: 2 });

    const entry = loadFigmaConnectorAudit(ref(), evidenceDir)?.auditLog[0];
    expect(entry?.action).toBe("snapshot");
    expect(entry?.outcome).toBe("ok");
    expect(entry?.counts).toEqual({
      screens: 2,
      renders: 1,
      skipped: 1,
      designTokens: 1,
      navTransitions: 1,
    });
  });

  it("audits the coded failure and re-raises when the build throws", async () => {
    consent();
    await expect(
      observeFigmaSnapshot({
        ctx: { evidenceDir, now: NOW },
        provenance,
        ir: ir(),
        augmentation: { deterministic: 1, modelAugmented: 0 },
        isResnapshot: true,
        run: () => Promise.reject(new FigmaConnectorError("FIGMA_RATE_LIMITED")),
      }),
    ).rejects.toMatchObject({ code: "FIGMA_RATE_LIMITED" });
    const entry = loadFigmaConnectorAudit(ref(), evidenceDir)?.auditLog[0];
    expect(entry?.action).toBe("resnapshot");
    expect(entry?.outcome).toBe("error");
    expect(entry?.errorCode).toBe("FIGMA_RATE_LIMITED");
    expect(entry?.counts).toBeUndefined();
  });

  it("audits a non-coded build failure as FIGMA_INTERNAL and re-raises the original error", async () => {
    consent();
    const boom = new Error("unexpected");
    await expect(
      observeFigmaSnapshot({
        ctx: { evidenceDir, now: NOW },
        provenance,
        ir: ir(),
        augmentation: { deterministic: 1, modelAugmented: 0 },
        run: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
    expect(loadFigmaConnectorAudit(ref(), evidenceDir)?.auditLog[0]?.errorCode).toBe(
      "FIGMA_INTERNAL",
    );
  });

  it("leaks no token, board id, or node id through the wrapper's audit artifact", async () => {
    consent();
    await observeFigmaSnapshot({
      ctx: { evidenceDir, now: NOW },
      provenance,
      ir: ir(),
      augmentation: { deterministic: 1, modelAugmented: 0 },
      run: () => Promise.resolve(snapshot),
    });
    const onDisk = readFileSync(join(evidenceDir, "qi", `${ref()}.figma-audit.json`), "utf8");
    expect(onDisk).not.toContain(PLANTED_TOKEN);
    expect(onDisk).not.toContain("figd_");
    expect(onDisk).not.toContain(PLANTED_BOARD_ID);
    expect(onDisk).not.toContain(PLANTED_NODE_ID);
    expect(onDisk).not.toContain("Onboarding · Personal Details");
  });
});

describe("observeFigmaRevoke", () => {
  it("runs the revoke and audits it without requiring consent", () => {
    let revoked = false;
    observeFigmaRevoke({
      ctx: { evidenceDir, now: NOW },
      scopeRef: ref(),
      run: () => {
        revoked = true;
      },
    });
    expect(revoked).toBe(true);
    const entry = loadFigmaConnectorAudit(ref(), evidenceDir)?.auditLog[0];
    expect(entry?.action).toBe("revoke");
    expect(entry?.outcome).toBe("ok");
  });
});
