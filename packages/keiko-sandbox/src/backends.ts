// PURE per-platform wrapper construction. Each builder turns an IsolatedRunPlan into the argv that
// runs the target command under an OS/container egress boundary. No spawning, no filesystem — these
// are deterministic string functions so the security-critical argv is pinned by unit tests.

import { basename, dirname, isAbsolute } from "node:path";
import { isValidNetworkGatewayPolicy } from "@oscharko-dev/keiko-contracts";
import type { IsolatedRunPlan, NetworkGatewayPolicy, SandboxBackend } from "./types.js";

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

function strictBubblewrapArgs(plan: IsolatedRunPlan): readonly string[] {
  // Execution-root mode is for untrusted generated tests. It exposes the disposable root read-write,
  // enough read-only system/toolchain paths to execute Node tooling, and /tmp + /dev + /proc.
  // /tmp is a symlink back into the disposable root so hardcoded temp writes stay contained.
  // It deliberately does not bind /home, /run, /var/run, or the host root as a writable filesystem.
  const commandDir = dirname(plan.command);
  const readonlyBinds = isAbsolute(commandDir)
    ? [...EXECUTION_ROOT_READONLY_BINDS, commandDir]
    : EXECUTION_ROOT_READONLY_BINDS;
  return [
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
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
    EXECUTION_ROOT_TMP,
    "--symlink",
    EXECUTION_ROOT_TMP,
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

function seatbeltArgs(plan: IsolatedRunPlan): readonly string[] {
  return ["-p", SEATBELT_DENY_EGRESS_PROFILE, plan.command, ...plan.args];
}

// The ONE gateway-allowlist Seatbelt profile builder (ADR-0043 D11/D14, #2951): deny all network
// egress and every service/inter-process escape surface by default, then carve out exactly the
// attested loopback family/port. Both the direct `runtime-gateway.ts` API and the generic
// `buildWrappedCommand` planning path call into this single formula — there is no second copy of
// the profile string anywhere in the package.
//
// `process-fork` is deliberately NOT denied (#3390 live run): the pinned OpenCode sidecar shells
// out to `git` for its own session/history endpoints (`POST /sync/history`, `GET /session`), and a
// fork denial made every one of those calls fail with HTTP 500 — a product-breaking regression this
// epic introduced, not a pre-existing posture (the pre-epic dev lane on `dev` ran no Seatbelt
// profile at all). Denying fork does not add egress confinement of its own: on macOS a Seatbelt
// profile is inherited by every descendant process, so a forked `git`/`curl` is still bound by the
// SAME `(deny network*)` plus the single loopback allow-carve-out below. The proof that this
// inheritance actually holds lives in `runtime-gateway.test.ts`'s real OS-level Seatbelt suite.
export function buildGatewaySeatbeltCommand(
  gateway: NetworkGatewayPolicy,
  command: string,
  args: readonly string[],
): WrappedCommand {
  const family = gateway.host === "127.0.0.1" ? "tcp4" : "tcp6";
  const profile =
    "(version 1)(allow default)(deny network*)" +
    "(deny mach-lookup)(deny appleevent-send)(deny lsopen)" +
    `(allow network-outbound (remote ${family} "localhost:${String(gateway.port)}"))` +
    `(allow network-inbound (local ${family} "localhost:*"))`;
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
}

function containerArgs(plan: IsolatedRunPlan, image: string): readonly string[] {
  // --network=none removes all networking. The execution root is bind-mounted read-write and used as
  // the working directory so the wrapped toolchain sees the same paths it would natively. Unlike the
  // native backends (which share the host filesystem and so take an absolute executable path), the
  // container resolves the command from the IMAGE's PATH, so only the bare name is used.
  return [
    "run",
    "--rm",
    "--network=none",
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

// Builds the wrapped command for a backend, or undefined for "none" (no enforcing wrapper).
export function buildWrappedCommand(
  backend: SandboxBackend,
  plan: IsolatedRunPlan,
): WrappedCommand | undefined {
  switch (backend) {
    case "bubblewrap":
      return { command: "bwrap", args: bubblewrapArgs(plan) };
    case "unshare":
      return { command: "unshare", args: unshareArgs(plan) };
    case "seatbelt":
      return isValidNetworkGatewayPolicy(plan.network)
        ? buildGatewaySeatbeltCommand(plan.network, plan.command, plan.args)
        : { command: "sandbox-exec", args: seatbeltArgs(plan) };
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
