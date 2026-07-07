import { describe, expect, it } from "vitest";
import { createPortablePlatformVerifier } from "./update-portable-platform-verification.js";

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal | undefined;
}

function commandRecorder(outputFor: (call: CommandCall) => string = () => ""): {
  readonly calls: CommandCall[];
  readonly run: CommandCallRecorder;
} {
  const calls: CommandCall[] = [];
  return {
    calls,
    run: (
      command: string,
      args: readonly string[],
      env: NodeJS.ProcessEnv,
      signal: AbortSignal | undefined,
    ): Promise<string> => {
      const call = { command, args, env, signal };
      calls.push(call);
      return Promise.resolve(outputFor(call));
    },
  };
}

type CommandCallRecorder = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
) => Promise<string>;

const WINDOWS_SIGNER = "A".repeat(40);
const MACOS_TEAM_OUTPUT = "TeamIdentifier=ABCDE12345\n";

describe("portable platform verification", () => {
  it("runs local Authenticode verification for Windows launchers", async () => {
    const recorder = commandRecorder(() => WINDOWS_SIGNER);
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
    });

    await verifier({
      target: "windows-x64",
      stagedRoot: "C:\\Users\\keiko\\stage",
      launcherPath: "C:\\Users\\keiko\\Keiko.exe",
      currentLauncherPath: "C:\\Users\\keiko\\current\\Keiko.exe",
    });

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]?.command).toBe("powershell.exe");
    expect(recorder.calls[0]?.args.join(" ")).toContain("Get-AuthenticodeSignature");
    expect(recorder.calls[0]?.env.KEIKO_PORTABLE_VERIFY_PATH).toBe("C:\\Users\\keiko\\Keiko.exe");
    expect(recorder.calls[1]?.env.KEIKO_PORTABLE_VERIFY_PATH).toBe(
      "C:\\Users\\keiko\\current\\Keiko.exe",
    );
  });

  it("runs local codesign, stapler, and Gatekeeper assessment for macOS app bundles", async () => {
    const recorder = commandRecorder((call) =>
      call.args.includes("--display") ? MACOS_TEAM_OUTPUT : "",
    );
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "darwin",
      runCommand: recorder.run,
    });

    await verifier({
      target: "macos-arm64",
      stagedRoot: "/Users/keiko/stage",
      launcherPath: "/Users/keiko/stage/Keiko.app/Contents/MacOS/Keiko",
      appBundlePath: "/Users/keiko/stage/Keiko.app",
      currentLauncherPath: "/Users/keiko/Keiko.app/Contents/MacOS/Keiko",
      currentAppBundlePath: "/Users/keiko/Keiko.app",
    });

    expect(recorder.calls.map((call) => call.command)).toEqual([
      "codesign",
      "xcrun",
      "spctl",
      "codesign",
      "codesign",
      "xcrun",
      "spctl",
      "codesign",
    ]);
    expect(recorder.calls[0]?.args).toEqual([
      "--verify",
      "--deep",
      "--strict",
      "/Users/keiko/stage/Keiko.app",
    ]);
    expect(recorder.calls[1]?.args).toEqual([
      "stapler",
      "validate",
      "/Users/keiko/stage/Keiko.app",
    ]);
    expect(recorder.calls[2]?.args).toEqual([
      "--assess",
      "--type",
      "execute",
      "/Users/keiko/stage/Keiko.app",
    ]);
    expect(recorder.calls[7]?.args).toEqual(["--display", "--verbose=4", "/Users/keiko/Keiko.app"]);
  });

  it("fails closed when staged and active signer identities differ", async () => {
    const recorder = commandRecorder((call) =>
      call.env.KEIKO_PORTABLE_VERIFY_PATH?.includes("current") === true
        ? "B".repeat(40)
        : WINDOWS_SIGNER,
    );
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
    });

    await expect(
      verifier({
        target: "windows-x64",
        stagedRoot: "C:\\Users\\keiko\\stage",
        launcherPath: "C:\\Users\\keiko\\Keiko.exe",
        currentLauncherPath: "C:\\Users\\keiko\\current\\Keiko.exe",
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(recorder.calls).toHaveLength(2);
  });

  it("fails closed when the local host cannot verify the target platform", async () => {
    const recorder = commandRecorder();
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "linux",
      runCommand: recorder.run,
    });

    await expect(
      verifier({
        target: "windows-x64",
        stagedRoot: "/tmp/stage",
        launcherPath: "/tmp/stage/Keiko.exe",
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(recorder.calls).toEqual([]);
  });

  it("fails closed when macOS bundle verification has no app bundle path", async () => {
    const recorder = commandRecorder();
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "darwin",
      runCommand: recorder.run,
    });

    await expect(
      verifier({
        target: "macos-x64",
        stagedRoot: "/tmp/stage",
        launcherPath: "/tmp/stage/Keiko.app/Contents/MacOS/Keiko",
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
    expect(recorder.calls).toEqual([]);
  });
});
