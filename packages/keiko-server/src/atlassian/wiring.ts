import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { recordConnectionCheck } from "./credentialActivity.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import type { CreateAtlassianHttpPortOptions } from "./httpPort.js";
import type {
  AtlassianCredentialMetadata,
  AtlassianCredentialCustody,
} from "@oscharko-dev/keiko-connectors";
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
  type AtlassianCredentialCustodyDeps,
  type AtlassianCredentialExecutionResolver,
} from "@oscharko-dev/keiko-connectors";
import type {
  LocalSecretVault,
  LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { AtlassianNetworkConfig } from "@oscharko-dev/keiko-contracts";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { openAtlassianCredentialVault } from "./credentialVault.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";

export interface BuildAtlassianConnectorCredentialDepsOptions {
  readonly onLivePodInvalidated?: AtlassianCredentialCustodyDeps["onLivePodInvalidated"];
  readonly networkConfig?: () => AtlassianNetworkConfig | undefined;
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
  // Optional activity-log seam (ADR-0019); the deps.ts composition root supplies
  // `processServerLogSink()`.
  readonly securityLogSink?: SecurityLogSink | undefined;
  // KEIKO-0826 follow-up: forwarded verbatim to AtlassianConnectorCredentialDeps.activityLog so
  // typed-4xx custody-error paths (`credential-not-found`, `unsupported-auth-scheme`,
  // `invalid-input`, `credential-limit-exceeded`) emit a body-free `atlassian.credential.rejected`
  // line to the process activity log. deps.ts wires `processServerLogSink()` here; in-file test
  // builds leave it undefined and the emit becomes a no-op.
  readonly activityLog?: ServerLogSink | undefined;
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
      securityLogSink: options.securityLogSink,
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
  const listenerPorts = new Set<number>();
  const { custody, executionResolver } = createAtlassianCredentialCustody({
    vault: lazyVaultPort(options),
    metadataStore: createAtlassianCredentialMetadataStore({ configPath: options.configPath }),
    onLivePodInvalidated: options.onLivePodInvalidated,
  });
  return {
    custody,
    registerListener: (port): (() => void) => {
      listenerPorts.add(port);
      return (): void => {
        listenerPorts.delete(port);
      };
    },
    httpPortFactory: (metadata, correlationId, lifecycle) =>
      createGatewayAtlassianHttpPort(
        credentialTransportOptions(
          { options, listenerPorts, executionResolver, custody },
          metadata,
          correlationId,
          lifecycle,
        ),
      ),
    httpBodyPortFactory: (metadata, correlationId, lifecycle) =>
      createGatewayAtlassianHttpBodyPort(
        credentialTransportOptions(
          { options, listenerPorts, executionResolver, custody },
          metadata,
          correlationId,
          lifecycle,
        ),
      ),
    ...(options.activityLog === undefined ? {} : { activityLog: options.activityLog }),
  };
}

function generationBoundResolver(
  resolver: AtlassianCredentialExecutionResolver,
  generation: number,
): AtlassianCredentialExecutionResolver {
  return { resolveForExecution: (authRef) => resolver.resolveForExecution(authRef, generation) };
}

interface CredentialTransportOwner {
  readonly options: BuildAtlassianConnectorCredentialDepsOptions;
  readonly listenerPorts: ReadonlySet<number>;
  readonly executionResolver: AtlassianCredentialExecutionResolver;
  readonly custody: AtlassianCredentialCustody;
}

function observedAuthentication(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
): (status: number) => void {
  if (metadata.deployment !== "data-center" || metadata.livePod === undefined)
    return (): void => undefined;
  const { authRef, generation } = metadata;
  const revision = metadata.livePod.verificationRevision;
  return (status): void => {
    if (status !== 401) return;
    const applied = owner.custody.observeAuthenticationFailure(
      authRef,
      generation,
      revision,
      correlationId,
    );
    recordConnectionCheck(
      owner.options,
      correlationId,
      "auth-failed",
      applied ? "applied" : "stale",
      "request",
    );
  };
}

function credentialTransportOptions(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string | undefined,
  lifecycle: AtlassianHttpLifecycleOptions = {},
): CreateAtlassianHttpPortOptions {
  const { options, listenerPorts, executionResolver } = owner;
  const dataCenter = metadata.deployment === "data-center";
  const observe = observedAuthentication(owner, metadata, correlationId ?? UNKNOWN_CORRELATION_ID);
  const beforeDispatch = lifecycle.beforeDispatch;
  const onResponse = lifecycle.onResponse;
  return {
    privateTargets: () => (dataCenter ? (options.networkConfig?.()?.privateTargets ?? []) : []),
    deniedLoopbackPorts: () => [...listenerPorts],
    baseUrl: metadata.baseUrl,
    authRef: metadata.authRef,
    credentials: generationBoundResolver(executionResolver, metadata.generation ?? 1),
    egress: options.egress,
    correlationId,
    ...(beforeDispatch === undefined ? {} : { beforeDispatch }),
    onResponse: (request, status): boolean => {
      try {
        return onResponse === undefined || onResponse(request, status);
      } finally {
        observe(status);
      }
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
}
