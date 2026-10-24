import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

/**
 * The deployment identity a gateway catalog reports behind an alias (#3905).
 *
 * A tool-calling proof says "this deployment accepted Keiko's forced tool call". The alias, the
 * endpoint and the protocol do not name that deployment: a gateway can re-point `gemma` from one
 * underlying model to another without changing any of the three. What discovery does observe is the
 * management record of the deployment (LiteLLM `/model/info`): its stable deployment id and the
 * underlying model, provider and backend it routes to.
 *
 * Only digests ever leave this module. The raw values are model names, backend addresses and
 * gateway-internal ids, none of which belongs in configuration, evidence or the activity log.
 */

export interface DiscoveredDeploymentFields {
  /** `model_info.id`: the gateway's own id of one deployment. */
  readonly deploymentId?: unknown;
  /** `litellm_params.model`: the underlying model the alias routes to. */
  readonly model?: unknown;
  /** `litellm_params.custom_llm_provider`. */
  readonly provider?: unknown;
  /** `litellm_params.api_base`: the backend the deployment calls. */
  readonly apiBase?: unknown;
}

const DEPLOYMENT_FIELD_NAMES = ["deploymentId", "model", "provider", "apiBase"] as const;

function statedValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Digest of one reported deployment, or undefined when the record states none of the fields. */
export function deploymentDigest(fields: DiscoveredDeploymentFields): string | undefined {
  const stated: Record<string, string> = {};
  for (const name of DEPLOYMENT_FIELD_NAMES) {
    const value = statedValue(fields[name]);
    if (value !== undefined) stated[name] = value;
  }
  return Object.keys(stated).length === 0 ? undefined : sha256Hex(canonicalise(stated));
}

/** Union of the replica digests of one alias, sorted so the listing order cannot matter. */
export function unionDeploymentDigests(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  const union = [...new Set([...(left ?? []), ...(right ?? [])])].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
  return union.length === 0 ? undefined : union;
}

/**
 * The one digest an alias carries: every observed replica takes part, so adding, removing or
 * swapping a replica changes it. Undefined when discovery observed no deployment, which leaves any
 * identity recorded earlier untouched (a degraded listing states nothing; it never clears).
 */
export function aliasDeploymentIdentity(
  replicaDigests: readonly string[] | undefined,
): string | undefined {
  return replicaDigests === undefined || replicaDigests.length === 0
    ? undefined
    : sha256Hex(canonicalise(replicaDigests));
}
