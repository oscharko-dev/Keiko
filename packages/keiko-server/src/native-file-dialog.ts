import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  NativeFileDialogRequest,
  NativeFileDialogResponse,
  NativeFileDialogSelection,
} from "@oscharko-dev/keiko-contracts";
import { validateNativeFileDialogRequest } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { FilesError, readJsonObject, resolveRoot } from "./files.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const MAX_NATIVE_FILE_DIALOG_BODY_BYTES = 16_384;
const MAX_NATIVE_FILE_DIALOG_OUTPUT_BYTES = 16_384;
const NATIVE_FILE_DIALOG_TIMEOUT_MS = 120_000;

export interface NativeFileDialogAdapterResult {
  readonly cancelled: boolean;
  readonly paths: readonly string[];
}

export interface NativeFileDialogAdapter {
  open(request: NativeFileDialogRequest): Promise<NativeFileDialogAdapterResult>;
}

interface NativeDialogProcessResult {
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

let activeDialog = false;

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function nativeDialogError(status: number, code: string, message: string): RouteResult {
  return { status, body: errorBody(code, message) };
}

function parseAdapterOutput(output: string): NativeFileDialogAdapterResult {
  const parsed = JSON.parse(output) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("native dialog output must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.cancelled !== "boolean" || !Array.isArray(record.paths)) {
    throw new Error("native dialog output shape is invalid");
  }
  const paths: string[] = [];
  for (const pathValue of record.paths) {
    if (typeof pathValue !== "string") throw new Error("native dialog path must be a string");
    paths.push(pathValue);
  }
  return { cancelled: record.cancelled, paths };
}

async function runNativeDialogProcess(
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<NativeDialogProcessResult> {
  return new Promise<NativeDialogProcessResult>((resolveProcess, rejectProcess) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const append = (current: string, chunk: Buffer): string => {
      if (outputExceeded) return current;
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_NATIVE_FILE_DIALOG_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return next.slice(0, MAX_NATIVE_FILE_DIALOG_OUTPUT_BYTES);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectProcess(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveProcess({ exitCode, stdout, stderr, timedOut, outputExceeded });
    });
    child.stdin.end(stdin, "utf8");
  });
}

const WINDOWS_FOLDER_DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$raw = [Console]::In.ReadToEnd()
$config = if ($raw.Trim().Length -eq 0) { @{} } else { $raw | ConvertFrom-Json }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$autoUpgrade = $dialog.PSObject.Properties['AutoUpgradeEnabled']
if ($null -ne $autoUpgrade) {
  $dialog.AutoUpgradeEnabled = $true
}
$dialog.ShowNewFolderButton = $true
if ($null -ne $config.title -and [string]$config.title -ne '') {
  $dialog.Description = [string]$config.title
}
if ($null -ne $config.defaultPath -and [System.IO.Directory]::Exists([string]$config.defaultPath)) {
  $dialog.SelectedPath = [string]$config.defaultPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  @{ cancelled = $false; paths = @($dialog.SelectedPath) } | ConvertTo-Json -Compress
} else {
  @{ cancelled = $true; paths = @() } | ConvertTo-Json -Compress
}
`;

export function createWindowsNativeFileDialogAdapter(
  runProcess: NativeDialogProcessRunner = runNativeDialogProcess,
): NativeFileDialogAdapter {
  return {
    async open(request): Promise<NativeFileDialogAdapterResult> {
      if (request.mode !== "open-directory") {
        throw new Error("unsupported native dialog mode");
      }
      const encodedScript = Buffer.from(WINDOWS_FOLDER_DIALOG_SCRIPT, "utf16le").toString("base64");
      const result = await runProcess(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", encodedScript],
        JSON.stringify({
          title: request.title ?? "",
          defaultPath: request.defaultPath ?? "",
        }),
        NATIVE_FILE_DIALOG_TIMEOUT_MS,
      );
      if (result.timedOut) throw new Error("native dialog timed out");
      if (result.outputExceeded) throw new Error("native dialog output exceeded cap");
      if (result.exitCode !== 0) throw new Error("native dialog process failed");
      return parseAdapterOutput(result.stdout);
    },
  };
}

export function createNativeFileDialogAdapter(
  platform = process.platform,
): NativeFileDialogAdapter {
  if (platform === "win32") return createWindowsNativeFileDialogAdapter();
  return {
    open(): Promise<NativeFileDialogAdapterResult> {
      return Promise.reject(new Error("native file dialog is unsupported on this platform"));
    },
  };
}

async function validateSelections(
  request: NativeFileDialogRequest,
  result: NativeFileDialogAdapterResult,
  deps: UiHandlerDeps,
): Promise<NativeFileDialogResponse | RouteResult> {
  if (result.cancelled) return { cancelled: true, selections: [] };
  if (request.mode !== "open-directory") {
    return nativeDialogError(
      501,
      "NATIVE_DIALOG_UNSUPPORTED",
      "Native file selection is not supported yet.",
    );
  }
  if (result.paths.length !== 1) {
    return nativeDialogError(
      502,
      "NATIVE_DIALOG_INVALID_SELECTION",
      "Native folder picker returned an invalid selection.",
    );
  }
  const selectedPath = result.paths[0];
  if (selectedPath === undefined) {
    return nativeDialogError(
      502,
      "NATIVE_DIALOG_INVALID_SELECTION",
      "Native folder picker returned an invalid selection.",
    );
  }
  if (selectedPath.includes("\0") || !isAbsolute(selectedPath)) {
    return nativeDialogError(
      502,
      "NATIVE_DIALOG_INVALID_SELECTION",
      "Native folder picker returned an invalid path.",
    );
  }
  const resolved = await resolveRoot(deps.store, selectedPath, deps.redactor);
  const selection: NativeFileDialogSelection = { path: resolved.root, kind: "directory" };
  return { cancelled: false, selections: [selection] };
}

function unsupportedFileModeResult(): RouteResult {
  return nativeDialogError(
    501,
    "NATIVE_DIALOG_UNSUPPORTED",
    "Native file selection is not supported yet.",
  );
}

function alreadyOpenResult(): RouteResult {
  return nativeDialogError(
    409,
    "NATIVE_DIALOG_ALREADY_OPEN",
    "A native file dialog is already open.",
  );
}

function failureResult(error: unknown): RouteResult {
  if (error instanceof FilesError) {
    return nativeDialogError(
      400,
      "NATIVE_DIALOG_INVALID_SELECTION",
      "Native folder picker returned a path Keiko cannot access.",
    );
  }
  return nativeDialogError(
    process.platform === "win32" ? 502 : 501,
    process.platform === "win32" ? "NATIVE_DIALOG_FAILED" : "NATIVE_DIALOG_UNSUPPORTED",
    process.platform === "win32"
      ? "Native folder picker failed."
      : "Native folder picker is not supported on this platform.",
  );
}

async function openAndValidateNativeDialog(
  request: NativeFileDialogRequest,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const adapter = deps.nativeFileDialog ?? createNativeFileDialogAdapter();
  const adapterResult = await adapter.open(request);
  const response = await validateSelections(request, adapterResult, deps);
  if (isRouteResult(response)) return response;
  return { status: 200, body: response };
}

export async function handleNativeFileDialogOpen(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_NATIVE_FILE_DIALOG_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = validateNativeFileDialogRequest(body);
  if (!parsed.ok) return nativeDialogError(400, "BAD_REQUEST", parsed.error);
  if (parsed.value.mode !== "open-directory") return unsupportedFileModeResult();
  if (activeDialog) return alreadyOpenResult();
  activeDialog = true;
  try {
    return await openAndValidateNativeDialog(parsed.value, deps);
  } catch (error) {
    return failureResult(error);
  } finally {
    activeDialog = false;
  }
}
