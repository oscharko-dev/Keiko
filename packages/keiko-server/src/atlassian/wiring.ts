// Composition-root wiring for Atlassian connector credential custody (Issue #2241, ADR-0128 D1).
//
// keiko-server assembles the concrete pieces the keiko-connectors domain logic declares as ports:
// the dedicated secret vault (D2 constants, opened LAZILY so a deployment that never stores an
// Atlassian credential never generates a key), the private metadata store beside it, and the
// gatewayFetch-backed AtlassianHttpPort factory. The narrow execution resolver returned by
// createAtlassianCredentialCustody is captured ONLY inside the httpPortFactory closure — it is
// not a field on the returned deps, so no route or serialized surface can reach the secret.

import {
  createAtlassianCredentialCustody,
  type AtlassianCredentialVaultPort,
} from "@oscharko-dev/keiko-connectors";
import type {
  LocalSecretVault,
  LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { openAtlassianCredentialVault } from "./credentialVault.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";

export interface BuildAtlassianConnectorCredentialDepsOptions {
  // The effective gateway config path; the credential custody domain lives in the sibling
  // `credentials/` directory (shared with the provider vault, separately keyed — ADR-0128 D2).
  readonly configPath: string;
  readonly env: EnvSource;
  // Resolved per outbound request so runtime gateway-config updates are honored immediately.
  readonly egress: () => OutboundHttpEgressConfig | undefined;
  // Test seam (mirrors the provider vault): inject NO_LOCAL_VAULT_KEYCHAIN to pin the keyfile
  // tier; production leaves it undefined so the darwin keychain tier stays available.
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

// Lazy vault port: key resolution (which may create a keychain entry or keyfile) happens on the
// first custody operation, never at BFF construction time.
function lazyVaultPort(
  options: BuildAtlassianConnectorCredentialDepsOptions,
): AtlassianCredentialVaultPort {
  let vault: LocalSecretVault | undefined;
  const open = (): LocalSecretVault =>
    (vault ??= openAtlassianCredentialVault({
      configPath: options.configPath,
      env: options.env,
      ...(options.keychainAccess === undefined ? {} : { keychainAccess: options.keychainAccess }),
    }));
  return {
    get: (reference: string): string | undefined => open().get(reference),
    set: (reference: string, secret: string): void => {
      open().set(reference, secret);
    },
    delete: (reference: string): void => {
      open().delete(reference);
    },
  };
}

export function buildAtlassianConnectorCredentialDeps(
  options: BuildAtlassianConnectorCredentialDepsOptions,
): AtlassianConnectorCredentialDeps {
  const { custody, executionResolver } = createAtlassianCredentialCustody({
    vault: lazyVaultPort(options),
    metadataStore: createAtlassianCredentialMetadataStore({ configPath: options.configPath }),
  });
  return {
    custody,
    httpPortFactory: (metadata) =>
      createGatewayAtlassianHttpPort({
        baseUrl: metadata.baseUrl,
        authRef: metadata.authRef,
        credentials: executionResolver,
        egress: options.egress,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }),
    httpBodyPortFactory: (metadata) =>
      createGatewayAtlassianHttpBodyPort({
        baseUrl: metadata.baseUrl,
        authRef: metadata.authRef,
        credentials: executionResolver,
        egress: options.egress,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }),
  };
}
