import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isProcessAlive as defaultIsProcessAlive } from "@oscharko-dev/keiko-security/process-scope";
import { join, posix, win32 } from "node:path";
import {
  securityErrorKind,
  type WindowsBinaryExistsCheck,
  type WindowsSystemDirectoryIdentityCheck,
} from "@oscharko-dev/keiko-security";
import {
  resolveWindowsPowerShellHelper,
  startOutlivingWindowsHelper,
  type WindowsHelperChild,
  type WindowsHelperSpawn,
  type WindowsHelperSystem,
} from "./windows-helper-start.js";

/**
 * Windows does not let a running program, or a native file it loaded, be removed, so the installed
 * copy's own `keiko uninstall` cannot delete its own runtime (#4358). The command removes
 * everything it can, writes down what is left, ends, and a small PowerShell helper outside the
 * installation, started before the first deletion, removes exactly that list once this process has
 * ended: by path, never recursively, under the installation root, plus the registration files and
 * folders named exactly at start.
 */

const HELPER_READY_FILE = "ready";
const HELPER_LIST_FILE = "residue.txt";
const HELPER_REFUSED_FILE = "refused";
// Before any deletion, so a long bound costs nothing when the helper is quick. Measured on Windows
// PowerShell 5.1: four to five seconds unloaded, 19 s for one start and up to 58 s for the two stages
// beside other work, so the bound is two minutes; after a few seconds the person is told what the
// command is waiting for, so a long wait is not silence.
const HELPER_READY_TIMEOUT_MS = 120_000;
const HELPER_NOTICE_AFTER_MS = 3000;
const HELPER_POLL_MS = 100;
// How long the helper waits for the committed list, and then for this process to end. The first is
// generous: this process removes thousands of files first. The second is short: the list is
// committed just before this process ends.
const HELPER_WAIT_FOR_LIST_S = 1800;
const HELPER_WAIT_FOR_OWNER_MS = 60_000;

export type HelperEntryKind =
  "file" | "identity-file" | "directory" | "external-file" | "external-directory";

export interface HelperEntry {
  readonly kind: HelperEntryKind;
  readonly path: string;
}

const ENTRY_CODE: Readonly<Record<HelperEntryKind, string>> = {
  file: "F",
  "identity-file": "I",
  directory: "D",
  "external-file": "X",
  "external-directory": "S",
};

const OIC = "[System.StringComparison]::OrdinalIgnoreCase";

// Single quotes only and no line breaks: the text is one plain -Command argument, as the box
// scripts are. The helper acts in three phases and in this order: it waits for the committed list
// (it ends, deleting nothing, when this process ends without one), then for this process to end (a
// bounded wait; after it nothing is deleted), and only then deletes. An F or D entry must lie under
// the installation root; an X or S entry must be one of the exact paths named at start. A file is
// deleted; a folder is deleted without its content, so a folder that still holds something stays.
// An entry that is a link, is of the wrong kind or cannot be deleted marks the run as failed, and a
// failed run leaves every I (identity file: the record, the package, the launcher and the setup
// manifest, which a later run needs to find the installation), X and S entry, so the installation
// stays registered and resumable until its last file is gone.
const ENTRY_STEPS = [
  "if ($line.Length -eq 0) { continue }",
  "if ($line.Length -lt 3 -or $line[1] -ne [char]9) { $failed = $true; continue }",
  "$kind = $line.Substring(0, 1)",
  "$path = $line.Substring(2)",
  "if ($kind -eq 'I' -and $failed) { continue }",
  // GetFullPath throws for a path over 260 characters on Windows PowerShell 5.1: that is a failed
  // entry, never an end of the script that skips its cleanup.
  "$full = $null",
  "try { $full = [System.IO.Path]::GetFullPath($path) } catch { $full = $null }",
  "if (-not [System.IO.Path]::IsPathRooted($path) -or $full -ne $path) { $failed = $true; continue }",
  `if ($kind -eq 'X' -or $kind -eq 'S') { $known = $false; foreach ($e in $externals) { if ($path.Equals($e, ${OIC})) { $known = $true } }; if (-not $known) { $failed = $true; continue }; if ($failed) { continue } } else { if (-not (($path + $sep).Equals($prefix, ${OIC}) -or $path.StartsWith($prefix, ${OIC}))) { $failed = $true; continue } }`,
  "$isFile = [System.IO.File]::Exists($path)",
  "$isDir = [System.IO.Directory]::Exists($path)",
  "if (-not $isFile -and -not $isDir) { continue }",
  "if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $failed = $true; continue }",
  "if ($kind -eq 'F' -or $kind -eq 'I' -or $kind -eq 'X') { if (-not $isFile) { $failed = $true; continue }; $ok = Invoke-Keiko { [System.IO.File]::Delete($path) } 20 } elseif ($kind -eq 'D' -or $kind -eq 'S') { if (-not $isDir) { $failed = $true; continue }; $ok = Invoke-Keiko { [System.IO.Directory]::Delete($path, $false) } 6 } else { $failed = $true; continue }",
  "if (-not $ok -and $kind -ne 'S') { $failed = $true }",
];

const HELPER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sep = [string][System.IO.Path]::DirectorySeparatorChar",
  "$dir = $env:KEIKO_UNINSTALL_DIR",
  `$ready = [System.IO.Path]::Combine($dir, '${HELPER_READY_FILE}')`,
  `$list = [System.IO.Path]::Combine($dir, '${HELPER_LIST_FILE}')`,
  `$refused = [System.IO.Path]::Combine($dir, '${HELPER_REFUSED_FILE}')`,
  // The deletion boundary and the registration paths are checked before the helper reports ready; any
  // doubt ends it with a `refused` file and no deletion. The root must be an absolute path that
  // equals its own full path (a relative one would resolve against the helper's working directory)
  // and longer than a drive root. The registration paths arrive as one string split at `|`, a
  // character no Windows path holds: a flat string array on every PowerShell version
  // (ConvertFrom-Json does not enumerate a JSON array the same way in Windows PowerShell 5.1 and 7),
  // and exactly the expected number of rooted paths.
  "$sound = $true",
  "$externals = @()",
  "try { $root = [System.IO.Path]::GetFullPath($env:KEIKO_UNINSTALL_ROOT); if (-not [System.IO.Path]::IsPathRooted($env:KEIKO_UNINSTALL_ROOT) -or $root -ne $env:KEIKO_UNINSTALL_ROOT -or $root.Length -le 3) { $sound = $false }; $externals = $env:KEIKO_UNINSTALL_EXTERNALS.Split([char]124); $expected = [int]$env:KEIKO_UNINSTALL_EXTERNALS_COUNT; if ($expected -lt 1 -or $externals.Length -ne $expected) { $sound = $false }; foreach ($x in $externals) { if ($x.Length -lt 3 -or -not [System.IO.Path]::IsPathRooted($x)) { $sound = $false } } } catch { $sound = $false }",
  "if (-not $sound) { [System.IO.File]::WriteAllText($refused, 'refused'); exit 2 }",
  "$prefix = if ($root.EndsWith($sep)) { $root } else { $root + $sep }",
  "[System.IO.File]::WriteAllText($ready, [string][System.Diagnostics.Process]::GetCurrentProcess().Id + [char]10)",
  // A process id that has been reused since this command started names a younger process: it is not
  // the one to wait for, and the committed-list wait ends with the list or with its bound.
  "try { $owner = [System.Diagnostics.Process]::GetProcessById([int]$env:KEIKO_UNINSTALL_PID); if ($owner.StartTime -gt [System.Diagnostics.Process]::GetCurrentProcess().StartTime) { $owner = $null } } catch { $owner = $null }",
  "function Invoke-Keiko([scriptblock]$action, [int]$attempts) { for ($i = 0; $i -lt $attempts; $i++) { try { & $action | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 } }; return $false }",
  "function Remove-KeikoOwn { foreach ($f in @($list, ($list + '.tmp'), $ready)) { [void](Invoke-Keiko { [System.IO.File]::Delete($f) } 3) }; [void](Invoke-Keiko { [System.IO.Directory]::Delete($dir, $false) } 3) }",
  `$until = [DateTime]::UtcNow.AddSeconds(${String(HELPER_WAIT_FOR_LIST_S)})`,
  `while (-not [System.IO.File]::Exists($list)) { if ($owner -eq $null -or $owner.HasExited) { if ([System.IO.File]::Exists($list)) { break }; Remove-KeikoOwn; exit 0 }; if ([DateTime]::UtcNow -gt $until) { Remove-KeikoOwn; exit 3 }; Start-Sleep -Milliseconds 200 }`,
  `if ($owner -ne $null) { if (-not $owner.WaitForExit(${String(HELPER_WAIT_FOR_OWNER_MS)})) { Remove-KeikoOwn; exit 3 } }`,
  "$failed = $false",
  `try { foreach ($line in [System.IO.File]::ReadAllLines($list)) { ${ENTRY_STEPS.join("; ")} } } catch { $failed = $true }`,
  "Remove-KeikoOwn",
  "if ($failed) { exit 1 } else { exit 0 }",
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
  /**
   * Commits the list the helper removes once this process has ended. When the helper has already
   * ended, nothing is committed and the answer is `helper-gone`: the caller must not claim a
   * hand-off, and keeps the installation registered.
   */
  readonly commit: (entries: readonly HelperEntry[]) => "committed" | "helper-gone";
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
  /** Called once when the helper has not reported after a few seconds. */
  readonly onPreparing?: (() => void) | undefined;
  /** Whether a process id names a running process; the platform probe unless a test names one. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function serializeEntries(entries: readonly HelperEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    if (/[\r\n\t]/u.test(entry.path)) throw new Error("uninstall helper entry is not a plain path");
    return `${ENTRY_CODE[entry.kind]}\t${entry.path}`;
  });
  return `${lines.join("\n")}\n`;
}

function createHandle(
  directory: string,
  externals: readonly string[],
  helperEnded: () => boolean,
): UninstallHelperHandle {
  return {
    commit: (entries): "committed" | "helper-gone" => {
      for (const entry of entries) {
        const external = entry.kind === "external-file" || entry.kind === "external-directory";
        if (external && !externals.includes(entry.path)) {
          throw new Error("uninstall helper entry was not named at start");
        }
      }
      if (helperEnded()) return "helper-gone";
      const temporary = join(directory, `${HELPER_LIST_FILE}.tmp`);
      writeFileSync(temporary, serializeEntries(entries), "utf8");
      renameSync(temporary, join(directory, HELPER_LIST_FILE));
      return "committed";
    },
  };
}

// What the real helper reported: its process id (the ready file holds nothing else), a refusal of its
// own start check, or nothing yet. A ready file that is empty, not yet complete (the id ends with a
// line break, so a partial write is recognisable) or being written is "not yet", never a refusal: only
// the helper's own `refused` file and a failing first stage refuse at once.
type HelperReport = number | "refused" | undefined;

interface ReportState {
  /** The last error met while reading the ready file; evidence if the wait ends without a report. */
  lastReadError?: unknown;
}

function recordReadFailure(state: ReportState, error: unknown): HelperReport {
  state.lastReadError = error;
  return undefined;
}

function readReport(directory: string, state: ReportState): HelperReport {
  if (existsSync(join(directory, HELPER_REFUSED_FILE))) return "refused";
  const readyPath = join(directory, HELPER_READY_FILE);
  if (!existsSync(readyPath)) return undefined;
  let text: string;
  try {
    text = readFileSync(readyPath, "utf8");
  } catch (error) {
    // The helper may hold the file while it writes (EBUSY, EPERM on Windows): not yet.
    return recordReadFailure(state, error);
  }
  if (!text.endsWith("\n")) return undefined;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Polls for the real helper's report, one bounded sleep at a time. Chained, not looped, so no step
// waits inside a loop.
function waitForReport(
  directory: string,
  failed: () => boolean,
  deps: UninstallHelperDeps,
  state: ReportState,
): Promise<HelperReport> {
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? HELPER_POLL_MS;
  const attempts = Math.max(
    1,
    Math.ceil((deps.readyTimeoutMs ?? HELPER_READY_TIMEOUT_MS) / pollMs),
  );
  let noticed = false;
  const check = (attempt: number): Promise<HelperReport> => {
    const report = readReport(directory, state);
    if (report !== undefined) return Promise.resolve(report);
    if (!noticed && attempt * pollMs >= HELPER_NOTICE_AFTER_MS) {
      noticed = true;
      deps.onPreparing?.();
    }
    if (failed() || attempt >= attempts) return Promise.resolve(undefined);
    return sleep(pollMs).then(() => check(attempt + 1));
  };
  return check(0);
}

// The first stage ends quickly and on purpose; only a failing exit code says it did not start the
// real helper.
function firstStageFailed(child: WindowsHelperChild | undefined): boolean {
  const code = child?.exitCode;
  return code !== undefined && code !== null && code !== 0;
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

interface FirstStageInputs {
  readonly directory: string;
  readonly installRoot: string;
  readonly externals: readonly string[];
}

// Starts the first stage, which starts the real helper; it is not waited for.
function launchFirstStage(
  system: WindowsHelperSystem,
  env: NodeJS.ProcessEnv,
  inputs: FirstStageInputs,
  deps: UninstallHelperDeps,
  onError: () => void,
): WindowsHelperChild {
  const child = startOutlivingWindowsHelper(
    {
      system,
      env,
      script: HELPER_SCRIPT,
      extraEnv: {
        KEIKO_UNINSTALL_DIR: inputs.directory,
        KEIKO_UNINSTALL_PID: String(deps.pid),
        KEIKO_UNINSTALL_ROOT: inputs.installRoot,
        KEIKO_UNINSTALL_EXTERNALS: inputs.externals.join("|"),
        KEIKO_UNINSTALL_EXTERNALS_COUNT: String(inputs.externals.length),
      },
    },
    deps.spawnFn,
  );
  child.on("error", onError);
  child.unref();
  return child;
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
  externals: readonly string[],
): Promise<UninstallHelperStart> {
  if (externals.some((path) => path.includes("|"))) {
    throw new Error("uninstall helper external path is not a plain path");
  }
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
  const state: { spawnFailed: boolean; child?: WindowsHelperChild } = { spawnFailed: false };
  try {
    state.child = launchFirstStage(system, env, { directory, installRoot, externals }, deps, () => {
      state.spawnFailed = true;
    });
  } catch (error) {
    return recordRefusal("spawn-failed", directory, error);
  }
  const failed = (): boolean => state.spawnFailed || firstStageFailed(state.child);
  const reportState: ReportState = {};
  const report = await waitForReport(directory, failed, deps, reportState);
  if (typeof report !== "number") {
    return recordRefusal(
      failed() ? "spawn-failed" : "not-ready",
      directory,
      reportState.lastReadError,
    );
  }
  // The real helper's own process id: it is what must be alive when the list is committed. The first
  // stage has ended long before, and its end says nothing about the helper.
  const alive = deps.isProcessAlive ?? defaultIsProcessAlive;
  return { kind: "ready", handle: createHandle(directory, externals, () => !alive(report)) };
}
