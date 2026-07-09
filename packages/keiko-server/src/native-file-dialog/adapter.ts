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

// Bounded runner for the dialog helper process. Modeled on the git route runner (shell:false,
// windowsHide, timeout, byte caps, curated env) plus stdin delivery.
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
      env: buildDialogEnv(),
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
