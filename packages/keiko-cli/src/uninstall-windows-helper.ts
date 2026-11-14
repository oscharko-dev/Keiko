import { mkdtempSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  securityErrorKind,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
} from "@oscharko-dev/keiko-security";
import {
  resolveWindowsPowerShellHelper,
  startVisibleWindowsHelper,
  windowsHelperEnv,
  type WindowsHelperSpawn,
  type WindowsHelperSystem,
} from "./windows-helper-start.js";

/**
 * Windows does not let a running program, or a native file it loaded, be removed, so the installed
 * copy's own `keiko uninstall` cannot delete its own runtime (#4358). The command removes
 * everything it can, writes down what is left, ends, and a small PowerShell helper outside the
 * installation, started before the first deletion and waiting for this process to end, removes
 * exactly that list: by path, never recursively, and only under the installation root (plus the
 * explicit registration files and folders, which are named separately).
 */

const HELPER_READY_FILE = "ready";
const HELPER_LIST_FILE = "residue.txt";
const HELPER_READY_TIMEOUT_MS = 10_000;
const HELPER_POLL_MS = 100;
const HELPER_WAIT_FOR_EXIT_MS = 120_000;

export type HelperEntryKind = "file" | "directory" | "external-file" | "external-directory";

export interface HelperEntry {
  readonly kind: HelperEntryKind;
  readonly path: string;
}

const ENTRY_CODE: Readonly<Record<HelperEntryKind, string>> = {
  file: "F",
  directory: "D",
  "external-file": "X",
  "external-directory": "S",
};

// Single quotes only and no line breaks: the text is one plain -Command argument, as the box
// scripts are. F and D entries must lie under the installation root; X and S are the registration
// files and folders the caller names. A file is deleted; a folder is deleted without its content, so
// a folder that still holds something stays.
const PER_ENTRY_STEPS = [
  "if ($line.Length -lt 3 -or $line[1] -ne [char]9) { continue }",
  "$kind = $line.Substring(0, 1)",
  "$path = $line.Substring(2)",
  "if (-not [System.IO.Path]::IsPathRooted($path) -or [System.IO.Path]::GetFullPath($path) -ne $path) { continue }",
  "$inside = $path.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or $path.StartsWith($root + [char]92, [System.StringComparison]::OrdinalIgnoreCase)",
  "if (($kind -eq 'F' -or $kind -eq 'D') -and -not $inside) { continue }",
  "if ($kind -eq 'F' -or $kind -eq 'X') { Invoke-Keiko { [System.IO.File]::Delete($path) } 20 } elseif ($kind -eq 'D' -or $kind -eq 'S') { Invoke-Keiko { [System.IO.Directory]::Delete($path, $false) } 6 }",
];

const HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$dir = $env:KEIKO_UNINSTALL_DIR",
  "$root = [System.IO.Path]::GetFullPath($env:KEIKO_UNINSTALL_ROOT).TrimEnd([char]92)",
  `[System.IO.File]::WriteAllText([System.IO.Path]::Combine($dir, '${HELPER_READY_FILE}'), 'ready')`,
  "try { $owner = [System.Diagnostics.Process]::GetProcessById([int]$env:KEIKO_UNINSTALL_PID) } catch { $owner = $null }",
  `if ($owner -ne $null) { if (-not $owner.WaitForExit(${String(HELPER_WAIT_FOR_EXIT_MS)})) { exit 3 } }`,
  `$list = [System.IO.Path]::Combine($dir, '${HELPER_LIST_FILE}')`,
  "function Invoke-Keiko([scriptblock]$action, [int]$attempts) { for ($i = 0; $i -lt $attempts; $i++) { try { & $action; return } catch { Start-Sleep -Milliseconds 500 } } }",
  `function Remove-KeikoOwn { Invoke-Keiko { [System.IO.File]::Delete($list) } 3; Invoke-Keiko { [System.IO.File]::Delete([System.IO.Path]::Combine($dir, '${HELPER_READY_FILE}')) } 3; Invoke-Keiko { [System.IO.Directory]::Delete($dir, $false) } 3 }`,
  "if (-not [System.IO.File]::Exists($list)) { Remove-KeikoOwn; exit 0 }",
  `foreach ($line in [System.IO.File]::ReadAllLines($list)) { ${PER_ENTRY_STEPS.join("; ")} }`,
  "Remove-KeikoOwn",
  "exit 0",
].join("; ");

/** The helper's exact command text, for its direct tests. */
export const UNINSTALL_HELPER_SCRIPT = HELPER_SCRIPT;

export interface RunningInsideInput {
  readonly installRoot: string;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly argv1: string | undefined;
  readonly cwd: string;
}

// A path that does not exist (yet, or any more) keeps its spelling; one that exists is resolved.
function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : path;
}

function isInsideRoot(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const relative = win32.relative(
      win32.resolve(root).toLowerCase(),
      win32.resolve(candidate).toLowerCase(),
    );
    return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
  }
  const relative = posix.relative(posix.resolve(root), posix.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
}

/**
 * Whether this very process lies inside the installation it is asked to remove: its executable, the
 * script it runs, or its working directory. Only Windows holds such files; the other platforms
 * remove a running program's files, so nothing there is asked to run from outside.
 */
export function runsInsideInstallation(input: RunningInsideInput): boolean {
  if (input.platform !== "win32") return false;
  const root = canonicalPath(input.installRoot);
  return [input.execPath, input.argv1, input.cwd].some(
    (path) => path !== undefined && isInsideRoot(root, canonicalPath(path), "win32"),
  );
}

export type UninstallHelperRefusal =
  "powershell-unavailable" | "temp-inside-installation" | "spawn-failed" | "not-ready";

export interface UninstallHelperHandle {
  /** Commits the list the helper removes once this process has ended. */
  readonly commit: (entries: readonly HelperEntry[]) => void;
}

export type UninstallHelperStart =
  | { readonly kind: "ready"; readonly handle: UninstallHelperHandle }
  | {
      readonly kind: "refused";
      readonly reason: UninstallHelperRefusal;
      /** The closed kind of the error behind the refusal, when there was one. */
      readonly failureKind?: string;
    };

export interface UninstallHelperDeps {
  readonly pid: number;
  readonly spawnFn?: WindowsHelperSpawn | undefined;
  readonly tempParent?: string | undefined;
  readonly readyTimeoutMs?: number | undefined;
  readonly pollMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly identityCheck?: WindowsSystemDirectoryIdentityCheck | undefined;
  readonly existsAsFile?: WindowsBinaryExistsCheck | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function serializeEntries(entries: readonly HelperEntry[]): string {
  const lines = entries.map((entry) => {
    if (/[\r\n\t]/u.test(entry.path)) throw new Error("uninstall helper entry is not a plain path");
    return `${ENTRY_CODE[entry.kind]}\t${entry.path}`;
  });
  return `${lines.join("\n")}\n`;
}

function createHandle(directory: string): UninstallHelperHandle {
  return {
    commit: (entries): void => {
      const temporary = join(directory, `${HELPER_LIST_FILE}.tmp`);
      writeFileSync(temporary, serializeEntries(entries), "utf8");
      renameSync(temporary, join(directory, HELPER_LIST_FILE));
    },
  };
}

// Polls for the helper's ready file, one bounded sleep at a time. Chained, not looped, so no step
// waits inside a loop.
function waitUntilReady(
  directory: string,
  failed: () => boolean,
  deps: UninstallHelperDeps,
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? HELPER_POLL_MS;
  const attempts = Math.max(
    1,
    Math.ceil((deps.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS) / pollMs),
  );
  const check = (attempt: number): Promise<boolean> => {
    if (existsSync(join(directory, HELPER_READY_FILE))) return Promise.resolve(true);
    if (failed() || attempt >= attempts) return Promise.resolve(false);
    return sleep(pollMs).then(() => check(attempt + 1));
  };
  return check(0);
}

function recordRefusal(
  reason: UninstallHelperRefusal,
  directory: string | undefined,
  error?: unknown,
): UninstallHelperStart {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  return error === undefined
    ? { kind: "refused", reason }
    : { kind: "refused", reason, failureKind: securityErrorKind(error) };
}

function helperArguments(): readonly string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-Command",
    HELPER_SCRIPT,
  ];
}

/**
 * Starts the helper and waits until it reports that it runs. Nothing is removed before this
 * returns `ready`: a PowerShell blocked by policy, a spawn that fails and a helper that never
 * reports (the detached start that exited without doing anything) all refuse here, with the
 * installation untouched.
 */
export async function startUninstallHelper(
  installRoot: string,
  env: NodeJS.ProcessEnv,
  deps: UninstallHelperDeps,
): Promise<UninstallHelperStart> {
  let system: WindowsHelperSystem;
  try {
    system = resolveWindowsPowerShellHelper(env, deps.identityCheck, deps.existsAsFile);
  } catch (error) {
    return recordRefusal("powershell-unavailable", undefined, error);
  }
  const directory = mkdtempSync(
    join(canonicalPath(deps.tempParent ?? tmpdir()), "keiko-uninstall-"),
  );
  if (isInsideRoot(canonicalPath(installRoot), directory, "win32")) {
    return recordRefusal("temp-inside-installation", directory);
  }
  const state = { spawnFailed: false };
  try {
    const helperEnv = windowsHelperEnv(env, system, {
      KEIKO_UNINSTALL_DIR: directory,
      KEIKO_UNINSTALL_PID: String(deps.pid),
      KEIKO_UNINSTALL_ROOT: installRoot,
    });
    const child = startVisibleWindowsHelper(
      system.command,
      helperArguments(),
      helperEnv,
      deps.spawnFn,
    );
    child.on("error", () => {
      state.spawnFailed = true;
    });
    child.unref();
  } catch (error) {
    return recordRefusal("spawn-failed", directory, error);
  }
  if (!(await waitUntilReady(directory, () => state.spawnFailed, deps))) {
    return recordRefusal(state.spawnFailed ? "spawn-failed" : "not-ready", directory);
  }
  return { kind: "ready", handle: createHandle(directory) };
}
