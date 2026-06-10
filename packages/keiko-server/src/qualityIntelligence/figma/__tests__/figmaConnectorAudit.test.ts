// Connector-activity audit ledger tests (Epic #750, Issue #760). Synthetic fixtures only; no live
// Figma. Asserts: an entry is emitted per action; the reused contained store round-trips and appends;
// and — the load-bearing governance invariant — a planted token, board id, board link, and screen
// name are ABSENT from the serialised audit artifact for every action.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFigmaConnectorAudit,
  loadFigmaConnectorAudit,
  type FigmaConnectorAction,
  type FigmaConnectorAuditCounts,
} from "../figmaConnectorAudit.js";
import { deriveFigmaScopeRef } from "../figmaScopeRef.js";

// Planted secrets / customer-content markers. None may appear in any audit artifact.
const PLANTED_TOKEN = "figd_planted-secret-pat-DO-NOT-LEAK-9999";
const PLANTED_BOARD_ID = "abcXYZfileKey789";
const PLANTED_BOARD_LINK = "https://www.figma.com/design/abcXYZfileKey789/Q4-Launch";
const PLANTED_SCREEN_NAME = "Onboarding · Personal Details";

const NOW = "2026-06-09T12:00:00.000Z";

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-figma-audit-"));
});
afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

const scopeRef = (): string => deriveFigmaScopeRef(PLANTED_BOARD_ID, "12:34");

const counts: FigmaConnectorAuditCounts = {
  screens: 5,
  renders: 4,
  skipped: 1,
  designTokens: 9,
  navTransitions: 3,
};

describe("appendFigmaConnectorAudit", () => {
  it("emits one append-only entry per connector action in order", () => {
    const ref = scopeRef();
    const actions: readonly FigmaConnectorAction[] = [
      "connect",
      "snapshot",
      "resnapshot",
      "revoke",
    ];
    for (const action of actions) {
      appendFigmaConnectorAudit({ scopeRef: ref, evidenceDir, action, outcome: "ok", now: NOW });
    }
    const artifact = loadFigmaConnectorAudit(ref, evidenceDir);
    expect(artifact?.auditLog.map((e) => e.action)).toEqual([
      "connect",
      "snapshot",
      "resnapshot",
      "revoke",
    ]);
    expect(artifact?.auditLog.every((e) => e.outcome === "ok")).toBe(true);
  });

  it("records counts on a successful snapshot and an errorCode on a failure", () => {
    const ref = scopeRef();
    appendFigmaConnectorAudit({
      scopeRef: ref,
      evidenceDir,
      action: "snapshot",
      outcome: "ok",
      counts,
      now: NOW,
    });
    appendFigmaConnectorAudit({
      scopeRef: ref,
      evidenceDir,
      action: "resnapshot",
      outcome: "error",
      errorCode: "FIGMA_RATE_LIMITED",
      now: NOW,
    });
    const log = loadFigmaConnectorAudit(ref, evidenceDir)?.auditLog ?? [];
    expect(log[0]?.counts).toEqual(counts);
    expect(log[0]?.errorCode).toBeUndefined();
    expect(log[1]?.outcome).toBe("error");
    expect(log[1]?.errorCode).toBe("FIGMA_RATE_LIMITED");
    expect(log[1]?.counts).toBeUndefined();
  });

  it("drops an errorCode that was passed alongside an ok outcome (no leak of failure detail)", () => {
    const ref = scopeRef();
    appendFigmaConnectorAudit({
      scopeRef: ref,
      evidenceDir,
      action: "connect",
      outcome: "ok",
      // An ok outcome must never carry an errorCode even if a caller mistakenly supplies one.
      errorCode: "FIGMA_INTERNAL",
      now: NOW,
    });
    expect(loadFigmaConnectorAudit(ref, evidenceDir)?.auditLog[0]?.errorCode).toBeUndefined();
  });

  it("never writes a token, board id, board link, or screen name to the audit artifact", () => {
    const ref = scopeRef();
    const actions: readonly FigmaConnectorAction[] = [
      "connect",
      "snapshot",
      "resnapshot",
      "revoke",
    ];
    for (const action of actions) {
      appendFigmaConnectorAudit({
        scopeRef: ref,
        evidenceDir,
        action,
        outcome: action === "revoke" ? "error" : "ok",
        ...(action === "revoke" ? { errorCode: "FIGMA_TOKEN_REVOKED" as const } : {}),
        ...(action === "snapshot" ? { counts } : {}),
        now: NOW,
      });
    }
    // Read the raw on-disk artifact bytes — not the parsed object — so a leak anywhere in the
    // serialised form is caught.
    const onDisk = readFileSync(join(evidenceDir, "qi", `${ref}.figma-audit.json`), "utf8");
    expect(onDisk).not.toContain(PLANTED_TOKEN);
    expect(onDisk).not.toContain("figd_");
    expect(onDisk).not.toContain(PLANTED_BOARD_ID);
    expect(onDisk).not.toContain(PLANTED_BOARD_LINK);
    expect(onDisk).not.toContain("figma.com");
    expect(onDisk).not.toContain(PLANTED_SCREEN_NAME);
    expect(onDisk).not.toContain("12:34"); // the raw node id
    // The opaque scopeRef IS present — that is the only board-derived identifier permitted.
    expect(onDisk).toContain(ref);
  });
});
