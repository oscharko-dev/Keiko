// `keiko prompt-enhancer` — the developer-facing surface for the Prompt Enhancer (Epic #1307, Issue
// #1314; ADR-0044 §1 "CLI command"). It drives the EXACT SAME deterministic orchestration as the BFF
// route (`runPromptEnhancement` from keiko-server), so the product and developer surfaces produce
// byte-identical enhancements (AC1). The command never dispatches a model: enhancement is deterministic
// and provider-neutral; an optional `--model` only resolves dispatch readiness through the Model
// Gateway (AC3). All printed output is redacted (AC4); `--evidence` emits a redact-by-construction
// audit manifest reusing the #1313 keiko-evidence promptEnhancement store.

import {
  ConfigInvalidError,
  GatewayError,
  loadConfigFromFile,
  redact,
  type EnvSource,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { PromptEnhancementInputError, runPromptEnhancement } from "@oscharko-dev/keiko-server";
import {
  validatePromptEnhancementWireRequest,
  type PromptEnhancementWireRequest,
  type PromptEnhancementWireResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  buildPromptEnhancementEvidenceManifest,
  createAuditRedactor,
  deepRedactStrings,
  type PromptEnhancementRecordInput,
} from "@oscharko-dev/keiko-evidence";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import type { CliIo } from "./runner.js";

// Test seams: production wires the real keiko-server orchestrator and config loader; tests inject
// deterministic fakes so the command is exercised without disk or a real gateway.
export interface PromptEnhancerCliDeps {
  readonly run?: typeof runPromptEnhancement;
  readonly loadConfig?: (path: string, env: EnvSource) => GatewayConfig;
}

const USAGE = `Usage: keiko prompt-enhancer --input "<raw prompt>" [OPTIONS]

Generate a governed, reviewable Enhanced Prompt from a raw draft. Deterministic and provider-neutral;
the result is data for review, never executed.

Options:
  --input TEXT       The raw prompt draft to enhance (required).
  --profile ID       Preferred profile: fast | precise | research | creative | technical |
                     safety-critical | agentic. Safety criticality may still escalate it.
  --strategy MODE    How to handle missing information: clarify (default) | assume.
  --candidates N     Number of candidate variants to score (1-7).
  --model ID         Resolve dispatch readiness for this model through the Model Gateway. Requires a
                     gateway config (--config PATH or KEIKO_CONFIG_FILE).
  --config PATH      Gateway config file (also honored via KEIKO_CONFIG_FILE).
  --evidence         Also print a redacted, content-light audit evidence manifest.
  --json             Print the full enhancement result as redacted JSON.
`;

const VALUE_FLAGS = [
  "--input",
  "--profile",
  "--strategy",
  "--candidates",
  "--model",
  "--config",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

type BooleanFlagKey = "json" | "evidence" | "help";
const BOOLEAN_FLAG_KEYS: Readonly<Record<string, BooleanFlagKey>> = {
  "--json": "json",
  "--evidence": "evidence",
  "--help": "help",
  "-h": "help",
};

const isValueFlag = (value: string): value is ValueFlag =>
  (VALUE_FLAGS as readonly string[]).includes(value);

interface ParsedFlags {
  readonly values: Partial<Record<ValueFlag, string>>;
  readonly json: boolean;
  readonly evidence: boolean;
  readonly help: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly error: string };

function parseArgs(args: readonly string[]): ParseResult {
  const values: Partial<Record<ValueFlag, string>> = {};
  const bools = { json: false, evidence: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (isValueFlag(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `missing value for ${arg}` };
      }
      values[arg] = value;
      i += 1;
      continue;
    }
    const boolKey = BOOLEAN_FLAG_KEYS[arg];
    if (boolKey !== undefined) {
      bools[boolKey] = true;
      continue;
    }
    return {
      ok: false,
      error: arg.startsWith("--") ? `unknown flag ${arg}` : `unexpected argument ${arg}`,
    };
  }
  return { ok: true, flags: { values, ...bools } };
}

// Build the wire request from flags and validate it with the same validator the BFF route uses, so the
// CLI and API reject identical malformed inputs. Numeric/enumerated flags are coerced before validation.
function buildWireRequest(
  flags: ParsedFlags,
): { ok: true; request: PromptEnhancementWireRequest } | { ok: false; errors: readonly string[] } {
  const candidate: Record<string, unknown> = { text: flags.values["--input"] };
  if (flags.values["--profile"] !== undefined)
    candidate.profilePreference = flags.values["--profile"];
  if (flags.values["--strategy"] !== undefined) {
    candidate.missingInformationStrategy = flags.values["--strategy"];
  }
  if (flags.values["--model"] !== undefined) candidate.modelId = flags.values["--model"];
  if (flags.values["--candidates"] !== undefined) {
    const parsed = Number(flags.values["--candidates"]);
    candidate.candidateCount = Number.isNaN(parsed) ? flags.values["--candidates"] : parsed;
  }
  const validation = validatePromptEnhancementWireRequest(candidate);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  return { ok: true, request: validation.value };
}

function resolveGatewayConfig(
  flags: ParsedFlags,
  env: EnvSource,
  io: CliIo,
  deps: PromptEnhancerCliDeps,
): { ok: true; config: GatewayConfig | undefined } | { ok: false; code: number } {
  // A model is only checked for downstream-dispatch readiness when --model is given. Without it,
  // enhancement is fully deterministic and needs no config.
  if (flags.values["--model"] === undefined) {
    return { ok: true, config: undefined };
  }
  const path = flags.values["--config"] ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    io.err(
      "Error: --model requires a gateway config to resolve readiness; pass --config PATH or set KEIKO_CONFIG_FILE.\n",
    );
    return { ok: false, code: 1 };
  }
  try {
    const load = deps.loadConfig ?? loadConfigFromFile;
    return { ok: true, config: load(path, env) };
  } catch (error) {
    if (error instanceof GatewayError || error instanceof ConfigInvalidError) {
      io.err(
        `Error: model gateway configuration problem — ${redact(error.message)}\n` +
          "Provide a valid gateway config with --config PATH or KEIKO_CONFIG_FILE.\n",
      );
      return { ok: false, code: 1 };
    }
    throw error;
  }
}

function evidenceStatus(
  decision: PromptEnhancementWireResponse["safety"]["decision"],
): PromptEnhancementRecordInput["status"] {
  if (decision === "accepted") return "validated";
  if (decision === "rejected") return "rejected";
  return "requires-human-review";
}

function evidenceCandidateRows(
  candidates: PromptEnhancementWireResponse["candidates"],
): PromptEnhancementRecordInput["candidateScores"] {
  return candidates.scorecards.map((scorecard) => ({
    candidateId: scorecard.candidateId,
    profile: scorecard.profile,
    aggregateScore: scorecard.aggregateScore,
    estimatedTokens: scorecard.estimatedTokens,
    selected: scorecard.candidateId === candidates.winnerCandidateId,
  }));
}

function evidenceModelMetadata(
  routing: PromptEnhancementWireResponse["modelRouting"],
  winnerProfile: string | undefined,
): PromptEnhancementRecordInput["modelMetadata"] {
  return {
    deterministic: true,
    ...(routing.resolvedModelId === undefined ? {} : { modelId: routing.resolvedModelId }),
    ...(winnerProfile === undefined ? {} : { profile: winnerProfile }),
  };
}

function buildEvidenceManifest(
  rawInput: string,
  result: PromptEnhancementWireResponse,
  env: EnvSource,
): unknown {
  const winnerProfile = result.candidates.scorecards.find(
    (scorecard) => scorecard.candidateId === result.candidates.winnerCandidateId,
  )?.profile;
  const record: PromptEnhancementRecordInput = {
    runId: `pe-run-${result.inputFingerprintSha256.slice(0, 32)}`,
    recordedAt: new Date().toISOString(),
    requestId: result.analysis.requestId,
    status: evidenceStatus(result.safety.decision),
    originalInput: rawInput,
    enhancedPromptId: result.promptId,
    enhancedPromptText: result.renderedPrompt,
    appliedSafetyRules: result.enhancedPrompt.safetyRules,
    appliedGroundingDirectives: result.enhancedPrompt.groundingPlan.directives,
    assumptions: result.analysis.missingContext.flatMap((item) =>
      item.kind === "assumption" ? [item.statement] : [],
    ),
    candidateScores: evidenceCandidateRows(result.candidates),
    safety: {
      decision: result.safety.decision,
      verificationStatus: result.safety.verificationStatus,
      requiresHumanReview: result.safety.requiresHumanReview,
      findingCodes: result.safety.findings.map((finding) => finding.code),
      leastPrivilege: result.safety.leastPrivilege,
    },
    modelMetadata: evidenceModelMetadata(result.modelRouting, winnerProfile),
  };
  // The builder fingerprints + redacts by construction, so the returned manifest carries no raw secret.
  // Pass the extra env-derived API-key literals so any configured secret is scrubbed too.
  return buildPromptEnhancementEvidenceManifest(record, {
    additionalSecrets: keikoApiKeySecretValues(env),
  }).manifest;
}

function renderHuman(result: PromptEnhancementWireResponse, io: CliIo): void {
  const winner = result.candidates.scorecards.find(
    (scorecard) => scorecard.candidateId === result.candidates.winnerCandidateId,
  );
  io.out(`Enhanced prompt (profile: ${winner?.profile ?? "n/a"}, id: ${result.promptId})\n`);
  io.out(
    `Task class: ${result.analysis.taskClass} · domain: ${result.analysis.domain} · criticality: ${result.analysis.criticality}\n`,
  );
  io.out(
    `Model routing: ${result.modelRouting.availability} (${result.modelRouting.reason})` +
      (result.modelRouting.resolvedModelId === undefined
        ? "\n"
        : ` → ${result.modelRouting.resolvedModelId}\n`),
  );
  io.out(
    `Safety: ${result.safety.decision} · verification: ${result.safety.verificationStatus}` +
      ` · human review: ${result.safety.requiresHumanReview ? "required" : "not required"}\n`,
  );
  if (result.safety.findings.length > 0) {
    io.out(`Safety findings: ${result.safety.findings.map((f) => f.code).join(", ")}\n`);
  }
  io.out("\nCandidate scorecards (winner first):\n");
  for (const scorecard of result.candidates.scorecards) {
    const marker = scorecard.candidateId === result.candidates.winnerCandidateId ? "*" : " ";
    io.out(
      `  ${marker} ${scorecard.profile.padEnd(16)} score ${scorecard.aggregateScore.toFixed(3)} · ~${String(scorecard.estimatedTokens)} tokens\n`,
    );
  }
  io.out("\n--- Enhanced prompt (review before any downstream use) ---\n");
  io.out(`${result.renderedPrompt}\n`);
}

/**
 * `keiko prompt-enhancer` entrypoint. Returns 0 on success, 1 on a runtime/config error, 2 on usage
 * error. Pure apart from optional config-file reads; never dispatches a model.
 */
export function runPromptEnhancerCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: PromptEnhancerCliDeps = {},
): number {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    io.err(`Error: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.flags.help) {
    io.out(USAGE);
    return 0;
  }
  const rawInput = parsed.flags.values["--input"];
  if (rawInput === undefined) {
    io.err(`Error: --input is required.\n\n${USAGE}`);
    return 2;
  }
  const wire = buildWireRequest(parsed.flags);
  if (!wire.ok) {
    io.err(`Error: invalid request:\n  - ${wire.errors.join("\n  - ")}\n`);
    return 2;
  }
  const config = resolveGatewayConfig(parsed.flags, env, io, deps);
  if (!config.ok) {
    return config.code;
  }

  const run = deps.run ?? runPromptEnhancement;
  let result: PromptEnhancementWireResponse;
  try {
    result = run(wire.request, { gatewayConfig: config.config });
  } catch (error) {
    if (error instanceof PromptEnhancementInputError) {
      io.err(`Error: enhancement rejected the request:\n  - ${error.errors.join("\n  - ")}\n`);
      return 1;
    }
    throw error;
  }

  emitResult(parsed.flags, result, rawInput, env, io);
  return 0;
}

// Redact and print the enhancement result. AC4: deep-redact every string leaf before printing so a
// secret-shaped substring a user pasted into their own draft is scrubbed from the echoed input /
// rendered prompt. The evidence manifest is built from the ORIGINAL result (the evidence store redacts
// by construction) and is always integrity-hashed and content-light.
function emitResult(
  flags: ParsedFlags,
  result: PromptEnhancementWireResponse,
  rawInput: string,
  env: EnvSource,
  io: CliIo,
): void {
  const redactFn = createAuditRedactor({ additionalSecrets: keikoApiKeySecretValues(env) }, env);
  const redactedResult = deepRedactStrings(result, redactFn) as PromptEnhancementWireResponse;
  if (flags.json) {
    io.out(`${JSON.stringify(redactedResult, null, 2)}\n`);
  } else {
    renderHuman(redactedResult, io);
  }
  if (flags.evidence) {
    const manifest = buildEvidenceManifest(rawInput, result, env);
    io.out(`\n--- Redacted evidence manifest ---\n${JSON.stringify(manifest, null, 2)}\n`);
  }
}
