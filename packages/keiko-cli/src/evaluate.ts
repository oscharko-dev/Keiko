// `keiko evaluate` — runs the evaluation harness (ADR-0012 D10). Offline (default, deterministic, no
// network) replays each fixture's scripted transcript; --live builds a GatewayModelPort and fails
// CLOSED (exit 1, names the required env vars) when no config/credentials resolve — it NEVER silently
// falls back to offline. Dry-run-safe by construction: fixtures choose their own apply mode. Mirrors
// runGenTestsCli structurally (injected CliIo + deps, testable without process.*). Exit 0 when all
// applicable dimensions pass AND surface parity passes; 1 on dimension/parity failure or runtime
// error; 2 on usage error (unknown flag, mutual exclusion, unknown suite/fixture name).

import { writeFileSync } from "node:fs";
import type { EnvSource, GatewayConfig, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import type {
  EvalRunnerDeps,
  EvalScorecard,
  EvaluationFixture,
} from "@oscharko-dev/keiko-evaluations";
import { runGenTestsCli } from "./gen-tests.js";
import { gatewayConfigFileLoader } from "./gateway-config.js";
import { runInvestigateCli } from "./investigate.js";
// GEN-PERF-CLI-001 — gateway/evidence/server/evaluations graphs load at dispatch.
import { loadEvaluations, loadEvidence, loadModelGateway, loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type EvaluationsModule = typeof import("@oscharko-dev/keiko-evaluations");
type EvidenceModule = typeof import("@oscharko-dev/keiko-evidence");

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
  { readonly fixtures: readonly EvaluationFixture[] } | { readonly usageError: string };

// Resolves the fixture set from --suite / --fixture, enforcing mutual exclusion and name validity.
function selectFixtures(parsed: EvaluateArgs, evaluations: EvaluationsModule): Selection {
  if (parsed.suite !== undefined && parsed.fixture !== undefined) {
    return { usageError: "Error: --suite and --fixture are mutually exclusive.\n" };
  }
  if (parsed.fixture !== undefined) {
    const fixture = evaluations.fixtureByName(parsed.fixture);
    return fixture === undefined
      ? { usageError: `Error: unknown fixture "${parsed.fixture}".\n` }
      : { fixtures: [fixture] };
  }
  const suite = parsed.suite ?? "all";
  if (!evaluations.isSuiteName(suite)) {
    return { usageError: `Error: unknown suite "${suite}".\n` };
  }
  return { fixtures: evaluations.fixturesForSuite(suite) };
}

// In live mode, deep-redact the scorecard before serialization so that any model content that
// leaked into workflow report fields (e.g. fixture reasons) is scrubbed by the same audit
// redactor applied at evidence-persist time. Offline scorecard is static harness text — safe as-is.
function redactedScorecard(
  scorecard: EvalScorecard,
  live: boolean,
  env: EnvSource,
  evidence: EvidenceModule,
): unknown {
  if (!live) {
    return scorecard;
  }
  const redactFn = evidence.createAuditRedactor(
    { additionalSecrets: keikoApiKeySecretValues(env) },
    env,
  );
  return evidence.deepRedactStrings(scorecard, redactFn);
}

function writeScorecard(path: string, output: unknown): void {
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function emit(
  scorecard: EvalScorecard,
  parsed: EvaluateArgs,
  io: CliIo,
  env: EnvSource,
  modules: { readonly evaluations: EvaluationsModule; readonly evidence: EvidenceModule },
): void {
  const output = redactedScorecard(scorecard, parsed.live, env, modules.evidence);
  // Emit --json to stdout BEFORE attempting the file write so that a file-already-exists
  // error (EEXIST from writeScorecard) does not silently suppress the JSON output.
  if (parsed.json) {
    io.out(`${JSON.stringify(output, null, 2)}\n`);
  }
  if (parsed.output !== undefined) {
    writeScorecard(parsed.output, output);
  }
  if (!parsed.json) {
    io.out(`${modules.evaluations.renderEvalSummary(scorecard)}\n`);
  }
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
  const [gateway, evaluations, evidence, { parseRunRequest }, configLoader] = await Promise.all([
    loadModelGateway(),
    loadEvaluations(),
    loadEvidence(),
    loadServer(),
    gatewayConfigFileLoader(),
  ]);
  const selection = selectFixtures(parsed, evaluations);
  if ("usageError" in selection) {
    io.err(selection.usageError);
    return 2;
  }
  return runSuite(parsed, selection.fixtures, io, env, deps, {
    gateway,
    evaluations,
    evidence,
    parseRunRequest,
    configLoader,
  });
}

interface EvaluateRuntime {
  readonly gateway: GatewayModule;
  readonly evaluations: EvaluationsModule;
  readonly evidence: EvidenceModule;
  readonly parseRunRequest: (typeof import("@oscharko-dev/keiko-server"))["parseRunRequest"];
  readonly configLoader: (path: string, env: EnvSource) => GatewayConfig;
}

async function runSuite(
  parsed: EvaluateArgs,
  fixtures: readonly EvaluationFixture[],
  io: CliIo,
  env: EnvSource,
  deps: EvaluateDeps,
  runtime: EvaluateRuntime,
): Promise<number> {
  try {
    const liveModelId = resolveLiveModelId(parsed, io, env, runtime);
    if (typeof liveModelId === "number") {
      return liveModelId;
    }
    const scorecard = await runtime.evaluations.runEvaluationSuite(
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
        configLoader: runtime.configLoader,
        surfaceParity: {
          runGenTestsCli,
          runInvestigateCli,
          parseRunRequest: runtime.parseRunRequest,
        },
        ...deps.runner,
      },
    );
    emit(scorecard, parsed, io, env, runtime);
    return exitCodeFor(scorecard);
  } catch (error) {
    if (isOutputAlreadyExistsError(error)) {
      io.err(`Error: output file already exists: ${parsed.output ?? "<unknown>"}\n`);
      return 1;
    }
    return handleRunError(error, parsed, io, runtime.gateway);
  }
}

function resolveLiveModelId(
  parsed: EvaluateArgs,
  io: CliIo,
  env: EnvSource,
  runtime: EvaluateRuntime,
): string | undefined | number {
  if (!parsed.live) {
    return parsed.model;
  }
  const { gateway, configLoader } = runtime;
  try {
    const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new gateway.ConfigInvalidError(
        "no config source; pass --config PATH or set KEIKO_CONFIG_FILE",
      );
    }
    const config = configLoader(path, env);
    if (parsed.model !== undefined) {
      assertLiveEvaluationModel(config, parsed.model, gateway);
      return parsed.model;
    }
    const modelId = selectLiveEvaluationModel(config, gateway);
    if (modelId === undefined) {
      io.err("Error: no configured workflow-capable chat model is available.\n");
      return 1;
    }
    return modelId;
  } catch (error) {
    if (error instanceof gateway.GatewayError) {
      io.err(
        `Error: model gateway configuration problem — ${gateway.redact(error.message)}\n` +
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

function selectLiveEvaluationModel(
  config: GatewayConfig,
  gateway: GatewayModule,
): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of gateway.listConfiguredCapabilities(config)) {
    if (!isLiveEvaluationCapable(capability)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

function assertLiveEvaluationModel(
  config: GatewayConfig,
  modelId: string,
  gateway: GatewayModule,
): void {
  gateway.assertConfiguredModel(config, modelId);
  if (!isLiveEvaluationCapable(gateway.findConfiguredCapability(config, modelId))) {
    throw new gateway.ConfigInvalidError(
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
function handleRunError(
  error: unknown,
  parsed: EvaluateArgs,
  io: CliIo,
  gateway: GatewayModule,
): number {
  if (error instanceof gateway.GatewayError) {
    io.err(
      `Error: model gateway configuration problem — ${gateway.redact(error.message)}\n` +
        (parsed.live
          ? "Live evaluation requires a configured provider. Pass --config PATH or set " +
            "KEIKO_CONFIG_FILE.\n"
          : ""),
    );
    return 1;
  }
  throw error;
}
