// Preconditions of the Windows coding acceptance promise (#4492 AC3).
//
// The promise of epic #4491 is for a standard user on a machine with no container runtime and no
// installed Keiko service. Evidence taken anywhere else describes the product, but it does not
// certify the promise. This module probes the three facts through injectable seams (so it is
// unit-testable on any host), reports every unmet precondition as its own closed code, and records
// booleans and counts only: never a path, a user name, a SID or a service name of the person.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export type WindowsPreconditionCode =
  | "administrator"
  | "administrator-probe-failed"
  | "container-runtime-present"
  | "container-runtime-probe-failed"
  | "service-installed"
  | "service-probe-failed";

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
  /** Whether the program is on `PATH`; `undefined` when `where.exe` itself could not run. */
  readonly onPath: (program: string) => boolean | undefined;
  /** Output of `whoami /groups /fo csv`; `undefined` when it could not run. */
  readonly whoamiGroups: () => string | undefined;
  /** Runs `sc.exe` with the arguments; a spawn failure is a `null` status. */
  readonly sc: (args: readonly string[]) => ScResult;
}

/** BUILTIN\Administrators: a member of it is never certified, enabled or deny-only. */
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** Everyone: present in every token, so its absence means the output is not a group list. */
const EVERYONE_SID = "S-1-1-0";
/** Mandatory integrity levels from High (12288) up mean an elevated token. */
const HIGH_INTEGRITY_RID = 12288;
const KEIKO_GATEWAY_SERVICE = "KeikoRuntimeGateway";
const KEIKO_SERVICE_PREFIX = "Keiko";
/** `sc.exe` status for a service that does not exist (ERROR_SERVICE_DOES_NOT_EXIST). */
const SC_SERVICE_DOES_NOT_EXIST = 1060;
const CONTAINER_PIPES = ["\\\\.\\pipe\\docker_engine", "\\\\.\\pipe\\podman-machine-default"];
const CONTAINER_APPLICATION_FOLDERS = [
  "Docker",
  "Podman",
  "RedHat\\Podman",
  "Podman Desktop",
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
 * Signs that a container runtime is installed, conservatively: a client on `PATH`, a configured
 * `DOCKER_HOST` or `CONTAINER_HOST`, an engine named pipe, or the install folder of Docker Desktop,
 * Podman (Desktop) or Rancher Desktop. Presence counts, whether or not the runtime is running.
 */
export function windowsContainerRuntimeFacts(
  seams: WindowsProbeSeams,
): Readonly<Record<string, boolean>> | undefined {
  const clients = ["docker", "podman", "nerdctl", "colima", "limactl"].map((program) =>
    seams.onPath(program),
  );
  if (clients.includes(undefined)) return undefined;
  const [docker, podman, ...others] = clients;
  return {
    dockerOnPath: docker === true,
    podmanOnPath: podman === true,
    otherClientOnPath: others.includes(true),
    dockerHostConfigured:
      (seams.env.DOCKER_HOST ?? "") !== "" || (seams.env.CONTAINER_HOST ?? "") !== "",
    runtimePipePresent: CONTAINER_PIPES.some((pipe) => seams.exists(pipe)),
    applicationPresent: applicationFolders(seams.env).some((folder) => seams.exists(folder)),
  };
}

/** The distinct names that start with the Keiko prefix in an `sc query` listing, in any locale. */
export function keikoServiceNames(listing: string): readonly string[] {
  const names = new Set<string>();
  const pattern = new RegExp(`^[^:\\r\\n]+:\\s*(${KEIKO_SERVICE_PREFIX}[\\w.-]*)\\s*$`, "gimu");
  for (const match of listing.matchAll(pattern)) {
    if (match[1] !== undefined) names.add(match[1].toLowerCase());
  }
  return [...names];
}

function gatewayServiceInstalled(seams: WindowsProbeSeams): boolean | undefined {
  const { status } = seams.sc(["query", KEIKO_GATEWAY_SERVICE]);
  if (status === 0) return true;
  return status === SC_SERVICE_DOES_NOT_EXIST ? false : undefined;
}

/**
 * Whether the gateway service, or any service named with the Keiko prefix, is installed;
 * `undefined` when `sc.exe` could not answer.
 */
export function windowsServiceFacts(seams: WindowsProbeSeams): WindowsServiceFacts | undefined {
  const installed = gatewayServiceInstalled(seams);
  const listing = seams.sc(["query", "type=", "service", "state=", "all"]);
  if (installed === undefined || listing.status !== 0) return undefined;
  const names = new Set(keikoServiceNames(listing.stdout));
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
  const containerRuntime = windowsContainerRuntimeFacts(seams);
  const services = windowsServiceFacts(seams);
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

function systemTool(env: WindowsProbeSeams["env"], tool: string): string {
  return win32.join(env.SystemRoot ?? "C:\\Windows", "System32", tool);
}

/** The seams bound to this machine; only meaningful on Windows. */
export function realWindowsProbeSeams(env: NodeJS.ProcessEnv = process.env): WindowsProbeSeams {
  return {
    env,
    exists: (path) => existsSync(path),
    onPath: (program): boolean | undefined => {
      const result = spawnSync(systemTool(env, "where.exe"), [program], { encoding: "utf8" });
      // `where.exe` answers 1 for a program that is not found; no status at all means it never ran.
      return result.status === null || result.status > 1 ? undefined : result.status === 0;
    },
    whoamiGroups: (): string | undefined => {
      const result = spawnSync(systemTool(env, "whoami.exe"), ["/groups", "/fo", "csv"], {
        encoding: "utf8",
      });
      return result.status === 0 ? result.stdout : undefined;
    },
    sc: (args): ScResult => {
      const result = spawnSync(systemTool(env, "sc.exe"), [...args], { encoding: "utf8" });
      return { status: result.status, stdout: result.stdout };
    },
  };
}
