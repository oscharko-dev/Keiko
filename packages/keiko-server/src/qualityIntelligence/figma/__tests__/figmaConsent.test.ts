// Read-only-scope consent tests (Epic #750, Issue #760). Synthetic only. Asserts: consent is
// recorded and gates the first fetch; the gate throws a coded error when absent; expected scopes are
// display-only and read-only; and the consent record leaks no token / board id / link.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import {
  EXPECTED_FIGMA_SCOPES,
  assertReadOnlyConsent,
  hasReadOnlyConsent,
  loadReadOnlyConsent,
  recordReadOnlyConsent,
} from "../figmaConsent.js";
import { deriveFigmaScopeRef } from "../figmaScopeRef.js";

const PLANTED_TOKEN = "figd_planted-secret-pat-DO-NOT-LEAK-9999";
const PLANTED_BOARD_ID = "abcXYZfileKey789";
const NOW = "2026-06-09T12:00:00.000Z";

let evidenceDir: string;
beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-figma-consent-"));
});
afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

const ref = (): string => deriveFigmaScopeRef(PLANTED_BOARD_ID, "12:34");

describe("read-only-scope consent", () => {
  it("has no consent before the operator acknowledges", () => {
    expect(hasReadOnlyConsent(ref(), evidenceDir)).toBe(false);
  });

  it("assertReadOnlyConsent throws FIGMA_CONSENT_REQUIRED before the first fetch when unconsented", () => {
    try {
      assertReadOnlyConsent(ref(), evidenceDir);
      throw new Error("expected assertReadOnlyConsent to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FigmaConnectorError);
      expect((error as FigmaConnectorError).code).toBe("FIGMA_CONSENT_REQUIRED");
    }
  });

  it("records consent and then lets the first fetch proceed", () => {
    const r = ref();
    recordReadOnlyConsent({ scopeRef: r, evidenceDir, acknowledgedBy: "operator-a", now: NOW });
    expect(hasReadOnlyConsent(r, evidenceDir)).toBe(true);
    expect(() => {
      assertReadOnlyConsent(r, evidenceDir);
    }).not.toThrow();
  });

  it("stores the read-only acknowledgement with the display-only expected scopes", () => {
    const r = ref();
    const consent = recordReadOnlyConsent({
      scopeRef: r,
      evidenceDir,
      acknowledgedBy: "operator-a",
      now: NOW,
    });
    expect(consent.readOnlyAcknowledged).toBe(true);
    expect(consent.acknowledgedScopes).toEqual(EXPECTED_FIGMA_SCOPES);
    expect(loadReadOnlyConsent(r, evidenceDir)?.acknowledgedAt).toBe(NOW);
  });

  it("exposes only least-privilege read-only scopes for display (no write/admin)", () => {
    expect(EXPECTED_FIGMA_SCOPES.length).toBeGreaterThan(0);
    for (const scope of EXPECTED_FIGMA_SCOPES) {
      expect(scope).toContain(":read");
      expect(scope).not.toContain(":write");
      expect(scope).not.toContain("admin");
    }
  });

  it("never writes a token or board id to the consent record", () => {
    const r = ref();
    recordReadOnlyConsent({ scopeRef: r, evidenceDir, acknowledgedBy: "operator-a", now: NOW });
    const onDisk = readFileSync(join(evidenceDir, "qi", `${r}.figma-consent.json`), "utf8");
    expect(onDisk).not.toContain(PLANTED_TOKEN);
    expect(onDisk).not.toContain("figd_");
    expect(onDisk).not.toContain(PLANTED_BOARD_ID);
    expect(onDisk).not.toContain("12:34");
    expect(onDisk).toContain(r);
  });
});
