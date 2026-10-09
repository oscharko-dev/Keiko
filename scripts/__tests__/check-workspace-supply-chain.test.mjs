import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  APPROVED_LICENSES,
  addTypeScriptRuntimeToSbom,
  isLicenseExpressionApproved,
  offendersForComponent,
  reviewedDependencyLicenseFailures,
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

describe("version-bound component license decisions", () => {
  const component = {
    name: "spdx-exceptions",
    version: "2.5.0",
    purl: "pkg:npm/spdx-exceptions@2.5.0",
    licenses: [{ license: { id: "CC-BY-3.0" } }],
  };
  it("accepts only the reviewed SPDX data identity with its actual declared license", () => {
    expect(offendersForComponent(component)).toEqual([]);
    expect(APPROVED_LICENSES.has("CC-BY-3.0")).toBe(false);
    expect(isLicenseExpressionApproved("CC-BY-3.0")).toBe(false);
  });
  it("accepts the reviewed Bowser variant without globally admitting MITNFA", () => {
    expect(
      offendersForComponent({
        name: "bowser",
        version: "2.14.1",
        purl: "pkg:npm/bowser@2.14.1",
        licenses: [{ expression: "MIT AND MITNFA" }],
      }),
    ).toEqual([]);
    expect(isLicenseExpressionApproved("MITNFA")).toBe(false);
  });
  it.each([
    { purl: undefined },
    { purl: "pkg:npm/spdx-exceptions@2.6.0" },
    { version: "2.6.0" },
    { name: "other" },
    { purl: "pkg:npm/other@2.5.0" },
    { licenses: [] },
    { licenses: [{ license: { id: "GPL-3.0-only" } }] },
    { licenses: [{ expression: "CC-BY-3.0 AND GPL-3.0-only" }] },
    { licenses: [{ expression: "CC-BY-3.0 WITH unknown-exception" }] },
    { licenses: [{ license: { id: "unknown" } }] },
  ])("retains refusals for identity or license drift %j", (drift) => {
    expect(offendersForComponent({ ...component, ...drift })).not.toEqual([]);
  });
  it("still chooses the existing BSD option of json-schema without a local exception", () => {
    expect(
      offendersForComponent({
        name: "json-schema",
        version: "0.4.0",
        purl: "pkg:npm/json-schema@0.4.0",
        licenses: [{ expression: "(AFL-2.1 OR BSD-3-Clause)" }],
      }),
    ).toEqual([]);
  });
});

function canonicalLicenseLocks() {
  return [
    JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")),
    JSON.parse(
      readFileSync(
        new URL("../../native/opencode-service-host/package-lock.json", import.meta.url),
        "utf8",
      ),
    ),
  ];
}

describe("reviewed dependency license preflight", () => {
  it("qualifies both actual canonical lock producers before package-wide GitHub exclusions", () => {
    expect(reviewedDependencyLicenseFailures(canonicalLicenseLocks())).toEqual([]);
  });

  it.each(["bowser", "json-schema", "spdx-exceptions"])(
    "rejects version, artifact, declaration and identity drift for %s",
    (name) => {
      const variants = [
        { version: "99.0.0" },
        { integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}` },
        { integrity: undefined },
        { license: "GPL-3.0-only" },
        { license: "MIT AND GPL-3.0-only" },
        { license: undefined },
        { resolved: "https://example.invalid/other.tgz" },
        { name: "other" },
      ];
      for (const drift of variants) {
        const locks = canonicalLicenseLocks();
        Object.assign(locks[1].packages[`node_modules/${name}`], drift);
        expect(reviewedDependencyLicenseFailures(locks), JSON.stringify(drift)).not.toEqual([]);
      }
    },
  );

  it.each(["bowser", "json-schema", "spdx-exceptions"])("rejects missing %s metadata", (name) => {
    const locks = canonicalLicenseLocks();
    Reflect.deleteProperty(locks[1].packages, `node_modules/${name}`);
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it.each(["bowser", "json-schema", "spdx-exceptions"])("rejects npm aliases of %s", (name) => {
    const locks = canonicalLicenseLocks();
    const entry = locks[1].packages[`node_modules/${name}`];
    Reflect.deleteProperty(locks[1].packages, `node_modules/${name}`);
    locks[1].packages["node_modules/alias"] = { ...entry, name };
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it("inspects nested root records in addition to the approved native instance", () => {
    const locks = canonicalLicenseLocks();
    const entry = locks[1].packages["node_modules/bowser"];
    locks[0].packages["node_modules/other/node_modules/bowser"] = { ...entry };
    expect(reviewedDependencyLicenseFailures(locks)).toEqual([]);
    locks[0].packages["node_modules/other/node_modules/bowser"].version = "99.0.0";
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it.each([
    undefined,
    null,
    {},
    [],
    { lockfileVersion: 2, packages: {} },
    { lockfileVersion: 3, packages: [] },
  ])("rejects malformed canonical lock metadata %j", (lock) => {
    const locks = canonicalLicenseLocks();
    locks[0] = lock;
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it("refuses malformed package records rather than silently skipping them", () => {
    const locks = canonicalLicenseLocks();
    locks[1].packages["node_modules/bowser"] = null;
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });
});

describe("required GitHub license exclusion preflight", () => {
  it("rejects a future-version alias even if its optional name field is missing", () => {
    const locks = canonicalLicenseLocks();
    locks[0].packages["node_modules/alias"] = {
      version: "99.0.0",
      resolved: "https://registry.npmjs.org/bowser/-/bowser-99.0.0.tgz",
      integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}`,
      license: "GPL-3.0-only",
    };
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it("requires canonical root metadata even when the native instances remain intact", () => {
    const locks = canonicalLicenseLocks();
    delete locks[0].packages[""];
    expect(reviewedDependencyLicenseFailures(locks)).not.toEqual([]);
  });

  it("emits package-wide exclusions only after the actual standalone CLI accepts both locks", () => {
    const locks = canonicalLicenseLocks();
    const result = runLicensePreflight(locks);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "pkg:npm/spdx-exceptions, pkg:npm/bowser, pkg:npm/json-schema",
    );
    expect(result.stderr).toBe("");
    locks[1].packages["node_modules/bowser"].version = "99.0.0";
    const refused = runLicensePreflight(locks);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("bowser: reviewed artifact, identity or license drift");
  });

  it("makes the same-job guard mandatory before the pinned package-wide license action", () => {
    const workflow = parse(
      readFileSync(
        new URL("../../.github/workflows/dependency-review.yml", import.meta.url),
        "utf8",
      ),
    );
    const steps = workflow.jobs["dependency-review"].steps;
    const guard = steps.findIndex((step) => step.id === "runtime-license-policy");
    const action = steps.findIndex((step) =>
      step.uses?.startsWith("actions/dependency-review-action@"),
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(action);
    expect(steps[guard].if).toBeUndefined();
    expect(steps[guard]["continue-on-error"]).toBeUndefined();
    expect(steps[guard].run).toContain(
      "node scripts/check-workspace-supply-chain.mjs --check-reviewed-dependency-licenses",
    );
    expect(steps[action].with["allow-dependencies-licenses"]).toContain(
      "${{ steps.runtime-license-policy.outputs.exclusions }}",
    );
    expect(steps[action].with["allow-licenses"]).not.toMatch(/CC-BY-3\.0|MITNFA|AFL/);
  });
});

function runLicensePreflight(locks) {
  const fixture = mkdtempSync(join(tmpdir(), "keiko-license-preflight-"));
  try {
    mkdirSync(join(fixture, "native/opencode-service-host"), { recursive: true });
    writeFileSync(join(fixture, "package-lock.json"), JSON.stringify(locks[0]));
    writeFileSync(
      join(fixture, "native/opencode-service-host/package-lock.json"),
      JSON.stringify(locks[1]),
    );
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../check-workspace-supply-chain.mjs", import.meta.url)),
        "--check-reviewed-dependency-licenses",
      ],
      { cwd: fixture, encoding: "utf8" },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
