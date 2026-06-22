// Direct unit tests for the shared figma-snapshot screenIds validator (Issue #754 no-leak).
//
// This module is the SINGLE source of truth both the start-run route and the re-check route delegate
// to, so its behaviour gates the whole scoped-snapshot guarantee. Mutation-robust: every reject branch
// (empty / non-array / non-string / blank / over-count / over-length) and the canonicalisation
// (trim → dedupe → sort) has a dedicated case, so deleting any guard fails a test here rather than
// only surfacing indirectly through a route test.

import { describe, expect, it } from "vitest";
import {
  MAX_FIGMA_SCREEN_IDS,
  MAX_FIGMA_SCREEN_ID_LENGTH,
  parseFigmaSnapshotScreenIds,
} from "../figmaSnapshotScreenIds.js";

describe("parseFigmaSnapshotScreenIds", () => {
  it("treats an absent (undefined) field as a whole-snapshot source", () => {
    const result = parseFigmaSnapshotScreenIds(undefined);
    expect(result).toEqual({ ok: true, screenIds: undefined });
  });

  it("rejects an explicitly empty array (a scoped source must list at least one screen)", () => {
    const result = parseFigmaSnapshotScreenIds([]);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array value", () => {
    expect(parseFigmaSnapshotScreenIds("1:2").ok).toBe(false);
    expect(parseFigmaSnapshotScreenIds(42).ok).toBe(false);
    expect(parseFigmaSnapshotScreenIds({ "0": "1:2" }).ok).toBe(false);
  });

  it("rejects a non-string element", () => {
    expect(parseFigmaSnapshotScreenIds(["1:2", 7]).ok).toBe(false);
    expect(parseFigmaSnapshotScreenIds(["1:2", null]).ok).toBe(false);
  });

  it("rejects a blank / whitespace-only element", () => {
    expect(parseFigmaSnapshotScreenIds(["1:2", "   "]).ok).toBe(false);
    expect(parseFigmaSnapshotScreenIds([""]).ok).toBe(false);
  });

  it("rejects when the count exceeds the cap", () => {
    const tooMany = Array.from({ length: MAX_FIGMA_SCREEN_IDS + 1 }, (_v, i) => `s-${String(i)}`);
    expect(parseFigmaSnapshotScreenIds(tooMany).ok).toBe(false);
    const atCap = Array.from({ length: MAX_FIGMA_SCREEN_IDS }, (_v, i) => `s-${String(i)}`);
    expect(parseFigmaSnapshotScreenIds(atCap).ok).toBe(true);
  });

  it("rejects an over-length screen id", () => {
    expect(parseFigmaSnapshotScreenIds(["a".repeat(MAX_FIGMA_SCREEN_ID_LENGTH + 1)]).ok).toBe(
      false,
    );
    expect(parseFigmaSnapshotScreenIds(["a".repeat(MAX_FIGMA_SCREEN_ID_LENGTH)]).ok).toBe(true);
  });

  it("canonicalises a valid scope: trim → dedupe → sort", () => {
    const result = parseFigmaSnapshotScreenIds(["  s-b ", "s-a", "s-a", "s-b"]);
    expect(result).toEqual({ ok: true, screenIds: ["s-a", "s-b"] });
  });

  it("produces an identical canonical scope regardless of input order", () => {
    const a = parseFigmaSnapshotScreenIds(["s-2", "s-1", "s-3"]);
    const b = parseFigmaSnapshotScreenIds(["s-3", "s-2", "s-1"]);
    expect(a).toEqual(b);
    expect(a.ok && a.screenIds).toEqual(["s-1", "s-2", "s-3"]);
  });
});
