import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DebugProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import { isWithinWorkspace, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  buildCopyOnlyProcessEnv,
  resolveExecutableCandidateOutsideWorkspace,
  type IsolatedProcessDirectory as EphemeralHome,
} from "../processHardening.js";
import type { DebugAdapterSpec } from "./providers/dapAdapterProviders.js";

export class DapAdapterPreflightError extends Error {
  public readonly code: Extract<DebugProcessErrorCode, "EXECUTABLE_NOT_FOUND">;
  public constructor() {
    super("EXECUTABLE_NOT_FOUND");
    this.name = "DapAdapterPreflightError";
    this.code = "EXECUTABLE_NOT_FOUND";
  }
}

export type DapEphemeralDirectory = EphemeralHome;
export interface DapAdapterPreflightDeps {
  readonly workspaceRoot: string;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly approvedPath: string;
  readonly createEphemeralHome?: (() => DapEphemeralDirectory) | undefined;
  readonly createEphemeralTemp?: (() => DapEphemeralDirectory) | undefined;
  readonly commandAllowed: (executableName: string, args: readonly string[]) => boolean;
}
export interface DapAdapterPreflight {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly home: DapEphemeralDirectory;
  readonly temp: DapEphemeralDirectory;
  readonly runtimeRoot: string;
}

const CAPSULE_HOME = "/run/keiko-debug/home";
const CAPSULE_TEMP = "/run/keiko-debug/tmp";
const CAPSULE_RUNTIME_PATH = "/opt/keiko-runtime";

function createDebugRuntimeDirectory(): DapEphemeralDirectory & { readonly root: string } {
  // The POSIX socket pathname must remain within the strict 100-byte endpoint ceiling.
  const parent = realpathSync("/tmp");
  const root = realpathSync(mkdtempSync(join(parent, "keiko-debug-root-")));
  chmodSync(root, 0o700);
  const stat = lstatSync(root);
  const qualified =
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o777) === 0o700 &&
    realpathSync(root) === root;
  if (!qualified) {
    rmSync(root, { recursive: true, force: true });
    throw new DapAdapterPreflightError();
  }
  const path = mkdtempSync(join(root, "session-"));
  chmodSync(path, 0o700);
  return {
    root,
    path,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function nestedHome(runtime: DapEphemeralDirectory): DapEphemeralDirectory {
  const path = join(runtime.path, "home");
  mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(runtime.path, "tmp"), { mode: 0o700 });
  return {
    path,
    cleanup: (): void => {
      // The parent runtime resource owns recursive cleanup.
    },
  };
}

function workspace(root: string): WorkspaceInfo {
  return { root } as WorkspaceInfo;
}

function trustedExecutable(
  name: string,
  spec: DebugAdapterSpec,
  deps: DapAdapterPreflightDeps,
): string {
  try {
    const candidate = resolveExecutableCandidateOutsideWorkspace(
      name,
      workspace(deps.workspaceRoot),
      deps.processEnv,
    );
    const trusted = spec.trustedRoots.some((root) => {
      const lexicalRoot = root;
      const realRoot = realpathSync(root);
      return (
        isWithinWorkspace(lexicalRoot, candidate.path) &&
        isWithinWorkspace(realRoot, candidate.real)
      );
    });
    if (!trusted) throw new DapAdapterPreflightError();
    return candidate.real;
  } catch {
    throw new DapAdapterPreflightError();
  }
}

function validateRequiredExecutables(
  spec: DebugAdapterSpec,
  deps: DapAdapterPreflightDeps,
): string {
  const executable = trustedExecutable(spec.executableName, spec, deps);
  for (const name of spec.requiredExecutables) trustedExecutable(name, spec, deps);
  return executable;
}

function copiedEnvironment(
  source: NodeJS.ProcessEnv,
  spec: DebugAdapterSpec,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...buildCopyOnlyProcessEnv(source, spec.envAllowlist),
    ...spec.fixedEnv,
    HOME: CAPSULE_HOME,
    USERPROFILE: CAPSULE_HOME,
    PATH: CAPSULE_RUNTIME_PATH,
    TMPDIR: CAPSULE_TEMP,
    TEMP: CAPSULE_TEMP,
    TMP: CAPSULE_TEMP,
  });
}

export function preflightDapAdapter(
  spec: DebugAdapterSpec,
  deps: DapAdapterPreflightDeps,
): DapAdapterPreflight {
  const args = Object.freeze([...spec.executableArgs]);
  if (!deps.commandAllowed(spec.executableName, args)) throw new DapAdapterPreflightError();
  const executable = validateRequiredExecutables(spec, deps);
  const home = deps.createEphemeralHome?.();
  let temp: DapEphemeralDirectory;
  try {
    const createTemp = deps.createEphemeralTemp ?? createDebugRuntimeDirectory;
    temp = createTemp();
  } catch (error: unknown) {
    home?.cleanup();
    throw error;
  }
  let resolvedHome: DapEphemeralDirectory;
  try {
    resolvedHome = home ?? nestedHome(temp);
  } catch (error: unknown) {
    temp.cleanup();
    throw error;
  }
  const runtimeRoot = dirname(temp.path);
  return {
    executable,
    args,
    env: copiedEnvironment(deps.processEnv, spec),
    home: resolvedHome,
    temp,
    runtimeRoot,
  };
}
