import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { A11Y_CONTRAST_MODES, A11Y_SURFACES, A11Y_THEMES } from "./support/a11y-surfaces.js";

/**
 * 0.3.0 release audit — the real-browser axe smoke is the ONLY gate that can see computed colour in
 * a running browser (jsdom + jest-axe has no layout, so `color-contrast` never runs there). It
 * shipped scanning two surfaces in one theme with no dialog open, which is a lane that reads as
 * contrast coverage while proving almost none of it.
 *
 * This suite pins the coverage contract so the lane cannot silently shrink back. It is deliberately
 * a source-shape gate (the repository's `*.static.test.ts` idiom): the browser lane itself runs in
 * CI, but nothing there fails when a surface is quietly dropped from the matrix.
 */
const specSource = readFileSync(new URL("./a11y.smoke.spec.ts", import.meta.url), "utf8");

const REQUIRED_SURFACE_IDS = [
  "launcher",
  "command-palette",
  "coding-workbench",
  "editor",
  "git-window",
  "delete-confirm",
] as const;

describe("a11y smoke coverage contract", () => {
  it("covers both product themes", () => {
    expect([...A11Y_THEMES]).toEqual(["dark", "light"]);
  });

  it("covers baseline, high-contrast and forced-colors", () => {
    expect([...A11Y_CONTRAST_MODES]).toEqual(["baseline", "high-contrast", "forced-colors"]);
  });

  it("covers every surface a local human operates", () => {
    const ids = A11Y_SURFACES.map((surface) => surface.id);
    for (const required of REQUIRED_SURFACE_IDS) {
      expect(ids, `missing a11y surface "${required}"`).toContain(required);
    }
  });

  it("includes at least one open modal, and at least one destructive confirm among them", () => {
    const modals = A11Y_SURFACES.filter((surface) => surface.modal);
    expect(modals.length).toBeGreaterThan(0);
    expect(modals.some((surface) => surface.destructive)).toBe(true);
    // A destructive surface that is not modal would not be measuring an open dialog at all.
    expect(A11Y_SURFACES.every((surface) => !surface.destructive || surface.modal)).toBe(true);
  });

  it("has no duplicate surface ids", () => {
    const ids = A11Y_SURFACES.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a11y smoke spec wiring", () => {
  it("derives its cases from the contract instead of hard-coding a surface list", () => {
    expect(specSource).toContain("for (const surface of A11Y_SURFACES)");
    expect(specSource).toContain("for (const theme of A11Y_THEMES)");
    expect(specSource).toContain("for (const mode of A11Y_CONTRAST_MODES)");
  });

  it("registers an opener for every contracted surface", () => {
    for (const surface of A11Y_SURFACES) {
      expect(specSource, `no opener entry for "${surface.id}"`).toMatch(
        new RegExp(`(^|\\s)"?${surface.id}"?:\\s`, "mu"),
      );
    }
    // The collection-time guard is what turns a missing opener into a red lane rather than a
    // silently smaller matrix.
    expect(specSource).toContain("throw new Error(`a11y smoke: no opener for surface");
  });

  it("keeps every generated case in the smoke lane", () => {
    const titles = specSource.match(/test\(`[^`]+`/gu) ?? [];
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title, `test title is not tagged @smoke: ${title}`).toContain("@smoke");
    }
  });

  it("drives contrast through emulateMedia and the in-app [data-hc] hook", () => {
    expect(specSource).toContain('contrast: mode === "high-contrast" ? "more" : "no-preference"');
    expect(specSource).toContain('forcedColors: mode === "forced-colors" ? "active" : "none"');
    expect(specSource).toContain('document.documentElement.dataset.hc = "more"');
  });

  // The ledger is the one way a real violation can be made non-gating, so it is where an "honest
  // coverage" change would quietly become dishonest: one entry per rule with no selector, and the
  // whole rule is muted everywhere. Pin its discipline instead of its emptiness — asserting "empty"
  // would only create pressure to not record a finding at all.
  it("scopes every known-issue entry to a selector, with a reason and an owner", () => {
    const entries = specSource.match(/\{\s*id: "[^"]+",[\s\S]*?owner: "[^"]+",\s*\},/gu) ?? [];
    const declaredIds = specSource.match(/^ {4}id: "[^"]+",$/gmu) ?? [];
    // Every `id:` inside the ledger literal must belong to a fully-formed entry.
    expect(entries).toHaveLength(declaredIds.length);
    for (const entry of entries) {
      expect(entry, "known-issue entry has no selector — it would mute the rule globally").toMatch(
        /selector: "[^"]+"/u,
      );
      expect(entry, "known-issue entry has an empty selector").not.toMatch(/selector: ""/u);
      expect(entry, "known-issue entry has an empty reason").not.toMatch(/reason:\s*"",/u);
      expect(entry, "known-issue entry has an empty owner").not.toMatch(/owner: "",/u);
    }
  });

  it("keeps the ledger a per-node filter, so a violation elsewhere still fails", () => {
    expect(specSource).toContain("known.id === violation.id &&");
    expect(specSource).toContain(
      "node.target.some((selector) => selector.includes(known.selector))",
    );
  });
});
