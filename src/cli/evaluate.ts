// `keiko evaluate` — runs the evaluation harness (ADR-0012 D10). Offline (default, deterministic, no
// network) replays each fixture's scripted transcript; --live builds a GatewayModelPort and fails
// CLOSED (exit 1, names the required env vars) when no config/credentials resolve — it NEVER silently
// falls back to offline. Dry-run-safe by construction: fixtures choose their own apply mode. Mirrors
// runGenTestsCli structurally (injected CliIo + deps, testable without process.*). Exit 0 when all
// applicable dimensions pass AND surface parity passes; 1 on dimension/parity failure or runtime
// error; 2 on usage error (unknown flag, mutual exclusion, unknown suite/fixture name).

import { writeFileSync } from "node:fs";
import { GatewayError } from "../gateway/errors.js";
import { redact } from "../gateway/redaction.js";
import type { EnvSource } from "../gateway/config.js";
import { createAuditRedactor, deepRedactStrings } from "../audit/index.js";
import {
  fixtureByName,
  fixturesForSuite,
  isSuiteName,
  renderEvalSummary,
  runEvaluationSuite,
  type EvalRunnerDeps,
  type EvalScorecard,
  type EvaluationFixture,
} from "../evaluations/index.js";
import type { CliIo } from "./runner.js";

const USAGE = `Usage:
  keiko evaluate [--suite <unit-tests|bug-investigation|all>] [--fixture <name>]
                 [--live] [--model <id>] [--json] [--output <path>]

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

const VALUE_FLAGS = ["--suite", "--fixture", "--model", "--output"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

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
  const redactFn = createAuditRedactor({ additionalSecrets: [] }, env);
  return deepRedactStrings(scorecard, redactFn);
}

function emit(scorecard: EvalScorecard, parsed: EvaluateArgs, io: CliIo, env: EnvSource): void {
  const output = redactedScorecard(scorecard, parsed.live, env);
  if (parsed.output !== undefined) {
    writeFileSync(parsed.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
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
    const scorecard = await runEvaluationSuite(
      {
        mode: parsed.live ? "live" : "offline",
        fixtures,
        ...(parsed.model === undefined ? {} : { modelIdOverride: parsed.model }),
      },
      // Provide Date.now as the default wall-clock so a real `keiko evaluate` prints the actual
      // current time. Tests override this via deps.runner.now for deterministic evaluatedAt.
      { env, now: Date.now, ...deps.runner },
    );
    emit(scorecard, parsed, io, env);
    return exitCodeFor(scorecard);
  } catch (error) {
    return handleRunError(error, parsed, io);
  }
}

// Live-mode fail-closed: a GatewayError (incl. ConfigInvalidError) means no resolvable config or
// credentials. Name the required env vars and exit 1 — never fall back to offline silently.
function handleRunError(error: unknown, parsed: EvaluateArgs, io: CliIo): number {
  if (error instanceof GatewayError) {
    io.err(
      `Error: model gateway configuration problem — ${redact(error.message)}\n` +
        (parsed.live
          ? "Live evaluation requires a configured provider. Provide keiko.config.json or set " +
            "KEIKO_DEFAULT_API_KEY and KEIKO_DEFAULT_BASE_URL.\n"
          : ""),
    );
    return 1;
  }
  throw error;
}
