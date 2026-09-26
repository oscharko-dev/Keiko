import { describe, expect, it, vi } from "vitest";
import {
  createPortableHandoffNativeCopyVerifier,
  PortableHandoffNativeVerificationError,
  type PortableHandoffNativeCopyVerifierOptions,
} from "./update-portable-handoff-native-verification.js";

const input = {
  kind: "coordinator" as const,
  currentPath: "/Applications/Keiko.app/Contents/MacOS/Keiko",
  copiedPath: "/state/updates/handoff/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/coordinator",
};

describe("portable handoff native copy verification", () => {
  it("uses the governed Authenticode same-publisher boundary on Windows", async () => {
    const matches = vi.fn().mockResolvedValue(true);
    const verify = createPortableHandoffNativeCopyVerifier({
      hostPlatform: "win32",
      windowsIdentityMatches: matches,
    });

    await expect(verify(input)).resolves.toBeUndefined();
    expect(matches).toHaveBeenCalledWith(input.currentPath, input.copiedPath);
  });

  it("revalidates both byte-identical macOS executables against the release Developer ID", async () => {
    const run = vi.fn<NonNullable<PortableHandoffNativeCopyVerifierOptions["macosRun"]>>(
      (_command, args) => {
        if (args[0] === "--display") {
          return Promise.resolve({
            status: 0,
            stdout: "",
            stderr: "Authority=Developer ID Application\nTeamIdentifier=AB12CD34EF\n",
          });
        }
        return Promise.resolve({ status: 0, stdout: "", stderr: "" });
      },
    );
    const verify = createPortableHandoffNativeCopyVerifier({
      hostPlatform: "darwin",
      macosExpectedTeamIdentifier: "AB12CD34EF",
      macosRun: run,
    });

    await expect(verify(input)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.filter((call) => call[1][0] === "--verify")).toHaveLength(2);
  });

  it.each([
    [
      "codesign cannot identify the current executable",
      [{ status: 1, stderr: "codesign failed", stdout: "" }],
      "portable handoff native Developer ID identity is unavailable",
      1,
    ],
    [
      "codesign returns no TeamIdentifier for the current executable",
      [{ status: 0, stderr: "Authority=Developer ID Application", stdout: "" }],
      "portable handoff native Developer ID identity is unavailable",
      1,
    ],
    [
      "the copied executable has a different team",
      [
        { status: 0, stderr: "TeamIdentifier=AB12CD34EF", stdout: "" },
        { status: 0, stderr: "TeamIdentifier=ZX98CV76BN", stdout: "" },
      ],
      "portable handoff native Developer ID identity changed",
      2,
    ],
    [
      "codesign rejects the current executable during strict verification",
      [
        { status: 0, stderr: "TeamIdentifier=AB12CD34EF", stdout: "" },
        { status: 0, stderr: "TeamIdentifier=AB12CD34EF", stdout: "" },
        { status: 1, stderr: "verification failed", stdout: "" },
      ],
      "portable handoff native Developer ID verification failed",
      3,
    ],
  ])("fails closed when %s", async (_label, results, message, calls) => {
    let index = 0;
    const run = vi.fn<NonNullable<PortableHandoffNativeCopyVerifierOptions["macosRun"]>>(() =>
      Promise.resolve(results[index++] ?? { status: 1, stderr: "unexpected command", stdout: "" }),
    );
    const verify = createPortableHandoffNativeCopyVerifier({
      hostPlatform: "darwin",
      macosExpectedTeamIdentifier: "AB12CD34EF",
      macosRun: run,
    });

    await expect(verify(input)).rejects.toThrow(message);
    expect(run).toHaveBeenCalledTimes(calls);
  });

  it("fails closed on a copied signer mismatch or unsupported host", async () => {
    const windows = createPortableHandoffNativeCopyVerifier({
      hostPlatform: "win32",
      windowsIdentityMatches: () => Promise.resolve(false),
    });
    await expect(windows(input)).rejects.toBeInstanceOf(PortableHandoffNativeVerificationError);

    const unsupported = createPortableHandoffNativeCopyVerifier({ hostPlatform: "linux" });
    await expect(unsupported(input)).rejects.toThrow(/unavailable/u);
  });
});
