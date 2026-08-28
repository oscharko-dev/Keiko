// Epic #1941 — fixed-purpose native dialog adapters (ADR-0118 D3).
//
// Each adapter spawns ONE fixed platform binary with a fixed argv and a static script from
// scripts.ts: there is no code path through which request data can reach command text. All
// user-controlled configuration travels as stdin JSON. The child process is bounded (timeout with
// SIGTERM→SIGKILL escalation, stdout/stderr byte caps) and its stderr is treated as confidential:
// callers receive typed failures, never raw process output.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { NativeFileDialogRequest } from "@oscharko-dev/keiko-contracts";
import { NATIVE_FILE_DIALOG_MAX_SELECTIONS } from "@oscharko-dev/keiko-contracts/runtime/native-file-dialog";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
import { MACOS_NATIVE_FILE_DIALOG_SCRIPT, WINDOWS_NATIVE_FILE_DIALOG_SCRIPT } from "./scripts.js";

// A native dialog is a human interaction: users legitimately keep it open while they search.
// Ten minutes bounds a hung platform helper without cutting off slow, deliberate selection. The
// BFF sets no HTTP response deadline, so the open request simply stays pending meanwhile.
export const NATIVE_FILE_DIALOG_TIMEOUT_MS = 600_000;
// 200 selections × a generous path length still fits comfortably; the cap exists to stop a
// misbehaving helper from streaming unbounded bytes at the BFF.
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SIGKILL_ESCALATION_MS = 2_000;

export interface NativeFileDialogAdapterResult {
  readonly cancelled: boolean;
  readonly paths: readonly string[];
}

export interface NativeFileDialogAdapter {
  open(request: NativeFileDialogRequest): Promise<NativeFileDialogAdapterResult>;
  // #2906: cancels the in-flight open() call, if any -- a no-op when no open() is running or it
  // has already settled. Does not itself resolve/reject the open() promise; a real adapter's
  // cancel() causes the underlying platform process to be killed, which then settles open() (as
  // a rejection) on its own. A caller must still await the original open() promise to know
  // cancellation has actually finished.
  cancel(): void;
}

export type NativeFileDialogAdapterFailureReason = "timeout" | "failed" | "unsupported";

// Typed adapter failure. `detail` is an operator-facing, content-free summary (exit codes and
// byte counts only — never stdout/stderr bodies, never selected paths).
export class NativeFileDialogAdapterError extends Error {
  readonly reason: NativeFileDialogAdapterFailureReason;

  constructor(reason: NativeFileDialogAdapterFailureReason, detail: string) {
    super(detail);
    this.name = "NativeFileDialogAdapterError";
    this.reason = reason;
  }
}

export interface NativeDialogProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export type NativeDialogProcessRunner = (
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
  // #2906: an optional cancellation signal, independent of the interaction timeout above -- the
  // BFF route uses this to kill an orphaned dialog process as soon as the client disconnects,
  // instead of waiting out the full 10-minute interaction budget.
  signal?: AbortSignal,
) => Promise<NativeDialogProcessResult>;

interface BoundedCapture {
  value: string;
  exceeded: boolean;
}

// A UTF-8 lead byte's expected total sequence length (1/2/3/4-byte forms). A stray continuation
// byte cannot start a sequence; walking it as length 1 keeps truncation making forward progress
// on malformed input instead of looping.
function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0x00) return 1;
  if ((leadByte & 0xe0) === 0xc0) return 2;
  if ((leadByte & 0xf0) === 0xe0) return 3;
  if ((leadByte & 0xf8) === 0xf0) return 4;
  return 1;
}

// Truncates to the largest whole number of UTF-8 characters that fits within `maxBytes`, so the
// result's own byte length never exceeds the cap. A naive JS-string `.slice(0, maxBytes)` cuts by
// UTF-16 code units, which can leave several times `maxBytes` of actual UTF-8 content for
// non-ASCII text; re-decoding a buffer sliced mid-sequence would instead substitute a 3-byte
// U+FFFD per split sequence, which can itself push the result a few bytes back OVER the cap.
function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const leadByte = buffer[offset];
    if (leadByte === undefined) break;
    const charLength = utf8SequenceLength(leadByte);
    if (offset + charLength > maxBytes) break;
    offset += charLength;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function appendBounded(capture: BoundedCapture, chunk: Buffer, maxBytes: number): void {
  if (capture.exceeded) return;
  capture.value += chunk.toString("utf8");
  if (Buffer.byteLength(capture.value, "utf8") > maxBytes) {
    capture.value = truncateUtf8(capture.value, maxBytes);
    capture.exceeded = true;
  }
}

interface KillEscalation {
  readonly wasTriggered: () => boolean;
  readonly triggerOutputCapKill: () => void;
  readonly clear: () => void;
}

// SIGTERM at the interaction deadline, SIGKILL shortly after for a helper that ignores it. The
// same escalation also arms when the stdout byte cap trips (`triggerOutputCapKill`), so a helper
// that streams past the cap and then ignores SIGTERM cannot hold the route's single-flight lock
// for anywhere near the full interaction timeout. `wasTriggered()` stays scoped to the
// interaction-deadline path only, so `NativeDialogProcessResult.timedOut` keeps meaning exactly
// "the interaction timeout fired" and does not get muddied by an output-cap kill.
function startKillEscalation(child: ChildProcess, timeoutMs: number): KillEscalation {
  let triggered = false;
  let killTimer: NodeJS.Timeout | undefined;
  const escalateToSigkill = (): void => {
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SIGKILL_ESCALATION_MS);
  };
  const timer = setTimeout(() => {
    triggered = true;
    child.kill("SIGTERM");
    escalateToSigkill();
  }, timeoutMs);
  return {
    wasTriggered: (): boolean => triggered,
    triggerOutputCapKill: (): void => {
      if (killTimer !== undefined) return;
      clearTimeout(timer);
      child.kill("SIGTERM");
      escalateToSigkill();
    },
    clear: (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    },
  };
}

// Copy-only env allowlist for the dialog child, mirroring `gitEnv()`/`buildSandboxEnv`'s pattern:
// never spread the BFF's full `process.env`, since it can legitimately hold live secrets (e.g. a
// model-provider API key per keiko-model-gateway's config). PATH lets the platform helper resolve
// its own runtime dependencies; the rest is the minimal session-identity state the helper needs to
// join the user's login session (macOS TCC/WindowServer, Windows interactive desktop/COM). Dialog
// configuration itself still never travels via env, only via stdin.
const NATIVE_DIALOG_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
] as const;

function buildDialogEnv(processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildSandboxEnv(processEnv, NATIVE_DIALOG_ENV_ALLOWLIST);
}

// #2906 round 2: passing `signal` to spawn() makes Node send SIGTERM AND emit 'error' (an
// AbortError) as soon as an aborted signal is observed -- well before the child has actually
// exited. Settling immediately here, as a genuine spawn failure does, would report cancellation as
// "done" while the process may still be alive: escalation.clear() inside settle() cancels the only
// kill escalation armed so far, so a helper that ignores SIGTERM would be orphaned with nothing
// left to finish it off. Instead, arm the same immediate SIGKILL escalation the output-cap path
// uses (idempotent if one is already scheduled) and let the 'close' handler produce the real
// settlement once the child has actually exited -- never fabricate a settlement from the abort
// signal alone. A genuine spawn failure (binary missing / not executable) still settles 127
// immediately, like the git runner.
function handleChildSpawnError(
  escalation: KillEscalation,
  signal: AbortSignal | undefined,
  settle: (exitCode: number | null) => void,
): void {
  if (signal?.aborted === true) {
    escalation.triggerOutputCapKill();
    return;
  }
  settle(127);
}

// Bounded runner for the dialog helper process. Modeled on the git route runner (shell:false,
// windowsHide, timeout, byte caps, curated env) plus stdin delivery. `signal`, when aborted (the
// BFF route's cancel() seam, #2906), makes Node kill the child immediately instead of waiting out
// the full interaction timeout -- the same `settle()` path handles both, so an aborted run still
// resolves (never hangs the caller) via the ordinary 'error'/'close' handlers below.
export function runNativeDialogProcess(
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<NativeDialogProcessResult> {
  return new Promise<NativeDialogProcessResult>((resolveProcess) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildDialogEnv(),
      ...(signal === undefined ? {} : { signal }),
    });
    const stdout: BoundedCapture = { value: "", exceeded: false };
    const stderr: BoundedCapture = { value: "", exceeded: false };
    const escalation = startKillEscalation(child, timeoutMs);
    let settled = false;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      escalation.clear();
      resolveProcess({
        exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        timedOut: escalation.wasTriggered(),
        outputExceeded: stdout.exceeded,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      appendBounded(stdout, chunk, MAX_STDOUT_BYTES);
      if (stdout.exceeded) escalation.triggerOutputCapKill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendBounded(stderr, chunk, MAX_STDERR_BYTES);
    });
    // Spawn failure (binary missing / not executable) surfaces as exit 127 like the git runner,
    // UNLESS this 'error' is a byproduct of our own cancel() -- see handleChildSpawnError above.
    child.on("error", () => {
      handleChildSpawnError(escalation, signal, settle);
    });
    child.on("close", (exitCode) => {
      settle(exitCode);
    });
    child.stdin.on("error", () => {
      // The helper may exit before consuming stdin (e.g. immediate spawn failure); losing the
      // config write is then irrelevant and must not crash the server with EPIPE.
    });
    child.stdin.end(stdin, "utf8");
  });
}

// Content-free operator summary for a failed helper run (exit code + byte counts only).
function processSummary(result: NativeDialogProcessResult): string {
  const exit = result.exitCode === null ? "null" : String(result.exitCode);
  const stderrBytes = String(Buffer.byteLength(result.stderr, "utf8"));
  return `exitCode=${exit} stderrBytes=${stderrBytes} outputExceeded=${String(result.outputExceeded)}`;
}

// Closed shape: an adapter is a fixed, first-party script (scripts.ts) and its stdout is
// otherwise untrusted input. A key outside this allowlist means either a broken/tampered helper
// or content smuggling — reject rather than silently drop it, mirroring the "unknown key not
// allowed (content-free)" convention in keiko-contracts/task-workspace.ts.
const ADAPTER_OUTPUT_KEYS = new Set(["cancelled", "paths"]);

function hasOnlyAllowedKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => ADAPTER_OUTPUT_KEYS.has(key));
}

function isPlainAdapterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RawAdapterOutput {
  readonly cancelled: boolean;
  readonly paths: readonly unknown[];
}

function validateAdapterOutputShape(parsed: unknown): RawAdapterOutput {
  if (!isPlainAdapterRecord(parsed)) {
    throw new NativeFileDialogAdapterError("failed", "native dialog output was not an object");
  }
  if (!hasOnlyAllowedKeys(parsed)) {
    throw new NativeFileDialogAdapterError("failed", "native dialog output shape was invalid");
  }
  if (typeof parsed.cancelled !== "boolean" || !Array.isArray(parsed.paths)) {
    throw new NativeFileDialogAdapterError("failed", "native dialog output shape was invalid");
  }
  return { cancelled: parsed.cancelled, paths: parsed.paths };
}

function parseAdapterOutput(stdout: string): NativeFileDialogAdapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new NativeFileDialogAdapterError("failed", "native dialog output was not JSON");
  }
  const { cancelled, paths: rawPaths } = validateAdapterOutputShape(parsed);
  if (rawPaths.length > NATIVE_FILE_DIALOG_MAX_SELECTIONS) {
    throw new NativeFileDialogAdapterError("failed", "native dialog returned too many paths");
  }
  const paths: string[] = [];
  for (const value of rawPaths) {
    if (typeof value !== "string") {
      throw new NativeFileDialogAdapterError("failed", "native dialog path was not a string");
    }
    paths.push(value);
  }
  return { cancelled, paths };
}

async function runAdapterScript(
  runProcess: NativeDialogProcessRunner,
  command: string,
  args: readonly string[],
  stdin: string,
  signal?: AbortSignal,
): Promise<NativeFileDialogAdapterResult> {
  const result = await runProcess(command, args, stdin, NATIVE_FILE_DIALOG_TIMEOUT_MS, signal);
  if (result.timedOut) {
    throw new NativeFileDialogAdapterError(
      "timeout",
      `native dialog timed out (${processSummary(result)})`,
    );
  }
  if (result.outputExceeded) {
    throw new NativeFileDialogAdapterError(
      "failed",
      `native dialog output exceeded cap (${processSummary(result)})`,
    );
  }
  if (result.exitCode !== 0) {
    throw new NativeFileDialogAdapterError(
      "failed",
      `native dialog helper failed (${processSummary(result)})`,
    );
  }
  return parseAdapterOutput(result.stdout);
}

// The flat extension list handed to the platform script. macOS `choose file` has no named filter
// groups, so both platforms receive the union; Windows additionally gets the named groups.
function flattenExtensions(request: NativeFileDialogRequest): readonly string[] {
  if (request.filters === undefined) return [];
  const unique = new Set<string>();
  for (const filter of request.filters) {
    for (const extension of filter.extensions) unique.add(extension);
  }
  return [...unique];
}

interface AdapterStdinConfig {
  readonly mode: NativeFileDialogRequest["mode"];
  readonly title: string;
  readonly defaultPath: string;
  readonly extensions: readonly string[];
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

function stdinConfig(request: NativeFileDialogRequest): AdapterStdinConfig {
  return {
    mode: request.mode,
    title: request.title ?? "",
    defaultPath: request.defaultPath ?? "",
    extensions: flattenExtensions(request),
    filters: request.filters ?? [],
  };
}

// #2906: shared cancellation bookkeeping for the two spawning adapters below. Each open() call
// gets its own AbortController; cancel() aborts whichever one is currently active. The route
// enforces single-flight (at most one open() per adapter instance), but a settled call still
// clears its own controller so a stale cancel() from an already-finished call can never reach a
// later, unrelated open().
function cancellableAdapter(
  run: (
    signal: AbortSignal,
    request: NativeFileDialogRequest,
  ) => Promise<NativeFileDialogAdapterResult>,
): NativeFileDialogAdapter {
  let active: AbortController | undefined;
  return {
    open(request): Promise<NativeFileDialogAdapterResult> {
      const controller = new AbortController();
      active = controller;
      return run(controller.signal, request).finally(() => {
        if (active === controller) active = undefined;
      });
    },
    cancel(): void {
      active?.abort();
    },
  };
}

// macOS: fixed SIP-protected binary, static JXA program as the only script argument.
export function createMacosNativeFileDialogAdapter(
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  return cancellableAdapter((signal, request) =>
    runAdapterScript(
      runProcess,
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MACOS_NATIVE_FILE_DIALOG_SCRIPT],
      JSON.stringify(stdinConfig(request)),
      signal,
    ),
  );
}

// Windows PowerShell 5.1 ships with every supported Windows; the absolute path avoids PATH
// hijacking. `-EncodedCommand` expects base64(utf16le(script)) and is not subject to script-file
// execution policy. The stdin config is base64-wrapped so the bytes stay ASCII regardless of the
// console input codepage.
function windowsPowershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function createWindowsNativeFileDialogAdapter(
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  const encodedScript = Buffer.from(WINDOWS_NATIVE_FILE_DIALOG_SCRIPT, "utf16le").toString(
    "base64",
  );
  return cancellableAdapter((signal, request) => {
    const config = Buffer.from(JSON.stringify(stdinConfig(request)), "utf8").toString("base64");
    return runAdapterScript(
      runProcess,
      windowsPowershellPath(),
      ["-NoProfile", "-STA", "-EncodedCommand", encodedScript],
      config,
      signal,
    );
  });
}

// Platform dispatch. Unsupported platforms get an adapter that fails typed-`unsupported`, so the
// route can answer 501 and the UI can keep manual path entry as the fallback (ADR-0118 D4).
export function createNativeFileDialogAdapter(
  platform: NodeJS.Platform = process.platform,
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  if (platform === "darwin") return createMacosNativeFileDialogAdapter(runProcess);
  if (platform === "win32") return createWindowsNativeFileDialogAdapter(runProcess);
  return {
    open(): Promise<NativeFileDialogAdapterResult> {
      return Promise.reject(
        new NativeFileDialogAdapterError(
          "unsupported",
          "native dialogs are unsupported on this platform",
        ),
      );
    },
    cancel(): void {
      // Nothing is ever in flight on an unsupported platform -- open() always rejects immediately.
    },
  };
}

export function nativeFileDialogSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}
