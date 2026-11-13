import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import {
  recordConnectionCheck,
  recordJiraHumanInput,
  type ConnectionCheckDetail,
  type ProbeCause,
} from "./credentialActivity.js";
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
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
  type AtlassianAuthenticationFailure,
  type JiraPrivateSessionBinding,
  type JiraPrivateSessionAccess,
  AtlassianCredentialCustodyError,
  verifyJiraDataCenterIdentity,
} from "@oscharko-dev/keiko-connectors";
import {
  ambiguousJiraAuthenticationResponse,
  currentJiraAuthenticationObservation,
  JIRA_IDENTITY_PROBE_WINDOW_MS,
  withJiraAuthenticationObservation,
  type JiraIdentityProbeOutcome,
  type JiraUnsettledProbe,
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
    compareAndSet: (reference, expected, next): boolean => {
      const compare = open().compareAndSet;
      if (compare === undefined) throw new AtlassianCredentialCustodyError("vault-unavailable");
      return compare(reference, expected, next);
    },
    acquireLease: (reference, scope): (() => void) | undefined => {
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
  return legacyVersion(pod.compatibility?.versionNumbers);
}

function legacyVersion(version: readonly number[] | undefined): "10.3" | "10.4" | undefined {
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
  if (selected.deployment !== "data-center" || current?.deployment !== "data-center")
    return retained;
  if (!samePrivateVerification(selected, current)) return retained;
  const legacyTemporaryRelease = legacyAvatarRelease(current);
  return legacyTemporaryRelease === undefined ? retained : { ...retained, legacyTemporaryRelease };
}

function samePrivateVerification(
  selected: Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>,
  current: Extract<AtlassianCredentialMetadata, { deployment: "data-center" }>,
): boolean {
  return (
    selected.generation === current.generation &&
    selected.baseUrl === current.baseUrl &&
    selected.livePod?.podId === current.livePod?.podId &&
    selected.livePod?.verificationRevision === current.livePod?.verificationRevision
  );
}

export function buildAtlassianConnectorCredentialDeps(
  options: BuildAtlassianConnectorCredentialDepsOptions,
): AtlassianConnectorCredentialDeps {
  const listenerPorts = new Set<number>();
  const metadataStore = createAtlassianCredentialMetadataStore({ configPath: options.configPath });
  let maintainInputs = (): void => undefined;
  const { custody, executionResolver } = createAtlassianCredentialCustody({
    vault: lazyVaultPort(options, () => {
      maintainInputs();
    }),
    metadataStore,
    onLivePodInvalidated: options.onLivePodInvalidated,
    onHumanInputCleared: (correlationId, phase): void => {
      recordJiraHumanInput(options, correlationIdOrUnknown(correlationId), phase);
    },
  });
  maintainInputs = (): void => {
    custody.humanInputs?.sweepExpired();
  };
  const owner: CredentialTransportOwner = {
    options,
    listenerPorts,
    executionResolver,
    custody,
    metadataStore,
    positiveProbes: new Map(),
    inflightProbes: new Map(),
  };
  return {
    custody,
    jiraPrivatePortFactory: privatePortFactory(owner),
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

function privatePortFactory(
  owner: CredentialTransportOwner,
): NonNullable<AtlassianConnectorCredentialDeps["jiraPrivatePortFactory"]> {
  return (metadata, context, options, lifecycle = {}): ReturnType<typeof createJiraPrivatePorts> =>
    createPrivatePorts(owner, metadata, context, options, lifecycle);
}

function createPrivatePorts(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  context: Parameters<NonNullable<AtlassianConnectorCredentialDeps["jiraPrivatePortFactory"]>>[1],
  options: JiraPrivatePortOptions,
  lifecycle: AtlassianCredentialHttpOptions,
): ReturnType<typeof createJiraPrivatePorts> {
  // The same by-value snapshot and the same observed wrapper as the ordinary ports: the PAT port
  // of the private owner is never a second path that decides a 401 on its own.
  const pinned = structuredClone(metadata);
  const bound = boundPrivateOptions(pinned, owner.custody.getMetadata(pinned.authRef), options);
  return createJiraPrivatePorts(
    credentialTransportOptions(owner, pinned, context.correlationId, lifecycle),
    credentialTransportOptions(owner, pinned, context.correlationId, lifecycle, false),
    context,
    {
      ...bound,
      observePatPort: (port) => observePort(owner, pinned, context.correlationId, lifecycle, port),
    },
  );
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
          claim: (
            id,
            binding,
            revision,
          ): ReturnType<
            NonNullable<AtlassianCredentialExecutionResolver["humanInputs"]>["claim"]
          > => {
            if (binding.authenticationGeneration !== generation)
              throw new AtlassianCredentialCustodyError("credential-changed");
            return inputs.claim(id, binding, revision);
          },
        };
  const boundSessions = generationBoundSessions(sessions, generation);
  return {
    resolveForExecution: (authRef) => resolver.resolveForExecution(authRef, generation),
    ...(boundInputs === undefined ? {} : { humanInputs: boundInputs }),
    ...(boundSessions === undefined ? {} : { sessions: boundSessions }),
  };
}

function generationBoundSessions(
  sessions: AtlassianCredentialExecutionResolver["sessions"],
  generation: number,
): AtlassianCredentialExecutionResolver["sessions"] {
  return sessions === undefined
    ? undefined
    : {
        withLease: <T>(
          binding: JiraPrivateSessionBinding,
          execute: (session: JiraPrivateSessionAccess) => Promise<T>,
        ): Promise<T> => {
          if (binding.authenticationGeneration !== generation)
            throw new AtlassianCredentialCustodyError("credential-changed");
          return sessions.withLease(binding, execute);
        },
        finish: (binding, revision, logout): Promise<void> => {
          if (binding.authenticationGeneration !== generation)
            throw new AtlassianCredentialCustodyError("credential-changed");
          return sessions.finish(binding, revision, logout);
        },
      };
}

interface CredentialTransportOwner {
  readonly options: BuildAtlassianConnectorCredentialDepsOptions;
  readonly listenerPorts: ReadonlySet<number>;
  readonly executionResolver: AtlassianCredentialExecutionResolver;
  readonly custody: AtlassianCredentialCustody;
  readonly metadataStore: AtlassianCredentialMetadataStore;
  /** Credential generation and revision -> end of the short window a positive identity read holds. */
  readonly positiveProbes: Map<string, number>;
  /** One identity read in flight per credential generation and revision; callers share it. */
  readonly inflightProbes: Map<string, Promise<JiraIdentityProbeOutcome>>;
}

function probeKey(metadata: AtlassianCredentialMetadata): string {
  const revision =
    metadata.deployment === "data-center" ? (metadata.livePod?.verificationRevision ?? 0) : 0;
  return `${metadata.authRef}|${String(metadata.generation ?? 1)}|${String(revision)}`;
}

function responseCause(
  status: number,
  failure: AtlassianAuthenticationFailure | undefined,
): ProbeCause {
  if (status === 401) return failure === "denied" ? "captcha" : "foreign-401";
  if (status === 429) return "http-429";
  if (status >= 500) return "http-5xx";
  if (status >= 400) return "http-4xx";
  return status >= 300 ? "redirect" : "invalid-body";
}

function probeCauseOf(last: AtlassianHttpBodyResult | undefined): ProbeCause {
  if (last === undefined) return "probe-error";
  if (last.kind === "response") return responseCause(last.status, last.authenticationFailure);
  return last.kind === "timeout" ? "timeout" : "network";
}

const PROBE_DETAIL = { decision: "probe", routeClass: "other" } as const;

interface ObservedIdentityPort {
  readonly port: AtlassianHttpBodyPort;
  readonly last: () => AtlassianHttpBodyResult | undefined;
  readonly reset: () => void;
}

/** The identity read's own port; it remembers its last answer so a 401's origin can be judged. */
function observedIdentityPort(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
  lifecycle: AtlassianCredentialHttpOptions,
): ObservedIdentityPort {
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
  const seen: { last?: AtlassianHttpBodyResult } = {};
  return {
    port: async (request) => {
      const result = await port(request);
      seen.last = result;
      return result;
    },
    last: () => seen.last,
    reset: (): void => {
      Reflect.deleteProperty(seen, "last");
    },
  };
}

async function readIdentity(
  context: {
    readonly owner: CredentialTransportOwner;
    readonly metadata: AtlassianCredentialMetadata;
    readonly correlationId: string;
    readonly key: string;
    readonly identity: ObservedIdentityPort;
  },
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<JiraIdentityProbeOutcome> {
  const { owner, metadata, correlationId, key, identity } = context;
  identity.reset();
  const status = await verifyJiraDataCenterIdentity(identity.port, metadata.baseUrl, {
    deadlineAt,
    signal,
  });
  const check = (outcome: "ok" | "probe-inconclusive", detail: ConnectionCheckDetail): void => {
    recordConnectionCheck(
      owner.options,
      correlationId,
      outcome,
      undefined,
      "request",
      undefined,
      detail,
    );
  };
  if (status === "ok") {
    check("ok", PROBE_DETAIL);
    rememberPositiveProbe(owner, key);
    return "confirmed";
  }
  // Only a 401 Jira itself authored shows a rejected token; a proxy's or a captcha's does not.
  const answered = identity.last();
  if (
    status === "auth-failed" &&
    answered?.kind === "response" &&
    answered.authenticationFailure === "jira"
  ) {
    observedAuthentication(owner, metadata, correlationId, PROBE_DETAIL)(401, "jira");
    return "rejected";
  }
  check("probe-inconclusive", { ...PROBE_DETAIL, probeCause: probeCauseOf(answered) });
  return "inconclusive";
}

function identityObservation(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
  lifecycle: AtlassianCredentialHttpOptions,
): (deadlineAt: number, signal: AbortSignal | undefined) => Promise<JiraIdentityProbeOutcome> {
  const key = probeKey(metadata);
  const context = {
    owner,
    metadata,
    correlationId,
    key,
    identity: observedIdentityPort(owner, metadata, correlationId, lifecycle),
  };
  return async (deadlineAt, signal): Promise<JiraIdentityProbeOutcome> => {
    // Only a positive result is reused, and only for this exact generation and revision.
    if ((owner.positiveProbes.get(key) ?? 0) > Date.now()) {
      recordConnectionCheck(owner.options, correlationId, "ok", undefined, "request", undefined, {
        decision: "probe-window",
        routeClass: "other",
      });
      return "confirmed";
    }
    // One probe in flight per credential generation and revision: concurrent 401s share it.
    const shared = owner.inflightProbes.get(key);
    if (shared !== undefined) return shareProbe(owner, correlationId, shared);
    const flight = readIdentity(context, deadlineAt, signal);
    owner.inflightProbes.set(key, flight);
    try {
      return await flight;
    } finally {
      owner.inflightProbes.delete(key);
    }
  };
}

async function shareProbe(
  owner: CredentialTransportOwner,
  correlationId: string,
  flight: Promise<JiraIdentityProbeOutcome>,
): Promise<JiraIdentityProbeOutcome> {
  const outcome = await flight;
  recordConnectionCheck(
    owner.options,
    correlationId,
    outcome === "confirmed" ? "ok" : outcome === "rejected" ? "auth-failed" : "probe-inconclusive",
    undefined,
    "request",
    undefined,
    { decision: "probe-shared", routeClass: "other" },
  );
  return outcome;
}

function rememberPositiveProbe(owner: CredentialTransportOwner, key: string): void {
  const now = Date.now();
  for (const [stored, until] of owner.positiveProbes) {
    if (until <= now) owner.positiveProbes.delete(stored);
  }
  owner.positiveProbes.set(key, now + JIRA_IDENTITY_PROBE_WINDOW_MS);
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
  // Every 401 may be decided by the identity probe, so the observation binds the credential
  // generation and verification revision by value: a caller mutating its metadata object later
  // cannot move what this port observes.
  const pinned = structuredClone(metadata);
  const port = create(credentialTransportOptions(owner, pinned, correlationId, lifecycle));
  if (lifecycle.purpose === "verification") return port;
  return observePort(owner, pinned, correlationId, lifecycle, port);
}

const UNSETTLED_CAUSE: Readonly<Record<JiraUnsettledProbe, ProbeCause>> = {
  stale: "stale",
  "cancelled-or-expired": "cancelled-or-expired",
  "probe-error": "probe-error",
  "foreign-401": "foreign-401",
  "denied-401": "captcha",
};

/** The one owner of the observed-credential wrapper: every credential-bearing port goes through it. */
function observePort<
  TRequest extends AtlassianHttpRequest | AtlassianHttpBodyRequest,
  TResult extends AtlassianHttpResult,
>(
  owner: CredentialTransportOwner,
  pinned: AtlassianCredentialMetadata,
  correlationId: string | undefined,
  lifecycle: AtlassianCredentialHttpOptions,
  port: (request: TRequest) => Promise<TResult>,
): (request: TRequest) => Promise<TResult> {
  const id = correlationId ?? UNKNOWN_CORRELATION_ID;
  return withJiraAuthenticationObservation(
    pinned,
    port,
    () => currentJiraAuthenticationObservation(pinned, owner.custody.getMetadata(pinned.authRef)),
    identityObservation(owner, pinned, id, lifecycle),
    {
      onUnsettled: (reason, error): void => {
        if (reason === "probe-error") reportProbeFailure(id, error);
        const identityRoute = reason === "foreign-401" || reason === "denied-401";
        recordConnectionCheck(
          owner.options,
          id,
          "probe-inconclusive",
          undefined,
          "request",
          undefined,
          {
            decision: identityRoute ? "identity-route" : "probe",
            routeClass: identityRoute ? "identity" : "other",
            probeCause: UNSETTLED_CAUSE[reason],
          },
        );
      },
    },
  );
}

/** A credential change thrown out of the probe port: body-free class and frames only. */
function reportProbeFailure(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "atlassian.connection.checked",
      source: "atlassian.identity-probe",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

function observedAuthentication(
  owner: CredentialTransportOwner,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
  detail: ConnectionCheckDetail = { decision: "identity-route", routeClass: "identity" },
): (status: number, failure?: AtlassianAuthenticationFailure) => void {
  if (metadata.deployment !== "data-center" || metadata.livePod === undefined)
    return (): void => undefined;
  const { authRef, generation } = metadata;
  const revision = metadata.livePod.verificationRevision;
  return (status, failure): void => {
    // Only a 401 Jira itself authored shows that the token was rejected (ADR-0128).
    if (status !== 401 || failure !== "jira") return;
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
      undefined,
      detail,
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
      ? (_status: number, _failure?: AtlassianAuthenticationFailure): void => undefined
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
    onResponse: (request, status, failure): boolean => {
      try {
        return onResponse === undefined || onResponse(request, status, failure);
      } finally {
        if (!ambiguousJiraAuthenticationResponse(metadata, request)) observe(status, failure);
      }
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
}
