// `keiko evaluate` — runs the evaluation harness (ADR-0012 D10). Offline (default, deterministic, no
// network) replays each fixture's scripted transcript; --live builds a GatewayModelPort and fails
// CLOSED (exit 1, names the required env vars) when no config/credentials resolve — it NEVER silently
// falls back to offline. Dry-run-safe by construction: fixtures choose their own apply mode. Mirrors
// runGenTestsCli structurally (injected CliIo + deps, testable without process.*). Exit 0 when all
// applicable dimensions pass AND surface parity passes; 1 on dimension/parity failure or runtime
// error; 2 on usage error (unknown flag, mutual exclusion, unknown suite/fixture name).

import { writeFileSync } from "node:fs";
import {
  ConfigInvalidError,
  GatewayError,
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  loadConfigFromFile,
  redact,
  type EnvSource,
  type GatewayConfig,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import { parseRunRequest } from "@oscharko-dev/keiko-server";
import {
  fixtureByName,
  fixturesForSuite,
  isSuiteName,
  renderEvalSummary,
  runEvaluationSuite,
  type EvalRunnerDeps,
  type EvalScorecard,
  type EvaluationFixture,
} from "@oscharko-dev/keiko-evaluations";
import { runGenTestsCli } from "./gen-tests.js";
import { runInvestigateCli } from "./investigate.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko evaluate [--suite <unit-tests|bug-investigation|all>] [--fixture <name>]
                 [--live] [--model <id>] [--config PATH] [--json] [--output <path>]

Runs the evaluation harness against the built-in fixtures. Offline by default
(deterministic, no network); pass --live to evaluate against a configured model.
--suite and --fixture are mutually exclusive.
`;

export interface EvaluateDeps {
  readonly runner?: EvalRunnerDeps | undefined;
}

interface EvaluateArgs {
  readonly suite: string | undefined;
  readonly fixture: string | undefined;
  readonly live: boolean;
  readonly model: string | undefined;
  readonly config: string | undefined;
  readonly json: boolean;
  readonly output: string | undefined;
}

function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const VALUE_FLAGS = ["--suite", "--fixture", "--model", "--config", "--output"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const BOOLEAN_FLAGS = ["--live", "--json"] as const;

function readValueFlags(args: readonly string[]): Record<ValueFlag, string | undefined> | null {
  const values = {} as Record<ValueFlag, string | undefined>;
  for (const flag of VALUE_FLAGS) {
    const value = flagValue(args, flag);
    if (value === null) {
      return null;
    }
    values[flag] = value;
  }
  return values;
}

function isValueFlag(value: string): value is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(value);
}

function isBooleanFlag(value: string): boolean {
  return (BOOLEAN_FLAGS as readonly string[]).includes(value);
}

function findUsageError(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (isValueFlag(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return `missing value for ${arg}`;
      }
      i += 1;
      continue;
    }
    if (isBooleanFlag(arg)) {
      continue;
    }
    return arg.startsWith("--") ? `unknown flag ${arg}` : `unexpected argument ${arg}`;
  }
  return undefined;
}

function parseArgs(args: readonly string[]): EvaluateArgs | null {
  const values = readValueFlags(args);
  if (values === null) {
    return null;
  }
  return {
    suite: values["--suite"],
    fixture: values["--fixture"],
    live: args.includes("--live"),
    model: values["--model"],
    config: values["--config"],
    json: args.includes("--json"),
    output: values["--output"],
  };
}

type Selection =
  | { readonly fixtures: readonly EvaluationFixture[] }
  | { readonly usageError: string };

// Resolves the fixture set from --suite / --fixture, enforcing mutual exclusion and name validity.
function selectFixtures(parsed: EvaluateArgs): Selection {
  if (parsed.suite !== undefined && parsed.fixture !== undefined) {
    return { usageError: "Error: --suite and --fixture are mutually exclusive.\n" };
  }
  if (parsed.fixture !== undefined) {
    const fixture = fixtureByName(parsed.fixture);
    return fixture === undefined
      ? { usageError: `Error: unknown fixture "${parsed.fixture}".\n` }
      : { fixtures: [fixture] };
  }
  const suite = parsed.suite ?? "all";
  if (!isSuiteName(suite)) {
    return { usageError: `Error: unknown suite "${suite}".\n` };
  }
  return { fixtures: fixturesForSuite(suite) };
}

// In live mode, deep-redact the scorecard before serialization so that any model content that
// leaked into workflow report fields (e.g. fixture reasons) is scrubbed by the same audit
// redactor applied at evidence-persist time. Offline scorecard is static harness text — safe as-is.
function redactedScorecard(scorecard: EvalScorecard, live: boolean, env: EnvSource): unknown {
  if (!live) {
    return scorecard;
  }
  const redactFn = createAuditRedactor({ additionalSecrets: keikoApiKeySecretValues(env) }, env);
  return deepRedactStrings(scorecard, redactFn);
}

function writeScorecard(path: string, output: unknown): void {
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function emit(scorecard: EvalScorecard, parsed: EvaluateArgs, io: CliIo, env: EnvSource): void {
  const output = redactedScorecard(scorecard, parsed.live, env);
  if (parsed.output !== undefined) {
    writeScorecard(parsed.output, output);
  }
  if (parsed.json) {
    io.out(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  io.out(`${renderEvalSummary(scorecard)}\n`);
}

// Exit 0 only when every scored dimension passed (zero failures) AND surface parity passed.
function exitCodeFor(scorecard: EvalScorecard): number {
  if (!scorecard.surfaceParity.allPassed) {
    return 1;
  }
  return scorecard.dimensions.some((d) => d.failCount > 0) ? 1 : 0;
}

export async function runEvaluateCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: EvaluateDeps = {},
): Promise<number> {
  if (args.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  const usageError = findUsageError(args);
  if (usageError !== undefined) {
    io.err(`Error: ${usageError}.\n${USAGE}`);
    return 2;
  }
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  const selection = selectFixtures(parsed);
  if ("usageError" in selection) {
    io.err(selection.usageError);
    return 2;
  }
  return runSuite(parsed, selection.fixtures, io, env, deps);
}

async function runSuite(
  parsed: EvaluateArgs,
  fixtures: readonly EvaluationFixture[],
  io: CliIo,
  env: EnvSource,
  deps: EvaluateDeps,
): Promise<number> {
  try {
    const liveModelId = resolveLiveModelId(parsed, io, env);
    if (typeof liveModelId === "number") {
      return liveModelId;
    }
    const scorecard = await runEvaluationSuite(
      {
        mode: parsed.live ? "live" : "offline",
        fixtures,
        ...(liveModelId === undefined ? {} : { modelIdOverride: liveModelId }),
        ...(parsed.config === undefined ? {} : { configPath: parsed.config }),
      },
      // Provide Date.now as the default wall-clock so a real `keiko evaluate` prints the actual
      // current time. Tests override this via deps.runner.now for deterministic evaluatedAt.
      {
        env,
        now: Date.now,
        surfaceParity: {
          runGenTestsCli,
          runInvestigateCli,
          parseRunRequest,
        },
        ...deps.runner,
      },
    );
    emit(scorecard, parsed, io, env);
    return exitCodeFor(scorecard);
  } catch (error) {
    if (isOutputAlreadyExistsError(error)) {
      io.err(`Error: output file already exists: ${parsed.output ?? "<unknown>"}\n`);
      return 1;
    }
    return handleRunError(error, parsed, io);
  }
}

function resolveLiveModelId(
  parsed: EvaluateArgs,
  io: CliIo,
  env: EnvSource,
): string | undefined | number {
  if (!parsed.live) {
    return parsed.model;
  }
  try {
    const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new ConfigInvalidError("no config source; pass --config PATH or set KEIKO_CONFIG_FILE");
    }
    const config = loadConfigFromFile(path, env);
    if (parsed.model !== undefined) {
      assertLiveEvaluationModel(config, parsed.model);
      return parsed.model;
    }
    const modelId = selectLiveEvaluationModel(config);
    if (modelId === undefined) {
      io.err("Error: no configured workflow-capable chat model is available.\n");
      return 1;
    }
    return modelId;
  } catch (error) {
    if (error instanceof GatewayError) {
      io.err(
        `Error: model gateway configuration problem — ${redact(error.message)}\n` +
          `Provide a gateway config with --config PATH or KEIKO_CONFIG_FILE.\n`,
      );
      return 1;
    }
    throw error;
  }
}

function isLiveEvaluationCapable(capability: ModelCapability | undefined): boolean {
  return (
    capability?.kind === "chat" &&
    capability.workflowEligible &&
    capability.toolCalling &&
    capability.structuredOutput
  );
}

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;

function selectLiveEvaluationModel(config: GatewayConfig): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!isLiveEvaluationCapable(capability)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

function assertLiveEvaluationModel(config: GatewayConfig, modelId: string): void {
  assertConfiguredModel(config, modelId);
  if (!isLiveEvaluationCapable(findConfiguredCapability(config, modelId))) {
    throw new ConfigInvalidError(
      `model '${modelId}' is not workflow-capable; live evaluation requires chat + tool-calling + structured-output`,
    );
  }
}

function isOutputAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

// Live-mode fail-closed: a GatewayError (incl. ConfigInvalidError) means no resolvable config or
// credentials. Name the required env vars and exit 1 — never fall back to offline silently.
function handleRunError(error: unknown, parsed: EvaluateArgs, io: CliIo): number {
  if (error instanceof GatewayError) {
    io.err(
      `Error: model gateway configuration problem — ${redact(error.message)}\n` +
        (parsed.live
          ? "Live evaluation requires a configured provider. Pass --config PATH or set " +
            "KEIKO_CONFIG_FILE.\n"
          : ""),
    );
    return 1;
  }
  throw error;
}
