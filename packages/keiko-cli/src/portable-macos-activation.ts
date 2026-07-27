import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PortableLayout } from "./portable-shared.js";

const MAX_ACTIVATION_OUTPUT_BYTES = 1_024;

export type MacosRuntimeActivationFn = (layout: PortableLayout) => Promise<boolean>;

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
  deps: MacosActivationDeps = {},
): Promise<boolean> {
  try {
    const manager = activationManagerPath(
      layout,
      deps.verifyImmutableOwnership ?? immutableRootOwnedActivationPath,
    );
    const result = await (deps.runManager ?? runActivationManager)(manager, layout.installRoot);
    return result.ok && result.stdout.trim() === "active" && result.stderr === "";
  } catch {
    return false;
  }
}
