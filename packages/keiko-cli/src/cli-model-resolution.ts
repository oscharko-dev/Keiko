// Shared model-resolution helpers used by every CLI subcommand that constructs a workflow-capable
// ModelPort from the injected gateway config (gen-tests, investigate). Extracted from those two
// files' byte-identical `buildModel` / `resolveConfiguredModelId` / `resolveModel` copies
// (KEIKO-0655) so a change to the resolution rules — the workflow-capable selector, the config
// source precedence, the GatewayError → exit-1 mapping — happens in ONE place instead of two.
//
// Type-shape contract: the caller supplies a minimal `ModelSelection` (config + model — the only
// two fields the resolver reads out of GenTestsArgs / InvestigateArgs). This keeps the helper
// blind to every other flag on those args shapes so a future command with its own args can reuse
// it without pulling those two interfaces in.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
import type { CliIo } from "./runner.js";

type GatewayModule = typeof import("@oscharko-dev/keiko-model-gateway");
type HarnessModule = typeof import("@oscharko-dev/keiko-harness");

/**
 * Minimal shape the resolver reads out of a subcommand's parsed-args object. `config` is the
 * `--config` flag value (or undefined to fall back to `env.KEIKO_CONFIG_FILE`); `model` is the
 * `--model` flag value (or undefined to let the resolver pick a workflow-capable default).
 */
export interface ModelSelection {
  readonly config: string | undefined;
  readonly model: string | undefined;
}

/**
 * Result of a successful resolution: the ModelPort ready to hand to a harness workflow plus the
 * modelId string that will appear in evidence. Callers narrow on `typeof result === "number"` to
 * decide whether to short-circuit with a CLI exit code.
 */
export interface ResolvedModel {
  readonly port: ModelPort;
  readonly modelId: string;
}

/**
 * Builds a ModelPort from the caller's gateway config using the workflow-safe capability selector
 * (chat + toolCalling + structuredOutput). An explicit `parsed.model` still wins after config
 * membership checks, matching evaluate.ts's precedence for the same three commands.
 *
 * Returns a CLI exit code (`1`) instead of throwing when the gateway is misconfigured, so callers
 * fall through the same `if (typeof result === "number") return result` branch they had for the
 * inline copies this helper replaced.
 */
export async function buildWorkflowCapableModel(
  parsed: ModelSelection,
  io: CliIo,
  env: EnvSource,
  gateway: GatewayModule,
  harness: HarnessModule,
): Promise<ResolvedModel | number> {
  try {
    const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
    if (path === undefined) {
      throw new gateway.ConfigInvalidError(
        "no config source; pass --config PATH or set KEIKO_CONFIG_FILE",
      );
    }
    const config = await loadGatewayConfigFromFile(path, env);
    if (parsed.model !== undefined) {
      gateway.assertConfiguredModel(config, parsed.model);
    }
    const modelId =
      parsed.model ??
      gateway.selectConfiguredModel(config, {
        kind: "chat",
        toolCalling: true,
        structuredOutput: true,
      });
    if (modelId === undefined) {
      io.err("Error: no configured workflow-capable chat model is available.\n");
      return 1;
    }
    return { port: new harness.GatewayModelPort(new gateway.Gateway(config)), modelId };
  } catch (error) {
    if (error instanceof gateway.GatewayError) {
      // KEIKO-0910: GatewayError extends RedactingError and self-redacts at construction
      // (ADR-0003), so wrapping `error.message` in `gateway.redact(...)` is a no-op that
      // reads as if the caller did not trust the base class. Print the already-redacted
      // message directly.
      io.err(
        `Error: model gateway configuration problem — ${error.message}\n` +
          `Provide a gateway config with --config PATH or KEIKO_CONFIG_FILE.\n`,
      );
      return 1;
    }
    throw error;
  }
}

/**
 * Resolves ONLY the configured modelId without building a gateway ModelPort. Used when the caller
 * has already supplied its own ModelPort via a test seam (`deps.model`) and still needs an id for
 * evidence / logs. Returns `undefined` when no workflow-capable model is configured; callers must
 * turn that into a CLI exit code themselves.
 */
export async function resolveConfiguredModelId(
  parsed: ModelSelection,
  env: EnvSource,
  gateway: GatewayModule,
): Promise<string | undefined> {
  const path = parsed.config ?? env.KEIKO_CONFIG_FILE;
  if (path === undefined) {
    return parsed.model ?? "default";
  }
  const config = await loadGatewayConfigFromFile(path, env);
  if (parsed.model !== undefined) {
    gateway.assertConfiguredModel(config, parsed.model);
    return parsed.model;
  }
  return gateway.selectConfiguredModel(config, {
    kind: "chat",
    toolCalling: true,
    structuredOutput: true,
  });
}

/**
 * Chooses the injected `deps.model` when the caller supplied one (test seam), and falls back to
 * `buildWorkflowCapableModel` otherwise. Turns a GatewayError while resolving the id into a CLI
 * exit code so both call sites (gen-tests, investigate) collapse to the same one-liner.
 */
export async function resolveModelOrExitCode(
  parsed: ModelSelection,
  io: CliIo,
  env: EnvSource,
  injectedModel: ModelPort | undefined,
  gateway: GatewayModule,
  harness: HarnessModule,
): Promise<ResolvedModel | number> {
  if (injectedModel !== undefined) {
    try {
      const modelId = await resolveConfiguredModelId(parsed, env, gateway);
      if (modelId === undefined) {
        io.err("Error: no configured workflow-capable chat model is available.\n");
        return 1;
      }
      return { port: injectedModel, modelId };
    } catch (error) {
      if (error instanceof gateway.GatewayError) {
        // KEIKO-0910: GatewayError self-redacts (ADR-0003) — no re-redaction needed.
        io.err(`Error: model gateway configuration problem — ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }
  return buildWorkflowCapableModel(parsed, io, env, gateway, harness);
}
