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

// Gateway-allowlist selection (ADR-0043 D14, #2951/#3422) is deliberately its own function. Linux
// gateway runs use the packaged Unix-domain bridge compiled by buildWrappedCommand; containers are
// never substituted because their network namespace has no corresponding bridge. Windows remains
// fail-closed here until its native WFP backend is implemented.
export function selectGatewayBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
): SandboxBackend {
  if (platform === "linux" && availability.bubblewrap) {
    return "bubblewrap";
  }
  if (platform === "linux" && availability.unshare) {
    return "unshare";
  }
  return platform === "darwin" && availability.seatbelt ? "seatbelt" : "none";
}
