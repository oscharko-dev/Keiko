import { describe, expect, it, vi } from "vitest";

import {
  classifyDistTagResult,
  classifyRegistryVersionResult,
  REGISTRY_OBSERVATION_TIMEOUT_MS,
  registryVersionEndpoint,
  registryVersionProbeArgs,
  resolveDistTagAction,
  resolveVersionExistence,
  verificationFailure,
  verificationObservation,
  verificationSucceeded,
  waitForVerifiedPackageState,
} from "../lib/npm-registry-observation.mjs";

const pkg = { name: "@oscharko-dev/keiko", spec: "@oscharko-dev/keiko@1.0.4", version: "1.0.4" };
const available = { kind: "available", version: pkg.version };
const missing = { kind: "missing", version: "" };
const transient = { kind: "transient", reason: "http-503", version: "" };

function state(version, tag) {
  return { tag, version };
}

describe("npm registry observation", () => {
  it("builds a credential-free, version-specific endpoint and bounded curl arguments", () => {
    expect(registryVersionEndpoint(pkg, "https://registry.example.test/npm?old=1#fragment")).toBe(
      "https://registry.example.test/npm/%40oscharko-dev/keiko/1.0.4",
    );
    expect(registryVersionEndpoint(pkg, "https://registry.example.test/npm/")).toBe(
      "https://registry.example.test/npm/%40oscharko-dev/keiko/1.0.4",
    );
    expect(registryVersionProbeArgs(pkg, "https://registry.example.test/")).toEqual([
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout",
      "5",
      "--max-time",
      String(REGISTRY_OBSERVATION_TIMEOUT_MS / 1_000),
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "https://registry.example.test/%40oscharko-dev/keiko/1.0.4",
    ]);
  });

  it.each([
    ["200", available],
    ["404", missing],
    ["408", { kind: "transient", reason: "http-408", version: "" }],
    ["425", { kind: "transient", reason: "http-425", version: "" }],
    ["429", { kind: "transient", reason: "http-429", version: "" }],
    ["503", transient],
    ["599", { kind: "transient", reason: "http-599", version: "" }],
    [
      "400",
      {
        kind: "fatal",
        message: `${pkg.spec} registry version endpoint returned HTTP 400.`,
        version: "",
      },
    ],
  ])("classifies registry HTTP %s", (httpStatus, expected) => {
    expect(
      classifyRegistryVersionResult(pkg, {
        error: undefined,
        status: 0,
        stdout: ` ${httpStatus}\n`,
      }),
    ).toEqual(expected);
  });

  it("classifies process-level registry probe failures as transient", () => {
    expect(classifyRegistryVersionResult(pkg, { error: new Error("spawn"), stdout: "" })).toEqual({
      kind: "transient",
      reason: "spawn-error",
      version: "",
    });
    expect(classifyRegistryVersionResult(pkg, { status: 28, stdout: "" })).toEqual({
      kind: "transient",
      reason: "curl-exit-28",
      version: "",
    });
    expect(classifyRegistryVersionResult(pkg, { status: undefined, stdout: "" })).toEqual({
      kind: "transient",
      reason: "curl-exit-unknown",
      version: "",
    });
  });

  it("classifies npm dist-tag observations without treating uncertainty as absence", () => {
    expect(classifyDistTagResult({ error: new Error("spawn"), stdout: "", stderr: "" })).toEqual({
      kind: "transient",
      reason: "spawn-error",
      version: "",
    });
    expect(classifyDistTagResult({ status: 0, stdout: "1.0.4\n", stderr: "" })).toEqual(available);
    expect(classifyDistTagResult({ status: 0, stdout: " \n", stderr: "" })).toEqual(missing);
    expect(classifyDistTagResult({ status: 1, stdout: "E404", stderr: "" })).toEqual(missing);
    expect(classifyDistTagResult({ status: 1, stdout: "", stderr: "No match found" })).toEqual(
      missing,
    );
    expect(classifyDistTagResult({ status: undefined, stdout: "", stderr: "timeout" })).toEqual({
      kind: "transient",
      reason: "npm-exit-unknown",
      version: "",
    });
  });

  it("resolves definitive prepublish observations immediately", () => {
    const onPending = vi.fn();
    const wait = vi.fn();
    expect(
      resolveVersionExistence({ attempts: 3, onPending, read: () => available, wait }),
    ).toEqual({ exists: true, observation: available });
    expect(resolveVersionExistence({ attempts: 3, onPending, read: () => missing, wait })).toEqual({
      exists: false,
      observation: missing,
    });
    expect(onPending).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries transient prepublish observations within a separate bounded budget", () => {
    const read = vi
      .fn()
      .mockReturnValueOnce(transient)
      .mockReturnValueOnce(transient)
      .mockReturnValue(missing);
    const onPending = vi.fn();
    const wait = vi.fn();
    expect(resolveVersionExistence({ attempts: 3, onPending, read, wait })).toEqual({
      exists: false,
      observation: missing,
    });
    expect(onPending).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("returns uncertainty after the full prepublish budget instead of authorizing publish", () => {
    const read = vi.fn(() => transient);
    const onPending = vi.fn();
    const wait = vi.fn();
    expect(resolveVersionExistence({ attempts: 3, onPending, read, wait })).toEqual({
      exists: undefined,
      observation: transient,
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(onPending).toHaveBeenCalledTimes(2);
  });

  it("requires both version and tag to be definitively available at the expected version", () => {
    expect(verificationSucceeded(pkg, state(available, available))).toBe(true);
    expect(verificationSucceeded(pkg, state(missing, available))).toBe(false);
    expect(verificationSucceeded(pkg, state({ ...available, version: "1.0.3" }, available))).toBe(
      false,
    );
    expect(verificationSucceeded(pkg, state(available, missing))).toBe(false);
    expect(verificationSucceeded(pkg, state(available, { ...available, version: "1.0.3" }))).toBe(
      false,
    );
  });

  it("renders body-free observations with the strongest available field", () => {
    expect(verificationObservation(available)).toBe("1.0.4");
    expect(verificationObservation(transient)).toBe("http-503");
    expect(verificationObservation(missing)).toBe("missing");
  });

  it("returns actionable failures for transient, missing, and stale states", () => {
    expect(
      verificationFailure(pkg, state(transient, missing), "https://registry.test/", "latest"),
    ).toContain("remained transient");
    expect(
      verificationFailure(pkg, state(missing, missing), "https://registry.test/", "latest"),
    ).toContain("is not available");
    expect(
      verificationFailure(pkg, state(available, transient), "https://registry.test/", "latest"),
    ).toContain("exact tagged commit");
    expect(
      verificationFailure(pkg, state(available, available), "https://registry.test/", "latest"),
    ).toBeUndefined();
  });

  it("waits for a complete version-and-tag state and returns the last bounded observation", () => {
    const complete = state(available, available);
    const pending = state(transient, missing);
    const read = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(complete);
    const onPending = vi.fn();
    const wait = vi.fn();
    expect(waitForVerifiedPackageState({ attempts: 3, onPending, pkg, read, wait })).toBe(complete);
    expect(onPending).toHaveBeenCalledWith(pending, 1);
    expect(wait).toHaveBeenCalledTimes(1);

    const exhaustedRead = vi.fn(() => pending);
    expect(
      waitForVerifiedPackageState({ attempts: 2, onPending, pkg, read: exhaustedRead, wait }),
    ).toBe(pending);
    expect(exhaustedRead).toHaveBeenCalledTimes(2);
  });

  it("chooses verified, fail-closed, and credentialed repair dist-tag actions", () => {
    const verify = vi.fn(() => state(available, available));
    expect(resolveDistTagAction({ currentTag: available, hasToken: false, pkg, verify })).toEqual({
      kind: "verified",
    });
    expect(verify).not.toHaveBeenCalled();

    expect(resolveDistTagAction({ currentTag: missing, hasToken: false, pkg, verify })).toEqual({
      kind: "verified",
    });
    const failedState = state(missing, missing);
    expect(
      resolveDistTagAction({
        currentTag: transient,
        hasToken: true,
        pkg,
        verify: () => failedState,
      }),
    ).toEqual({ kind: "failed", state: failedState });
    expect(resolveDistTagAction({ currentTag: missing, hasToken: true, pkg, verify })).toEqual({
      kind: "repair",
    });
  });

  it("repairs only definitive tag drift when a credential is available", () => {
    const stale = { kind: "available", version: "1.0.3" };
    const staleState = state(available, stale);
    expect(
      resolveDistTagAction({
        currentTag: transient,
        hasToken: true,
        pkg,
        verify: () => staleState,
      }),
    ).toEqual({ kind: "repair" });
    const transientTagState = state(available, transient);
    expect(
      resolveDistTagAction({
        currentTag: transient,
        hasToken: true,
        pkg,
        verify: () => transientTagState,
      }),
    ).toEqual({ kind: "failed", state: transientTagState });
  });
});
