import { afterEach, describe, expect, it, vi } from "vitest";

import {
  failureReasonCodes,
  parseArgs,
  signatureVerifiedFor,
  verificationSucceeded,
} from "../verify-portable-runtime-signing.mjs";

const WINDOWS_TARGET = { nodePlatform: "win32" };
const LINUX_TARGET = { nodePlatform: "linux" };
const MACOS_TARGET = { nodePlatform: "darwin" };

// `fail()` ends the process. Route it through a throw so the rejection paths stay assertable in
// band, matching the convention in release-script-lcov-mapping.test.mjs.
function trapExit() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verify-portable-runtime-signing parseArgs", () => {
  it("returns every supported policy verbatim, so a later value comparison stays reachable", () => {
    // Regression pin for javascript:S3403: an all-`undefined` options literal used to pin each
    // property's inferred type to `undefined`, which made `options.policy === "production"` read as
    // statically impossible even though "production" is a real policy.
    for (const policy of ["staging", "development", "pull-request", "production"]) {
      expect(parseArgs(["--manifest", "/tmp/m.json", "--policy", policy])).toEqual({
        manifest: "/tmp/m.json",
        policy,
        verificationInput: undefined,
      });
    }
  });

  /**
   * The evaluation lane joined `PORTABLE_VERIFICATION_POLICIES`, which alone makes
   * `--policy evaluation` syntactically valid here. Without an explicit rejection it would fall
   * through to the non-production status and reason codes and then be PERSISTED over `security`,
   * every sidecar signing block, the reviewed binding and `updateEligibility` — laundering an
   * evaluation artifact into a pull-request-shaped one with no error. Relying on "nobody will pass
   * it" is not a control.
   */
  it("refuses the producer-declared evaluation lane even though the shared policy array lists it", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--manifest", "/tmp/m.json", "--policy", "evaluation"])).toThrowError(
      "process.exit(1)",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("accepts the optional verification input and is order-independent", () => {
    expect(
      parseArgs([
        "--policy",
        "production",
        "--verification-input",
        "/tmp/in.json",
        "--manifest",
        "/tmp/m.json",
      ]),
    ).toEqual({
      manifest: "/tmp/m.json",
      policy: "production",
      verificationInput: "/tmp/in.json",
    });
  });

  it.each([
    ["a missing manifest", ["--policy", "production"]],
    ["a missing policy", ["--manifest", "/tmp/m.json"]],
    ["a policy outside the supported set", ["--manifest", "/tmp/m.json", "--policy", "prod-ish"]],
    [
      "an unsupported argument",
      ["--manifest", "/tmp/m.json", "--policy", "production", "--sign-anyway"],
    ],
    ["a flag present without its value", ["--manifest"]],
    ["a flag value that is an empty string", ["--policy", ""]],
  ])("fails closed on %s", (_case, argv) => {
    const exit = trapExit();
    expect(() => parseArgs(argv)).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("verify-portable-runtime-signing platform policy", () => {
  it("requires provenance for Linux success and reports the governed failure code", () => {
    expect(verificationSucceeded(LINUX_TARGET, { provenanceVerified: true })).toBe(true);
    expect(verificationSucceeded(LINUX_TARGET, { provenanceVerified: false })).toBe(false);
    expect(failureReasonCodes(LINUX_TARGET, { provenanceVerified: true })).toEqual([]);
    expect(failureReasonCodes(LINUX_TARGET, { provenanceVerified: false })).toEqual([
      "github-provenance-unverified",
    ]);
    expect(signatureVerifiedFor(LINUX_TARGET, false, { provenanceVerified: true })).toBe(true);
    expect(signatureVerifiedFor(LINUX_TARGET, true, { provenanceVerified: false })).toBe(false);
  });

  it("keeps Windows and macOS signature semantics isolated from the Linux policy", () => {
    expect(
      verificationSucceeded(WINDOWS_TARGET, {
        publisherChainVerified: true,
        timestampVerified: true,
      }),
    ).toBe(true);
    expect(
      verificationSucceeded(WINDOWS_TARGET, {
        publisherChainVerified: false,
        timestampVerified: true,
      }),
    ).toBe(false);
    expect(signatureVerifiedFor(WINDOWS_TARGET, true, {})).toBe(true);
    expect(failureReasonCodes(WINDOWS_TARGET, {})).toEqual([
      "windows-publisher-chain-unverified",
      "windows-timestamp-unverified",
    ]);

    const verifiedMacChecks = {
      assessmentVerified: true,
      developerIdVerified: true,
      notarizationVerified: true,
      stapleVerified: true,
    };
    expect(verificationSucceeded(MACOS_TARGET, verifiedMacChecks)).toBe(true);
    expect(
      verificationSucceeded(MACOS_TARGET, { ...verifiedMacChecks, stapleVerified: false }),
    ).toBe(false);
    expect(signatureVerifiedFor(MACOS_TARGET, true, verifiedMacChecks)).toBe(true);
    expect(failureReasonCodes(MACOS_TARGET, verifiedMacChecks)).toEqual([]);
  });
});
