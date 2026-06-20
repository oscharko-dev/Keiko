// Thin EFFECT layer: detect which enforcing backends exist on the host by resolving their binaries on
// PATH. Existence is a first cut; if a selected backend is present but non-functional (e.g. user
// namespaces disabled), the wrapped spawn fails at keiko-tools' exec boundary and that surfaces as a
// fail-closed command error — never a silent unprotected run. Platform-dependent logic is factored
// into pure, parameterised helpers so the selection weight is carried by deterministic unit tests.

import { accessSync, constants } from "node:fs";
import { platform as osPlatform } from "node:os";
import { delimiter, join } from "node:path";
import type { BackendAvailability } from "./types.js";

// The executable suffixes to try for a bare binary name. POSIX has none; Windows uses PATHEXT.
export function executableExtensions(
  platform: NodeJS.Platform,
  pathext: string | undefined,
): readonly string[] {
  if (platform !== "win32") {
    return [""];
  }
  return (pathext ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((value) => value.length > 0);
}

// True when `binary` resolves to an executable file in some PATH entry. Pure-ish: reads PATH/PATHEXT
// from the supplied env and probes the filesystem with fs.access.
export function isExecutableOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue = env.PATH ?? "";
  const extensions = executableExtensions(platform, env.PATHEXT);
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      try {
        accessSync(join(dir, binary + ext), constants.X_OK);
        return true;
      } catch {
        // Not in this directory; keep scanning.
      }
    }
  }
  return false;
}

export function probeBackends(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BackendAvailability {
  return {
    bubblewrap: isExecutableOnPath("bwrap", env, platform),
    unshare: isExecutableOnPath("unshare", env, platform),
    seatbelt: isExecutableOnPath("sandbox-exec", env, platform),
    docker: isExecutableOnPath("docker", env, platform),
    podman: isExecutableOnPath("podman", env, platform),
  };
}

export function currentPlatform(): NodeJS.Platform {
  return osPlatform();
}
