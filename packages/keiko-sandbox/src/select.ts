// PURE backend selection for a deny-by-default egress run. Native primitive first (fastest, no
// daemon), then a container runtime as the universal fallback (notably Windows, which has no native
// equivalent). Returns "none" when nothing on the host can enforce egress, so the caller fails closed.

import type { BackendAvailability, SandboxBackend } from "./types.js";

export function selectEnforcingBackend(
  platform: NodeJS.Platform,
  availability: BackendAvailability,
): SandboxBackend {
  if (platform === "linux") {
    if (availability.bubblewrap) {
      return "bubblewrap";
    }
    if (availability.unshare) {
      return "unshare";
    }
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
