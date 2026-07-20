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

  it("fails closed on a missing manifest", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--policy", "production"])).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed on a missing policy", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--manifest", "/tmp/m.json"])).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed on a policy outside the supported set", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--manifest", "/tmp/m.json", "--policy", "prod-ish"])).toThrow(
      "process.exit(1)",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed on an unsupported argument", () => {
    const exit = trapExit();
    expect(() =>
      parseArgs(["--manifest", "/tmp/m.json", "--policy", "production", "--sign-anyway"]),
    ).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when a flag is present without its value", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--manifest"])).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when a flag value is an empty string", () => {
    const exit = trapExit();
    expect(() => parseArgs(["--policy", ""])).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
