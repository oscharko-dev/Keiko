import type { EnvSource, GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
// GEN-PERF-CLI-001 — the gateway + credential-vault graphs load on first use;
// this helper sits behind most commands, so a static value import here would
// re-eagerize the whole CLI.
import { loadCredentialVault, loadModelGateway } from "./lazy-modules.js";

export type ConfigPathResolution =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "missing-value" }
  | { readonly kind: "not-configured" };

export function resolveConfigPathFromArgs(
  args: readonly string[],
  env: EnvSource,
): ConfigPathResolution {
  const flagIndex = args.indexOf("--config");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    return value === undefined || value.startsWith("--")
      ? { kind: "missing-value" }
      : { kind: "path", path: value };
  }
  return env.KEIKO_CONFIG_FILE === undefined
    ? { kind: "not-configured" }
    : { kind: "path", path: env.KEIKO_CONFIG_FILE };
}

// Resolves the SYNCHRONOUS config-file loader once the heavy modules are in.
// Consumers that must hand a sync loader to another layer (the evaluations
// runner's EvaluationConfigLoader) await this factory once at dispatch.
export async function gatewayConfigFileLoader(): Promise<
  (path: string, env: EnvSource) => GatewayConfig
> {
  const [{ loadConfigFromFile }, { createProviderSecretResolver }] = await Promise.all([
    loadModelGateway(),
    loadCredentialVault(),
  ]);
  return (path: string, env: EnvSource): GatewayConfig =>
    loadConfigFromFile(path, env, {
      secretResolver: createProviderSecretResolver({ configPath: path, env }),
    });
}

export async function loadGatewayConfigFromFile(
  path: string,
  env: EnvSource,
): Promise<GatewayConfig> {
  return (await gatewayConfigFileLoader())(path, env);
}
