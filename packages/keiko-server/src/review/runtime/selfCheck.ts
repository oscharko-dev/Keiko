// The review instance's startup self-check (ADR-0182 D2, Issue #4135).
//
// A Keiko for Quality review instance starts only when every one of its four read-only layers is
// present and exact, and only on the governed review profile:
//   1. the generated configuration denies `*` and allows exactly the four review tools, names the
//      server-defined review agent and carries Keiko's system prompt, with no MCP server or
//      instruction source;
//   2. the generated plugin registers exactly the four review tools and no native policy plugin;
//   3. the review authority grants `workspace-read` only, at `governed-assist`;
//   4. the tool facade and catalog bridge are composed with the review purpose.
// Any other state refuses the start with a closed reason; nothing is half-started.

import {
  REVIEW_RUNTIME_AGENT_NAME,
  REVIEW_RUNTIME_TOOL_NAMES,
  type CodingRuntimePurpose,
  type ReviewProfileRefusalReason,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

import type { OpenCodeToolProfile } from "../../coding-runtime/opencodeToolSchemas.js";
import { openCodeReviewPermissionRules } from "../../coding-runtime/opencodeLaunchProfile.js";
import { REVIEW_SYSTEM_PROMPT } from "./reviewPrompt.js";
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

const REVIEW_PLUGIN_FILES = ["keiko_governed_tools", "keiko_native_context"] as const;
// A registration call (`register_<tool>(editor);`); the tool functions' own definitions carry no
// semicolon after the parameter list, so only calls match.
const REGISTRATION = /register_(\w+)\(editor\);/gu;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && expected.every((value) => values.includes(value));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewAgentIsExact(agents: unknown): boolean {
  if (!isRecord(agents) || !sameSet(Object.keys(agents), [REVIEW_RUNTIME_AGENT_NAME])) return false;
  const agent = agents[REVIEW_RUNTIME_AGENT_NAME];
  return (
    isRecord(agent) &&
    agent.mode === "primary" &&
    agent.system === REVIEW_SYSTEM_PROMPT &&
    sameJson(agent.permissions, openCodeReviewPermissionRules())
  );
}

function noRepositoryInputs(config: Readonly<Record<string, unknown>>): boolean {
  const mcp = config.mcp;
  return (
    isRecord(mcp) &&
    isRecord(mcp.servers) &&
    Object.keys(mcp.servers).length === 0 &&
    Array.isArray(config.instructions) &&
    config.instructions.length === 0
  );
}

/** Layer 1: the generated configuration is exactly the review profile's. */
export function reviewConfigurationIsExact(config: unknown): boolean {
  return (
    isRecord(config) &&
    sameJson(config.permissions, openCodeReviewPermissionRules()) &&
    config.default_agent === REVIEW_RUNTIME_AGENT_NAME &&
    reviewAgentIsExact(config.agents) &&
    noRepositoryInputs(config)
  );
}

/** The tool names a generated governed-tools plugin registers, in source order. */
export function registeredPluginToolNames(source: string): readonly string[] {
  return [...source.matchAll(REGISTRATION)].map((match) => match[1] ?? "");
}

/** Layer 2: exactly the governed-tools and context plugins, registering exactly the four tools. */
export function reviewPluginSetIsExact(
  plugins: Readonly<Record<string, string>> | undefined,
): boolean {
  if (plugins === undefined || !sameSet(Object.keys(plugins), REVIEW_PLUGIN_FILES)) return false;
  const tools = registeredPluginToolNames(plugins.keiko_governed_tools ?? "");
  return sameSet(tools, REVIEW_RUNTIME_TOOL_NAMES);
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
