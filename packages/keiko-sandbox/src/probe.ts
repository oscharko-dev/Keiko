// Thin EFFECT layer: detect which enforcing backends exist on the host by resolving their binaries on
// PATH. Existence is a first cut; if a selected backend is present but non-functional (e.g. user
// namespaces disabled), the wrapped spawn fails at keiko-tools' exec boundary and that surfaces as a
// fail-closed command error — never a silent unprotected run. Platform-dependent logic is factored
// into pure, parameterised helpers so the selection weight is carried by deterministic unit tests.

import { accessSync, constants, statSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
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
        const candidate = join(dir, binary + ext);
        accessSync(candidate, constants.X_OK);
        if (isTrustedExecutablePath(candidate, platform)) {
          return true;
        }
      } catch {
        // Not in this directory; keep scanning.
      }
    }
  }
  return false;
}

function modeWritableByGroupOrOther(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

function isTrustedExecutablePath(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return true;
  }
  const file = statSync(candidate);
  if (!file.isFile() || modeWritableByGroupOrOther(file.mode)) {
    return false;
  }
  const root = parse(candidate).root;
  let current = dirname(candidate);
  for (;;) {
    const stat = statSync(current);
    if (!stat.isDirectory() || modeWritableByGroupOrOther(stat.mode)) {
      return false;
    }
    if (current === root) {
      return true;
    }
    current = dirname(current);
  }
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
