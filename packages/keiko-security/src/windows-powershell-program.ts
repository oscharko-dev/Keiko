// Shared scaffolding for the fixed inbox-PowerShell programs Keiko runs to read Windows facts that
// Node cannot reach (windows-local-volume.ts, windows-owner-private.ts). Each program stays a fixed
// literal that receives its inputs on standard input; only this scaffolding is shared, so the
// P/Invoke declaration style, the trusted environment, the time bounds and the output decoding
// cannot drift apart.
//
// TWO BOUNDS, NOT ONE (#4358). A program used to run under one limit that covered both the inbox
// PowerShell host coming up and the program's own work. The host start is the larger and the less
// predictable part: 0.2 to 2 s on a native x64 host, 6.5 to 20 s measured under x64 emulation on
// Windows on ARM, and it carries nothing of the question the program answers. A limit sized for
// the work therefore refused a correct local disk whenever the host was slow. The two are now
// bounded where they happen:
//   - the WORK keeps the caller's limit, counted from the program's first statement and enforced
//     inside the program by a watchdog that ends the process (`boundedPowerShellProgram`). A stalled
//     volume or file query is cut off exactly as early as before;
//   - the HOST START has its own allowance (`WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS`), which only
//     bounds a host that never reaches the program.
// The verdict stays fail closed in both cases, and the two are told apart in the evidence.
import { win32 as win32Path } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, type SecurityLogSink } from "./log-port.js";

const ASSEMBLY_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

/**
 * PowerShell source that defines `$type` and a `pinvoke($name, $returnType, $parameters)` helper
 * declaring kernel32 functions in one dynamic assembly. The caller declares its functions, then
 * calls `$type.CreateType()`. The name is a fixed identifier, never caller data.
 */
export function kernel32PInvokePrelude(assemblyName: string): string {
  if (!ASSEMBLY_NAME.test(assemblyName)) throw new TypeError("assembly name must be an identifier");
  return `  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('${assemblyName}'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('${assemblyName}')
  $type = $module.DefineType('${assemblyName}Api', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  function pinvoke($name, $returnType, $parameters) {
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name, $attributes, [Reflection.CallingConventions]::Standard, $returnType, [type[]]$parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    return $method
  }
`;
}

/** `-EncodedCommand` form of a fixed program: Base64 of its UTF-16LE text. */
export function encodePowerShellProgram(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

/**
 * The only environment a program receives, derived from the identity-validated
 * `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`.
 */
export function trustedPowerShellEnvironment(executable: string): NodeJS.ProcessEnv {
  const root = win32Path.dirname(
    win32Path.dirname(win32Path.dirname(win32Path.dirname(executable))),
  );
  return { SystemRoot: root, WINDIR: root, SystemDrive: root.slice(0, 2) };
}

/** A runner's stdout/stderr as text, whether it returned a string, a Buffer or nothing. */
export function commandOutputText(value: string | Buffer | null): string {
  if (value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

/**
 * How long the inbox PowerShell host may take to reach a program's first statement. Three times
 * the slowest start measured (20 s, x64 emulation on Windows on ARM); a native host needs a small
 * fraction of it. It bounds host start only, never the work of a program.
 */
export const WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS = 60_000;
const MAX_WORK_TIMEOUT_MS = 600_000;
/** First line every bounded program writes; a run without it never executed the program. */
export const WINDOWS_PROGRAM_STARTED_MARKER = "KEIKO_PROGRAM_STARTED";
// `Process.Kill()` ends the process with exit code -1.
const WATCHDOG_EXIT_STATUS = 0xffffffff;
/** Programs at or above this total duration are recorded, so a slow host is visible in the log. */
export const WINDOWS_PROGRAM_SLOW_MS = 2_000;

export type WindowsProgramName = "local-volume" | "owner-private" | "process-identity";

export type WindowsProgramRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly input: string;
    readonly shell: false;
    readonly timeout: number;
    readonly windowsHide: true;
  },
) => {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stdout: string | Buffer | null;
  readonly stderr: string | Buffer | null;
};

const SECURITY_WINDOWS_PROGRAM_RUN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-program.run",
  category: "diagnostic",
  owner: "keiko-security",
  emitter: "windows-powershell-program.emitProgramRun",
  fields: {
    program: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["local-volume", "owner-private", "process-identity"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "host-start-timeout", "work-timeout", "unavailable"],
    },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["windows-program-latency"],
  proofIds: ["security.windows-program.run.outcome"],
  releaseImpact: "patch",
});

/** The inbox PowerShell host did not reach the program within its start allowance. */
export class WindowsProgramHostStartError extends Error {
  public override readonly name = "WindowsProgramHostStartError";
  public readonly code = "host-start-timeout";
  public constructor() {
    super("Windows PowerShell did not start in time");
  }
}

/** The program started and its own work exceeded the caller's limit. */
export class WindowsProgramWorkTimeoutError extends Error {
  public override readonly name = "WindowsProgramWorkTimeoutError";
  public readonly code = "work-timeout";
  public constructor() {
    super("Windows PowerShell program exceeded its time limit");
  }
}

/**
 * A fixed program with its two framing statements: a start marker, then the watchdog that ends
 * the process `workTimeoutMs` after that marker. The watchdog is a plain .NET delegate on the
 * process's own `Kill`, so it fires on a thread-pool thread even while the program is blocked in a
 * system call. `workTimeoutMs` is a number Keiko chose, never caller data.
 */
export function boundedPowerShellProgram(
  source: string,
  workTimeoutMs: number,
  preparation?: string,
): string {
  if (!Number.isSafeInteger(workTimeoutMs) || workTimeoutMs < 1) {
    throw new TypeError("work timeout must be a positive integer");
  }
  if (workTimeoutMs > MAX_WORK_TIMEOUT_MS) throw new TypeError("work timeout is too large");
  // Host preparation (loading a module the program needs) runs BEFORE the start marker: it is part
  // of the host coming up and is bounded by the host start allowance, not by the work limit. It is
  // a fixed statement Keiko chose, never caller data, and it receives no input.
  const prepared = preparation === undefined ? "" : `${preparation}\n`;
  return `${prepared}[Console]::Out.Write('${WINDOWS_PROGRAM_STARTED_MARKER}' + [char]10); [Console]::Out.Flush()
$keikoWatchdog = [Threading.CancellationTokenSource]::new(${String(workTimeoutMs)})
$null = $keikoWatchdog.Token.Register([Action][Delegate]::CreateDelegate([Action], [Diagnostics.Process]::GetCurrentProcess(), 'Kill'))
${source}`;
}

/** The outer limit a bounded program runs under: host start allowance plus its own work limit. */
export function boundedPowerShellTimeoutMs(workTimeoutMs: number): number {
  return WINDOWS_POWERSHELL_HOST_START_TIMEOUT_MS + workTimeoutMs;
}

export interface BoundedPowerShellRun {
  readonly program: WindowsProgramName;
  readonly executable: string;
  /** The fixed program text, without the framing `boundedPowerShellProgram` adds. */
  readonly source: string;
  /**
   * A fixed statement that prepares the host for the program (for example loading a module) and
   * runs before the start marker, under the host start allowance. It must not read the input.
   */
  readonly preparation?: string | undefined;
  readonly input: string;
  readonly workTimeoutMs: number;
  /** Bound on the program's own output; the start marker is accounted for separately. */
  readonly maxOutputBytes: number;
  readonly runner: WindowsProgramRunner;
  readonly securityLogSink?: SecurityLogSink | undefined;
  /** Hermetic clock seam for the recorded duration; production callers pass none. */
  readonly now?: (() => number) | undefined;
}

export interface BoundedPowerShellResult {
  /**
   * Whether the program's start marker was seen. A caller must treat `false` as a failed run: the
   * host answered without ever running the program (blocked, or broken before its first statement).
   */
  readonly started: boolean;
  /** The runner's own failure, when the run ended without a time limit being hit. */
  readonly error?: Error | undefined;
  readonly status: number | null;
  /** The program's output after its start marker; empty when it never started. */
  readonly stdout: string;
  readonly stderr: string;
}

export type WindowsProgramObserver = (boundMs: number) => void;

let programObserver: WindowsProgramObserver | undefined;

/**
 * Process-wide notice before every bounded program, with the longest time that program may block
 * the calling process (#4358). A program runs synchronously, so nothing else in the process can
 * report life while it runs; a starting UI process registers an observer to tell its launcher how
 * long the silence may last. `undefined` removes the observer. An observer must not throw: it runs
 * inside a security check, whose outcome it must never change.
 */
export function setWindowsProgramObserver(observer: WindowsProgramObserver | undefined): void {
  programObserver = observer;
}

type WindowsProgramOutcome = "completed" | "host-start-timeout" | "work-timeout" | "unavailable";

function programRunEnvelope(
  outcome: WindowsProgramOutcome,
  durationMs: number,
): Parameters<typeof activityLogEvent>[1] {
  if (outcome === "completed") return { level: "info", durationMs };
  const errorKind = outcome === "unavailable" ? "unavailable" : "timeout";
  return { level: "warn", errorKind, durationMs };
}

// One line for a program that was slow, hit a time limit or could not be run. A quick, completed
// program writes nothing: these programs run often, and only the slow host is worth a line.
function emitProgramRun(
  sink: SecurityLogSink | undefined,
  program: WindowsProgramName,
  outcome: WindowsProgramOutcome,
  durationMs: number,
): void {
  if (outcome === "completed" && durationMs < WINDOWS_PROGRAM_SLOW_MS) return;
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      SECURITY_WINDOWS_PROGRAM_RUN_OPERATION,
      programRunEnvelope(outcome, durationMs),
      {
        program,
        outcome,
      },
    ),
  );
}

/**
 * Records that a program could not be run at all (the inbox PowerShell could not be resolved, or
 * the run failed outside its time limits), for a caller that answers "nothing was learned".
 */
export function emitWindowsProgramUnavailable(
  sink: SecurityLogSink | undefined,
  program: WindowsProgramName,
): void {
  emitProgramRun(sink, program, "unavailable", 0);
}

function startedOutput(stdout: string): string | undefined {
  const marker = `${WINDOWS_PROGRAM_STARTED_MARKER}\n`;
  return stdout.startsWith(marker) ? stdout.slice(marker.length) : undefined;
}

// Node reports the watchdog's exit code -1 unsigned; the signed form is accepted as well.
function endedByWatchdog(status: number | null): boolean {
  return status === WATCHDOG_EXIT_STATUS || status === -1;
}

function runnerTimedOut(error: Error | undefined): boolean {
  return error !== undefined && Reflect.get(error, "code") === "ETIMEDOUT";
}

/**
 * Runs one fixed program under both bounds. Throws {@link WindowsProgramHostStartError} when the
 * host never reached the program and {@link WindowsProgramWorkTimeoutError} when the program's own
 * work exceeded its limit; otherwise returns what the program produced for the caller to judge. A
 * slow or timed-out run is one body-free `security.windows-program.run` line.
 */
export function runBoundedPowerShellProgram(run: BoundedPowerShellRun): BoundedPowerShellResult {
  const now = run.now ?? ((): number => performance.now());
  programObserver?.(boundedPowerShellTimeoutMs(run.workTimeoutMs));
  const startedAt = now();
  const result = run.runner(
    run.executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellProgram(
        boundedPowerShellProgram(run.source, run.workTimeoutMs, run.preparation),
      ),
    ],
    {
      encoding: "utf8",
      env: trustedPowerShellEnvironment(run.executable),
      input: run.input,
      maxBuffer: run.maxOutputBytes + WINDOWS_PROGRAM_STARTED_MARKER.length + 1,
      shell: false,
      timeout: boundedPowerShellTimeoutMs(run.workTimeoutMs),
      windowsHide: true,
    },
  );
  const durationMs = Math.round(now() - startedAt);
  const stdout = startedOutput(commandOutputText(result.stdout));
  const timedOut = runnerTimedOut(result.error);
  if (stdout === undefined && timedOut) {
    emitProgramRun(run.securityLogSink, run.program, "host-start-timeout", durationMs);
    throw new WindowsProgramHostStartError();
  }
  if (stdout !== undefined && (timedOut || endedByWatchdog(result.status))) {
    emitProgramRun(run.securityLogSink, run.program, "work-timeout", durationMs);
    throw new WindowsProgramWorkTimeoutError();
  }
  emitProgramRun(run.securityLogSink, run.program, "completed", durationMs);
  return {
    started: stdout !== undefined,
    error: result.error,
    status: result.status,
    stdout: stdout ?? "",
    stderr: commandOutputText(result.stderr),
  };
}
