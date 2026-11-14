// #4358: a pass of the Windows local-volume check may be remembered for passive reads only. These
// pins hold the points that ACT on the verdict to the enforcing check, which asks Windows every
// time: the update session's detector and the discovery that starts the portable coding runtime.
import { afterEach, describe, expect, it, vi } from "vitest";

const volumeCheck = vi.hoisted(() => ({
  calls: [] as string[],
  refuse: undefined as undefined | "not-local" | "unverifiable",
}));
vi.mock("@oscharko-dev/keiko-security/windows-local-volume", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-security/windows-local-volume")>();
  return {
    ...actual,
    assertWindowsLocalVolume: (): void => {
      volumeCheck.calls.push("enforcing");
      if (volumeCheck.refuse !== undefined) {
        throw new actual.WindowsLocalVolumeError(
          "refused",
          volumeCheck.refuse,
          "verify",
          undefined,
        );
      }
    },
    assertWindowsLocalVolumeForPassiveRead: (): void => {
      volumeCheck.calls.push("passive-read");
    },
  };
});

const detection = vi.hoisted(() => ({ args: [] as unknown[][] }));
vi.mock("./update-install-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-install-mode.js")>();
  return {
    ...actual,
    detectUpdateInstallMode: (
      ...args: Parameters<typeof actual.detectUpdateInstallMode>
    ): ReturnType<typeof actual.detectUpdateInstallMode> => {
      detection.args.push(args);
      return actual.detectUpdateInstallMode(...args);
    },
  };
});

import {
  discoverPortableOpenCode,
  discoverQualifiedPortableOpenCode,
} from "./coding-runtime/productionPortableCodingRuntime.js";
import { defaultDetectorFor } from "./update-session-support.js";

afterEach(() => {
  volumeCheck.calls.length = 0;
  volumeCheck.refuse = undefined;
  detection.args.length = 0;
});

describe("the points that act on the local-volume verdict check fresh", () => {
  it("the update session's detector never asks for a remembered pass", () => {
    const detector = defaultDetectorFor(
      {
        facts: () => ({
          entryPath: "/opt/keiko/app/dist/cli/index.js",
          packageRoot: "/opt/keiko/app",
          packageName: "@oscharko-dev/keiko",
          packageManagerHint: undefined,
        }),
      },
      {},
    );
    detector();
    detector();
    expect(detection.args).toHaveLength(2);
    // no fifth argument: the detection's default is the fresh, enforcing check
    expect(detection.args.map((args) => args[4])).toEqual([undefined, undefined]);
    expect(volumeCheck.calls).not.toContain("passive-read");
  });

  it("the portable coding runtime discovery asks Windows every time", () => {
    const input = {
      env: {},
      installRoot: String.raw`C:\Users\person\AppData\Local\Programs\Keiko`,
      platform: "win32" as const,
      arch: "x64",
    };
    discoverQualifiedPortableOpenCode(input);
    discoverQualifiedPortableOpenCode(input);
    expect(volumeCheck.calls).toEqual(["enforcing", "enforcing"]);
  });
});

// The bundled runtime of a Windows portable install was silently absent when the check refused.
describe("the portable coding runtime names why its install folder forbids it", () => {
  const input = {
    env: {},
    installRoot: String.raw`C:\Users\person\AppData\Local\Programs\Keiko`,
    platform: "win32" as const,
    arch: "x64",
  };

  it.each([
    ["not-local", "install-volume-not-local"],
    ["unverifiable", "install-volume-unverified"],
  ] as const)("reports a %s refusal as %s", (verdict, unavailableReason) => {
    volumeCheck.refuse = verdict;
    expect(discoverPortableOpenCode(input)).toEqual({ unavailableReason });
    expect(discoverQualifiedPortableOpenCode(input)).toBeUndefined();
    expect(volumeCheck.calls).toEqual(["enforcing", "enforcing"]);
  });
});
