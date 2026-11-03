import { isCodingWorkbenchMentionName } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  OPENCODE_RUNTIME_MODEL_ALIAS,
  OPENCODE_RUNTIME_PROVIDER_ID,
  type OpenCodeContextGeometry,
} from "./opencodeLaunchProfile.js";

/**
 * Per-agent models (#3903 AC1, owner decision 2026-10-25): as in standalone OpenCode, an agent may
 * name its own model -- the run's primary agent keeps the large model the run started with, a
 * subagent may use a smaller one. Every model is still one the Model Gateway serves: the one
 * gateway-bound provider declares the gateway's coding-capable models beside the run's own alias,
 * and an agent's `model` is honoured only when it names one of them. An override for any other
 * provider or model is refused and the agent keeps the run's model, so no model traffic leaves the
 * gateway. The gateway admits these models for the run's own capability and budgets.
 */
export interface OpenCodeAgentModelBinding {
  /** The further gateway models the provider declares, by gateway model id, with their geometry. */
  readonly models: Readonly<Record<string, OpenCodeContextGeometry>>;
  /** Per-agent overrides from the configuration documents: agent name to `<provider>/<model>`. */
  readonly agents: Readonly<Record<string, { readonly model: string }>>;
  /** Configured overrides honoured, and those refused (another provider, an unknown model). */
  readonly admittedCount: number;
  readonly refusedCount: number;
}

export interface OpenCodeAgentModelCatalog {
  /** The run's own gateway model id: an override naming it keeps the run's alias. */
  readonly runModelId: string;
  /** The gateway's coding-capable models other than the run's, each with its geometry. */
  readonly models: Readonly<Record<string, OpenCodeContextGeometry>>;
}

const RUNTIME_MODEL = `${OPENCODE_RUNTIME_PROVIDER_ID}/${OPENCODE_RUNTIME_MODEL_ALIAS}`;
const PROVIDER_PREFIX = `${OPENCODE_RUNTIME_PROVIDER_ID}/`;
const AGENT_SECTIONS = ["agent", "agents"] as const;

// `keiko-runtime/<id>` names the gateway model directly; a standalone spelling `<provider>/<id>`
// or a bare `<id>` maps when the gateway serves a model of that id.
function candidates(value: string): readonly string[] {
  if (value.startsWith(PROVIDER_PREFIX)) return [value.slice(PROVIDER_PREFIX.length)];
  const slash = value.indexOf("/");
  return slash < 0 ? [value] : [value, value.slice(slash + 1)];
}

/** The gateway-bound `model` an agent's configured `model` names, or `undefined` when it names none. */
export function gatewayAgentModel(
  value: string,
  catalog: OpenCodeAgentModelCatalog,
): string | undefined {
  for (const candidate of candidates(value)) {
    if (candidate === OPENCODE_RUNTIME_MODEL_ALIAS || candidate === catalog.runModelId)
      return RUNTIME_MODEL;
    if (Object.hasOwn(catalog.models, candidate)) return `${PROVIDER_PREFIX}${candidate}`;
  }
  return undefined;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

interface Tally {
  readonly agents: Record<string, { readonly model: string }>;
  admitted: number;
  refused: number;
}

function admitSection(section: unknown, catalog: OpenCodeAgentModelCatalog, tally: Tally): void {
  for (const [name, entry] of Object.entries(plainRecord(section) ?? {})) {
    const model = plainRecord(entry)?.model;
    if (typeof model !== "string") continue;
    const routed = isCodingWorkbenchMentionName(name)
      ? gatewayAgentModel(model, catalog)
      : undefined;
    if (routed === undefined) {
      tally.refused += 1;
      continue;
    }
    tally.agents[name] = { model: routed };
    tally.admitted += 1;
  }
}

/**
 * The provider's further models and the configured per-agent overrides of one native run, from the
 * user's global and the project's configuration documents in merge order (a later document's
 * override replaces an earlier one's for the same agent).
 */
export function openCodeAgentModelBinding(
  documents: readonly Readonly<Record<string, unknown>>[],
  catalog: OpenCodeAgentModelCatalog,
): OpenCodeAgentModelBinding {
  const tally: Tally = { agents: {}, admitted: 0, refused: 0 };
  for (const document of documents)
    for (const section of AGENT_SECTIONS) admitSection(document[section], catalog, tally);
  return {
    models: catalog.models,
    agents: tally.agents,
    admittedCount: tally.admitted,
    refusedCount: tally.refused,
  };
}
