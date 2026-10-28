// The live redaction-secret literals of the running gateway configuration, kept free of the
// handler graph so a route module can resolve them without importing `deps.js` and its routes
// (#4114: the raw Git diff view redacts with these from inside the route graph).

import {
  resolveOutboundHttpEgressConfig,
  type EnvSource,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { keikoApiKeySecretValues } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "./deps.js";

type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;

export function currentGatewayConfig(deps: UiHandlerDeps): GatewayConfig | undefined {
  return deps.gatewayConfig?.current() ?? deps.config;
}

export function currentGatewayEgressConfig(
  deps: Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env" | "egress">,
): GatewayEgressConfig | undefined {
  return (
    deps.gatewayConfig?.current()?.egress ??
    deps.egress ??
    deps.config?.egress ??
    resolveOutboundHttpEgressConfig(undefined, deps.env)
  );
}

export function configTopologyValues(config: GatewayConfig | undefined): readonly string[] {
  // Epic #177 audit: redact provider URLs and egress settings because backend topology gives an
  // attacker a place to direct probes. Credentials are collected separately as opaque secrets for
  // evidence hashing.
  if (config === undefined) return [];
  const out: string[] = [];
  const addEgressTopology = (egress: GatewayConfig["egress"]): void => {
    if (egress === undefined) return;
    if (egress.httpProxy !== undefined) out.push(egress.httpProxy);
    if (egress.httpsProxy !== undefined) out.push(egress.httpsProxy);
    if (egress.caBundlePath !== undefined) out.push(egress.caBundlePath);
  };
  addEgressTopology(config.egress);
  for (const provider of config.providers) {
    out.push(provider.baseUrl);
    addEgressTopology(provider.egress);
  }
  if (config.reranker !== undefined) {
    out.push(config.reranker.baseUrl);
    addEgressTopology(config.reranker.egress);
  }
  return out;
}

export function configOpaqueSecretValues(config: GatewayConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const out: string[] = [];
  if (config.figma?.accessToken !== undefined) {
    out.push(config.figma.accessToken);
  }
  for (const provider of config.providers) {
    out.push(provider.apiKey);
  }
  if (config.reranker !== undefined) {
    out.push(config.reranker.apiKey);
  }
  return out;
}

function configSecretValues(config: GatewayConfig | undefined): readonly string[] {
  return [...configTopologyValues(config), ...configOpaqueSecretValues(config)];
}

export function figmaEnvSecretValues(env: EnvSource): readonly string[] {
  const token = env.FIGMA_ACCESS_TOKEN;
  return token !== undefined && token.length > 0 ? [token] : [];
}

export function egressSecretValues(egress: GatewayConfig["egress"]): readonly string[] {
  if (egress === undefined) return [];
  return [egress.httpProxy, egress.httpsProxy, egress.caBundlePath].filter(
    (value): value is string => value !== undefined,
  );
}

// The Figma PAT is redacted via its config (`config.figma.accessToken`) and env
// (`FIGMA_ACCESS_TOKEN`) literals. The decrypted ENCRYPTED-VAULT token (#758) is intentionally NOT
// added here: it never reaches a redactable payload — it is confined to the outbound `X-Figma-Token`
// request header by construction (figmaConnector.ts) and is never returned, logged, or serialized.
// Adding it would require decrypting the vault at redactor-build time, widening exposure for no gain.
export function redactionSecrets(
  env: EnvSource,
  config: GatewayConfig | undefined,
  egress: GatewayConfig["egress"] = config?.egress,
): readonly string[] {
  return Array.from(
    new Set([
      ...keikoApiKeySecretValues(env),
      ...figmaEnvSecretValues(env),
      ...configSecretValues(config),
      ...egressSecretValues(egress),
    ]),
  );
}

export function currentRedactionSecrets(deps: UiHandlerDeps): readonly string[] {
  return redactionSecrets(
    deps.env,
    deps.gatewayConfig?.configured?.() ?? currentGatewayConfig(deps),
    currentGatewayEgressConfig(deps),
  );
}
