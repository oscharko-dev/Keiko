// #4496 (ADR-0043 D21): a governed execution-root step on Windows. The pinned runtime supervisor
// runs it as the root of a per-run AppContainer that holds no network capability, inside a
// kill-on-close Job Object. This module owns what keiko-tools sends to that supervisor and how it
// reads the answer; exec.ts keeps the single spawn boundary.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { WindowsStepDrive, WindowsStepSupervisor } from "@oscharko-dev/keiko-contracts";
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

const MAVEN_LAUNCHERS = new Set(["mvn.cmd", "mvn.bat", "mvn"]);

/**
 * The supervisor's read roots, and the person's Maven repository for Maven's installed launcher
 * only: a launcher inside the execution root is the workspace's own file, not Maven.
 */
export function windowsStepReadRoots(
  executable: string,
  executionRoot: string,
  supervisor: WindowsStepSupervisor,
): readonly string[] {
  const { mavenRepository, readRoots } = supervisor;
  if (mavenRepository === undefined) return readRoots;
  if (!MAVEN_LAUNCHERS.has(win32.basename(executable).toLowerCase())) return readRoots;
  if (contains(executionRoot, executable)) return readRoots;
  return [...readRoots, mavenRepository];
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
    grants: windowsStepGrants(
      executionRoot,
      executable,
      windowsStepReadRoots(executable, executionRoot, supervisor),
      command,
      profile,
    ),
    recoveryHandle: randomBytes(16).toString("hex"),
  };
}

// The characters that end a path inside an argument or a variable: a separator continues it into
// the granted directory, anything else ends it there.
const PATH_SEPARATORS = new Set(["\\", "/"]);
const PATH_ENDINGS = new Set(['"', "'", ";", ",", "|", "<", ">", " ", "\t", "\r", "\n"]);
// A root right after a letter or digit is part of another word (`XC:\work`), never the path; an
// option glued to a path (`-IC:\work`) therefore keeps its real path and fails closed.
const NAME_CHARACTER = /[\p{L}\p{N}_]/u;

function withoutTrailingSeparator(value: string): string {
  let end = value.length;
  while (end > 0 && PATH_SEPARATORS.has(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

function sameCharacter(left: string, right: string): boolean {
  const slash = (value: string): string => (value === "/" ? "\\" : value.toLowerCase());
  return slash(left) === slash(right);
}

function rootAt(value: string, index: number, root: string): boolean {
  if (index + root.length > value.length) return false;
  for (let offset = 0; offset < root.length; offset++) {
    if (!sameCharacter(value.charAt(index + offset), root.charAt(offset))) return false;
  }
  return true;
}

// The drive and how much of the value it replaces at `index`, or undefined for no granted root.
function driveAt(
  value: string,
  index: number,
  drives: readonly WindowsStepDrive[],
): { readonly replacement: string; readonly length: number } | undefined {
  if (index > 0 && NAME_CHARACTER.test(value.charAt(index - 1))) return undefined;
  for (const { root, drive } of drives) {
    if (!rootAt(value, index, root)) continue;
    const next = value.charAt(index + root.length);
    if (next === "" || PATH_ENDINGS.has(next)) {
      // `"X:\"` would read back as an escaped quote; `X:\.` names the same directory.
      return {
        replacement: next === '"' ? `${drive}${win32.sep}.` : `${drive}${win32.sep}`,
        length: root.length,
      };
    }
    if (PATH_SEPARATORS.has(next)) return { replacement: drive, length: root.length };
  }
  return undefined;
}

/**
 * `value` with each granted directory named through its drive letter (#4496), the longest root
 * first; a sibling or a longer name that merely starts with a root is left alone.
 */
export function throughWindowsStepDrives(
  value: string,
  drives: readonly WindowsStepDrive[],
): string {
  if (drives.length === 0) return value;
  const ordered = drives
    .map(({ root, drive }) => ({ root: withoutTrailingSeparator(root), drive }))
    .filter(({ root }) => root.length > 0)
    .sort((left, right) => right.root.length - left.root.length);
  let result = "";
  let index = 0;
  while (index < value.length) {
    const found = driveAt(value, index, ordered);
    if (found === undefined) {
      result += value.charAt(index);
      index++;
      continue;
    }
    result += found.replacement;
    index += found.length;
  }
  return result;
}

/** The real folder a search-path entry names (through a junction or link), or undefined. */
export type WindowsStepRealPath = (entry: string) => string | undefined;

// Only a drive-absolute entry is resolved: a relative one would resolve against Keiko's own folder,
// not the step's, and a share (`\\server\share`) can stall the server while it answers (#4492). A
// mapped network drive letter is drive-absolute and can stall the same way; executable resolution
// already probes every PATH entry with the same exposure.
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

/**
 * A search path with each entry named through its drive letter. An entry no granted root names
 * lexically is tried by its real folder: Scoop puts its `current` junction on PATH while the
 * executable is granted by the folder it resolves to, and through the junction the step found npm
 * but not the `node` its script runs (#4492).
 */
function throughSearchPath(
  value: string,
  drives: readonly WindowsStepDrive[],
  realPath: WindowsStepRealPath,
): string {
  return value
    .split(";")
    .map((entry) => {
      const named = throughWindowsStepDrives(entry, drives);
      if (named !== entry || !DRIVE_ABSOLUTE.test(entry)) return named;
      const real = realPath(entry);
      if (real === undefined) return entry;
      const throughReal = throughWindowsStepDrives(real, drives);
      return throughReal === real ? entry : throughReal;
    })
    .join(";");
}

/**
 * The launch and the grants, in the order the supervisor reads them. The image, the working
 * directory, the arguments and every variable name a granted directory through its drive letter;
 * the grants keep the real paths, where the access entries live. A variable whose name the
 * supervisor's packet cannot carry (such as `ProgramFiles(x86)`) is left out of the step.
 */
export function windowsStepFrames(
  launch: WindowsStepLaunch,
  cwd: string,
  env: Readonly<Record<string, string>>,
  drives: readonly WindowsStepDrive[],
  realPath: WindowsStepRealPath = (): undefined => undefined,
): Buffer {
  const through = (value: string): string => throughWindowsStepDrives(value, drives);
  const carried = Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => ENVIRONMENT_NAME.test(name))
      .map(([name, value]) => [
        name,
        name.toUpperCase() === "PATH" ? throughSearchPath(value, drives, realPath) : through(value),
      ]),
  );
  return Buffer.concat([
    encodeLaunchPacket(
      { recoveryHandle: launch.recoveryHandle, args: launch.args.map(through), env: carried },
      { executable: through(launch.image), cwd: through(cwd) },
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
