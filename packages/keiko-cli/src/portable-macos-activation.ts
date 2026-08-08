import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
// GEN-PERF-CLI-001 — server/evidence graphs load at dispatch; module scope stays type-only.
import { loadServer } from "./lazy-modules.js";
import type { PortableLayout, PortableTarget } from "./portable-shared.js";

const MAX_ACTIVATION_OUTPUT_BYTES = 1_024;

/**
 * The launch-time containment decision for a macOS install.
 *
 * - `active`: the runtime supervisor confirmed platform containment.
 * - `waived-unsigned`: the install carries no release signature, so the Endpoint Security
 *   extension can never load — the platform itself, not the artifact, rules containment out.
 *   Launch proceeds without it and says so (ADR-0163 D9).
 * - `unavailable`: a release-signed install could not confirm containment. Launch refuses.
 */
export type MacosRuntimeActivation = "active" | "waived-unsigned" | "unavailable";

export type MacosRuntimeActivationFn = (
  layout: PortableLayout,
  target: PortableTarget,
) => Promise<MacosRuntimeActivation>;

interface ActivationManagerResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface MacosActivationDeps {
  readonly runManager?:
    ((path: string, cwd: string) => Promise<ActivationManagerResult>) | undefined;
  /** Ownership seam for tests; production requires an immutable root-owned app path. */
  readonly verifyImmutableOwnership?: ((appRoot: string, manager: string) => boolean) | undefined;
  /**
   * Signature-anchor seam for tests; production asks the platform verifier. The anchor must stay
   * outside the artifact: a probe that reads any file the install can rewrite would let that file
   * switch off the very activation requirement that detects the rewrite.
   */
  readonly carriesReleaseSignature?:
    ((installRoot: string, target: PortableTarget) => boolean | Promise<boolean>) | undefined;
}

async function platformCarriesReleaseSignature(
  installRoot: string,
  target: PortableTarget,
): Promise<boolean> {
  const { portableInstallCarriesReleaseSignature } = await loadServer();
  return portableInstallCarriesReleaseSignature(installRoot, target);
}

function activationManagerPath(
  layout: PortableLayout,
  verifyImmutableOwnership: (appRoot: string, manager: string) => boolean,
): string {
  const path = join(layout.installRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
  const entry = lstatSync(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    !verifyImmutableOwnership(layout.installRoot, path)
  ) {
    throw new Error("macOS runtime activation manager is invalid");
  }
  return path;
}

function immutableRootOwnedActivationPath(appRoot: string, manager: string): boolean {
  const paths = [
    dirname(appRoot),
    appRoot,
    join(appRoot, "Contents"),
    join(appRoot, "Contents", "MacOS"),
    manager,
  ];
  return paths.every((path, index) => {
    const entry = lstatSync(path);
    const leaf = index === paths.length - 1;
    return (
      !entry.isSymbolicLink() &&
      entry.uid === 0 &&
      (entry.mode & 0o022) === 0 &&
      (leaf ? entry.isFile() && entry.nlink === 1 : entry.isDirectory())
    );
  });
}

function runActivationManager(path: string, cwd: string): Promise<ActivationManagerResult> {
  return new Promise((resolve) => {
    execFile(
      path,
      ["--activate"],
      {
        cwd,
        encoding: "utf8",
        env: {},
        maxBuffer: MAX_ACTIVATION_OUTPUT_BYTES,
        shell: false,
      },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout, stderr });
      },
    );
  });
}

export async function activateMacosPortableRuntime(
  layout: PortableLayout,
  target: PortableTarget,
  deps: MacosActivationDeps = {},
): Promise<MacosRuntimeActivation> {
  const carriesReleaseSignature = deps.carriesReleaseSignature ?? platformCarriesReleaseSignature;
  if (!(await carriesReleaseSignature(layout.installRoot, target))) return "waived-unsigned";
  try {
    const manager = activationManagerPath(
      layout,
      deps.verifyImmutableOwnership ?? immutableRootOwnedActivationPath,
    );
    const result = await (deps.runManager ?? runActivationManager)(manager, layout.installRoot);
    const active = result.ok && result.stdout.trim() === "active" && result.stderr === "";
    return active ? "active" : "unavailable";
  } catch {
    return "unavailable";
  }
}
