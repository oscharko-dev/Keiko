import { describe, expect, it } from "vitest";

import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  qualifyLongLivedRuntime,
  type LongLivedRuntimeQualification,
} from "./runtime.js";

const qualified: LongLivedRuntimeQualification = {
  platform: "win32",
  arch: "x64",
  backend: "windows-job-object",
  releaseReceipt: `sha256:${"a".repeat(64)}`,
};

describe("long-lived runtime qualification", () => {
  it("requires an exact platform, architecture, backend, and release receipt match", () => {
    expect(qualifyLongLivedRuntime(qualified, [qualified])).toEqual({
      ok: true,
      qualification: qualified,
      launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
    });
    expect(
      qualifyLongLivedRuntime({ ...qualified, releaseReceipt: `sha256:${"b".repeat(64)}` }, [
        qualified,
      ]),
    ).toEqual({ ok: false, reason: "runtime-unqualified" });
    expect(qualifyLongLivedRuntime(qualified)).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
  });

  it("rejects malformed receipts and platform/backend mismatches even if listed", () => {
    const malformed = { ...qualified, releaseReceipt: "release-2258" };
    const mismatched = { ...qualified, backend: "macos-app-sandbox" } as const;
    const invalidPlatform = {
      ...qualified,
      platform: "linux",
      arch: "ia32",
      backend: "macos-app-sandbox",
    } as unknown as LongLivedRuntimeQualification;
    const extraKey = { ...qualified, unreviewed: true } as LongLivedRuntimeQualification;

    expect(qualifyLongLivedRuntime(malformed, [malformed])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(mismatched, [mismatched])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(invalidPlatform, [invalidPlatform])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
    expect(qualifyLongLivedRuntime(extraKey, [extraKey])).toEqual({
      ok: false,
      reason: "runtime-unqualified",
    });
  });

  it("describes disabled upstream authority without guessing adapter flags", () => {
    expect(CLOSED_RUNTIME_LAUNCH_PROFILE).toEqual({
      upstreamEditAuthority: false,
      upstreamShellAuthority: false,
      upstreamGitAuthority: false,
      upstreamDeliveryAuthority: false,
      upstreamConnectorAuthority: false,
      upstreamBrowserAuthority: false,
      unrestrictedNetworkAuthority: false,
    });
  });
});
