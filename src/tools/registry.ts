// The tool host: WorkspaceToolHost implements the harness ToolPort. It narrows untrusted
// `Record<string,unknown>` arguments, dispatches the 6 tools through a handler map, and returns
// a ToolCallResult whose `output` is already redacted. run_command is the only tool that sets
// commandExecuted:true (the executor counts those against maxCommandExecutions). All filesystem
// reads go through the workspace layer; all writes through the WorkspaceWriter; all spawns through
// the injected SpawnFn — so a unit test needs no real secrets and no real processes.

import type { ToolDefinition } from "../gateway/types.js";
import type {
  ToolCallMetadata,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "../harness/ports.js";
import { discoverWithStats, readWorkspaceFile } from "../workspace/discovery.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import type { WorkspaceInfo } from "../workspace/types.js";
import { nodeSpawnFn, runCommand, type ExecutableResolver, type SpawnFn } from "./exec.js";
import { CommandCancelledError, ToolArgumentError, UnknownToolError } from "./errors.js";
import { applyPatch, renderDryRun, validatePatch } from "./patch.js";
import { TOOL_DEFINITIONS } from "./schemas.js";
import { nodeWorkspaceWriter, type WorkspaceWriter } from "./writer.js";
import {
  resolveToolHostConfig,
  type CommandResult,
  type ToolHostConfig,
  type ToolHostConfigInput,
} from "./types.js";

type Args = Record<string, unknown>;

interface Handled {
  readonly output: string;
  readonly commandExecuted: boolean;
  // S-M1: redacted audit metadata for command/patch tools; absent for read-only tools.
  readonly metadata?: ToolCallMetadata | undefined;
}

function requireString(args: Args, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolArgumentError(`argument '${key}' must be a non-empty string`, tool);
  }
  return value;
}

function optionalString(args: Args, key: string, tool: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolArgumentError(`argument '${key}' must be a string`, tool);
  }
  return value;
}

function optionalNumber(args: Args, key: string, tool: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ToolArgumentError(`argument '${key}' must be a non-negative number`, tool);
  }
  return value;
}

function optionalBoolean(args: Args, key: string, tool: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolArgumentError(`argument '${key}' must be a boolean`, tool);
  }
  return value;
}

function optionalStringArray(args: Args, key: string, tool: string): readonly string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolArgumentError(`argument '${key}' must be a string array`, tool);
  }
  return value as readonly string[];
}

function summarizeCommand(result: CommandResult): string {
  return JSON.stringify({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export class WorkspaceToolHost implements ToolPort {
  private readonly workspace: WorkspaceInfo;
  private readonly fs: WorkspaceFs;
  private readonly writer: WorkspaceWriter;
  private readonly spawn: SpawnFn;
  private readonly resolveExecutable: ExecutableResolver | undefined;
  private readonly config: ToolHostConfig;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(deps: {
    readonly workspace: WorkspaceInfo;
    readonly fs?: WorkspaceFs | undefined;
    readonly writer?: WorkspaceWriter | undefined;
    readonly spawn?: SpawnFn | undefined;
    readonly resolveExecutable?: ExecutableResolver | undefined;
    readonly config?: ToolHostConfigInput | undefined;
    readonly processEnv?: NodeJS.ProcessEnv | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.workspace = deps.workspace;
    this.fs = deps.fs ?? nodeWorkspaceFs;
    this.writer = deps.writer ?? nodeWorkspaceWriter;
    this.spawn = deps.spawn ?? nodeSpawnFn;
    this.resolveExecutable = deps.resolveExecutable;
    this.config = resolveToolHostConfig(deps.config);
    this.processEnv = deps.processEnv ?? process.env;
    this.now = deps.now ?? Date.now;
  }

  listTools(): readonly ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (request.signal.aborted) {
      throw new CommandCancelledError("tool call cancelled before dispatch");
    }
    const startedAt = this.now();
    const handled = await this.dispatch(request);
    return {
      toolCallId: request.toolCallId,
      output: handled.output,
      durationMs: this.now() - startedAt,
      commandExecuted: handled.commandExecuted,
      ...(handled.metadata === undefined ? {} : { metadata: handled.metadata }),
    };
  }

  private dispatch(request: ToolCallRequest): Promise<Handled> {
    const args = request.arguments;
    switch (request.toolName) {
      case "read_file":
        return Promise.resolve(this.readFile(args));
      case "list_files":
        return Promise.resolve(this.listFiles(args));
      case "inspect_package_scripts":
        return Promise.resolve(this.inspectScripts(args));
      case "run_command":
        return this.runCommandTool(args, request.signal);
      case "propose_patch":
        return Promise.resolve(this.proposePatch(args));
      case "apply_patch":
        return Promise.resolve(this.applyPatchTool(args, request.signal));
      default:
        throw new UnknownToolError(`no such tool: ${request.toolName}`, request.toolName);
    }
  }

  private readFile(args: Args): Handled {
    const path = requireString(args, "path", "read_file");
    const maxBytes = optionalNumber(args, "maxBytes", "read_file") ?? this.config.maxReadBytes;
    const content = readWorkspaceFile(this.workspace, path, { maxBytes }, this.fs);
    return { output: JSON.stringify(content), commandExecuted: false };
  }

  private listFiles(args: Args): Handled {
    const maxDepth = optionalNumber(args, "maxDepth", "list_files");
    const maxFiles = optionalNumber(args, "maxFiles", "list_files");
    const applyGitignore = optionalBoolean(args, "applyGitignore", "list_files");
    const result = discoverWithStats(
      this.workspace,
      {
        maxDepth: maxDepth ?? 12,
        maxFiles: maxFiles ?? 5_000,
        applyGitignore: applyGitignore ?? true,
      },
      this.fs,
    );
    return { output: JSON.stringify(result), commandExecuted: false };
  }

  private inspectScripts(args: Args): Handled {
    const path = optionalString(args, "path", "inspect_package_scripts") ?? "package.json";
    const content = readWorkspaceFile(
      this.workspace,
      path,
      { maxBytes: this.config.maxReadBytes },
      this.fs,
    );
    const scripts = parseScripts(content.text, path);
    return { output: JSON.stringify({ path, scripts }), commandExecuted: false };
  }

  private async runCommandTool(args: Args, signal: AbortSignal): Promise<Handled> {
    const command = requireString(args, "command", "run_command");
    const cmdArgs = optionalStringArray(args, "args", "run_command") ?? [];
    const cwd = optionalString(args, "cwd", "run_command");
    const timeoutMs = optionalNumber(args, "timeoutMs", "run_command");
    const result = await runCommand(
      { command, args: cmdArgs, cwd, timeoutMs, signal },
      {
        workspace: this.workspace,
        policy: this.config.sandbox,
        commandRules: this.config.commandRules,
        spawn: this.spawn,
        resolveExecutable: this.resolveExecutable,
        processEnv: this.processEnv,
        now: this.now,
      },
    );
    return {
      output: summarizeCommand(result),
      commandExecuted: true,
      metadata: {
        kind: "command",
        executable: command,
        argCount: cmdArgs.length,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        sandbox: {
          envAllowlist: this.config.sandbox.envAllowlist,
          network: this.config.sandbox.network,
          maxOutputBytes: this.config.sandbox.maxOutputBytes,
          timeoutMs: timeoutMs ?? this.config.sandbox.defaultTimeoutMs,
          terminationGraceMs: this.config.sandbox.terminationGraceMs,
          cwdRequested: cwd !== undefined,
        },
      },
    };
  }

  private proposePatch(args: Args): Handled {
    const diff = requireString(args, "diff", "propose_patch");
    const validation = validatePatch(this.workspace, diff, {
      fs: this.fs,
      limits: this.config.patchLimits,
    });
    return {
      output: JSON.stringify({ validation, preview: renderDryRun(validation) }),
      commandExecuted: false,
    };
  }

  private applyPatchTool(args: Args, signal: AbortSignal): Handled {
    const diff = requireString(args, "diff", "apply_patch");
    const result = applyPatch(this.workspace, diff, {
      applyEnabled: this.config.applyEnabled,
      signal,
      fs: this.fs,
      writer: this.writer,
      limits: this.config.patchLimits,
    });
    return {
      output: JSON.stringify(result),
      commandExecuted: false,
      metadata: {
        kind: "patch-apply",
        changedFiles: result.changedFiles.length,
        created: result.created.length,
        deleted: result.deleted.length,
      },
    };
  }
}

function parseScripts(text: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolArgumentError(`${path} is not valid JSON`, "inspect_package_scripts");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const scripts = (parsed as Record<string, unknown>).scripts;
  return typeof scripts === "object" && scripts !== null
    ? (scripts as Record<string, unknown>)
    : {};
}
