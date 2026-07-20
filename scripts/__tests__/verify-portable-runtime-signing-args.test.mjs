import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../verify-portable-runtime-signing.mjs";

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
