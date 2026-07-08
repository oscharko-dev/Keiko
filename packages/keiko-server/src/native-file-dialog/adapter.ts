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
import { NATIVE_FILE_DIALOG_MAX_SELECTIONS } from "@oscharko-dev/keiko-contracts";
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
) => Promise<NativeDialogProcessResult>;

interface BoundedCapture {
  value: string;
  exceeded: boolean;
}

function appendBounded(capture: BoundedCapture, chunk: Buffer, maxBytes: number): void {
  if (capture.exceeded) return;
  capture.value += chunk.toString("utf8");
  if (Buffer.byteLength(capture.value, "utf8") > maxBytes) {
    capture.value = capture.value.slice(0, maxBytes);
    capture.exceeded = true;
  }
}

interface KillEscalation {
  readonly wasTriggered: () => boolean;
  readonly clear: () => void;
}

// SIGTERM at the interaction deadline, SIGKILL shortly after for a helper that ignores it.
function startKillEscalation(child: ChildProcess, timeoutMs: number): KillEscalation {
  let triggered = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    triggered = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SIGKILL_ESCALATION_MS);
  }, timeoutMs);
  return {
    wasTriggered: (): boolean => triggered,
    clear: (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    },
  };
}

// Bounded runner for the dialog helper process. Modeled on the git route runner (shell:false,
// windowsHide, timeout, byte caps) plus stdin delivery. The environment is intentionally
// inherited: the helper must join the user's login session (macOS TCC/WindowServer, Windows
// interactive desktop, COM/profile state) or no dialog can appear — configuration still never
// travels via env, only via stdin.
export function runNativeDialogProcess(
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<NativeDialogProcessResult> {
  return new Promise<NativeDialogProcessResult>((resolveProcess) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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
      if (stdout.exceeded) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendBounded(stderr, chunk, MAX_STDERR_BYTES);
    });
    // Spawn failure (binary missing / not executable) surfaces as exit 127 like the git runner;
    // the adapter maps it to a typed error, never a throw into the route.
    child.on("error", () => {
      settle(127);
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

function parseAdapterOutput(stdout: string): NativeFileDialogAdapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new NativeFileDialogAdapterError("failed", "native dialog output was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NativeFileDialogAdapterError("failed", "native dialog output was not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.cancelled !== "boolean" || !Array.isArray(record.paths)) {
    throw new NativeFileDialogAdapterError("failed", "native dialog output shape was invalid");
  }
  if (record.paths.length > NATIVE_FILE_DIALOG_MAX_SELECTIONS) {
    throw new NativeFileDialogAdapterError("failed", "native dialog returned too many paths");
  }
  const paths: string[] = [];
  for (const value of record.paths) {
    if (typeof value !== "string") {
      throw new NativeFileDialogAdapterError("failed", "native dialog path was not a string");
    }
    paths.push(value);
  }
  return { cancelled: record.cancelled, paths };
}

async function runAdapterScript(
  runProcess: NativeDialogProcessRunner,
  command: string,
  args: readonly string[],
  stdin: string,
): Promise<NativeFileDialogAdapterResult> {
  const result = await runProcess(command, args, stdin, NATIVE_FILE_DIALOG_TIMEOUT_MS);
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

// macOS: fixed SIP-protected binary, static JXA program as the only script argument.
export function createMacosNativeFileDialogAdapter(
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  return {
    open(request): Promise<NativeFileDialogAdapterResult> {
      return runAdapterScript(
        runProcess,
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", MACOS_NATIVE_FILE_DIALOG_SCRIPT],
        JSON.stringify(stdinConfig(request)),
      );
    },
  };
}

// Windows PowerShell 5.1 ships with every supported Windows; the absolute path avoids PATH
// hijacking. `-EncodedCommand` expects base64(utf16le(script)) and is not subject to script-file
// execution policy. The stdin config is base64-wrapped so the bytes stay ASCII regardless of the
// console input codepage.
function windowsPowershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function createWindowsNativeFileDialogAdapter(
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  const encodedScript = Buffer.from(WINDOWS_NATIVE_FILE_DIALOG_SCRIPT, "utf16le").toString(
    "base64",
  );
  return {
    open(request): Promise<NativeFileDialogAdapterResult> {
      const config = Buffer.from(JSON.stringify(stdinConfig(request)), "utf8").toString("base64");
      return runAdapterScript(
        runProcess,
        windowsPowershellPath(),
        ["-NoProfile", "-STA", "-EncodedCommand", encodedScript],
        config,
      );
    },
  };
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
  };
}

export function nativeFileDialogSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}
