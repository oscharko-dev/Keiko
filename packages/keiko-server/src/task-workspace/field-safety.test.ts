// Unit coverage for the strict free-form identity-field guard (Issue #449 / PR #1587 security
// follow-up — LOW, defense in depth). `requestedBy` / `taskId` are length-bounded but free-form and
// flow into the advisory lock owner, the active-pointer setBy, and operator-visible evidence; this
// proves the guard REJECTS control / zero-width / bidirectional-override code points (rather than
// stripping them, which would corrupt the taskId idempotency key and lock-owner equality).
//
// The unsafe set mirrors the canonical keiko-contracts `stripUnsafeFormatChars` primitive (one
// definition for the whole codebase), made STRICTER: identity fields are single-line, so TAB/LF/CR —
// which text-safety deliberately preserves for multi-line evidence — are forbidden here too. Code
// points are written as numeric escapes so the source stays auditable and free of invisible literals.

import { describe, expect, it } from "vitest";
import { TaskWorkspaceError } from "./errors.js";
import { assertSafeFieldValue, containsUnsafeFieldChars } from "./field-safety.js";

// Embeds the given code point in the middle of an otherwise-safe value, without an invisible literal.
function withCp(cp: number): string {
  return `a${String.fromCodePoint(cp)}b`;
}

describe("containsUnsafeFieldChars", () => {
  it("accepts ordinary single-line identity values, including spaces and non-ASCII letters", () => {
    for (const value of [
      "alice",
      "Keiko Test",
      "agent-42",
      "task-123:abc/def",
      "José", // accented letter — a legitimate, visible code point
      "コード", // CJK — visible, not a format/control code point
      "user@example.com",
      "a".repeat(512),
    ]) {
      expect(containsUnsafeFieldChars(value)).toBe(false);
    }
  });

  it("treats the empty string as safe (length gating is a separate concern)", () => {
    expect(containsUnsafeFieldChars("")).toBe(false);
  });

  it("rejects C0 control characters, including TAB / LF / CR", () => {
    for (const cp of [0x00, 0x07, 0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x1f]) {
      expect(containsUnsafeFieldChars(withCp(cp))).toBe(true);
    }
  });

  it("rejects DEL (0x7F) and the C1 control block (0x80–0x9F)", () => {
    for (const cp of [0x7f, 0x80, 0x90, 0x9f]) {
      expect(containsUnsafeFieldChars(withCp(cp))).toBe(true);
    }
  });

  it("rejects zero-width / BOM code points", () => {
    // ZWSP, ZWNJ, ZWJ, BOM (ZWNBSP)
    for (const cp of [0x200b, 0x200c, 0x200d, 0xfeff]) {
      expect(containsUnsafeFieldChars(withCp(cp))).toBe(true);
    }
  });

  it("rejects bidirectional override / embedding / isolate code points (Trojan-source class)", () => {
    // LRM, RLM, RLE, LRE, PDF, LRO, RLO, LRI, RLI, FSI, PDI, Arabic letter mark
    for (const cp of [
      0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
      0x061c,
    ]) {
      expect(containsUnsafeFieldChars(withCp(cp))).toBe(true);
    }
  });

  it("detects an unsafe code point anywhere in the value (leading, middle, trailing)", () => {
    expect(containsUnsafeFieldChars(`${String.fromCodePoint(0x202e)}alice`)).toBe(true);
    expect(containsUnsafeFieldChars(`al${String.fromCodePoint(0x200b)}ice`)).toBe(true);
    expect(containsUnsafeFieldChars(`alice${String.fromCodePoint(0x00)}`)).toBe(true);
  });
});

describe("assertSafeFieldValue", () => {
  it("returns silently for a safe value", () => {
    expect(() => {
      assertSafeFieldValue("alice", "requestedBy");
    }).not.toThrow();
  });

  it("throws a blocked INVALID_REQUEST that names the field without echoing the value", () => {
    const spoofed = `victim${String.fromCodePoint(0x202e)}`;
    let caught: TaskWorkspaceError | undefined;
    try {
      assertSafeFieldValue(spoofed, "requestedBy");
    } catch (error) {
      caught = error as TaskWorkspaceError;
    }
    expect(caught).toBeInstanceOf(TaskWorkspaceError);
    expect(caught?.code).toBe("INVALID_REQUEST");
    expect(caught?.status).toBe(400);
    expect(caught?.failureClass).toBe("blocked");
    expect(caught?.reasons).toContain("requestedBy");
    // The untrusted value must never be reflected back to the caller.
    expect(caught?.reasons.join(" ")).not.toContain("victim");
    expect(caught?.message).not.toContain("victim");
  });

  it("carries the offending field name through for taskId too", () => {
    const taskId = `t${String.fromCodePoint(0x200b)}1`;
    expect(() => {
      assertSafeFieldValue(taskId, "taskId");
    }).toThrow(TaskWorkspaceError);
  });
});
