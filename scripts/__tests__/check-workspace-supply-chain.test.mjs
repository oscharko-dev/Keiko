import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  APPROVED_LICENSES,
  addTypeScriptRuntimeToSbom,
  isLicenseExpressionApproved,
  offendersForComponent,
  typescriptToolchainSbomFailures,
} from "../check-workspace-supply-chain.mjs";

const TYPESCRIPT_LOCK_ENTRY = {
  version: "6.0.3",
  resolved: "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
  integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
  license: "Apache-2.0",
};

describe("addTypeScriptRuntimeToSbom", () => {
  it("adds the packaged runtime component and dependency edge deterministically", () => {
    const sbom = {
      metadata: { component: { "bom-ref": "keiko@1.0.0" } },
      components: [],
      dependencies: [{ ref: "keiko@1.0.0", dependsOn: [] }],
    };
    const result = addTypeScriptRuntimeToSbom(sbom, TYPESCRIPT_LOCK_ENTRY);
    expect(result.components).toContainEqual(
      expect.objectContaining({
        "bom-ref": "typescript@6.0.3",
        name: "typescript",
        version: "6.0.3",
        scope: "required",
      }),
    );
    expect(result.dependencies).toContainEqual({
      ref: "keiko@1.0.0",
      dependsOn: ["typescript@6.0.3"],
    });
    expect(result.dependencies).toContainEqual({ ref: "typescript@6.0.3", dependsOn: [] });
  });

  it("does not duplicate an existing runtime component or dependency edge", () => {
    const sbom = {
      metadata: { component: { "bom-ref": "keiko@1.0.0" } },
      components: [{ name: "typescript", version: "6.0.3", "bom-ref": "typescript@6.0.3" }],
      dependencies: [
        { ref: "keiko@1.0.0", dependsOn: ["typescript@6.0.3"] },
        { ref: "typescript@6.0.3", dependsOn: [] },
      ],
    };
    const result = addTypeScriptRuntimeToSbom(sbom, TYPESCRIPT_LOCK_ENTRY);
    expect(result.components).toHaveLength(1);
    expect(result.dependencies).toHaveLength(2);
  });

  it.each([
    {},
    { ...TYPESCRIPT_LOCK_ENTRY, integrity: "sha256-invalid" },
    { ...TYPESCRIPT_LOCK_ENTRY, license: "unknown" },
  ])("fails closed for incomplete lock metadata", (lockEntry) => {
    expect(() => addTypeScriptRuntimeToSbom({ components: [] }, lockEntry)).toThrow(
      "TypeScript runtime lock metadata is incomplete.",
    );
  });
});

describe("typescriptToolchainSbomFailures", () => {
  it("accepts exactly the productive TypeScript 6 API runtime", () => {
    expect(
      typescriptToolchainSbomFailures(
        { components: [{ name: "typescript", version: "6.0.3" }] },
        "6.0.3",
      ),
    ).toEqual([]);
  });

  it("fails when the productive API runtime is absent", () => {
    expect(typescriptToolchainSbomFailures({ components: [] }, "6.0.3")).not.toEqual([]);
  });

  it.each([
    { group: "@typescript", name: "native", version: "7.0.2" },
    { group: "@typescript", name: "typescript-linux-x64", version: "7.0.2" },
    { name: "@typescript/native", version: "7.0.2" },
  ])("rejects native compiler component $group/$name", (nativeComponent) => {
    const sbom = {
      components: [{ name: "typescript", version: "6.0.3" }, nativeComponent],
    };
    expect(typescriptToolchainSbomFailures(sbom, "6.0.3")).not.toEqual([]);
  });

  it("rejects an unexpected productive TypeScript API version", () => {
    const sbom = { components: [{ name: "typescript", version: "7.0.2" }] };
    expect(typescriptToolchainSbomFailures(sbom, "6.0.3")).not.toEqual([]);
  });
});

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
