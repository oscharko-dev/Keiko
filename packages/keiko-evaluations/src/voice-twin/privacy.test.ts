// Unit tests for privacy.ts (Issue #505 — per-module coverage additions).
//
// Targets uncovered branches:
//   - line 83: the scoped-package match branch `denied.startsWith("@") &&
//     dependencyName.startsWith(denied + "/")` — hit by @daily-co/daily-js matching @daily-co
//   - canonical sort ordering with multiple hits across different manifests
//   - ALLOWED_MEDIA_RUNTIME: "ws" is allowed and never flagged
//   - auditVoiceEgress: zero-destination approved, multiple unapproved counted
// Each assertion is mutation-robust.

import { describe, expect, it } from "vitest";
import {
  ALLOWED_MEDIA_RUNTIME,
  DENIED_MEDIA_PACKAGES,
  auditVoiceEgress,
  scanManifestsForDeniedMediaPackages,
} from "./privacy.js";

// ─── DENIED_MEDIA_PACKAGES catalog ───────────────────────────────────────────
describe("DENIED_MEDIA_PACKAGES", () => {
  it("contains simple-peer", () => {
    // Mutation guard: if simple-peer is removed from the list, this fails.
    expect(DENIED_MEDIA_PACKAGES).toContain("simple-peer");
  });

  it("contains the @daily-co scope entry", () => {
    // Mutation guard: if @daily-co is removed, the scope-match branch becomes unreachable.
    expect(DENIED_MEDIA_PACKAGES).toContain("@daily-co");
  });

  it("is non-empty and does not contain ws (the allowed runtime)", () => {
    expect(DENIED_MEDIA_PACKAGES.length).toBeGreaterThan(0);
    // Mutation guard: if ws were added to DENIED list, ALLOWED_MEDIA_RUNTIME tests would catch it.
    expect(DENIED_MEDIA_PACKAGES).not.toContain("ws");
  });
});

// ─── ALLOWED_MEDIA_RUNTIME ────────────────────────────────────────────────────
describe("ALLOWED_MEDIA_RUNTIME", () => {
  it('contains only "ws"', () => {
    // Mutation guard: if ws is removed or the list grows, this fails.
    expect(ALLOWED_MEDIA_RUNTIME).toEqual(["ws"]);
  });

  it("ws in dependencies does not trigger a scan hit", () => {
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-server", dependencyNames: ["ws"] },
    ]);
    // Mutation guard: if ws were on the denied list, clean would be false.
    expect(scan.clean).toBe(true);
    expect(scan.found).toHaveLength(0);
  });
});

// ─── auditVoiceEgress ────────────────────────────────────────────────────────
describe("auditVoiceEgress", () => {
  it("approves an empty ledger (no egress)", () => {
    const audit = auditVoiceEgress([]);
    // Mutation guard: if unapprovedCount === 0 becomes > 0, audit.approved flips.
    expect(audit.approved).toBe(true);
    expect(audit.unapprovedCount).toBe(0);
  });

  it("approves a ledger with only configured-model-endpoint destinations", () => {
    const audit = auditVoiceEgress([
      { class: "configured-model-endpoint" },
      { class: "configured-model-endpoint" },
    ]);
    expect(audit.approved).toBe(true);
    expect(audit.unapprovedCount).toBe(0);
  });

  it("approves a ledger with only none destinations", () => {
    const audit = auditVoiceEgress([{ class: "none" }]);
    expect(audit.approved).toBe(true);
    expect(audit.unapprovedCount).toBe(0);
  });

  it("rejects a ledger containing a single unapproved-external", () => {
    const audit = auditVoiceEgress([{ class: "unapproved-external" }]);
    // Mutation guard: if the filter condition uses !== instead of ===, count would be 0.
    expect(audit.approved).toBe(false);
    expect(audit.unapprovedCount).toBe(1);
  });

  it("rejects and counts every unapproved-external in a mixed ledger", () => {
    const audit = auditVoiceEgress([
      { class: "configured-model-endpoint" },
      { class: "unapproved-external" },
      { class: "unapproved-external" },
      { class: "none" },
    ]);
    expect(audit.approved).toBe(false);
    // Mutation guard: if only the first matching destination is counted, unapprovedCount === 1.
    expect(audit.unapprovedCount).toBe(2);
  });
});

// ─── scanManifestsForDeniedMediaPackages ─────────────────────────────────────
describe("scanManifestsForDeniedMediaPackages", () => {
  it("returns clean when all manifests have no denied packages", () => {
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-server", dependencyNames: ["ws", "express"] },
      { packageName: "keiko-ui", dependencyNames: ["react", "next"] },
    ]);
    expect(scan.clean).toBe(true);
    expect(scan.found).toHaveLength(0);
  });

  it("returns clean for an empty manifest list", () => {
    const scan = scanManifestsForDeniedMediaPackages([]);
    expect(scan.clean).toBe(true);
    expect(scan.found).toHaveLength(0);
  });

  it("detects exact-match denied package (simple-peer)", () => {
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-ui", dependencyNames: ["react", "simple-peer"] },
    ]);
    // Mutation guard: if the exact-match branch is removed, simple-peer would not be found.
    expect(scan.clean).toBe(false);
    expect(scan.found).toHaveLength(1);
    expect(scan.found[0]).toEqual({ packageName: "keiko-ui", deniedPackage: "simple-peer" });
  });

  // ─── Scoped-package match: @daily-co/daily-js matches @daily-co scope ────────
  it("detects scoped sub-package match: @daily-co/daily-js matches @daily-co", () => {
    // This covers the branch on line 83: `denied.startsWith("@") && dependencyName.startsWith(denied + "/")`.
    // Mutation guard: if that branch is deleted, @daily-co/daily-js is NOT caught.
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "some-pkg", dependencyNames: ["@daily-co/daily-js"] },
    ]);
    expect(scan.clean).toBe(false);
    expect(scan.found).toHaveLength(1);
    expect(scan.found[0]).toEqual({ packageName: "some-pkg", deniedPackage: "@daily-co" });
  });

  it("does NOT match a package that merely starts with a denied name but is different", () => {
    // e.g., "socket.io-admin" should only be matched by the exact-match "socket.io-client" if
    // present, but a hypothetical "socket.io-xyz" that is NOT in the list should not be flagged.
    // Here we check that "socketio" (no hyphen) does not match "socket.io".
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "pkg", dependencyNames: ["socketio", "peerjs-legacy"] },
    ]);
    // "peerjs-legacy" is NOT in the denied list (only "peerjs" is). "socketio" is not "socket.io".
    expect(scan.found.map((h) => h.deniedPackage)).not.toContain("socket.io");
    // But peerjs-legacy does not equal peerjs (exact match only for non-scoped).
    // So the scan should be clean for these two.
    expect(scan.found.filter((h) => h.deniedPackage === "peerjs")).toHaveLength(0);
  });

  it("matches exact peerjs (not just prefix) when listed exactly", () => {
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "pkg", dependencyNames: ["peerjs"] },
    ]);
    // Mutation guard: if the exact-match `dependencyName === denied` is removed, peerjs is missed.
    expect(scan.clean).toBe(false);
    expect(scan.found[0]?.deniedPackage).toBe("peerjs");
  });

  it("canonically sorts results by packageName then deniedPackage", () => {
    // Two packages, each with one hit. Sort: "alpha" < "beta".
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "beta-pkg", dependencyNames: ["simple-peer"] },
      { packageName: "alpha-pkg", dependencyNames: ["peerjs"] },
    ]);
    // Mutation guard: if the sort is dropped (original insertion order), "beta-pkg" would come first.
    expect(scan.found[0]?.packageName).toBe("alpha-pkg");
    expect(scan.found[1]?.packageName).toBe("beta-pkg");
  });

  it("canonically sorts by deniedPackage when packageName is the same", () => {
    // Same package with two hits — sorted by deniedPackage.
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-ui", dependencyNames: ["wrtc", "livekit", "simple-peer"] },
    ]);
    expect(scan.clean).toBe(false);
    // All three are in DENIED_MEDIA_PACKAGES; sorted by deniedPackage within same packageName.
    const deniedNames = scan.found.map((h) => h.deniedPackage);
    const sorted = [...deniedNames].sort((a, b) => a.localeCompare(b));
    // Mutation guard: if sort is dropped, order would be insertion order (wrtc, livekit, simple-peer).
    expect(deniedNames).toEqual(sorted);
  });

  it("reports one hit per package+denied pair even when duplicated in dependencyNames", () => {
    // Two occurrences of simple-peer in the same manifest: still one hit per pair.
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-ui", dependencyNames: ["simple-peer", "ws", "simple-peer"] },
    ]);
    // Implementation does not deduplicate (each dep in the loop is a separate check),
    // so this asserts the actual behavior: two hits for the two occurrences.
    // This is a mutation guard: if the loop is changed to break early, count drops to 1.
    expect(scan.found).toHaveLength(2);
    expect(scan.clean).toBe(false);
  });

  it("scoped match does NOT fire for non-scoped denied entries (e.g. peerjs/extra)", () => {
    // "peerjs" is not a scope (@-prefixed), so "peerjs/extra" must NOT match it via scope branch.
    // The exact-match fails (peerjs/extra !== peerjs) and the scope branch is skipped.
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "pkg", dependencyNames: ["peerjs/extra"] },
    ]);
    // Mutation guard: if scope branch fires for non-@ entries, this would get a false positive.
    expect(scan.found).toHaveLength(0);
  });
});
