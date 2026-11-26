// Preconditions of the Windows coding acceptance promise (#4492 AC3).
//
// The promise of epic #4491 is for a standard user on a machine with no container runtime and no
// installed Keiko service. Evidence taken anywhere else describes the product, but it does not
// certify the promise. This module probes the three facts through injectable seams (so it is
// unit-testable on any host), reports every unmet precondition as its own closed code, and records
// booleans and counts only: never a path, a user name, a SID or a service name of the person.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { win32 } from "node:path";

import { resolveWindowsSystemBinary } from "@oscharko-dev/keiko-security";

/** Every code the probe can emit; the checker must recognize each of them. */
export const WINDOWS_PRECONDITION_CODES = [
  "administrator",
  "administrator-probe-failed",
  "container-runtime-present",
  "container-runtime-probe-failed",
  "service-installed",
  "service-probe-failed",
] as const;

export type WindowsPreconditionCode = (typeof WINDOWS_PRECONDITION_CODES)[number];

export type WindowsUserClass = "standard" | "administrator" | "unknown";

export interface WindowsServiceFacts {
  /** The gateway service Keiko 1.5.x registered (ADR-0043 D19) is installed. */
  readonly keikoGatewayServiceInstalled: boolean;
  /** Distinct services whose name starts with the Keiko prefix, the gateway service included. */
  readonly keikoServiceCount: number;
}

export interface WindowsPreconditionFacts {
  readonly userClass: WindowsUserClass;
  /** Empty when the probe failed: the checker reads every missing sign as unrecorded. */
  readonly containerRuntime: Readonly<Record<string, boolean>>;
  /** Absent when the probe failed. */
  readonly services: WindowsServiceFacts | undefined;
  readonly unmetPreconditions: readonly WindowsPreconditionCode[];
}

export interface ScResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** Everything the probe reads from the machine; a test replaces each seam. */
export interface WindowsProbeSeams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  /**
   * The names in `\\.\pipe\`, listed rather than opened, so no pipe server sees a client;
   * `undefined` when the listing could not be read.
   */
  readonly pipes: () => readonly string[] | undefined;
  /** Whether the program is on `PATH`; `undefined` when `where.exe` itself could not run. */
  readonly onPath: (program: string) => boolean | undefined;
  /** Output of `whoami /groups /fo csv`; `undefined` when it could not run. */
  readonly whoamiGroups: () => string | undefined;
  /** Runs `sc.exe query <name>`; a spawn failure is a `null` status. */
  readonly sc: (args: readonly string[]) => ScResult;
  /**
   * Lists the service keys of the registry with `reg.exe`. The SCM refuses to enumerate services
   * to a standard user under a batch or network logon (OpenSCManager access denied), but the keys
   * are readable under every logon.
   */
  readonly reg: (args: readonly string[]) => ScResult;
}

/** BUILTIN\Administrators: a member of it is never certified, enabled or deny-only. */
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** Everyone: present in every token, so its absence means the output is not a group list. */
const EVERYONE_SID = "S-1-1-0";
/** Mandatory integrity levels from High (12288) up mean an elevated token. */
const HIGH_INTEGRITY_RID = 12288;
/**
 * The service Keiko 1.5.x registered (ADR-0043 D19). packages/keiko-cli names only its install
 * folder, and a test-support module may not import keiko-cli (ADR-0019 direction 7), so the name
 * is kept here.
 */
const KEIKO_GATEWAY_SERVICE = "KeikoRuntimeGateway";
/**
 * The services of a Windows container engine, matched exactly and case-insensitively against the
 * registry listing: Docker Engine without Desktop (`docker` and `containerd`) and Docker Desktop.
 * Podman's machine runs under WSL and shows as the pipe, the client or the install folder.
 */
const CONTAINER_SERVICES = ["docker", "containerd", "com.docker.service"];
/** Upper bound for one system tool, so a hung `sc.exe` cannot hang the probe. */
const TOOL_TIMEOUT_MS = 10_000;
const KEIKO_SERVICE_PREFIX = "Keiko";
/** `sc.exe` status for a service that does not exist (ERROR_SERVICE_DOES_NOT_EXIST). */
const SC_SERVICE_DOES_NOT_EXIST = 1060;
/**
 * The named-pipe namespace, read as a directory so no pipe is opened and no server sees a client.
 * `cmd.exe /c dir` cannot list it: on Windows 11 it answers "syntax is incorrect" (2026-11-26).
 */
const PIPE_DIRECTORY = `${String.raw`\\.\pipe`}${win32.sep}`;
const CONTAINER_PIPES = ["docker_engine", "podman-machine-default"];
const CONTAINER_APPLICATION_FOLDERS = [
  "Docker",
  "Podman",
  String.raw`RedHat\Podman`,
  "Podman Desktop",
  "podman-desktop",
  "Rancher Desktop",
];

function sidTokens(output: string): readonly string[] {
  return output.match(/(?<![\w-])S-1-\d+(?:-\d+)+(?![\w-])/gu) ?? [];
}

function elevatedIntegrity(sids: readonly string[]): boolean {
  return sids.some((sid) => {
    const rid = /^S-1-16-(\d+)$/u.exec(sid)?.[1];
    return rid !== undefined && Number(rid) >= HIGH_INTEGRITY_RID;
  });
}

/**
 * The promise is for a standard user, so only a token that is not elevated and whose user is not a
 * member of Administrators at all is certified. A split-token administrator's filtered token still
 * lists the group (as deny-only), and that machine is an administrator's, so it fails too. The SIDs
 * are read locale-independently and are never recorded.
 */
export function windowsUserClass(whoamiGroupsOutput: string): WindowsUserClass {
  const sids = sidTokens(whoamiGroupsOutput);
  if (!sids.includes(EVERYONE_SID)) return "unknown";
  if (sids.includes(ADMINISTRATORS_SID) || elevatedIntegrity(sids)) return "administrator";
  return "standard";
}

function probeUserClass(seams: WindowsProbeSeams): WindowsUserClass {
  const output = seams.whoamiGroups();
  return output === undefined ? "unknown" : windowsUserClass(output);
}

function applicationFolders(env: WindowsProbeSeams["env"]): readonly string[] {
  const present = (names: readonly string[]): string[] =>
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined || value === "" ? [] : [value];
    });
  const perUser = present(["LOCALAPPDATA"]);
  const roots = [
    ...present(["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]),
    ...perUser,
    ...perUser.map((root) => win32.join(root, "Programs")),
  ];
  return roots.flatMap((root) =>
    CONTAINER_APPLICATION_FOLDERS.map((folder) => win32.join(root, folder)),
  );
}

/**
 * Signs that a container runtime is installed or configured, conservatively: a client on `PATH`, a
 * configured `DOCKER_HOST` or `CONTAINER_HOST`, an engine named pipe, a `docker`, `containerd` or
 * Docker Desktop service, or the install folder of Docker Desktop, Podman (Desktop) or Rancher Desktop. These are signs of
 * presence, not proof that an engine is reachable, and they count whether or not it is running.
 */
export function windowsContainerRuntimeFacts(
  seams: WindowsProbeSeams,
  serviceNames: ReadonlySet<string> | undefined,
): Readonly<Record<string, boolean>> | undefined {
  const clients = ["docker", "podman", "nerdctl", "colima", "limactl"].map((program) =>
    seams.onPath(program),
  );
  const pipeNames = seams.pipes();
  if (clients.includes(undefined) || serviceNames === undefined || pipeNames === undefined) {
    return undefined;
  }
  const pipes = new Set(pipeNames.map((name) => name.toLowerCase()));
  const [docker, podman, ...others] = clients;
  return {
    dockerOnPath: docker === true,
    podmanOnPath: podman === true,
    otherClientOnPath: others.includes(true),
    dockerHostConfigured:
      (seams.env.DOCKER_HOST ?? "") !== "" || (seams.env.CONTAINER_HOST ?? "") !== "",
    containerServiceInstalled: CONTAINER_SERVICES.some((name) => serviceNames.has(name)),
    runtimePipePresent: CONTAINER_PIPES.some((name) => pipes.has(name)),
    applicationPresent: applicationFolders(seams.env).some((folder) => seams.exists(folder)),
  };
}

const SERVICES_REGISTRY_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Services`;
const SERVICE_KEY_LINE = /^HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\([^\\\r\n]+)$/u;

/** The distinct, lower-cased names of the direct child keys in a `reg query` listing, in any locale. */
export function serviceKeyNames(listing: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const name = SERVICE_KEY_LINE.exec(line.trimEnd())?.[1]?.toLowerCase();
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** The names that start with the Keiko prefix; each is counted once. */
export function keikoRegistryServiceNames(listing: string): readonly string[] {
  const prefix = KEIKO_SERVICE_PREFIX.toLowerCase();
  return [...serviceKeyNames(listing)].filter((name) => name.startsWith(prefix));
}

/** The service keys of the registry; `undefined` when `reg.exe` could not answer. */
function registryServiceNames(seams: WindowsProbeSeams): ReadonlySet<string> | undefined {
  const listing = seams.reg(["query", SERVICES_REGISTRY_KEY]);
  return listing.status === 0 ? serviceKeyNames(listing.stdout) : undefined;
}

function serviceInstalled(seams: WindowsProbeSeams, name: string): boolean | undefined {
  const { status } = seams.sc(["query", name]);
  if (status === 0) return true;
  return status === SC_SERVICE_DOES_NOT_EXIST ? false : undefined;
}

/**
 * Whether the gateway service, or any service named with the Keiko prefix, is installed;
 * `undefined` when `sc.exe` or `reg.exe` could not answer.
 */
export function windowsServiceFacts(
  seams: WindowsProbeSeams,
  serviceNames: ReadonlySet<string> | undefined,
): WindowsServiceFacts | undefined {
  const installed = serviceInstalled(seams, KEIKO_GATEWAY_SERVICE);
  if (installed === undefined || serviceNames === undefined) return undefined;
  const prefix = KEIKO_SERVICE_PREFIX.toLowerCase();
  const names = new Set([...serviceNames].filter((name) => name.startsWith(prefix)));
  if (installed) names.add(KEIKO_GATEWAY_SERVICE.toLowerCase());
  return { keikoGatewayServiceInstalled: installed, keikoServiceCount: names.size };
}

function userClassCodes(userClass: WindowsUserClass): readonly WindowsPreconditionCode[] {
  if (userClass === "administrator") return ["administrator"];
  return userClass === "unknown" ? ["administrator-probe-failed"] : [];
}

function containerCodes(
  facts: Readonly<Record<string, boolean>> | undefined,
): readonly WindowsPreconditionCode[] {
  if (facts === undefined) return ["container-runtime-probe-failed"];
  return Object.values(facts).some(Boolean) ? ["container-runtime-present"] : [];
}

function serviceCodes(facts: WindowsServiceFacts | undefined): readonly WindowsPreconditionCode[] {
  if (facts === undefined) return ["service-probe-failed"];
  return facts.keikoGatewayServiceInstalled || facts.keikoServiceCount > 0
    ? ["service-installed"]
    : [];
}

/** Probes all three preconditions; every unmet one is named, and a probe that fails is its own code. */
export function probeWindowsPreconditions(
  seams: WindowsProbeSeams = realWindowsProbeSeams(),
): WindowsPreconditionFacts {
  const userClass = probeUserClass(seams);
  const serviceNames = registryServiceNames(seams);
  const containerRuntime = windowsContainerRuntimeFacts(seams, serviceNames);
  const services = windowsServiceFacts(seams, serviceNames);
  return {
    userClass,
    containerRuntime: containerRuntime ?? {},
    services,
    unmetPreconditions: [
      ...userClassCodes(userClass),
      ...containerCodes(containerRuntime),
      ...serviceCodes(services),
    ],
  };
}

/** Runs one System32 tool without a shell and with a timeout; a tool that never ran has no status. */
function runSystemTool(
  env: WindowsProbeSeams["env"],
  tool: string,
  args: readonly string[],
): ScResult {
  const binary = resolveWindowsSystemBinary(tool, env);
  const result = spawnSync(binary, [...args], {
    // The System32 folder, so a tool never resolves anything against the caller's directory.
    cwd: win32.dirname(binary),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: TOOL_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout };
}

/** The pipe names, or no answer when the namespace cannot be read, which the checker names. */
export function listPipeNames(
  read: (directory: string) => readonly string[] = readdirSync,
): readonly string[] | undefined {
  try {
    return read(PIPE_DIRECTORY);
  } catch (error) {
    // A namespace the system refuses is a failed probe; anything else is a defect of the probe.
    if (error instanceof Error && "code" in error) return undefined;
    throw error;
  }
}

/** The seams bound to this machine; only meaningful on Windows. */
export function realWindowsProbeSeams(env: NodeJS.ProcessEnv = process.env): WindowsProbeSeams {
  return {
    env,
    exists: (path) => existsSync(path),
    pipes: () => listPipeNames(),
    onPath: (program): boolean | undefined => {
      const { status } = runSystemTool(env, "where.exe", [program]);
      // `where.exe` answers 1 for a program that is not found; no status at all means it never ran.
      return status === null || status > 1 ? undefined : status === 0;
    },
    whoamiGroups: (): string | undefined => {
      const { status, stdout } = runSystemTool(env, "whoami.exe", ["/groups", "/fo", "csv"]);
      return status === 0 ? stdout : undefined;
    },
    sc: (args) => runSystemTool(env, "sc.exe", args),
    reg: (args) => runSystemTool(env, "reg.exe", args),
  };
}
