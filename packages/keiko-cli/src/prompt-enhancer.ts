// `keiko prompt-enhancer` — the developer-facing surface for the Prompt Enhancer (Epic #1307, Issue
// #1314; ADR-0044 §1 "CLI command"). It drives the same governed workflow as the BFF route
// (`runPromptEnhancement` from keiko-workflows). Without `--model` it runs deterministic-only; with
// `--model` it may route a bounded model-assisted refinement through the Model Gateway. All printed
// output is redacted (AC4); `--evidence` emits a redact-by-construction audit manifest reusing the
// #1313 keiko-evidence promptEnhancement store.

import type { EnvSource, GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  validatePromptEnhancementWireRequest,
  type PromptEnhancementWireRequest,
  type PromptEnhancementWireResponse,
} from "@oscharko-dev/keiko-contracts";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
// GEN-PERF-CLI-001 — gateway/harness/workflows/evidence load at dispatch; the
// contracts + security leaves above are cheap and stay static.
import { loadEvidence, loadHarness, loadModelGateway, loadWorkflows } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type HarnessModule = typeof import("@oscharko-dev/keiko-harness");
type WorkflowsModule = typeof import("@oscharko-dev/keiko-workflows");
type EvidenceModule = typeof import("@oscharko-dev/keiko-evidence");

// Test seams: production wires the real keiko-server orchestrator and config loader; tests inject
// deterministic fakes so the command is exercised without disk or a real gateway.
export interface PromptEnhancerCliDeps {
  readonly run?: WorkflowsModule["runPromptEnhancement"];
  readonly loadConfig?: (path: string, env: EnvSource) => GatewayConfig;
  readonly modelPortFactory?: ((modelId: string) => ModelPort | undefined) | undefined;
}

const USAGE = `Usage: keiko prompt-enhancer --input "<raw prompt>" [OPTIONS]

Generate a governed, reviewable Enhanced Prompt from a raw draft. Without --model this is
deterministic-only; with --model Keiko may use that chat model to refine the prompt.

Options:
  --input TEXT       The raw prompt draft to enhance (required).
  --profile ID       Preferred profile: fast | precise | research | creative | technical |
                     safety-critical | agentic. Safety criticality may still escalate it.
  --strategy MODE    How to handle missing information: clarify (default) | assume.
  --candidates N     Number of candidate variants to score (1-7).
  --model ID         Use this chat model for model-assisted refinement through the Model Gateway. Requires a
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
      if (value === undefined || (arg !== "--input" && value.startsWith("--"))) {
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
  gateway: GatewayModule,
): { ok: true; config: GatewayConfig | undefined } | { ok: false; code: number } {
  // A model is only used for refinement when --model is given. Without it, enhancement is fully
  // deterministic and needs no config.
  if (flags.values["--model"] === undefined) {
    return { ok: true, config: undefined };
  }
  const path = flags.values["--config"] ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    io.err(
      "Error: --model requires a gateway config; pass --config PATH or set KEIKO_CONFIG_FILE.\n",
    );
    return { ok: false, code: 1 };
  }
  try {
    const load = deps.loadConfig ?? gateway.loadConfigFromFile;
    return { ok: true, config: load(path, env) };
  } catch (error) {
    if (error instanceof gateway.GatewayError || error instanceof gateway.ConfigInvalidError) {
      io.err(
        `Error: model gateway configuration problem — ${gateway.redact(error.message)}\n` +
          "Provide a valid gateway config with --config PATH or KEIKO_CONFIG_FILE.\n",
      );
      return { ok: false, code: 1 };
    }
    throw error;
  }
}

function buildEvidenceManifest(
  rawInput: string,
  result: PromptEnhancementWireResponse,
  env: EnvSource,
  config: GatewayConfig | undefined,
  workflows: WorkflowsModule,
  evidence: EvidenceModule,
): unknown {
  const record = workflows.buildPromptEnhancementRecordInput({
    rawInput,
    result,
    recordedAt: new Date().toISOString(),
  });
  // The builder fingerprints + redacts by construction, so the returned manifest carries no raw secret.
  // Topology values are literal-redacted; configured credentials only trigger full string redaction so
  // the raw credential values never approach the evidence hashing boundary.
  return evidence.buildPromptEnhancementEvidenceManifest(record, {
    additionalSecrets: promptEnhancerTopologyRedactionSecrets(config),
    redactAllStrings: promptEnhancerHasOpaqueRedactionSecret(env, config),
  }).manifest;
}

function egressSecretValues(egress: GatewayConfig["egress"]): readonly string[] {
  if (egress === undefined) return [];
  return [egress.httpProxy, egress.httpsProxy, egress.caBundlePath].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
}

function configTopologyValues(config: GatewayConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const out: string[] = [...egressSecretValues(config.egress)];
  for (const provider of config.providers) {
    out.push(provider.baseUrl, ...egressSecretValues(provider.egress));
  }
  return out;
}

function configOpaqueSecretValues(config: GatewayConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const out: string[] = [];
  if (config.figma?.accessToken !== undefined) {
    out.push(config.figma.accessToken);
  }
  for (const provider of config.providers) {
    out.push(provider.apiKey);
  }
  return out;
}

function figmaEnvSecretValues(env: EnvSource): readonly string[] {
  const token = env.FIGMA_ACCESS_TOKEN;
  return token !== undefined && token.length > 0 ? [token] : [];
}

function promptEnhancerRedactionSecrets(
  env: EnvSource,
  config: GatewayConfig | undefined,
): readonly string[] {
  return Array.from(
    new Set([
      ...keikoApiKeySecretValues(env),
      ...figmaEnvSecretValues(env),
      ...configTopologyValues(config),
      ...configOpaqueSecretValues(config),
    ]),
  );
}

function promptEnhancerTopologyRedactionSecrets(
  config: GatewayConfig | undefined,
): readonly string[] {
  return Array.from(new Set(configTopologyValues(config)));
}

function promptEnhancerHasOpaqueRedactionSecret(
  env: EnvSource,
  config: GatewayConfig | undefined,
): boolean {
  return (
    keikoApiKeySecretValues(env).length > 0 ||
    figmaEnvSecretValues(env).length > 0 ||
    configOpaqueSecretValues(config).length > 0
  );
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
      ` · ${result.modelRouting.executionStatus ?? "deterministic"}` +
      (result.modelRouting.fallbackReason === undefined
        ? ""
        : ` · fallback: ${result.modelRouting.fallbackReason}`) +
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

type PromptEnhancerCliPreparation =
  | {
      readonly ok: true;
      readonly flags: ParsedFlags;
      readonly rawInput: string;
      readonly request: PromptEnhancementWireRequest;
      readonly config: GatewayConfig | undefined;
    }
  | { readonly ok: false; readonly code: number };

function preparePromptEnhancerCliRun(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: PromptEnhancerCliDeps,
  gateway: GatewayModule,
): PromptEnhancerCliPreparation {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    io.err(`Error: ${parsed.error}\n\n${USAGE}`);
    return { ok: false, code: 2 };
  }
  if (parsed.flags.help) {
    io.out(USAGE);
    return { ok: false, code: 0 };
  }
  const rawInput = parsed.flags.values["--input"];
  if (rawInput === undefined) {
    io.err(`Error: --input is required.\n\n${USAGE}`);
    return { ok: false, code: 2 };
  }
  const wire = buildWireRequest(parsed.flags);
  if (!wire.ok) {
    io.err(`Error: invalid request:\n  - ${wire.errors.join("\n  - ")}\n`);
    return { ok: false, code: 2 };
  }
  const config = resolveGatewayConfig(parsed.flags, env, io, deps, gateway);
  if (!config.ok) return { ok: false, code: config.code };
  return {
    ok: true,
    flags: parsed.flags,
    rawInput,
    request: wire.request,
    config: config.config,
  };
}

/**
 * `keiko prompt-enhancer` entrypoint. Returns 0 on success, 1 on a runtime/config error, 2 on usage
 * error. Pure apart from optional config-file reads and optional model-assisted refinement.
 */
export async function runPromptEnhancerCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: PromptEnhancerCliDeps = {},
): Promise<number> {
  const [gateway, harness, workflows, evidence] = await Promise.all([
    loadModelGateway(),
    loadHarness(),
    loadWorkflows(),
    loadEvidence(),
  ]);
  const prepared = preparePromptEnhancerCliRun(args, io, env, deps, gateway);
  if (!prepared.ok) return prepared.code;
  const run = deps.run ?? workflows.runPromptEnhancement;
  let result: PromptEnhancementWireResponse;
  try {
    result = await run(prepared.request, {
      gatewayRoutingConfig: workflows.promptEnhancementGatewayRoutingConfig(prepared.config),
      modelPortFactory:
        deps.modelPortFactory ?? promptEnhancerModelPortFactory(prepared.config, gateway, harness),
    });
  } catch (error) {
    if (error instanceof workflows.PromptEnhancementInputError) {
      io.err(`Error: enhancement rejected the request:\n  - ${error.errors.join("\n  - ")}\n`);
      return 1;
    }
    throw error;
  }

  emitResult(prepared.flags, result, prepared.rawInput, env, prepared.config, io, {
    workflows,
    evidence,
  });
  return 0;
}

function promptEnhancerModelPortFactory(
  config: GatewayConfig | undefined,
  gatewayModule: GatewayModule,
  harness: HarnessModule,
): ((modelId: string) => ModelPort | undefined) | undefined {
  if (config === undefined) return undefined;
  const gateway = new gatewayModule.Gateway(config);
  const port = new harness.GatewayModelPort(gateway);
  return (modelId: string): ModelPort | undefined =>
    config.providers.some((provider) => provider.modelId === modelId) ? port : undefined;
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
  config: GatewayConfig | undefined,
  io: CliIo,
  modules: { readonly workflows: WorkflowsModule; readonly evidence: EvidenceModule },
): void {
  const redactFn = modules.evidence.createAuditRedactor(
    { additionalSecrets: promptEnhancerRedactionSecrets(env, config) },
    env,
  );
  const redactedResult = modules.evidence.deepRedactStrings(
    result,
    redactFn,
  ) as PromptEnhancementWireResponse;
  if (flags.json) {
    io.out(`${JSON.stringify(redactedResult, null, 2)}\n`);
  } else {
    renderHuman(redactedResult, io);
  }
  if (flags.evidence) {
    const manifest = buildEvidenceManifest(
      rawInput,
      result,
      env,
      config,
      modules.workflows,
      modules.evidence,
    );
    io.out(`\n--- Redacted evidence manifest ---\n${JSON.stringify(manifest, null, 2)}\n`);
  }
}
