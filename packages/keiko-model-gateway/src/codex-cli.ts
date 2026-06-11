import { spawn } from "node:child_process";
import {
  AuthenticationError,
  CancelledError,
  ConfigInvalidError,
  ProviderError,
  TimeoutError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type { ModelCapability } from "./types.js";
import { createDefaultChatCapability } from "./capabilities.js";

const DEFAULT_CODEX_EXECUTABLE = "codex";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type CodexApprovedCommand =
  | "version"
  | "login-status"
  | "doctor-json"
  | "debug-models"
  | "exec-json";

export interface CodexCliCommandInput {
  readonly command: CodexApprovedCommand;
  readonly executable?: string | undefined;
  readonly modelId?: string | undefined;
  readonly stdinText?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly cwd?: string | undefined;
}

export interface CodexCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly terminatedBySignal: string | null;
}

export type CodexCliCommandRunner = (
  input: CodexCliCommandInput,
) => Promise<CodexCliCommandResult>;

export interface CodexExecUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface CodexExecResult {
  readonly content: string;
  readonly usage: CodexExecUsage;
}

interface CodexCheckDetails {
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly details?: Readonly<Record<string, string>> | undefined;
}

interface CodexDoctorReport {
  readonly overallStatus?: string | undefined;
  readonly codexVersion?: string | undefined;
  readonly checks?: Readonly<Record<string, CodexCheckDetails>> | undefined;
}

interface CodexModelCatalogEntry {
  readonly slug: string;
  readonly visibility?: string | undefined;
  readonly supported_in_api?: boolean | undefined;
  readonly shell_type?: string | undefined;
  readonly description?: string | undefined;
}

interface CodexModelCatalog {
  readonly models?: readonly CodexModelCatalogEntry[] | undefined;
}

function argsFor(
  command: CodexApprovedCommand,
  modelId: string | undefined,
): readonly string[] {
  switch (command) {
    case "version":
      return ["--version"];
    case "login-status":
      return ["login", "status"];
    case "doctor-json":
      return ["doctor", "--json"];
    case "debug-models":
      return ["debug", "models"];
    case "exec-json":
      if (modelId === undefined || modelId.length === 0) {
        throw new ConfigInvalidError("codex local-session execution requires a configured model id");
      }
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--model",
        modelId,
        "-",
      ];
  }
}

function errorSnippet(output: string): string {
  return output
    .trim()
    .split(/\r?\n/u)
    .slice(0, 3)
    .join(" ")
    .slice(0, 240);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(stdout: string, label: string, version: string | undefined): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const versionHint = version === undefined ? "unknown version" : `version '${version}'`;
    throw new ConfigInvalidError(
      `codex CLI ${versionHint} did not return valid JSON for ${label}`,
    );
  }
}

function classifyExecFailure(
  stderr: string,
  exitCode: number,
  modelId: string,
): ProviderError | AuthenticationError | ConfigInvalidError {
  const signal = `${stderr}`.toLowerCase();
  if (/(login|logged in|auth|session|token|credential)/u.test(signal)) {
    return new AuthenticationError(
      `codex local session is not authenticated for '${modelId}'`,
    );
  }
  if (/(unknown option|unexpected argument|unrecognized|invalid value|usage: codex)/u.test(signal)) {
    return new ConfigInvalidError(
      `codex CLI does not support the required local-session machine interface for '${modelId}'`,
    );
  }
  return new ProviderError(
    `codex local-session execution failed for '${modelId}' (exit ${exitCode})`,
    502,
  );
}

function parseVersionString(stdout: string): string {
  const version = stdout.trim();
  if (version.length === 0) {
    throw new ConfigInvalidError("codex CLI returned an empty version string");
  }
  return version;
}

function classifyDoctorFailure(
  doctor: CodexDoctorReport,
  modelId: string,
): AuthenticationError | ProviderError {
  const auth = doctor.checks?.["auth.credentials"];
  if (auth?.status !== "ok") {
    throw new AuthenticationError(`codex local session is not authenticated for '${modelId}'`);
  }
  const websocket = doctor.checks?.["network.websocket_reachability"];
  if (websocket?.status !== "ok") {
    const summary = `${websocket?.summary ?? ""}`.toLowerCase();
    if (/(auth|session|token|login|credential)/u.test(summary)) {
      throw new AuthenticationError(
        `codex local session is not ready to serve '${modelId}'`,
      );
    }
    throw new ProviderError(
      `codex local session is not reachable for '${modelId}'`,
      503,
    );
  }
  if (doctor.overallStatus === "fail") {
    throw new ProviderError(
      `codex local session health checks failed for '${modelId}'`,
      503,
    );
  }
  return new ProviderError(`codex local session is unavailable for '${modelId}'`, 503);
}

function parseExecJsonl(stdout: string, modelId: string): CodexExecResult {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let latestContent: string | undefined;
  let usage: CodexExecUsage = { promptTokens: 0, completionTokens: 0 };
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJsonRecord(event) || typeof event.type !== "string") {
      continue;
    }
    if (event.type === "item.completed" && isJsonRecord(event.item)) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        latestContent = event.item.text;
      }
    }
    if (event.type === "turn.completed" && isJsonRecord(event.usage)) {
      usage = {
        promptTokens:
          typeof event.usage.input_tokens === "number" ? event.usage.input_tokens : 0,
        completionTokens:
          typeof event.usage.output_tokens === "number" ? event.usage.output_tokens : 0,
      };
    }
  }
  if (latestContent === undefined) {
    throw new ProviderError(
      `codex local session returned no assistant message for '${modelId}'`,
      502,
    );
  }
  return { content: latestContent, usage };
}

function mapCatalogEntryToCapability(entry: CodexModelCatalogEntry): ModelCapability {
  const slug = entry.slug;
  const defaultCapability = createDefaultChatCapability(slug);
  const costClass =
    /mini/u.test(slug) ? "low" : /(gpt-5\.5|gpt-5\.4)$/u.test(slug) ? "high" : "medium";
  const latencyClass = /mini/u.test(slug) ? "fast" : "standard";
  return {
    ...defaultCapability,
    toolCalling: false,
    structuredOutput: true,
    streaming: false,
    workflowEligible: entry.shell_type === "shell_command",
    costClass,
    latencyClass,
    throughputHint: "Codex local session",
    preferredUseCases:
      entry.shell_type === "shell_command"
        ? ["Local coding workflow"]
        : ["Chat"],
    knownLimitations: [
      "Gateway tool-call bridging is not available through the local Codex session provider",
      "Streaming is synthesized from buffered local-session execution",
      "Structured output is enforced by prompt instructions and JSON parsing",
      ...(entry.description === undefined ? [] : [entry.description]),
    ],
    supportsSeeding: false,
    supportsResponseFormat: true,
  };
}

export const defaultCodexCliCommandRunner: CodexCliCommandRunner = (input) =>
  new Promise<CodexCliCommandResult>((resolve, reject) => {
    const executable = input.executable ?? DEFAULT_CODEX_EXECUTABLE;
    const child = spawn(executable, argsFor(input.command, input.modelId), {
      cwd: input.cwd ?? process.cwd(),
      env: process.env,
      shell: false,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(() => reject(new CancelledError(`codex ${input.command} was cancelled`)));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      input.signal?.removeEventListener("abort", onAbort);
      finish(() =>
        reject(
          new TransportError(
            `codex CLI could not be started: ${error instanceof Error ? error.message : "unknown error"}`,
          ),
        ),
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => reject(new ProviderError("codex CLI output exceeded the safety limit", 502)));
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => reject(new ProviderError("codex CLI stderr exceeded the safety limit", 502)));
        return;
      }
      stderr += chunk.toString("utf8");
    });

    child.on("close", (exitCode, signal) => {
      input.signal?.removeEventListener("abort", onAbort);
      finish(() =>
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
          terminatedBySignal: signal,
        }),
      );
    });

    if (input.stdinText !== undefined) {
      child.stdin.write(input.stdinText);
    }
    child.stdin.end();
  });

export interface CodexCliClientDeps {
  readonly commandRunner?: CodexCliCommandRunner | undefined;
  readonly executable?: string | undefined;
  readonly cwd?: string | undefined;
}

export class CodexCliClient {
  private readonly commandRunner: CodexCliCommandRunner;
  private readonly executable: string | undefined;
  private readonly cwd: string | undefined;
  private versionPromise: Promise<string> | undefined;
  private doctorPromise: Promise<CodexDoctorReport> | undefined;

  constructor(deps: CodexCliClientDeps = {}) {
    this.commandRunner = deps.commandRunner ?? defaultCodexCliCommandRunner;
    this.executable = deps.executable;
    this.cwd = deps.cwd;
  }

  private async run(
    command: CodexApprovedCommand,
    input: Omit<CodexCliCommandInput, "command" | "executable" | "cwd"> = {},
  ): Promise<CodexCliCommandResult> {
    return this.commandRunner({
      command,
      executable: this.executable,
      cwd: this.cwd,
      ...input,
    });
  }

  async version(): Promise<string> {
    this.versionPromise ??= (async () => {
      const result = await this.run("version");
      if (result.exitCode !== 0) {
        throw new ConfigInvalidError(
          `codex CLI version check failed: ${errorSnippet(result.stderr || result.stdout)}`,
        );
      }
      return parseVersionString(result.stdout);
    })();
    return this.versionPromise;
  }

  async loginStatus(signal?: AbortSignal): Promise<string> {
    const result = await this.run("login-status", { signal });
    if (result.exitCode !== 0) {
      throw new AuthenticationError("codex local session is not logged in");
    }
    const status = result.stdout.trim();
    if (status.length === 0) {
      throw new AuthenticationError("codex local session login status is unavailable");
    }
    return status;
  }

  async doctor(signal?: AbortSignal): Promise<CodexDoctorReport> {
    this.doctorPromise ??= (async () => {
      const version = await this.version();
      const result = await this.run("doctor-json", { signal });
      if (result.exitCode !== 0) {
        throw new ConfigInvalidError(
          `codex CLI ${version} does not support the required doctor JSON interface`,
        );
      }
      return parseJson<CodexDoctorReport>(result.stdout, "`codex doctor --json`", version);
    })();
    return this.doctorPromise;
  }

  async ensureReady(modelId: string, signal?: AbortSignal): Promise<void> {
    const doctor = await this.doctor(signal);
    if (doctor.checks?.["auth.credentials"]?.status !== "ok") {
      await this.loginStatus(signal);
    }
    if (
      doctor.checks?.["auth.credentials"]?.status !== "ok" ||
      doctor.checks?.["network.websocket_reachability"]?.status !== "ok" ||
      doctor.overallStatus === "fail"
    ) {
      throw classifyDoctorFailure(doctor, modelId);
    }
  }

  async discoverCapabilities(signal?: AbortSignal): Promise<readonly ModelCapability[]> {
    const version = await this.version();
    const result = await this.run("debug-models", { signal });
    if (result.exitCode !== 0) {
      throw new ConfigInvalidError(
        `codex CLI ${version} does not support the required model discovery interface`,
      );
    }
    const catalog = parseJson<CodexModelCatalog>(result.stdout, "`codex debug models`", version);
    return (catalog.models ?? [])
      .filter((entry) => entry.supported_in_api !== false)
      .filter((entry) => entry.visibility !== "hide")
      .map(mapCatalogEntryToCapability);
  }

  async execJson(
    modelId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<CodexExecResult> {
    const result = await this.run("exec-json", {
      modelId,
      stdinText: prompt,
      signal,
    });
    if (result.exitCode !== 0) {
      throw classifyExecFailure(result.stderr || result.stdout, result.exitCode, modelId);
    }
    return parseExecJsonl(result.stdout, modelId);
  }
}
