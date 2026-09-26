import { describe, expect, it } from "vitest";
import { createPortablePlatformVerifier } from "./update-portable-platform-verification.js";

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal | undefined;
  readonly stdin: string | undefined;
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
      stdin: string | undefined,
    ): Promise<string> => {
      const call = { command, args, env, signal, stdin };
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
  stdin: string | undefined,
) => Promise<string>;

const WINDOWS_ROOT = "C".repeat(40);
const WINDOWS_PUBLISHER = `1.3.6.1.4.1.311.97.12345|${WINDOWS_ROOT}|${"A".repeat(40)}`;
const MACOS_TEAM_OUTPUT = "TeamIdentifier=ABCDE12345\n";

describe("portable platform verification", () => {
  it("verifies the staged Linux production root through its bound Sigstore qualification", async () => {
    const roots: string[] = [];
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "linux",
      linuxRuntimeVerifier: (root) => {
        roots.push(root);
        return true;
      },
    });

    await verifier({
      target: "linux-x64",
      stagedRoot: "/home/keiko/stage",
      launcherPath: "/home/keiko/stage/Keiko/Keiko",
    });

    expect(roots).toEqual(["/home/keiko/stage/Keiko"]);
  });

  it("fails closed when Linux qualification or provenance cannot be re-established", async () => {
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "linux",
      linuxRuntimeVerifier: () => false,
    });

    await expect(
      verifier({
        target: "linux-x64",
        stagedRoot: "/home/keiko/stage",
        launcherPath: "/home/keiko/stage/Keiko/Keiko",
      }),
    ).rejects.toMatchObject({ reason: "portable-verification-failed" });
  });

  it("runs local Authenticode verification for Windows launchers", async () => {
    const trustedRoot = String.raw`D:\Windows`;
    const recorder = commandRecorder(() => WINDOWS_PUBLISHER);
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
      windowsSystem: {
        env: { SystemRoot: trustedRoot },
        existsAsFile: () => true,
        identityCheck: (candidate) => candidate === trustedRoot,
      },
    });

    await verifier({
      target: "windows-x64",
      stagedRoot: "C:\\Users\\keiko\\stage",
      launcherPath: "C:\\Users\\keiko\\Keiko.exe",
      currentLauncherPath: "C:\\Users\\keiko\\current\\Keiko.exe",
    });

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls.map((call) => call.command)).toEqual([
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ]);
    expect(recorder.calls[0]?.args.join(" ")).toContain("Get-AuthenticodeSignature");
    expect(recorder.calls[0]?.args.join(" ")).toContain("[Reflection.Assembly]::Load($b)");
    expect(recorder.calls[0]?.args.join(" ")).not.toContain("Add-Type");
    expect(recorder.calls[0]?.stdin).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(recorder.calls[0]?.args.at(-1)).toBe("C:\\Users\\keiko\\stage");
    expect(recorder.calls[1]?.args.at(-1)).toBe("C:\\Users\\keiko\\current\\Keiko.exe");
    expect(recorder.calls.map((call) => call.env)).toEqual([
      {
        ComSpec: String.raw`D:\Windows\System32\cmd.exe`,
        PATH: String.raw`D:\Windows\System32;D:\Windows`,
        SystemRoot: trustedRoot,
        WINDIR: trustedRoot,
      },
      {
        ComSpec: String.raw`D:\Windows\System32\cmd.exe`,
        PATH: String.raw`D:\Windows\System32;D:\Windows`,
        SystemRoot: trustedRoot,
        WINDIR: trustedRoot,
      },
    ]);
  });

  it("rejects a hostile Windows system root before invoking the command runner", async () => {
    const recorder = commandRecorder(() => WINDOWS_PUBLISHER);
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
      windowsSystem: {
        env: { SystemRoot: String.raw`D:\Attacker` },
        existsAsFile: () => true,
        identityCheck: () => false,
      },
    });

    await expect(
      verifier({
        target: "windows-x64",
        stagedRoot: String.raw`C:\Users\keiko\stage`,
        launcherPath: String.raw`C:\Users\keiko\stage\Keiko.exe`,
        currentLauncherPath: String.raw`C:\Users\keiko\current\Keiko.exe`,
      }),
    ).rejects.toMatchObject({ name: "WindowsSystemDirectoryError" });
    expect(recorder.calls).toEqual([]);
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
      call.args.at(-1)?.includes("current") === true
        ? `1.3.6.1.4.1.311.97.99999|${WINDOWS_ROOT}|${"B".repeat(40)}`
        : WINDOWS_PUBLISHER,
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

  it("accepts a rotated Azure leaf when the verified durable publisher identity is unchanged", async () => {
    const recorder = commandRecorder((call) =>
      call.args.at(-1)?.includes("current") === true
        ? `1.3.6.1.4.1.311.97.12345|${WINDOWS_ROOT}|${"B".repeat(40)}`
        : WINDOWS_PUBLISHER,
    );
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
    });

    await expect(
      verifier({
        target: "windows-x64",
        stagedRoot: "C:\\Users\\keiko\\stage-with-new-leaf",
        launcherPath: "C:\\Users\\keiko\\stage-with-new-leaf\\Keiko.exe",
        currentLauncherPath: "C:\\Users\\keiko\\current-with-old-leaf\\Keiko.exe",
      }),
    ).resolves.toBeUndefined();
    expect(recorder.calls).toHaveLength(2);
  });

  it("fails closed when only the verified Windows root identity differs", async () => {
    const recorder = commandRecorder((call) =>
      call.args.at(-1)?.includes("current") === true
        ? `1.3.6.1.4.1.311.97.12345|${"D".repeat(40)}|${"B".repeat(40)}`
        : WINDOWS_PUBLISHER,
    );
    const verifier = createPortablePlatformVerifier({
      hostPlatform: "win32",
      runCommand: recorder.run,
    });

    await expect(
      verifier({
        target: "windows-x64",
        stagedRoot: "C:\\Users\\keiko\\stage",
        launcherPath: "C:\\Users\\keiko\\stage\\Keiko.exe",
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
