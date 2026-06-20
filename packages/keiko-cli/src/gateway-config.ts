import {
  loadConfigFromFile,
  type EnvSource,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { createProviderSecretResolver } from "@oscharko-dev/keiko-server/credential-vault";

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

export function loadGatewayConfigFromFile(path: string, env: EnvSource): GatewayConfig {
  return loadConfigFromFile(path, env, {
    secretResolver: createProviderSecretResolver({ configPath: path, env }),
  });
}
