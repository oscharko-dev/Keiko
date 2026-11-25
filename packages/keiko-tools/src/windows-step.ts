// #4496 (ADR-0043 D21): a governed execution-root step on Windows. The pinned runtime supervisor
// runs it as the root of a per-run AppContainer that holds no network capability, inside a
// kill-on-close Job Object. This module owns what keiko-tools sends to that supervisor and how it
// reads the answer; exec.ts keeps the single spawn boundary.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { WindowsStepSupervisor } from "@oscharko-dev/keiko-contracts";
import {
  encodeControlPacket,
  encodeLaunchPacket,
  encodeWindowsGatewayGrants,
  WINDOWS_FILESYSTEM_GRANTS_MAX,
  type WindowsFilesystemGrant,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
import { CommandDeniedError } from "./errors.js";

/** What one supervised step needs once its environment is known. */
export interface WindowsStepLaunch {
  /** The step's own image: the resolved executable, or cmd.exe for a command script. */
  readonly image: string;
  /** Arguments already quoted for `image`; the supervisor joins them verbatim. */
  readonly args: readonly string[];
  readonly grants: readonly WindowsFilesystemGrant[];
  readonly recoveryHandle: string;
}

const ENVIRONMENT_NAME = /^[A-Za-z_]\w{0,127}$/u;

/**
 * One argument quoted as the Microsoft C runtime parses it back: backslashes before a quote are
 * doubled and the quote escaped; trailing backslashes are doubled before the closing quote. The
 * supervisor quotes its own launches the same way (append_quoted).
 */
export function quoteWindowsArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function contains(root: string, path: string): boolean {
  const relative = win32.relative(root, path);
  return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
}

/** The toolchain folder an executable belongs to: a `bin` folder's parent (a JDK, Maven). */
function toolchainRoot(executable: string): string {
  const folder = win32.dirname(executable);
  return win32.basename(folder).toLowerCase() === "bin" ? win32.dirname(folder) : folder;
}

/**
 * The tree's grants: the execution root for modification, and read access to the toolchain of
 * the step's executable and to the supervisor's read roots. A directory inside the execution root
 * or inside another read grant adds nothing. A grant that would hold the whole user profile, and
 * more grants than the supervisor accepts, are refused.
 */
export function windowsStepGrants(
  executionRoot: string,
  executable: string,
  readRoots: readonly string[],
  command: string,
  profile?: string,
): readonly WindowsFilesystemGrant[] {
  const holdsProfile = (path: string): boolean =>
    profile !== undefined && win32.isAbsolute(profile) && contains(path, profile);
  if (holdsProfile(executionRoot)) {
    throw new CommandDeniedError("the execution root holds the whole user profile", command);
  }
  const grants: WindowsFilesystemGrant[] = [
    { path: executionRoot, access: "modify", principal: "tree" },
  ];
  for (const root of [toolchainRoot(executable), ...readRoots]) {
    if (!win32.isAbsolute(root))
      throw new CommandDeniedError("step read root is not absolute", command);
    if (holdsProfile(root)) {
      throw new CommandDeniedError("a step read root holds the whole user profile", command);
    }
    if (grants.some((grant) => contains(grant.path, root))) continue;
    grants.push({ path: root, access: "read", principal: "tree" });
  }
  if (grants.length > WINDOWS_FILESYSTEM_GRANTS_MAX) {
    throw new CommandDeniedError(
      "the step needs more directories than one tree may be granted",
      command,
    );
  }
  return grants;
}

export function windowsStepLaunch(
  invocation: {
    readonly command: string;
    readonly args: readonly string[];
    readonly windowsVerbatimArguments: boolean;
  },
  executable: string,
  executionRoot: string,
  supervisor: WindowsStepSupervisor,
  command: string,
  profile: string | undefined,
): WindowsStepLaunch {
  return {
    image: invocation.command,
    args: invocation.windowsVerbatimArguments
      ? invocation.args
      : invocation.args.map(quoteWindowsArgument),
    grants: windowsStepGrants(executionRoot, executable, supervisor.readRoots, command, profile),
    recoveryHandle: randomBytes(16).toString("hex"),
  };
}

/**
 * The launch and the grants, in the order the supervisor reads them. A variable whose name the
 * supervisor's packet cannot carry (such as `ProgramFiles(x86)`) is left out of the step.
 */
export function windowsStepFrames(
  launch: WindowsStepLaunch,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Buffer {
  const carried = Object.fromEntries(
    Object.entries(env).filter(([name]) => ENVIRONMENT_NAME.test(name)),
  );
  return Buffer.concat([
    encodeLaunchPacket(
      { recoveryHandle: launch.recoveryHandle, args: launch.args, env: carried },
      { executable: launch.image, cwd },
    ),
    encodeWindowsGatewayGrants(launch.grants),
  ]);
}

/** KRC1 terminate: the supervisor ends the whole job with 137, then reaps and revokes. */
export function windowsStepTerminateFrame(): Buffer {
  return encodeControlPacket(3);
}

/** The supervisor's answer, read from its response descriptor. */
export type WindowsStepAnswer =
  | { readonly kind: "pending" }
  | { readonly kind: "launched" }
  | { readonly kind: "reaped"; readonly exitCode: number; readonly activeProcesses: number }
  | { readonly kind: "refused"; readonly code: number }
  | { readonly kind: "malformed" };

const RESPONSE_HEADER = 12;

/** Accumulates KRS1 frames; the last complete one decides. */
export class WindowsStepResponses {
  private pending: Buffer = Buffer.alloc(0);
  private current: WindowsStepAnswer = { kind: "pending" };
  private started = false;

  public feed(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.current.kind !== "malformed" && this.pending.length >= RESPONSE_HEADER) {
      const length = this.pending.readUInt32LE(8);
      if (this.pending.subarray(0, 4).toString("ascii") !== "KRS1" || length > 64) {
        this.current = { kind: "malformed" };
        return;
      }
      if (this.pending.length < RESPONSE_HEADER + length) return;
      this.current = decodeAnswer(
        this.pending.readUInt16LE(6),
        this.pending.subarray(RESPONSE_HEADER, RESPONSE_HEADER + length),
      );
      if (this.current.kind === "launched") this.started = true;
      this.pending = this.pending.subarray(RESPONSE_HEADER + length);
    }
  }

  public answer(): WindowsStepAnswer {
    return this.current;
  }

  /** Whether the supervisor reported the step launched, whatever it answered afterwards. */
  public launched(): boolean {
    return this.started;
  }
}

function decodeAnswer(kind: number, payload: Buffer): WindowsStepAnswer {
  if (kind === 1) return { kind: "launched" };
  if (kind === 2 && payload.length === 8) {
    return {
      kind: "reaped",
      exitCode: payload.readUInt32LE(0),
      activeProcesses: payload.readUInt32LE(4),
    };
  }
  if (kind === 3 && payload.length === 2) return { kind: "refused", code: payload.readUInt16LE(0) };
  return { kind: "malformed" };
}
