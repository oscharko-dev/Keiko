import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODING_RUNTIME_RELEASES_FILE,
  reviewedRelease,
  selectedCodingRuntimeFailures,
} from "../lib/coding-runtime-releases.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ARM = "@oscharko-dev/keiko-coding-runtime-darwin-arm64";
const X64 = "@oscharko-dev/keiko-coding-runtime-darwin-x64";

function entry(name, version, opencodeVersion) {
  return {
    name,
    opencodeVersion,
    tarball: `${name.slice(1).replace("/", "-")}-${version}.tgz`,
    sizeBytes: 1,
    sha256: "a".repeat(64),
    integrity: `sha512-${"A".repeat(86)}==`,
  };
}

function document(version, opencodeVersion) {
  return {
    schemaVersion: 1,
    releases: {
      [version]: {
        "macos-arm64": entry(ARM, version, opencodeVersion),
        "macos-x64": entry(X64, version, opencodeVersion),
      },
    },
  };
}

function manifest(version) {
  return { optionalDependencies: { [ARM]: version, [X64]: version, other: "1.0.0" } };
}

// #4271: the product release gate for the optional npm coding runtimes.
describe("selected coding-runtime release gate", () => {
  it("passes when every selected runtime package carries the approved OpenCode", () => {
    expect(
      selectedCodingRuntimeFailures(manifest("1.1.5"), document("1.1.5", "2.2.5"), "2.2.5"),
    ).toEqual([]);
  });

  it("refuses selected runtime packages that carry an older OpenCode", () => {
    const failures = selectedCodingRuntimeFailures(
      manifest("1.1.4"),
      document("1.1.4", "2.1.4"),
      "2.2.5",
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain(`${ARM}@1.1.4 carries OpenCode 2.1.4`);
    expect(failures[1]).toContain(`${X64}@1.1.4 carries OpenCode 2.1.4`);
  });

  it("refuses an unreviewed, missing or malformed runtime selection", () => {
    expect(
      selectedCodingRuntimeFailures(manifest("1.1.6"), document("1.1.5", "2.2.5"), "2.2.5"),
    ).toEqual([
      `${ARM}@1.1.6: runtime version 1.1.6 was never reviewed`,
      `${X64}@1.1.6: runtime version 1.1.6 was never reviewed`,
    ]);
    expect(selectedCodingRuntimeFailures({}, document("1.1.5", "2.2.5"), "2.2.5")).toEqual([
      "no optional npm coding-runtime package is pinned",
    ]);
    const onlyArm = document("1.1.5", "2.2.5");
    delete onlyArm.releases["1.1.5"]["macos-x64"];
    expect(selectedCodingRuntimeFailures(manifest("1.1.5"), onlyArm, "2.2.5")).toEqual([
      `${X64}@1.1.5 is not a reviewed runtime package`,
    ]);
    expect(
      selectedCodingRuntimeFailures(manifest("1.1.5"), document("1.1.5", undefined), "2.2.5"),
    ).toHaveLength(2);
  });

  it("records the OpenCode each reviewed release of this repository carries", () => {
    const reviewed = JSON.parse(
      readFileSync(join(REPO_ROOT, CODING_RUNTIME_RELEASES_FILE), "utf8"),
    );
    for (const version of Object.keys(reviewed.releases)) {
      for (const pinned of reviewedRelease(reviewed, version)) {
        expect(pinned.opencodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
      }
    }
  });
});
