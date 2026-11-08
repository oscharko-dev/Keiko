import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { recordConnectionCheck, recordJiraHumanInput } from "./credentialActivity.js";
import { createJiraPrivatePorts, type JiraPrivatePortOptions } from "./httpPrivateIdentity.js";
import type {
  AtlassianCredentialHttpOptions,
  AtlassianConnectorCredentialDeps,
} from "./credentialRoutes.js";
import {
  type CreateAtlassianHttpPortOptions,
  createGatewayAtlassianHttpBodyPort,
  createGatewayAtlassianHttpPort,
} from "./httpPort.js";
import {
  type AtlassianCredentialMetadata,
  type AtlassianCredentialCustody,
  createAtlassianCredentialCustody,
  type AtlassianCredentialVaultPort,
  type AtlassianCredentialCustodyDeps,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpRequest,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpResult,
  AtlassianCredentialCustodyError,
  verifyJiraDataCenterIdentity,
} from "@oscharko-dev/keiko-connectors";
import {
  ambiguousJiraAuthenticationResponse,
  currentJiraAuthenticationObservation,
  withJiraAuthenticationObservation,
} from "./jiraAuthenticationObservation.js";
// Composition-root wiring for Atlassian connector credential custody (Issue #2241, ADR-0128 D1).
//
// keiko-server assembles the concrete pieces the keiko-connectors domain logic declares as ports:
// the dedicated secret vault (D2 constants, opened LAZILY so a deployment that never stores an
// Atlassian credential never generates a key), the private metadata store beside it, and the
// gatewayFetch-backed AtlassianHttpPort factory. The narrow execution resolver returned by
// createAtlassianCredentialCustody is captured ONLY inside the httpPortFactory closure — it is
// not a field on the returned deps, so no route or serialized surface can reach the secret.

import type {
  LocalSecretVault,
  LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { openAtlassianCredentialVault } from "./credentialVault.js";
import {
  createAtlassianCredentialMetadataStore,
  type AtlassianCredentialMetadataStore,
} from "./credentialMetadataStore.js";
import {
  resolveAtlassianTargetAdmission,
  type AtlassianTargetAdmission,
} from "./targetAdmission.js";

export interface BuildAtlassianConnectorCredentialDepsOptions {
  readonly onLivePodInvalidated?: AtlassianCredentialCustodyDeps["onLivePodInvalidated"];
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
  onReady: () => void,
): AtlassianCredentialVaultPort {
  let vault: LocalSecretVault | undefined;
  let maintained = false;
  let maintaining = false;
  const open = (): LocalSecretVault => {
    vault ??= openAtlassianCredentialVault({
      configPath: options.configPath,
      env: options.env,
      ...(options.keychainAccess === undefined ? {} : { keychainAccess: options.keychainAccess }),
      securityLogSink: options.securityLogSink,
    });
    // Re-entry is the same opened vault used by the bounded retention pass, not another open.
    if (!maintained && !maintaining) {
      maintaining = true;
      try {
        onReady();
        maintained = true;
      } finally {
        maintaining = false;
      }
    }
    return vault;
  };
  return {
    list: () => open().list(),
    get: (reference: string): string | undefined => open().get(reference),
    set: (reference: string, secret: string): void => {
      open().set(reference, secret);
    },
    delete: (reference: string): void => {
      open().delete(reference);
    },
    compareAndSet: (reference, expected, next) => {
      const compare = open().compareAndSet;
      if (compare === undefined) throw new AtlassianCredentialCustodyError("vault-unavailable");
      return compare(reference, expected, next);
    },
    acquireLease: (reference, scope) => {
      const acquire = open().acquireLease;
      if (acquire === undefined) throw new AtlassianCredentialCustodyError("vault-unavailable");
      return acquire(reference, scope);
    },
  };
}

function legacyAvatarRelease(metadata: AtlassianCredentialMetadata): "10.3" | "10.4" | undefined {
  if (metadata.deployment !== "data-center") return undefined;
  const pod = metadata.livePod;
  if (
    pod?.verificationStatus !== "ok" ||
    pod.verificationInProgress ||
    pod.credentialOperation !== undefined
  )
    return undefined;
  const version = pod.compatibility?.versionNumbers;
  if (version?.[0] !== 10) return undefined;
  if (version[1] === 3) return "10.3";
  return version[1] === 4 ? "10.4" : undefined;
}

function boundPrivateOptions(
  selected: AtlassianCredentialMetadata,
  current: AtlassianCredentialMetadata | undefined,
  options: JiraPrivatePortOptions,
): JiraPrivatePortOptions {
  // Never accept a caller's compatibility hint: use the same current persisted verification.
  const { legacyTemporaryRelease: _hint, ...retained } = options;
  if (
    selected.deployment !== "data-center" ||
    current?.deployment !== "data-center" ||
    selected.generation !== current.generation ||
    selected.baseUrl !== current.baseUrl ||
    selected.livePod?.podId !== current.livePod?.podId ||
    selected.livePod?.verificationRevision !== current.livePod?.verificationRevision
  )
    return retained;
  const legacyTemporaryRelease = legacyAvatarRelease(current);
  return legacyTemporaryRelease === undefined ? retained : { ...retained, legacyTemporaryRelease };
}

export function buildAtlassianConnectorCredentialDeps(
  options: BuildAtlassianConnectorCredentialDepsOptions,
): AtlassianConnectorCredentialDeps {
  const listenerPorts = new Set<number>();
  const metadataStore = createAtlassianCredentialMetadataStore({ configPath: options.configPath });
  let maintainInputs = (): void => undefined;
  const { custody, executionResolver } = createAtlassianCredentialCustody({
    vault: lazyVaultPort(options, () => maintainInputs()),
    metadataStore,
    onLivePodInvalidated: options.onLivePodInvalidated,
    onHumanInputCleared: (correlationId, phase) =>
      recordJiraHumanInput(options, correlationIdOrUnknown(correlationId), phase),
  });
  maintainInputs = () => custody.humanInputs?.sweepExpired();
  const owner = { options, listenerPorts, executionResolver, custody, metadataStore };
  return {
    custody,
    jiraPrivatePortFactory: (metadata, context, privateOptions, lifecycle = {}) =>
      createJiraPrivatePorts(
        credentialTransportOptions(owner, metadata, context.correlationId, lifecycle),
        credentialTransportOptions(owner, metadata, context.correlationId, lifecycle, false),
        context,
        boundPrivateOptions(metadata, custody.getMetadata(metadata.authRef), privateOptions),
      ),
    registerListener: (port): (() => void) => {
      listenerPorts.add(port);
      return (): void => {
        listenerPorts.delete(port);
      };
    },
    httpPortFactory: (metadata, correlationId, lifecycle = {}) =>
      observedPort(owner, metadata, correlationId, lifecycle, createGatewayAtlassianHttpPort),
    httpBodyPortFactory: (metadata, correlationId, lifecycle = {}) =>
      observedPort(owner, metadata, correlationId, lifecycle, createGatewayAtlassianHttpBodyPort),
    ...(options.activityLog === undefined ? {} : { activityLog: options.activityLog }),
  };
}

function generationBoundResolver(
  resolver: AtlassianCredentialExecutionResolver,
  generation: number,
): AtlassianCredentialExecutionResolver {
  const inputs = resolver.humanInputs;
  const sessions = resolver.sessions;
  const boundInputs: AtlassianCredentialExecutionResolver["humanInputs"] =
    inputs === undefined
      ? undefined
      : {
          claim: (id, binding, revision) => {
            if (binding.authenticationGeneration !== generation)
              throw new AtlassianCredentialCustodyError("credential-changed");
            return inputs.claim(id, binding, revision);
          },
        };
  const boundSessions: AtlassianCredentialExecutionResolver["sessions"] =
    sessions === undefined
      ? undefined
      : {
          withLease: (binding, execute) => {
            if (binding.authenticationGeneration !== generation)
              throw new AtlassianCredentialCustodyError("credential-changed");
            return sessions.withLease(binding, execute);
          },
          finish: (binding, revision, logout) => {
            if (binding.authenticationGeneration !== generation)
              throw new AtlassianCredentialCustodyError("credential-changed");
            return sessions.finish(binding, revision, logout);
          },
        };
  return {
    resolveForExecution: (authRef) => resolver.resolveForExecution(authRef, generation),
    ...(boundInputs === undefined ? {} : { humanInputs: boundInputs }),
    ...(boundSessions === undefined ? {} : { sessions: boundSessions }),
  };
}

interface CredentialTransportOwner {
  readonly options: BuildAtlassianConnectorCredentialDepsOptions;
  readonly listenerPorts: ReadonlySet<number>;
  readonly executionResolver: AtlassianCredentialExecutionResolver;
  readonly custody: AtlassianCredentialCustody;
  readonly metadataStore: AtlassianCredentialMetadataStore;
}

function identityObservation(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
  lifecycle: AtlassianCredentialHttpOptions,
): (deadlineAt: number, signal: AbortSignal | undefined) => Promise<boolean> {
  const current = (): boolean =>
    currentJiraAuthenticationObservation(metadata, owner.custody.getMetadata(metadata.authRef));
  const port = createGatewayAtlassianHttpBodyPort({
    ...credentialTransportOptions(owner, metadata, correlationId, {
      beforeDispatch: (request): boolean => {
        if (!current()) throw new AtlassianCredentialCustodyError("credential-changed");
        return lifecycle.beforeDispatch === undefined || lifecycle.beforeDispatch(request);
      },
    }),
    // This direct port owns its awaited identity observation and retains normal target admission.
    onResponse: (): boolean => true,
    singleAttempt: true,
  });
  return async (deadlineAt, signal): Promise<boolean> => {
    const status = await verifyJiraDataCenterIdentity(port, metadata.baseUrl, {
      deadlineAt,
      signal,
    });
    if (status === "auth-failed") observedAuthentication(owner, metadata, correlationId)(401);
    else recordConnectionCheck(owner.options, correlationId, status, undefined, "request");
    return status === "ok";
  };
}

function observedPort<
  TRequest extends AtlassianHttpRequest | AtlassianHttpBodyRequest,
  TResult extends AtlassianHttpResult,
>(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string | undefined,
  lifecycle: AtlassianCredentialHttpOptions,
  create: (options: CreateAtlassianHttpPortOptions) => (request: TRequest) => Promise<TResult>,
): (request: TRequest) => Promise<TResult> {
  const port = create(credentialTransportOptions(owner, metadata, correlationId, lifecycle));
  if (lifecycle.purpose === "verification") return port;
  return withJiraAuthenticationObservation(
    metadata,
    port,
    () =>
      currentJiraAuthenticationObservation(metadata, owner.custody.getMetadata(metadata.authRef)),
    identityObservation(owner, metadata, correlationId ?? UNKNOWN_CORRELATION_ID, lifecycle),
  );
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

function targetAdmissionFor(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  lifecycle: AtlassianCredentialHttpOptions,
): CreateAtlassianHttpPortOptions["targetAdmission"] {
  if (metadata.deployment !== "data-center") return undefined;
  return (signal): Promise<AtlassianTargetAdmission | undefined> =>
    resolveAtlassianTargetAdmission(
      owner.metadataStore,
      metadata,
      signal,
      lifecycle.purpose === "verification",
    );
}

function credentialTransportOptions(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string | undefined,
  lifecycle: AtlassianCredentialHttpOptions = {},
  observeCredentialAuthentication = true,
): CreateAtlassianHttpPortOptions {
  const { options, listenerPorts, executionResolver } = owner;
  const observe =
    lifecycle.purpose === "verification" || !observeCredentialAuthentication
      ? (): void => undefined
      : observedAuthentication(owner, metadata, correlationId ?? UNKNOWN_CORRELATION_ID);
  const beforeDispatch = lifecycle.beforeDispatch;
  const onResponse = lifecycle.onResponse;
  return {
    targetAdmission: targetAdmissionFor(owner, metadata, lifecycle),
    activityLog: options.activityLog,
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
        if (!ambiguousJiraAuthenticationResponse(metadata, request)) observe(status);
      }
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
}
