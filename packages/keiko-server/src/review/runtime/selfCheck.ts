// The review instance's startup self-check (ADR-0182 D2, Issue #4135).
//
// A Keiko for Quality review instance starts only when every one of its four read-only layers is
// present and exact, and only on the governed review profile:
//   1. the generated configuration is, key for key and value for value, the canonical review
//      configuration the server generates for the same context geometry: `*` denied, exactly the
//      four review tools allowed, the server-defined review agent with Keiko's system prompt, no
//      MCP server, reference, instruction source, plugin, command, skill or other key;
//   2. the generated plugins are exactly the governed-tools and context plugins, each matching its
//      SHA-256 pin, so the registered tool set is exactly the four review tools;
//   3. the review authority grants `workspace-read` only, at `governed-assist`, for review;
//   4. the composition hands its tool facade and catalog bridge the review purpose itself.
// Any other state refuses the start with a closed reason; nothing is half-started. The launch
// re-check (`launchPlugins`) applies the same layer 1 and layer 2 comparisons to the run's actual
// configuration and plugins.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type CodingRuntimePurpose,
  type ReviewProfileRefusalReason,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

import type { OpenCodeToolProfile } from "../../coding-runtime/opencodeToolSchemas.js";
import {
  createFixedOpenCodeV2Config,
  OPENCODE_RUNTIME_MODEL_ALIAS,
  OPENCODE_RUNTIME_PROVIDER_ID,
  type OpenCodeContextGeometry,
} from "../../coding-runtime/opencodeLaunchProfile.js";
import type { ReviewProfileLayer } from "./activity-log.js";

/** What the composition is about to launch, as the self-check reads it. */
export interface ReviewRuntimeLayers {
  readonly toolProfile: OpenCodeToolProfile;
  /** The generated runtime configuration (`buildOpenCodeLaunchProfile(...).configValue`). */
  readonly configValue: Readonly<Record<string, unknown>> | undefined;
  /** The generated plugin sources (`createGeneratedOpenCodeV2Plugins(profile)`). */
  readonly pluginSources: Readonly<Record<string, string>> | undefined;
  /** The review authority the run will be minted with. */
  readonly authority:
    | {
        readonly actionClasses: readonly CodingWorkbenchActionClass[];
        readonly effectiveMode: CodingWorkbenchMode;
        readonly runtimePurpose: CodingRuntimePurpose | undefined;
      }
    | undefined;
  /** The purpose the run's tool facade and catalog bridge are composed with. */
  readonly facadePurpose: CodingRuntimePurpose | undefined;
}

export type ReviewRuntimeSelfCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ReviewProfileRefusalReason;
      readonly layer: ReviewProfileLayer;
    };

/**
 * The SHA-256 of each generated review plugin source (ADR-0182 D2 layer 2). The governed-tools
 * plugin registers exactly `keiko_read`, `keiko_discover`, `keiko_search` and
 * `keiko_review_report`; the context plugin only adds Keiko's guidance. A change to either source
 * changes its digest and refuses the review start until the new source is reviewed and re-pinned.
 */
const REVIEW_PLUGIN_SOURCE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  keiko_governed_tools: "76ce586fe63768b4f477b66d918e5f63e294b631ed4a8c8b42eca9a61655d089",
  keiko_native_context: "884d0fd4f1eda22f363a2f1e0709446b45d6e5e96b98fdb689977ec66dc53e89",
});

function sameSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The context geometry a configuration declares for its one provider model: the only input the
 * canonical review configuration depends on (its provider limits and compaction derive from it).
 */
function declaredGeometry(
  config: Readonly<Record<string, unknown>>,
): OpenCodeContextGeometry | undefined {
  const providers = config.providers;
  const provider = isRecord(providers) ? providers[OPENCODE_RUNTIME_PROVIDER_ID] : undefined;
  const models = isRecord(provider) ? provider.models : undefined;
  const model = isRecord(models) ? models[OPENCODE_RUNTIME_MODEL_ALIAS] : undefined;
  const limit = isRecord(model) ? model.limit : undefined;
  if (!isRecord(limit)) return undefined;
  const { context, input, output } = limit;
  if (!positiveInteger(context) || !positiveInteger(input) || !positiveInteger(output)) {
    return undefined;
  }
  return { contextWindowTokens: context, maxInputTokens: input, maxOutputTokens: output };
}

/**
 * Layer 1: the generated configuration is exactly the canonical review configuration for its own
 * context geometry. Every key is compared, so an added plugin, command, skill, reference, shell,
 * web search, provider, policy or any other key refuses, as does any changed value.
 */
export function reviewConfigurationIsExact(config: unknown): boolean {
  if (!isRecord(config)) return false;
  const geometry = declaredGeometry(config);
  return (
    geometry !== undefined &&
    isDeepStrictEqual(config, createFixedOpenCodeV2Config(geometry, undefined, "review"))
  );
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Layer 2: exactly the two review plugins, each source matching its SHA-256 pin. */
export function reviewPluginSetIsExact(
  plugins: Readonly<Record<string, string>> | undefined,
): boolean {
  if (plugins === undefined) return false;
  const files = Object.keys(plugins);
  if (!sameSet(files, Object.keys(REVIEW_PLUGIN_SOURCE_SHA256))) return false;
  return files.every((file) => {
    const source = plugins[file];
    return typeof source === "string" && sha256(source) === REVIEW_PLUGIN_SOURCE_SHA256[file];
  });
}

/** Layer 3: the review authority grants reading only, at `governed-assist`. */
function reviewAuthorityIsExact(authority: ReviewRuntimeLayers["authority"]): boolean {
  return (
    authority !== undefined &&
    sameSet(authority.actionClasses, ["workspace-read"]) &&
    authority.effectiveMode === "governed-assist" &&
    authority.runtimePurpose === "review"
  );
}

function refusal(
  reason: ReviewProfileRefusalReason,
  layer: ReviewProfileLayer,
): ReviewRuntimeSelfCheck {
  return { ok: false, reason, layer };
}

/** Runs every layer's check; the first missing or inexact layer refuses the start. */
export function checkReviewRuntimeLayers(layers: ReviewRuntimeLayers): ReviewRuntimeSelfCheck {
  if (layers.toolProfile === "native") return refusal("native-profile", "profile");
  if (layers.toolProfile !== "review") return refusal("review-profile-invalid", "profile");
  if (!reviewConfigurationIsExact(layers.configValue)) {
    return refusal("review-profile-invalid", "configuration");
  }
  if (!reviewPluginSetIsExact(layers.pluginSources)) {
    return refusal("review-profile-invalid", "tool-set");
  }
  if (layers.authority === undefined) return refusal("authority-missing", "authority");
  if (!reviewAuthorityIsExact(layers.authority)) {
    return refusal("review-profile-invalid", "authority");
  }
  if (layers.facadePurpose !== "review") return refusal("review-profile-invalid", "facade");
  return { ok: true };
}
