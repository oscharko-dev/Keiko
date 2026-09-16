import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { runModelsCli } from "./models.js";
import { runAgentCli } from "./run.js";
import { runContextCli } from "./context.js";
import { runVerifyCli } from "./verify.js";
import { runGenTestsCli } from "./gen-tests.js";
import { runInvestigateCli } from "./investigate.js";
import { runEvidenceCli } from "./evidence.js";
import { runEvaluateCli } from "./evaluate.js";
import { runPromptEnhancerCli } from "./prompt-enhancer.js";
import { runMemoryCli } from "./memory.js";
import { runInitCli } from "./init.js";
import { runLifecycleCli } from "./lifecycle.js";
import { runTaskWorkspaceCli } from "./task-workspace.js";
import { runUiCli } from "./ui.js";
import { runLauncherCli } from "./launcher.js";
import { runPortableCli } from "./portable.js";
import { runUninstallCli } from "./uninstall.js";
import { runRepairCli } from "./repair.js";
import { runUpdateCli } from "./update.js";
import {
  collectDoctorReport,
  emitDoctorWarning,
  runDoctorCli,
  type DoctorReport,
} from "./doctor.js";
import { runAuditCli } from "./audit.js";
import { runSupportCli } from "./support.js";
import { loadServer } from "./lazy-modules.js";
import type { CliSecurityLogSinkFactory } from "./security-log.js";
import {
  securityErrorKind,
  type SecurityLogEvent,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
// The version constant comes from the contracts LEAF, not the keiko-sdk barrel:
// the sdk package eagerly re-exports harness/workflows/evidence/gateway/
// evaluations, so importing SDK_VERSION from it loaded the entire product graph
// on every `keiko` invocation — the single largest slice of the measured ~410ms
// startup tax (GEN-PERF-CLI-001). SDK_VERSION is defined as exactly this alias.
import { KEIKO_PRODUCT_VERSION as SDK_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

// Pure CLI core: returns an exit code and writes through the injected IO so it is
// testable without touching process.* (the thin process shim lives in index.ts).
export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const HELP_TEXT = `keiko ${SDK_VERSION}
Enterprise model-agnostic developer-assist coding agent.

Usage:
  keiko [--help | -h]      Print this help and exit.
  keiko [--version | -v]   Print the version and exit.
  keiko init [OPTIONS]     Add local package.json start/stop scripts.
  keiko doctor             Diagnose stale global-vs-local launch paths.
  keiko audit local-state [--state-dir PATH]
                           Audit a local .keiko tree against the at-rest contract (read-only).
  keiko support <export|analyze> [OPTIONS]
                           Export a redacted support bundle, or analyze one by correlation id.
  keiko repair [OPTIONS]   Repair a broken local install (offline remediation pass).
  keiko uninstall [OPTIONS] Remove Keiko's runtime artifacts (state, shortcuts, scripts).
  keiko update <status|check|apply> Inspect or run governed updates (UI remains primary).
  keiko portable <setup|launch|status|resolve-root>
                           Manage archive-first portable setup and launch.
  keiko start|stop|status|restart Manage the local Keiko UI process.
  keiko models list        List registered model capabilities.
  keiko models validate    Validate gateway configuration.
  keiko run <task>         Run a bounded dry-run task through the agent harness.
  keiko context [OPTIONS]  Print a redacted workspace context summary (dry-run).
  keiko verify [OPTIONS]   Run the project's gates and print a redacted evidence summary.
  keiko gen-tests [OPTIONS] Generate a reviewable unit-test patch (dry-run by default).
  keiko investigate [OPTIONS] Investigate a bug and propose a fix + regression test (dry-run by default).
  keiko evidence <list|show> Inspect redacted evidence manifests written by \`keiko run\`.
  keiko evaluate [OPTIONS]     Run the evaluation harness (offline by default; --live for live model).
  keiko prompt-enhancer [OPTIONS] Enhance a raw prompt into a governed, reviewable Enhanced Prompt.
  keiko memory <maintain|stats> Run a memory maintenance pass or print vault stats (#204).
  keiko task-workspace <reconciliation|health|repair|cleanup|cleanup-orphans>
                           Inspect or repair governed task workspaces.
  keiko ui [OPTIONS]       Launch the local UI on 127.0.0.1 and print its URL.
  keiko launcher <install|remove|status> [OPTIONS]
                           Manage a user-local OS shortcut for \`keiko start --open\`.

Exit codes:
  0  Success
  1  Runtime error
  2  Usage error
`;

type CommandHandler = (
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
) => number | Promise<number>;

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

export interface RunCliDeps {
  readonly cwd?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly spawnSync?: SpawnSyncFn | undefined;
}

interface DeferredSecurityLogCollector {
  readonly factory: CliSecurityLogSinkFactory;
  readonly flush: () => Promise<void>;
}

interface PendingSecurityLogEvent {
  readonly stateDir: string;
  readonly event: SecurityLogEvent;
}

function deferredSecurityLogCollector(): DeferredSecurityLogCollector {
  const pending: PendingSecurityLogEvent[] = [];
  const sinks = new Map<string, SecurityLogSink>();
  let active = false;
  let drainPromise: Promise<void> | undefined;
  let fileSinkFactory: CliSecurityLogSinkFactory | undefined;

  const drain = async (): Promise<void> => {
    if (pending.length === 0) return;
    try {
      fileSinkFactory ??= (await loadServer()).createFileServerLogSink;
      while (pending.length > 0) {
        const next = pending.shift();
        if (next === undefined) continue;
        let sink = sinks.get(next.stateDir);
        if (sink === undefined) {
          sink = fileSinkFactory(next.stateDir);
          sinks.set(next.stateDir, sink);
        }
        sink.write(next.event);
      }
    } catch (cause) {
      pending.splice(0);
      warnSecurityLogSinkUnavailable(cause);
    }
  };

  const startDrain = (): Promise<void> => {
    if (drainPromise !== undefined) return drainPromise;
    drainPromise = drain().finally(() => {
      drainPromise = undefined;
      if (active && pending.length > 0) void startDrain();
    });
    return drainPromise;
  };

  return {
    factory: (stateDir): SecurityLogSink => ({
      write: (event): void => {
        pending.push({ stateDir, event });
        if (active) void startDrain();
      },
    }),
    flush: async (): Promise<void> => {
      active = true;
      while (pending.length > 0 || drainPromise !== undefined) {
        await (drainPromise ?? startDrain());
      }
    },
  };
}

async function runWithDeferredSecurityLog(
  run: (factory: CliSecurityLogSinkFactory) => number | Promise<number>,
): Promise<number> {
  const collector = deferredSecurityLogCollector();
  try {
    return await run(collector.factory);
  } finally {
    // Activating the collector drains events already emitted without loading the server graph for
    // eventless commands. Detached helpers retain their sink after settlement; any later child
    // error therefore starts another serialized drain instead of being stranded in this queue.
    await collector.flush();
  }
}

function warnSecurityLogSinkUnavailable(cause: unknown): void {
  const errorKind = securityErrorKind(cause);
  try {
    process.emitWarning(
      "Keiko CLI security activity-log evidence may be incomplete because the sink is unavailable.",
      {
        type: "KeikoActivityLog",
        code: "KEIKO_CLI_SECURITY_LOG_SINK_UNAVAILABLE",
        detail: `errorKind=${errorKind}`,
      },
    );
  } catch {
    // The warning channel is the last body-free fallback. Logging must never block a repair,
    // uninstall, or portable command when that channel is unavailable too.
  }
}

function runRepairCommand(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
  // Keep repair's established synchronous return on hosts that cannot invoke the Windows shortcut
  // helper. Windows loads the existing file sink only after dispatch, never on `keiko --version`.
  if (process.platform !== "win32" || rest[0] === "--help" || rest[0] === "-h") {
    return runRepairCli(rest, io, env);
  }
  return runWithDeferredSecurityLog((securityLogSinkFactory) =>
    runRepairCli(rest, io, env, { securityLogSinkFactory }),
  );
}

function runLauncherCommand(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
  const command = rest[0];
  const needsWindowsHelper = process.platform === "win32" && command === "install";
  if (!needsWindowsHelper) return runLauncherCli(rest, io, env);
  return runWithDeferredSecurityLog((securityLogSinkFactory) =>
    runLauncherCli(rest, io, env, { securityLogSinkFactory }),
  );
}

function runLifecycleCommand(
  command: "start" | "restart",
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
  const needsWindowsOpener = process.platform === "win32" && rest.includes("--open");
  if (!needsWindowsOpener) return runLifecycleCli(command, rest, io, env);
  return runWithDeferredSecurityLog((securityLogSinkFactory) =>
    runLifecycleCli(command, rest, io, env, { securityLogSinkFactory }),
  );
}

function runUninstallCommand(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
  const help = rest[0] === "--help" || rest[0] === "-h";
  if (process.platform !== "win32" || help) return runUninstallCli(rest, io, env);
  return runWithDeferredSecurityLog((securityLogSinkFactory) =>
    runUninstallCli(rest, io, env, { securityLogSinkFactory }),
  );
}

function runPortableCommand(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> {
  const command = rest[0];
  const noShortcutOperation =
    command === undefined || command === "--help" || command === "-h" || command === "status";
  if (process.platform !== "win32" || noShortcutOperation) return runPortableCli(rest, io, env);
  return runWithDeferredSecurityLog((securityLogSinkFactory) =>
    runPortableCli(rest, io, env, { securityLogSinkFactory }),
  );
}

// A Map has no prototype-chain lookup surface — `.get("toString")` etc. return undefined instead
// of resolving to inherited Object.prototype functions. An object literal indexed by raw argv let
// `keiko toString` dispatch into `Object.prototype.toString`, whose "[object Object]" return
// value became the exit code and crashed `process.exit` with ERR_INVALID_ARG_TYPE (KEIKO-0434).
const COMMAND_HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ["models", runModelsCli],
  ["run", runAgentCli],
  ["context", (rest, io): number | Promise<number> => runContextCli(rest, io)],
  ["verify", (rest, io): number | Promise<number> => runVerifyCli(rest, io)],
  ["gen-tests", runGenTestsCli],
  ["investigate", runInvestigateCli],
  ["evidence", (rest, io, env): number | Promise<number> => runEvidenceCli(rest, io, { env })],
  ["evaluate", (rest, io, env): number | Promise<number> => runEvaluateCli(rest, io, env, {})],
  [
    "prompt-enhancer",
    (rest, io, env): number | Promise<number> => runPromptEnhancerCli(rest, io, env, {}),
  ],
  ["memory", (rest, io, env): number | Promise<number> => runMemoryCli(rest, io, env)],
  ["task-workspace", runTaskWorkspaceCli],
  ["init", runInitCli],
  ["doctor", runDoctorCli],
  ["audit", (rest, io, env): Promise<number> => runAuditCli(rest, io, env)],
  ["support", (rest, io, env): Promise<number> => runSupportCli(rest, io, env)],
  ["repair", runRepairCommand],
  ["uninstall", runUninstallCommand],
  ["update", runUpdateCli],
  [
    "start",
    (rest, io, env): number | Promise<number> => runLifecycleCommand("start", rest, io, env),
  ],
  ["stop", (rest, io, env): number | Promise<number> => runLifecycleCli("stop", rest, io, env)],
  ["status", (rest, io, env): number | Promise<number> => runLifecycleCli("status", rest, io, env)],
  [
    "restart",
    (rest, io, env): number | Promise<number> => runLifecycleCommand("restart", rest, io, env),
  ],
  ["ui", runUiCli],
  ["launcher", runLauncherCommand],
  ["portable", runPortableCommand],
]);

// Dispatches named subcommands; returns undefined when the name is not recognised.
function dispatchCommand(
  name: string,
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
): number | Promise<number> | undefined {
  return COMMAND_HANDLERS.get(name)?.(rest, io, env);
}

function handleMetaCommand(first: string | undefined, io: CliIo): number | undefined {
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP_TEXT);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`keiko ${SDK_VERSION}\n`);
    return 0;
  }
  return undefined;
}

const LOCAL_REEXEC_MARKER = "KEIKO_LOCAL_PACKAGE_REEXEC";
const LOCAL_REEXEC_COMMANDS = new Set(["start", "restart", "ui", "update"]);
type LocalPackageInstall = NonNullable<DoctorReport["localPackageInstall"]>;

function helpRequested(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function commandAllowsLocalReexec(args: readonly string[]): boolean {
  const first = args[0];
  return first !== undefined && LOCAL_REEXEC_COMMANDS.has(first) && !helpRequested(args);
}

function localPackageReexecTarget(report: DoctorReport): LocalPackageInstall | undefined {
  const localInstall = report.localPackageInstall;
  if (report.runningEntry === undefined || localInstall === undefined) return undefined;
  return report.runningEntry === localInstall.cliEntry ? undefined : localInstall;
}

function processEnvForLocalPackageReexec(
  env: EnvSource,
  cliEntry: string,
  staticRoot: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      Reflect.deleteProperty(next, key);
    } else {
      next[key] = value;
    }
  }
  next[LOCAL_REEXEC_MARKER] = "1";
  next.KEIKO_CLI_BIN_PATH = cliEntry;
  next.KEIKO_UI_STATIC_ROOT = staticRoot;
  return next;
}

function runLocalPackageReexec(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: RunCliDeps,
  report: DoctorReport,
  localInstall: LocalPackageInstall,
): number {
  io.err("keiko notice: stale launch path detected; re-running the local package install.\n");
  const result = (deps.spawnSync ?? spawnSync)(process.execPath, [localInstall.cliEntry, ...args], {
    cwd: report.cwd,
    env: processEnvForLocalPackageReexec(env, localInstall.cliEntry, localInstall.staticRoot),
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.error !== undefined) {
    io.err(`keiko: failed to re-run the local package install (${result.error.message}).\n`);
    return 1;
  }
  if (result.signal !== null) {
    io.err(`keiko: local package install exited after signal ${result.signal}.\n`);
    return 1;
  }
  return result.status ?? 1;
}

function maybeReexecLocalPackage(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: RunCliDeps,
): number | undefined {
  if (!commandAllowsLocalReexec(args)) return undefined;
  if (env[LOCAL_REEXEC_MARKER] === "1") return undefined;
  const report = collectDoctorReport({
    cwd: deps.cwd ?? process.cwd(),
    argv: deps.argv ?? process.argv,
  });
  const localInstall = localPackageReexecTarget(report);
  if (localInstall === undefined) return undefined;
  return runLocalPackageReexec(args, io, env, deps, report, localInstall);
}

// Returns a number for synchronous commands; the async `run` command returns a Promise.
// The process shim in index.ts awaits the union before assigning process.exitCode.
export function runCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: RunCliDeps = {},
): number | Promise<number> {
  const first = args[0];
  const meta = handleMetaCommand(first, io);
  if (meta !== undefined) return meta;
  if (first === undefined) {
    io.err("keiko: internal error while dispatching command.\n");
    return 2;
  }
  const reexec = maybeReexecLocalPackage(args, io, env, deps);
  if (reexec !== undefined) return reexec;
  if (first === "start" || first === "ui") {
    emitDoctorWarning(io);
  }
  const result = dispatchCommand(first, args.slice(1), io, env);
  if (result !== undefined) {
    return result;
  }
  io.err(`keiko: unknown ${first.startsWith("-") ? "option" : "command"}: ${first}\n`);
  io.err("Run `keiko --help` for usage.\n");
  return 2;
}
