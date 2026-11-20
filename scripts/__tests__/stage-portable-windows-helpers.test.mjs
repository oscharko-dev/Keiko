import { describe, expect, it, vi } from "vitest";

import { WINDOWS_PORTABLE_RUNTIME_APPROVAL } from "../../packages/keiko-server/dist/coding-runtime/npmLaneRuntimeApprovals.js";
import { portableTargetByName } from "../portable-runtime.mjs";
import {
  verifyWindowsNativeHelpers,
  windowsNativeHelperApprovalFailures,
} from "../stage-portable-runtime.mjs";

// #4068: the 1.5.4 release build compiled the unchanged secure-read source on an updated Windows
// runner image into new bytes. The server's pin still named the earlier image's bytes, so every
// Windows installation of 1.5.4 refused to start a Coding run ("gateway-service-unqualified"),
// and nothing in the build noticed. These are the two helper sets of that incident.
const RELEASE_154_SECURE_READ = {
  name: "keiko-secure-workspace-read",
  unsignedSha256: "8699612eabadc70f95ab969ed259edca8b18a5381c2c577acd2ca835c226ac64",
  sizeBytes: 128_512,
};
const RELEASE_154_SUPERVISOR = {
  name: "keiko-runtime-supervisor",
  unsignedSha256: "8966ba374943d8b0f7dce4bdee296084802783cda0e4a191666a0c4cd16616fb",
  sizeBytes: 252_416,
};
const RELEASE_154_HELPERS = [RELEASE_154_SECURE_READ, RELEASE_154_SUPERVISOR];
const PIN_BEFORE_THE_FIX = {
  ...WINDOWS_PORTABLE_RUNTIME_APPROVAL,
  helperSha256: "65cc98c377f0e82494c54a1dd68a5be85fcd7b80272679638579aff23f4ab9e6",
  helperSizeBytes: 129_024,
};

function helpersMatching(approval) {
  return [
    {
      name: "keiko-secure-workspace-read",
      unsignedSha256: approval.helperSha256,
      sizeBytes: approval.helperSizeBytes,
    },
    {
      name: "keiko-runtime-supervisor",
      unsignedSha256: approval.runtimeSupervisor.sha256,
      sizeBytes: approval.runtimeSupervisor.sizeBytes,
    },
  ];
}

describe("Windows native helper approval at staging", () => {
  it("names the secure-read helper the 1.5.4 build shipped against the pin it had then", () => {
    expect(windowsNativeHelperApprovalFailures(RELEASE_154_HELPERS, PIN_BEFORE_THE_FIX)).toEqual([
      "keiko-secure-workspace-read: built 8699612eabadc70f95ab969ed259edca8b18a5381c2c577acd2ca835c226ac64 (128512 bytes), approved 65cc98c377f0e82494c54a1dd68a5be85fcd7b80272679638579aff23f4ab9e6 (129024 bytes)",
    ]);
  });

  it("accepts the bytes a release ships under the server's current pin", () => {
    expect(
      windowsNativeHelperApprovalFailures(RELEASE_154_HELPERS, WINDOWS_PORTABLE_RUNTIME_APPROVAL),
    ).toEqual([]);
  });

  it("refuses a matching digest with another size, a missing helper and a missing supervisor pin", () => {
    const approval = WINDOWS_PORTABLE_RUNTIME_APPROVAL;
    const [secureRead, supervisor] = helpersMatching(approval);
    expect(
      windowsNativeHelperApprovalFailures(
        [{ ...secureRead, sizeBytes: secureRead.sizeBytes + 1 }, supervisor],
        approval,
      ),
    ).toHaveLength(1);
    expect(windowsNativeHelperApprovalFailures([secureRead], approval)).toEqual([
      "keiko-runtime-supervisor: not staged",
    ]);
    const withoutSupervisor = { ...approval, runtimeSupervisor: undefined };
    expect(
      windowsNativeHelperApprovalFailures([secureRead, supervisor], withoutSupervisor),
    ).toHaveLength(1);
  });

  it("stops a Windows stage whose helpers differ and never loads a pin for other targets", async () => {
    const onFailure = vi.fn();
    await expect(
      verifyWindowsNativeHelpers(portableTargetByName("windows-x64"), RELEASE_154_HELPERS, {
        loadApproval: async () => PIN_BEFORE_THE_FIX,
        onFailure,
      }),
    ).rejects.toThrow("portable Windows native helper verification aborted");
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toContain("no Windows installation of this build");

    const loadApproval = vi.fn();
    for (const name of ["linux-x64", "macos-arm64", "macos-x64"]) {
      await verifyWindowsNativeHelpers(portableTargetByName(name), [], { loadApproval, onFailure });
    }
    expect(loadApproval).not.toHaveBeenCalled();
  });

  it("checks a Windows stage against the pin the built server enforces", async () => {
    const onFailure = vi.fn();
    await expect(
      verifyWindowsNativeHelpers(
        portableTargetByName("windows-x64"),
        helpersMatching(WINDOWS_PORTABLE_RUNTIME_APPROVAL),
        { onFailure },
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyWindowsNativeHelpers(
        portableTargetByName("windows-x64"),
        helpersMatching(PIN_BEFORE_THE_FIX),
        { onFailure },
      ),
    ).rejects.toThrow("portable Windows native helper verification aborted");
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
