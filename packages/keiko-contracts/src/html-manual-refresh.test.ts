import { describe, expect, it } from "vitest";

import {
  HTML_MANUAL_REFRESH_SCHEMA_VERSION,
  MANUAL_REFRESH_REASON_CODES,
  MANUAL_REFRESH_REASON_GUIDANCE,
  type ManualRefreshChangeSummary,
  validateManualRefreshChangeSummary,
} from "./html-manual-refresh.js";

function validSummary(): ManualRefreshChangeSummary {
  return {
    schemaVersion: HTML_MANUAL_REFRESH_SCHEMA_VERSION,
    outcome: "updated",
    sourceKind: "html-manual-local",
    counts: {
      addedPages: 2,
      changedPages: 1,
      removedPages: 0,
      movedPages: 0,
      unchangedPages: 5,
      failedPages: 0,
      deniedLinks: 3,
    },
    removalDetection: "evaluated",
    crawlRunFingerprint: "sha256:AbC-_123",
    reasonCodes: ["scope-preserved", "pages-added", "pages-changed"],
    refreshedAt: 1000,
  };
}

describe("validateManualRefreshChangeSummary", () => {
  it("accepts a well-formed redacted summary", () => {
    const result = validateManualRefreshChangeSummary(validSummary());
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = validateManualRefreshChangeSummary("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["refreshSummary must be an object"]);
  });

  it("rejects an unknown outcome", () => {
    const result = validateManualRefreshChangeSummary({ ...validSummary(), outcome: "exploded" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
  });

  it("rejects an unknown source kind", () => {
    const result = validateManualRefreshChangeSummary({
      ...validSummary(),
      sourceKind: "html-manual-ftp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("sourceKind"))).toBe(true);
  });

  it("rejects a negative or non-integer count", () => {
    const summary = validSummary();
    const result = validateManualRefreshChangeSummary({
      ...summary,
      counts: { ...summary.counts, addedPages: -1, changedPages: 1.5 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("counts.addedPages"))).toBe(true);
      expect(result.errors.some((e) => e.includes("counts.changedPages"))).toBe(true);
    }
  });

  it("rejects an unknown reason code", () => {
    const result = validateManualRefreshChangeSummary({
      ...validSummary(),
      reasonCodes: ["scope-preserved", "made-up-code"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("reasonCodes"))).toBe(true);
  });

  it("rejects duplicate reason codes", () => {
    const result = validateManualRefreshChangeSummary({
      ...validSummary(),
      reasonCodes: ["scope-preserved", "scope-preserved"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("unique"))).toBe(true);
  });

  it("rejects a fingerprint carrying a path, URL, or whitespace marker", () => {
    for (const bad of ["/Users/secret/index.html", "https://host/x", "has space", "a@b", "q?x"]) {
      const result = validateManualRefreshChangeSummary({
        ...validSummary(),
        crawlRunFingerprint: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("crawlRunFingerprint"))).toBe(true);
      }
    }
  });

  it("rejects an obfuscated fingerprint that carries no denylisted character but is not the real sha256:base64url shape", () => {
    // A percent-encoded traversal string uses none of `\s/\\?#@`, so a pure character-denylist check
    // would accept it as a "redaction-safe opaque token". The allowlist must reject it.
    for (const bad of ["..%2F..%2Fetc", "sha256:has%2Epercent", "plainTokenWithoutColon"]) {
      const result = validateManualRefreshChangeSummary({
        ...validSummary(),
        crawlRunFingerprint: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("crawlRunFingerprint"))).toBe(true);
      }
    }
  });

  it("rejects an unexpected top-level property instead of silently carrying it through", () => {
    const result = validateManualRefreshChangeSummary({
      ...validSummary(),
      rawDiagnostic: "leaked raw diagnostic string with a /file/path",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("rawDiagnostic"))).toBe(true);
    }
  });

  it("rejects an unexpected property nested inside counts instead of silently carrying it through", () => {
    const summary = validSummary();
    const result = validateManualRefreshChangeSummary({
      ...summary,
      counts: { ...summary.counts, secretDebugPath: "/Users/oscar/secret/manual/index.html" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("secretDebugPath"))).toBe(true);
    }
  });

  it("rejects a wrong schema version and a negative timestamp", () => {
    const result = validateManualRefreshChangeSummary({
      ...validSummary(),
      schemaVersion: "2",
      refreshedAt: -5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
      expect(result.errors.some((e) => e.includes("refreshedAt"))).toBe(true);
    }
  });

  it("provides browser-safe guidance for every reason code without leaking paths", () => {
    for (const code of MANUAL_REFRESH_REASON_CODES) {
      const guidance = MANUAL_REFRESH_REASON_GUIDANCE[code];
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(0);
      expect(guidance).not.toMatch(/[/\\]/u);
    }
  });
});
