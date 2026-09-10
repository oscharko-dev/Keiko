import { execFile } from "node:child_process";
import {
  macosDeveloperIdRequirement,
  macosReleaseTeamIdentifier,
  macosTeamIdentifierFromOutput,
} from "./coding-runtime/macosPortableCodeIdentity.js";
import { windowsPublisherIdentityMatchesAsync } from "./coding-runtime/windowsPortableAuthenticode.js";

const VERIFY_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export interface PortableHandoffNativeCopyVerificationInput {
  readonly kind: "coordinator" | "runtime-supervisor";
  readonly currentPath: string;
  readonly copiedPath: string;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly windowsHide: boolean },
) => Promise<CommandResult>;

export interface PortableHandoffNativeCopyVerifierOptions {
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly windowsIdentityMatches?:
    ((currentPath: string, copiedPath: string) => Promise<boolean>) | undefined;
  readonly macosRun?: CommandRunner | undefined;
  readonly macosExpectedTeamIdentifier?: string | undefined;
}

export class PortableHandoffNativeVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableHandoffNativeVerificationError";
  }
}

function fail(message: string): never {
  throw new PortableHandoffNativeVerificationError(message);
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly windowsHide: boolean },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        shell: false,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        let status: number | null = null;
        if (error === null) status = 0;
        else if (typeof error.code === "number") status = error.code;
        resolve({
          status,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function macosIdentity(path: string, run: CommandRunner): Promise<string> {
  const displayed = await run("/usr/bin/codesign", ["--display", "--verbose=4", path], {
    timeout: VERIFY_TIMEOUT_MS,
    windowsHide: true,
  });
  const teamIdentifier = macosTeamIdentifierFromOutput(`${displayed.stdout}\n${displayed.stderr}`);
  if (displayed.status !== 0 || teamIdentifier === undefined) {
    fail("portable handoff native Developer ID identity is unavailable");
  }
  return teamIdentifier;
}

async function verifyMacosCopy(
  input: PortableHandoffNativeCopyVerificationInput,
  run: CommandRunner,
  expectedTeamIdentifier: string,
): Promise<void> {
  const currentTeam = await macosIdentity(input.currentPath, run);
  const copiedTeam = await macosIdentity(input.copiedPath, run);
  if (currentTeam !== expectedTeamIdentifier || copiedTeam !== expectedTeamIdentifier) {
    fail("portable handoff native Developer ID identity changed");
  }
  const requirement = macosDeveloperIdRequirement(expectedTeamIdentifier);
  for (const path of [input.currentPath, input.copiedPath]) {
    const verified = await run(
      "/usr/bin/codesign",
      ["--verify", "--strict", `-R=${requirement}`, path],
      { timeout: VERIFY_TIMEOUT_MS, windowsHide: true },
    );
    if (verified.status !== 0) fail("portable handoff native Developer ID verification failed");
  }
  // A detached Mach-O does not carry an independently stapled app-bundle ticket. Notarization is
  // established on the already trusted current bundle by portable preflight; the secure copy is
  // byte-identical to that bundle member and this check independently revalidates its embedded
  // Developer ID signature and release-team continuity.
}

export function createPortableHandoffNativeCopyVerifier(
  options: PortableHandoffNativeCopyVerifierOptions = {},
): (input: PortableHandoffNativeCopyVerificationInput) => Promise<void> {
  const hostPlatform = options.hostPlatform ?? process.platform;
  return async (input): Promise<void> => {
    if (hostPlatform === "win32") {
      const matches =
        options.windowsIdentityMatches ??
        ((currentPath: string, copiedPath: string): Promise<boolean> =>
          windowsPublisherIdentityMatchesAsync(currentPath, copiedPath));
      if (!(await matches(input.currentPath, input.copiedPath))) {
        fail("portable handoff native Authenticode identity changed");
      }
      return;
    }
    if (hostPlatform === "darwin") {
      const expectedTeamIdentifier =
        options.macosExpectedTeamIdentifier ?? macosReleaseTeamIdentifier();
      if (expectedTeamIdentifier === undefined) {
        fail("portable handoff release Developer ID identity is unavailable");
      }
      await verifyMacosCopy(input, options.macosRun ?? runCommand, expectedTeamIdentifier);
      return;
    }
    fail("portable handoff native verification is unavailable on this platform");
  };
}

export const verifyPortableHandoffNativeCopy = createPortableHandoffNativeCopyVerifier();
