// CLI parsing and composition for the closed offline support report (ADR-0173).
import { closeSync, mkdirSync, writeFileSync } from "node:fs";

import { homedir as defaultHomedir } from "node:os";

import { dirname } from "node:path";

import {
  activityLogEvent,
  defineActivityLogOperation,
  MAX_SUPPORT_REPORT_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

import { emitSecurityLogEvent, securityErrorKind } from "@oscharko-dev/keiko-security";

import { openSafeArtifactFile } from "@oscharko-dev/keiko-security/fs-hardening";

// KEIKO-0655: shared argv-parsing helper replaces the byte-identical flagValue copy this file held.
import { flagValue } from "./cli-arg-parsing.js";

import {
  cliControlStateConflictsWithTarget,
  cliTargetIdentitySha256,
  resolveCliControlStateDir,
} from "./cli-control-state.js";

import {
  installLayoutOverrideEvidence,
  writeInstallLayoutOverrideEvidenceWithFactory,
} from "./install-layout.js";

// Load report composition only when export/analyze is dispatched.
import type { CliIo } from "./runner.js";

import { createCliSecurityLogSink, type CliSecurityLogSinkFactory } from "./security-log.js";

import { inspectStateRoot, resolveStateDir } from "./state-paths.js";

import { runSupportIncidentCli } from "./support-incident.js";

import {
  parseSupportManifestArgs,
  parseSupportQueryArgs,
  runSupportManifestCli,
  runSupportQueryCli,
  SUPPORT_QUERY_USAGE,
  type SupportManifestArgs,
  type SupportQueryArgs,
  type SupportSelectorArgs,
} from "./support-query-cli.js";

import { parseSupportExportSelector } from "./support-selective-export.js";

import { describeErrorKind } from "./support-export.js";

const USAGE = `Usage:
  keiko support export [--out DIRECTORY] [--state-dir PATH] [--max-bytes N]
                        [--incident ID | --correlation-id ID | --defect-fingerprint SHA256]
  keiko support analyze FILE [--correlation-id ID] [--json] [--clusters]
                        [--seed] [--emit-fixture PATH]
  keiko support incident list|show|preview|report|dismiss [ID] [--state-dir PATH] [--json]
  keiko support query ... and keiko support manifest rebuild|verify

Export creates one private canonical report, with embedded integrity and selective registered
causal evidence. --out selects a private directory; the filename always uses the closed class.
The default is <state-dir>/support-reports/keiko-support-v1-<incident-prefix>-<UTC-date>.json.
The hard maximum is 10 MiB; --max-bytes may lower it. Required evidence never silently disappears:
a closure that cannot fit is explicitly insufficient. Existing targets are never overwritten.
No attachments, raw logs, config snapshots, evidence manifests, sidecars or inclusion flags.
Nothing is sent. Manually share only through your organization's approved channel.

Analyze bounds and validates the entire untrusted report before human or machine output. It uses
the recorded registry, performs no embedded filesystem or network lookup, and reports authenticity
as unknown. --json emits the versioned body-free machine view. --seed prepares deterministic replay
from the incident's correlation; --emit-fixture exclusively writes an explicitly selected fixture.
Legacy bundles with open sections are refused: regenerate a report on the originating installation.
`;

export interface SupportCliDeps {
  readonly cwd?: string | undefined;
  readonly activityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly controlActivityStateDir?: string | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const CLI_SUPPORT_EXPORT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.support.export.failed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "support.emitSupportInstallLayoutRefusal",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unsafe-state-root", "activity-log-unavailable", "state-root-validation-failed"],
    },
    targetSha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["cli-support-export"],
  proofIds: ["cli.support.export.failed.install-layout-refusal"],
  releaseImpact: "patch",
});

type SupportInstallLayoutFailureReason =
  "unsafe-state-root" | "activity-log-unavailable" | "state-root-validation-failed";

interface SupportRefusalContext {
  readonly stateDir: string;
  readonly controlStateDir: string;
  readonly correlationId: string;
  readonly factory: CliSecurityLogSinkFactory | undefined;
}

function emitSupportInstallLayoutRefusal(
  context: SupportRefusalContext,
  failureKind: string,
  reason: SupportInstallLayoutFailureReason,
): void {
  try {
    if (cliControlStateConflictsWithTarget(context.controlStateDir, context.stateDir)) return;
  } catch {
    return;
  }
  const sink = createCliSecurityLogSink(
    context.controlStateDir,
    context.factory,
    context.correlationId,
  );
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      CLI_SUPPORT_EXPORT_FAILED_OPERATION,
      {
        level: "error",
        correlationId: context.correlationId,
        errorKind: reason === "unsafe-state-root" ? "unsafe-target" : "unavailable",
      },
      {
        reason,
        targetSha256: cliTargetIdentitySha256(context.stateDir),
        failureKind,
      },
    ),
  );
}

function refuseSupportInstallLayout(
  context: SupportRefusalContext,
  failureKind: string,
  reason: SupportInstallLayoutFailureReason,
): "refused" {
  emitSupportInstallLayoutRefusal(context, failureKind, reason);
  return "refused";
}

function writeSupportInstallLayoutEvidence(
  stateDir: string,
  env: EnvSource,
  deps: SupportCliDeps,
): "ready" | "refused" {
  const evidence = installLayoutOverrideEvidence(env);
  if (evidence === undefined) return "ready";
  const controlStateDir =
    deps.controlActivityStateDir ??
    resolveCliControlStateDir(
      deps.platform ?? process.platform,
      (deps.homedir ?? defaultHomedir)(),
    );
  const context: SupportRefusalContext = {
    stateDir,
    controlStateDir,
    correlationId: evidence.correlationId,
    factory: deps.activityLogSinkFactory,
  };
  try {
    const stateRoot = inspectStateRoot(stateDir);
    if (stateRoot.status === "symlink") {
      return refuseSupportInstallLayout(
        context,
        "SupportStateRootSymlinkError",
        "unsafe-state-root",
      );
    }
    if (stateRoot.status === "not-directory") {
      return refuseSupportInstallLayout(
        context,
        "SupportStateRootNotDirectoryError",
        "unsafe-state-root",
      );
    }
    return writeInstallLayoutOverrideEvidenceWithFactory(deps.activityLogSinkFactory, stateDir, env)
      ? "ready"
      : refuseSupportInstallLayout(
          context,
          "SupportActivityLogUnavailableError",
          "activity-log-unavailable",
        );
  } catch (error) {
    return refuseSupportInstallLayout(
      context,
      securityErrorKind(error),
      "state-root-validation-failed",
    );
  }
}

function prepareSupportInstallLayoutEvidence(
  stateDir: string,
  env: EnvSource,
  deps: SupportCliDeps,
  io: CliIo,
): boolean {
  if (writeSupportInstallLayoutEvidence(stateDir, env, deps) === "ready") return true;
  io.err(
    "keiko support export: refusing to consume a normalized install path because durable " +
      "activity logging is unavailable.\n",
  );
  return false;
}

interface ExportArgs {
  readonly out: string | undefined;
  readonly stateDir: string | undefined;
  readonly maxBytes: number | undefined;
  // An omitted selector creates a local user-reported incident.
  readonly selector?: SupportSelectorArgs | undefined;
}

// The flags that once attached the raw `ui.log` (#3532). They are refused explicitly rather than
// ignored, so an operator who still passes them learns that no report can carry raw UI output.
const RETIRED_UI_LOG_FLAGS: readonly string[] = [
  "--include-evidence",
  "--include-ui-log",
  "--i-understand-this-is-unredacted",
];

interface AnalyzeArgs {
  readonly file: string;
  readonly correlationId: string | undefined;
  readonly json: boolean;
  // Wave 6 (epic #3233 closeout, gap #1): a whole-file view of `analyzeLogText`'s own `clusters`
  // field, independent of --correlation-id.
  readonly clusters: boolean;
  // Both require --correlation-id (parseAnalyzeArgs rejects them otherwise) since both are built
  // from `buildReproductionSeed`, which is defined for exactly one correlationId.
  readonly seed: boolean;
  readonly emitFixture: string | undefined;
}

export type ParsedSupportArgs =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "export"; readonly value: ExportArgs }
  | { readonly kind: "analyze"; readonly value: AnalyzeArgs }
  // #3533: local incident candidates; the incident module parses its own arguments.
  | { readonly kind: "incident"; readonly args: readonly string[] }
  // #3531: streaming machine queries and the rebuildable segment manifests.
  | { readonly kind: "query-help" }
  | { readonly kind: "query"; readonly value: SupportQueryArgs }
  | { readonly kind: "manifest"; readonly value: SupportManifestArgs };

type ParseResult<T> =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "ok"; readonly value: T };

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// The answers that need no flag parsing: help, and the refusal of a retired ui.log flag.
function exportArgsEarlyResult(args: readonly string[]): ParseResult<ExportArgs> | undefined {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (!RETIRED_UI_LOG_FLAGS.some((flag) => args.includes(flag))) return undefined;
  return {
    kind: "usage",
    message:
      "keiko support export: inclusion flags are no longer supported; raw output is never " +
      `part of a support report. Every UI diagnostic is in the Activity Log.\n${USAGE}`,
  };
}

function parseExportArgs(args: readonly string[]): ParseResult<ExportArgs> {
  const early = exportArgsEarlyResult(args);
  if (early !== undefined) return early;
  const out = flagValue(args, "--out");
  const stateDir = flagValue(args, "--state-dir");
  const maxBytesRaw = flagValue(args, "--max-bytes");
  if (out === null || stateDir === null || maxBytesRaw === null) {
    return {
      kind: "usage",
      message: `keiko support export: a flag is missing its value.\n${USAGE}`,
    };
  }
  const maxBytes = maxBytesRaw === undefined ? undefined : parsePositiveInteger(maxBytesRaw);
  if (
    maxBytesRaw !== undefined &&
    (maxBytes === undefined || maxBytes > MAX_SUPPORT_REPORT_BYTES)
  ) {
    return {
      kind: "usage",
      message: `keiko support export: --max-bytes must be between 1 and 10485760.\n${USAGE}`,
    };
  }
  const selection = parseSupportExportSelector(args);
  if (selection.kind === "usage") {
    return { kind: "usage", message: `keiko support export: ${selection.message}\n${USAGE}` };
  }
  return {
    kind: "ok",
    value: {
      out,
      stateDir,
      maxBytes,
      selector: selection.selector,
    },
  };
}

function parseAnalyzeArgs(args: readonly string[]): ParseResult<AnalyzeArgs> {
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const file = args[0];
  if (file === undefined || file.startsWith("--")) {
    return {
      kind: "usage",
      message: `keiko support analyze: a FILE argument is required.\n${USAGE}`,
    };
  }
  const rest = args.slice(1);
  const correlationId = flagValue(rest, "--correlation-id");
  if (correlationId === null) {
    return {
      kind: "usage",
      message: `keiko support analyze: --correlation-id is missing its value.\n${USAGE}`,
    };
  }
  const emitFixture = flagValue(rest, "--emit-fixture");
  if (emitFixture === null) {
    return {
      kind: "usage",
      message: `keiko support analyze: --emit-fixture is missing its value.\n${USAGE}`,
    };
  }
  const seed = rest.includes("--seed");
  return {
    kind: "ok",
    value: {
      file,
      correlationId,
      json: rest.includes("--json"),
      clusters: rest.includes("--clusters"),
      seed,
      emitFixture,
    },
  };
}

export function parseSupportArgs(args: readonly string[]): ParsedSupportArgs {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return { kind: "help" };
  }
  if (subcommand === "export") {
    const parsed = parseExportArgs(rest);
    return parsed.kind === "ok" ? { kind: "export", value: parsed.value } : parsed;
  }
  if (subcommand === "analyze") {
    const parsed = parseAnalyzeArgs(rest);
    return parsed.kind === "ok" ? { kind: "analyze", value: parsed.value } : parsed;
  }
  if (subcommand === "incident") return { kind: "incident", args: rest };
  return parseQuerySubcommand(subcommand, rest);
}

function parseQuerySubcommand(subcommand: string, rest: readonly string[]): ParsedSupportArgs {
  if (subcommand === "query") {
    const parsed = parseSupportQueryArgs(rest);
    if (parsed.kind === "help") return { kind: "query-help" };
    return parsed.kind === "ok" ? { kind: "query", value: parsed.value } : parsed;
  }
  if (subcommand === "manifest") {
    const parsed = parseSupportManifestArgs(rest);
    if (parsed.kind === "help") return { kind: "query-help" };
    return parsed.kind === "ok" ? { kind: "manifest", value: parsed.value } : parsed;
  }
  return { kind: "usage", message: `keiko support: unknown subcommand: ${subcommand}\n${USAGE}` };
}

async function runSupportExport(
  args: ExportArgs,
  io: CliIo,
  env: EnvSource,
  deps: SupportCliDeps,
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = resolveStateDir(cwd, env, args.stateDir);
  if (!prepareSupportInstallLayoutEvidence(stateDir, env, deps, io)) return 1;
  return (await import("./support-report-cli.js")).runSafeSupportExport(args, io, env, deps);
}

// Fail-closed (disclosed gap #1's fix): never overwrites or follows an existing entry — a fixture
// is meant to be hand-edited after generation, and silently clobbering that would destroy real
// work. The one file is created exclusively in place through the shared hardened primitive, with
// the trust root a user-chosen `--out` report uses (the destination's own directory): a live or
// dangling symlink, hard link, or FIFO at PATH is refused as an existing target, nothing is ever
// created at a link's target, and no staging or recovery files are left beside it. The parent
// directory is created first so `--emit-fixture some/new/dir/fixture.ts` does not require the
// operator to `mkdir -p`. Content-free error reporting: only the closed failure kind is printed.
function writeFixtureOrExitCode(path: string, contents: string, io: CliIo): number | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const descriptor = openSafeArtifactFile(path, {
      artifactClass: "replay-fixture",
      mode: "exclusive-create",
      trustedRoot: dirname(path),
    });
    try {
      writeFileSync(descriptor, contents, "utf8");
    } finally {
      closeSync(descriptor);
    }
    return undefined;
  } catch (error) {
    const kind = describeErrorKind(error);
    io.err(
      kind === "target-exists"
        ? `keiko support analyze: refusing to overwrite existing file: ${path}\n`
        : `keiko support analyze: could not write fixture: ${kind}\n`,
    );
    return 1;
  }
}

export async function runSupportCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: SupportCliDeps = {},
): Promise<number> {
  const parsed = parseSupportArgs(args);
  if (parsed.kind === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed.kind === "usage") {
    io.err(parsed.message);
    return 2;
  }
  if (parsed.kind === "export") {
    return runSupportExport(parsed.value, io, env, deps);
  }
  if (parsed.kind === "incident") {
    return runSupportIncidentCli(parsed.args, io, env, { cwd: deps.cwd });
  }
  if (parsed.kind === "query-help") {
    io.out(SUPPORT_QUERY_USAGE);
    return 0;
  }
  if (parsed.kind === "query") return runSupportQueryCli(parsed.value, io, env, { cwd: deps.cwd });
  if (parsed.kind === "manifest") {
    return runSupportManifestCli(parsed.value, io, env, { cwd: deps.cwd });
  }
  return (await import("./support-report-cli.js")).runSafeSupportAnalyze(
    parsed.value,
    io,
    env,
    deps,
    writeFixtureOrExitCode,
  );
}
