// PURE backend selection for a deny-by-default egress run. Native primitive first (fastest, no
// daemon), then a container runtime as the universal fallback (notably Windows, which has no native
// equivalent). Returns "none" when nothing on the host can enforce egress, so the caller fails closed.

import type { BackendAvailability, FilesystemPolicy, SandboxBackend } from "./types.js";

function selectExecutionRootBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
): SandboxBackend {
  if (platform === "linux" && availability.bubblewrap) {
    return "bubblewrap";
  }
  if (availability.docker) {
    return "container-docker";
  }
  if (availability.podman) {
    return "container-podman";
  }
  return "none";
}

function selectNetworkOnlyBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
): SandboxBackend {
  if (platform === "linux" && availability.bubblewrap) {
    return "bubblewrap";
  }
  if (platform === "linux" && availability.unshare) {
    return "unshare";
  }
  if (platform === "darwin" && availability.seatbelt) {
    return "seatbelt";
  }
  if (availability.docker) {
    return "container-docker";
  }
  if (availability.podman) {
    return "container-podman";
  }
  return "none";
}

export function selectEnforcingBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
  filesystem: FilesystemPolicy = "inherit",
): SandboxBackend {
  if (filesystem === "execution-root") {
    return selectExecutionRootBackend(platform, availability);
  }
  return selectNetworkOnlyBackend(platform, availability);
}

// Gateway-allowlist selection (ADR-0043 D14, #2951) is deliberately its own function, not a branch
// of selectNetworkOnlyBackend: a bubblewrap/unshare Linux network namespace and a container's
// `--network=none`/bridge namespace both isolate the child from the HOST's loopback socket, so they
// cannot reach the attested gateway port without additional bridging this host does not provide —
// picking one of them here would be the "weaker fallback" the acceptance criteria forbid. Only
// macOS Seatbelt can bind a child to exactly one loopback destination today; every other platform
// (including Windows, which has no entry in `BackendAvailability` at all) returns "none" so the
// caller fails the run closed instead of running it unconfined or under the wrong isolation.
export function selectGatewayBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
): SandboxBackend {
  return platform === "darwin" && availability.seatbelt ? "seatbelt" : "none";
}
