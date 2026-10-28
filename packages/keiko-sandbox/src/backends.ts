// PURE per-platform wrapper construction. Each builder turns an IsolatedRunPlan into the argv that
// runs the target command under an OS/container egress boundary. No spawning, no filesystem — these
// are deterministic string functions so the security-critical argv is pinned by unit tests.

import { basename, dirname, isAbsolute, resolve } from "node:path";
import { copyNetworkGatewayPolicy } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { linuxGatewayLauncherPath } from "./runtime.js";
import {
  executionRootSeatbeltProfile,
  gatewayFilesystemSeatbeltRules,
  nativeWorkspaceSeatbeltRules,
  OWN_PROCESS_TARGETS_SEATBELT_RULE,
} from "./seatbelt-execution-root.js";
import type {
  IsolatedRunPlan,
  NetworkGatewayPolicy,
  RuntimeGatewayEgress,
  RuntimeGatewayFilesystem,
  RuntimeGatewayProfile,
  SandboxBackend,
} from "./types.js";

export interface WrappedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

// macOS Seatbelt profile: allow everything by default, but DENY outbound network to remote hosts.
// Loopback and unix sockets stay allowed so a test that binds a local server still runs; a connection
// to a remote IP is denied and fails, satisfying the enforced-egress requirement (ADR-0043).
export const SEATBELT_DENY_EGRESS_PROFILE: string =
  "(version 1)" +
  "(allow default)" +
  "(deny network-outbound)" +
  "(allow network-outbound (remote unix-socket))" +
  '(allow network-outbound (remote ip "localhost:*"))';

// Default OCI image for the container fallback. node is needed to run the unit-test toolchain; a
// pinned, widely cached slim image keeps the fallback deterministic. Egress is removed by
// --network=none regardless of image contents.
export const DEFAULT_CONTAINER_IMAGE = "node:24.18.0-slim";
export const EXECUTION_ROOT_MOUNT = "/keiko-execution-root";
export const EXECUTION_ROOT_TMP = `${EXECUTION_ROOT_MOUNT}/.keiko-sandbox-tmp`;
const EXECUTION_ROOT_READONLY_BINDS: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/opt",
  "/nix/store",
]);

function roBindTryArgs(paths: readonly string[]): readonly string[] {
  return paths.flatMap((path) => ["--ro-bind-try", path, path]);
}

// The child's /tmp inside the mounted execution root. The root is the caller's real directory, so
// whatever the child writes there (npm logs, Node's compile cache) stays behind after the run; a
// caller that owns a per-run directory names it here and removes it once the run settles.
function executionTmpMount(plan: IsolatedRunPlan): string {
  const executionTmp = plan.executionTmp;
  if (executionTmp === undefined) return EXECUTION_ROOT_TMP;
  const name = basename(executionTmp);
  if (
    executionTmp.includes("\0") ||
    dirname(executionTmp) !== plan.cwd ||
    name === "" ||
    name === "." ||
    name === ".."
  ) {
    throw new TypeError("sandbox-execution-tmp-invalid");
  }
  return `${EXECUTION_ROOT_MOUNT}/${name}`;
}

function strictBubblewrapArgs(plan: IsolatedRunPlan): readonly string[] {
  // Execution-root mode is for untrusted generated tests. It exposes the disposable root read-write,
  // enough read-only system/toolchain paths to execute Node tooling, and /tmp + /dev + /proc.
  // Its private PID namespace denies host process access and reaps detached descendants on exit.
  // /tmp is a symlink back into the disposable root so hardcoded temp writes stay contained; a
  // caller's per-run `executionTmp` takes the place of the shared directory.
  // It deliberately does not bind /home, /run, /var/run, or the host root as a writable filesystem.
  const commandDir = dirname(plan.command);
  const tmpMount = executionTmpMount(plan);
  const readonlyBinds = isAbsolute(commandDir)
    ? [...EXECUTION_ROOT_READONLY_BINDS, commandDir]
    : EXECUTION_ROOT_READONLY_BINDS;
  return [
    ...(plan.network === "none" ? ["--unshare-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "USERPROFILE",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    ...roBindTryArgs(readonlyBinds),
    "--dir",
    EXECUTION_ROOT_MOUNT,
    "--bind",
    plan.cwd,
    EXECUTION_ROOT_MOUNT,
    "--dir",
    tmpMount,
    "--symlink",
    tmpMount,
    "/tmp",
    "--chdir",
    EXECUTION_ROOT_MOUNT,
    "--",
    plan.command,
    ...plan.args,
  ];
}

function bubblewrapArgs(plan: IsolatedRunPlan): readonly string[] {
  if (plan.filesystem === "execution-root") {
    return strictBubblewrapArgs(plan);
  }
  // --unshare-net puts the child in a fresh network namespace (loopback-only, no route out).
  // --dev-bind / / keeps the host filesystem usable (FS containment is enforced upstream by the
  // workspace gate + the disposable execution root). --die-with-parent prevents orphaned sandboxes.
  return [
    "--unshare-net",
    "--die-with-parent",
    "--dev-bind",
    "/",
    "/",
    "--chdir",
    plan.cwd,
    "--",
    plan.command,
    ...plan.args,
  ];
}

function unshareArgs(plan: IsolatedRunPlan): readonly string[] {
  // util-linux fallback (preinstalled on Linux CI). --map-root-user lets the unprivileged caller
  // create the namespaces; --net gives an isolated network namespace with no external route.
  return ["--map-root-user", "--net", plan.command, ...plan.args];
}

function buildLinuxGatewayCommand(
  backend: "bubblewrap" | "unshare",
  plan: IsolatedRunPlan,
  gateway: NetworkGatewayPolicy,
): WrappedCommand {
  if (
    !isAbsolute(plan.command) ||
    plan.command.includes("\0") ||
    !isAbsolute(plan.cwd) ||
    plan.cwd.includes("\0") ||
    plan.args.some((argument) => argument.includes("\0"))
  ) {
    throw new TypeError("linux-gateway-launch-input-invalid");
  }
  return {
    command: process.execPath,
    args: [
      linuxGatewayLauncherPath(),
      "host",
      backend,
      gateway.host,
      String(gateway.port),
      plan.cwd,
      plan.command,
      ...plan.args,
    ],
  };
}

function buildBubblewrapCommand(plan: IsolatedRunPlan): WrappedCommand {
  const gateway = copyNetworkGatewayPolicy(plan.network);
  // The native profile is qualified on macOS only (#3897). A bubblewrap mount plan was executed in a
  // Linux container by the PR audit: a shell child still read a workspace `.env`, and a fresh
  // network namespace could not reach the host-loopback Model Gateway. Until a Linux boundary
  // enforces the shared sensitive exclusions and keeps the gateway reachable, a native run is
  // refused here, never launched with a weaker boundary; Linux runs use the mapped profile.
  if (gateway !== undefined && plan.gatewayProfile === "keiko-native")
    throw new TypeError("native-linux-backend-unqualified");
  if (gateway !== undefined) return buildLinuxGatewayCommand("bubblewrap", plan, gateway);
  if (
    plan.network !== "none" &&
    !(plan.network === "inherit" && plan.filesystem === "execution-root")
  ) {
    throw new TypeError("sandbox-network-policy-invalid");
  }
  return { command: "bwrap", args: bubblewrapArgs(plan) };
}

function buildUnshareCommand(plan: IsolatedRunPlan): WrappedCommand {
  const gateway = copyNetworkGatewayPolicy(plan.network);
  // `unshare` cannot mount a filesystem allowlist: it would launch the native runtime with the
  // host mounts. An unqualified native backend is refused, never launched unconfined (#3897).
  if (gateway !== undefined && plan.gatewayProfile === "keiko-native")
    throw new TypeError("native-linux-backend-unqualified");
  if (gateway !== undefined) return buildLinuxGatewayCommand("unshare", plan, gateway);
  if (plan.network !== "none") throw new TypeError("sandbox-network-policy-invalid");
  return { command: "unshare", args: unshareArgs(plan) };
}

function seatbeltArgs(plan: IsolatedRunPlan): readonly string[] {
  const profile =
    plan.filesystem === "execution-root"
      ? executionRootSeatbeltProfile(plan, [
          "/bin",
          "/usr/bin",
          "/usr/lib",
          dirname(process.execPath),
          resolve(dirname(process.execPath), "../lib"),
        ])
      : SEATBELT_DENY_EGRESS_PROFILE;
  return ["-p", profile, plan.command, ...plan.args];
}

function gatewayProcessExecPolicy(command: string, childExecutable: string): string {
  if (
    !isAbsolute(command) ||
    command.includes("\0") ||
    !isAbsolute(childExecutable) ||
    childExecutable.includes("\0")
  ) {
    throw new TypeError("gateway-seatbelt-command-not-absolute");
  }
  const executables = new Set([command, childExecutable]);
  const literals = [...executables].map((path) => `(literal ${JSON.stringify(path)})`).join(" ");
  return `(deny process-exec)(allow process-exec ${literals})`;
}

// The ONE gateway-allowlist Seatbelt profile builder (ADR-0043 D11/D14, #2951): deny all network
// egress and every service/inter-process escape surface by default, then carve out exactly the
// attested loopback family/port. Both the direct `runtime-gateway.ts` API and the generic
// `buildWrappedCommand` planning path call into this single formula — there is no second copy of
// the profile string anywhere in the package.
//
// `process-fork` remains available because the pinned OpenCode sidecar forks Git during its
// session/history handshake (#3390). Executable transitions are independently deny-by-default:
// only the verified runtime executable and the one separately attested Git implementation may
// execute. Descendants inherit both this executable allowlist and the network restriction.
export function buildGatewaySeatbeltCommand(
  gateway: NetworkGatewayPolicy,
  command: string,
  args: readonly string[],
  childExecutable: string,
  filesystem?: RuntimeGatewayFilesystem,
  gatewayProfile: RuntimeGatewayProfile = "keiko-gateway",
  egress: RuntimeGatewayEgress = "loopback-only",
): WrappedCommand {
  const closedGateway = copyNetworkGatewayPolicy(gateway);
  if (closedGateway === undefined) throw new TypeError("gateway-network-policy-invalid");
  if (gatewayProfile === "keiko-native") {
    return buildNativeSeatbeltCommand(command, args, filesystem, egress);
  }
  const family = closedGateway.host === "127.0.0.1" ? "tcp4" : "tcp6";
  const profile =
    "(version 1)(allow default)(deny network*)" +
    gatewayProcessExecPolicy(command, childExecutable) +
    "(deny mach-lookup)(deny appleevent-send)(deny lsopen)" +
    // Same process authority as every other Keiko Seatbelt profile: own tree only (#3897 review).
    OWN_PROCESS_TARGETS_SEATBELT_RULE +
    (filesystem === undefined ? "" : gatewayFilesystemSeatbeltRules(filesystem, childExecutable)) +
    `(allow network-outbound (remote ${family} "localhost:${String(closedGateway.port)}"))` +
    `(allow network-inbound (local ${family} "localhost:*"))`;
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
}

// Below Full access the native process tree reaches loopback only (#3897): the attested Model
// Gateway and tool facade are loopback, and so are the dev servers a test starts. Every other
// destination, unix-socket peer included (ssh-agent, container daemons, the resolver), is denied
// by the kernel before any traffic. `inherited` (Full access) adds no network rule at all.
const NATIVE_LOOPBACK_ONLY_NETWORK_RULES =
  "(deny network*)" +
  '(allow network-outbound (remote ip "localhost:*"))' +
  '(allow network-inbound (local ip "localhost:*"))' +
  '(allow network-bind (local ip "localhost:*"))';

/**
 * The native profile (#3897): the agent runs its own shell and toolchains like standalone
 * OpenCode. What the kernel enforces for the whole process tree is the filesystem boundary (a read
 * allowlist of the workspace, the private state, the system and toolchain roots; writes only inside
 * the workspace and the private state, whose `tmp` is the runtime's TMPDIR; credential stores,
 * credential files and Keiko's state unreadable), the service escape surfaces and the process
 * boundary (signals and process information reach the tree's own sandbox only, never another
 * process of the same OS user). Network follows the run's mode: loopback only below Full access;
 * inherited at Full access, where the per-action permission policy and the accepted Authority
 * Envelope bound it.
 */
function buildNativeSeatbeltCommand(
  command: string,
  args: readonly string[],
  filesystem: RuntimeGatewayFilesystem | undefined,
  egress: RuntimeGatewayEgress,
): WrappedCommand {
  if (!isAbsolute(command) || command.includes("\0"))
    throw new TypeError("gateway-seatbelt-command-not-absolute");
  if (filesystem === undefined) throw new TypeError("native-seatbelt-filesystem-invalid");
  const profile =
    "(version 1)(allow default)(deny appleevent-send)(deny lsopen)" +
    OWN_PROCESS_TARGETS_SEATBELT_RULE +
    nativeWorkspaceSeatbeltRules(filesystem) +
    (egress === "inherited" ? "" : NATIVE_LOOPBACK_ONLY_NETWORK_RULES);
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
}

function buildSeatbeltCommand(plan: IsolatedRunPlan): WrappedCommand {
  const gateway = copyNetworkGatewayPolicy(plan.network);
  if (gateway !== undefined) {
    return buildGatewaySeatbeltCommand(
      gateway,
      plan.command,
      plan.args,
      plan.gatewayChildExecutable ?? "",
      plan.gatewayFilesystem,
      plan.gatewayProfile,
      plan.gatewayEgress,
    );
  }
  if (
    plan.network !== "none" &&
    !(plan.network === "inherit" && plan.filesystem === "execution-root")
  ) {
    throw new TypeError("sandbox-network-policy-invalid");
  }
  return { command: "sandbox-exec", args: seatbeltArgs(plan) };
}

function containerArgs(plan: IsolatedRunPlan, image: string): readonly string[] {
  // --network=none removes all networking. The execution root is bind-mounted read-write and used as
  // the working directory so the wrapped toolchain sees the same paths it would natively. Unlike the
  // native backends (which share the host filesystem and so take an absolute executable path), the
  // container resolves the command from the IMAGE's PATH, so only the bare name is used.
  return [
    "run",
    "--rm",
    ...(plan.network === "none" ? ["--network=none"] : []),
    ...(plan.filesystem === "execution-root"
      ? ["--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m"]
      : []),
    "--volume",
    `${plan.cwd}:${plan.cwd}:rw`,
    "--workdir",
    plan.cwd,
    image,
    basename(plan.command),
    ...plan.args,
  ];
}

function unsupportedBackend(backend: never): never {
  throw new Error(`Unsupported sandbox backend: ${String(backend)}`);
}

function assertCompatibleFilesystem(backend: SandboxBackend, plan: IsolatedRunPlan): void {
  if (
    plan.filesystem === "execution-root" &&
    (backend === "unshare" || copyNetworkGatewayPolicy(plan.network) !== undefined)
  ) {
    throw new TypeError("sandbox-filesystem-policy-unsupported");
  }
}

// Builds the wrapped command for a backend, or undefined for "none" (no enforcing wrapper).
export function buildWrappedCommand(
  backend: SandboxBackend,
  plan: IsolatedRunPlan,
): WrappedCommand | undefined {
  assertCompatibleFilesystem(backend, plan);
  switch (backend) {
    case "bubblewrap":
      return buildBubblewrapCommand(plan);
    case "unshare":
      return buildUnshareCommand(plan);
    case "seatbelt":
      return buildSeatbeltCommand(plan);
    case "container-docker":
      return { command: "docker", args: containerArgs(plan, DEFAULT_CONTAINER_IMAGE) };
    case "container-podman":
      return { command: "podman", args: containerArgs(plan, DEFAULT_CONTAINER_IMAGE) };
    case "none":
      return undefined;
    default:
      return unsupportedBackend(backend);
  }
}
