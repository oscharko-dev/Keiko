import { describe, expect, it } from "vitest";

import {
  APPROVED_LICENSES,
  isLicenseExpressionApproved,
  offendersForComponent,
} from "../check-workspace-supply-chain.mjs";

describe("isLicenseExpressionApproved (SPDX expression evaluation)", () => {
  it("accepts a dual-licensed OR expression when one operand is approved", () => {
    // dompurify (a monaco-editor transitive dependency) ships as "(MPL-2.0 OR Apache-2.0)".
    // MPL-2.0 is not on the allow-list, but Apache-2.0 is, so the choice is satisfiable.
    expect(APPROVED_LICENSES.has("MPL-2.0")).toBe(false);
    expect(isLicenseExpressionApproved("(MPL-2.0 OR Apache-2.0)")).toBe(true);
  });

  it("rejects an OR expression when no operand is approved", () => {
    expect(isLicenseExpressionApproved("(GPL-3.0-only OR LGPL-3.0-only)")).toBe(false);
  });

  it("requires every operand of an AND expression", () => {
    expect(isLicenseExpressionApproved("MIT AND Apache-2.0")).toBe(true);
    expect(isLicenseExpressionApproved("MIT AND GPL-3.0-only")).toBe(false);
  });

  it("accepts an OR clause whose AND operands are all approved", () => {
    expect(isLicenseExpressionApproved("(GPL-3.0-only OR (MIT AND ISC))")).toBe(true);
  });

  it("honours AND-over-OR precedence and parentheses (no false accept via a lone operand)", () => {
    // A copyleft-mandating expression must NOT be approved just because it contains a permissive
    // operand inside a parenthesised OR. AND binds tighter than OR, and parentheses group.
    expect(isLicenseExpressionApproved("GPL-3.0-only AND (MIT OR ISC)")).toBe(false);
    expect(isLicenseExpressionApproved("(MIT OR Apache-2.0) AND GPL-3.0-only")).toBe(false);
    // The mandated license is permissive, so it is satisfiable.
    expect(isLicenseExpressionApproved("MIT AND (Apache-2.0 OR ISC)")).toBe(true);
    expect(isLicenseExpressionApproved("MIT OR (Apache-2.0 AND GPL-3.0-only)")).toBe(true);
  });

  it("fails closed on unparseable or unrecognised forms", () => {
    expect(isLicenseExpressionApproved("(MIT OR Apache-2.0")).toBe(false); // unbalanced
    expect(isLicenseExpressionApproved("MIT OR")).toBe(false); // dangling operator
    expect(isLicenseExpressionApproved("GPL-2.0-or-later WITH Classpath-exception-2.0")).toBe(
      false,
    );
    expect(isLicenseExpressionApproved("Apache-2.0+")).toBe(false); // unknown `+` token
    expect(isLicenseExpressionApproved("MIT MIT")).toBe(false); // leftover token
  });

  it("rejects empty or non-string input", () => {
    expect(isLicenseExpressionApproved("")).toBe(false);
    expect(isLicenseExpressionApproved("   ")).toBe(false);
    expect(isLicenseExpressionApproved(undefined)).toBe(false);
  });
});

describe("offendersForComponent", () => {
  it("treats a component with no declared license as an offender", () => {
    expect(offendersForComponent({ name: "x", version: "1.0.0" })).toEqual([
      { id: "x@1.0.0", license: "<missing>" },
    ]);
  });

  it("accepts an approved single-license component", () => {
    expect(
      offendersForComponent({
        name: "x",
        version: "1.0.0",
        licenses: [{ license: { id: "MIT" } }],
      }),
    ).toEqual([]);
  });

  it("flags an unapproved single-license component", () => {
    expect(
      offendersForComponent({
        name: "x",
        version: "1.0.0",
        licenses: [{ license: { id: "GPL-3.0-only" } }],
      }),
    ).toEqual([{ id: "x@1.0.0", license: "GPL-3.0-only" }]);
  });

  it("accepts a CycloneDX expression-form license that is satisfiable", () => {
    expect(
      offendersForComponent({
        name: "dompurify",
        version: "3.2.7",
        licenses: [{ expression: "(MPL-2.0 OR Apache-2.0)" }],
      }),
    ).toEqual([]);
  });

  it("flags a CycloneDX expression-form license that is not satisfiable", () => {
    expect(
      offendersForComponent({
        name: "x",
        version: "1.0.0",
        licenses: [{ expression: "(GPL-3.0-only OR LGPL-3.0-only)" }],
      }),
    ).toEqual([{ id: "x@1.0.0", license: "(GPL-3.0-only OR LGPL-3.0-only)" }]);
  });
});
