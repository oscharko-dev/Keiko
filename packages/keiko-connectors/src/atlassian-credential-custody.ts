// Atlassian connector credential custody (Issue #2241, Epic #2238, ADR-0128 D2).
//
// The enforcement point for the mode-independent hard denial from ADR-0129 D3: a stored Atlassian
// API token must never reach logs, evidence, diagnostics, audit events, API responses, or the UI
// after save. The custody surface is write-only after creation:
//
//   - `create` accepts the raw secret exactly once, seals it into the injected vault under a
//     freshly minted opaque `authRef` (`atlassian-cred:<16 random bytes, base64url>`), persists the
//     non-secret metadata separately, and returns ONLY the metadata.
//   - `list` / `getMetadata` return the non-secret projection (display name, provider, base URL,
//     auth scheme, created-at) — never the secret, not even masked fragments.
//   - `delete` removes the ciphertext and the metadata; the `authRef` is invalidated and any later
//     resolution fails closed with a content-free reason.
//   - `resolveForExecution` lives on a SEPARATE narrow resolver interface that is deliberately not
//     part of the general custody surface: `keiko-server` injects it only into the outbound HTTP
//     adapter, which materialises the secret into the `Authorization` header immediately before
//     the platform fetch call (mirroring the Figma PAT port comment) and never re-emits it.
//
// This package has no filesystem or network capability (ADR-0128 D1): the vault and the metadata
// store are injected ports. The concrete vault is `keiko-security`'s `createLocalSecretVault`
// instance for the dedicated `atlassian-connector-credentials` domain, constructed in
// `keiko-server` (the sole composition root). Every error thrown here carries a closed,
// content-free code and a fixed message — no field VALUE (token, email, URL, display name) ever
// enters an error, so a thrown custody error can never leak a secret into a diagnostic record.

import { randomBytes, randomUUID } from "node:crypto";
import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isAtlassianConnectionVerificationStatus,
  type JiraLivePodMetadata,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { Buffer } from "node:buffer";
import type {
  AtlassianCredentialMetadata,
  AtlassianCredentialCreateRequest,
  AtlassianConnectorProvider,
} from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorProvider,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianDisplayName,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { LocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";

// ─── Bounds for the credential material itself (hostile-input guards) ─────────
// The account email and API token feed `Authorization: Basic base64(email:token)` downstream, so
// both are restricted to printable ASCII with no whitespace — a value carrying CR/LF or other
// control bytes could otherwise attempt header injection at the transport layer.
export const ATLASSIAN_ACCOUNT_EMAIL_MAX_CHARS = 254;
export const ATLASSIAN_API_TOKEN_MIN_CHARS = 8;
export const ATLASSIAN_API_TOKEN_MAX_CHARS = 1024;

// Defense-in-depth cap on the number of stored Atlassian credentials/connectors (KEIKO-0826). An
// independently-appropriate limit for this resource — not shared with, or derived from, the
// unrelated pending-approval registry cap (ATLASSIAN_ACTION_APPROVAL_MAX_PENDING in
// keiko-server's actionApprovals.ts), which bounds a different resource with a different natural
// size. A handful to a few dozen configured connectors is the realistic ceiling for any tenant.
export const ATLASSIAN_CREDENTIAL_CUSTODY_MAX_ENTRIES = 64;

const ACCOUNT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const API_TOKEN_PATTERN = /^[\x21-\x7E]+$/u;

export function isSafeAtlassianAccountEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ATLASSIAN_ACCOUNT_EMAIL_MAX_CHARS &&
    ACCOUNT_EMAIL_PATTERN.test(value)
  );
}

export function isSafeAtlassianApiToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= ATLASSIAN_API_TOKEN_MIN_CHARS &&
    value.length <= ATLASSIAN_API_TOKEN_MAX_CHARS &&
    API_TOKEN_PATTERN.test(value)
  );
}

// ─── Content-free custody errors ───────────────────────────────────────────────
export type AtlassianCredentialCustodyErrorCode =
  | "invalid-input"
  | "unsupported-auth-scheme"
  | "credential-not-found"
  | "credential-unreadable"
  | "vault-unavailable"
  | "credential-limit-exceeded"
  | "creation-conflict"
  | "credential-changed";

// Fixed, content-free messages per code. Field-level `details` name FIELDS only, never values.
const CUSTODY_ERROR_MESSAGES: Readonly<Record<AtlassianCredentialCustodyErrorCode, string>> = {
  "invalid-input": "Atlassian connector credential input failed validation.",
  "unsupported-auth-scheme":
    "The requested Atlassian auth scheme is declared but not supported in this release.",
  "credential-not-found": "Atlassian connector credential is not available.",
  "credential-unreadable": "Atlassian connector credential could not be read from custody.",
  "vault-unavailable": "Atlassian connector credential vault operation failed.",
  "credential-limit-exceeded": "Atlassian connector credential storage limit has been reached.",
  "creation-conflict": "This Jira Pod creation request has already been applied.",
  "credential-changed": "The credential changed before this operation could run.",
};

export class AtlassianCredentialCustodyError extends Error {
  readonly code: AtlassianCredentialCustodyErrorCode;
  // Content-free field-level validation messages ("<field> must ...") — never field values.
  readonly details: readonly string[];

  constructor(
    code: AtlassianCredentialCustodyErrorCode,
    details: readonly string[] = [],
    cause?: unknown,
  ) {
    super(CUSTODY_ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "AtlassianCredentialCustodyError";
    this.code = code;
    this.details = details;
  }
}

// ─── Metadata (the ONLY shape custody ever returns) ───────────────────────────
// The non-secret projection of one stored credential. There is deliberately no field that could
// carry the token or the account email: the email is half of the Basic credential pair and lives
// only inside the sealed vault envelope.
export type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-contracts";

const METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "authRef",
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "createdAt",
  "deployment",
  "generation",
  "livePod",
]);

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Fail-closed key allowlist: an unexpected field on a redacted, wire-facing shape (a potential
// secret carrier) is a validation failure, never silently carried through.
function hasOnlyMetadataKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => METADATA_KEYS.has(key));
}

function isValidDeploymentMetadata(record: Record<string, unknown>): boolean {
  if (record.authScheme === "basic-api-token") {
    return (
      record.livePod === undefined &&
      (record.deployment === undefined || record.deployment === "cloud")
    );
  }
  return (
    record.authScheme === "bearer-pat" &&
    record.provider === "jira" &&
    record.deployment === "data-center" &&
    record.generation !== undefined &&
    (record.livePod === undefined || validLivePodMetadata(record.livePod))
  );
}

const LIVE_POD_KEYS = new Set([
  "podId",
  "ownerDigest",
  "creationRequestId",
  "verificationRevision",
  "verificationInProgress",
  "verificationStatus",
]);

function ownerDigestIsValid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validLivePodMetadata(value: unknown): value is JiraLivePodMetadata {
  if (!isRecord(value) || !Object.keys(value).every((key) => LIVE_POD_KEYS.has(key))) return false;
  return (
    isChatJiraPodId(value.podId) &&
    isChatJiraPodId(value.creationRequestId) &&
    ownerDigestIsValid(value.ownerDigest) &&
    Number.isSafeInteger(value.verificationRevision) &&
    Number(value.verificationRevision) >= 0 &&
    typeof value.verificationInProgress === "boolean" &&
    (value.verificationStatus === "unverified" ||
      isAtlassianConnectionVerificationStatus(value.verificationStatus))
  );
}

function hasValidMetadataFields(record: Record<string, unknown>): boolean {
  return (
    record.schemaVersion === ATLASSIAN_CONNECTOR_SCHEMA_VERSION &&
    isAtlassianConnectorAuthRef(record.authRef) &&
    isAtlassianConnectorProvider(record.provider) &&
    isSafeAtlassianDisplayName(record.displayName) &&
    isSafeAtlassianConnectorBaseUrl(record.baseUrl) &&
    isValidDeploymentMetadata(record) &&
    (record.generation === undefined ||
      (Number.isSafeInteger(record.generation) && Number(record.generation) > 0)) &&
    isFiniteNonNegativeNumber(record.createdAt)
  );
}

export function isAtlassianCredentialMetadata(
  value: unknown,
): value is AtlassianCredentialMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return hasOnlyMetadataKeys(record) && hasValidMetadataFields(record);
}

// ─── Injected ports (implemented by keiko-server, the composition root) ───────
// Structural subset of keiko-security's LocalSecretVault: custody needs no `replaceAll`/`list`.
export type AtlassianCredentialVaultPort = Pick<LocalSecretVault, "get" | "set" | "delete">;

// Non-secret metadata persistence. keiko-server implements this over a private, 0600-hardened
// JSON store in the same `<config-dir>/credentials/` custody domain as the vault (ADR-0128 D2) —
// deliberately NOT the UI SQLite store, whose ADR-0013 D8 forbidden-fields invariant excludes
// provider names, base URLs, and credential references.
export interface AtlassianCredentialMetadataStore {
  readonly insert: (metadata: AtlassianCredentialMetadata) => void;
  readonly get: (authRef: string) => AtlassianCredentialMetadata | undefined;
  readonly list: () => readonly AtlassianCredentialMetadata[];
  readonly delete: (authRef: string) => boolean;
}

// ─── Resolved credential (execution path only; in-memory, short-lived) ────────
export type AtlassianResolvedCredential =
  | { readonly scheme: "basic-api-token"; readonly accountEmail: string; readonly apiToken: string }
  | { readonly scheme: "bearer-pat"; readonly apiToken: string };

// The narrow execution-only resolver. NOT part of `AtlassianCredentialCustody`: keiko-server
// injects it exclusively into the outbound HTTP adapter (ADR-0128 D2 write-only rule), so no
// route, event, or serialized surface can ever reach the secret.
export interface AtlassianCredentialExecutionResolver {
  readonly resolveForExecution: (
    authRef: string,
    expectedGeneration?: number,
  ) => AtlassianResolvedCredential;
}

// ─── Custody surface ───────────────────────────────────────────────────────────
export interface AtlassianCredentialCustody {
  // Accepts the raw secret exactly once (unknown-shaped: hostile input is validated here, at the
  // enforcement point). Returns metadata only. Throws AtlassianCredentialCustodyError.
  readonly create: (input: unknown, livePodOwnerDigest?: string) => AtlassianCredentialMetadata;
  readonly beginVerification: (
    authRef: string,
    expectedGeneration?: number,
  ) => { readonly metadata: AtlassianCredentialMetadata; readonly revision: number } | undefined;
  readonly finishVerification: (
    authRef: string,
    generation: number,
    revision: number,
    status: JiraLivePodMetadata["verificationStatus"],
  ) => boolean;
  readonly getMetadata: (authRef: string) => AtlassianCredentialMetadata | undefined;
  readonly list: () => readonly AtlassianCredentialMetadata[];
  // Removes ciphertext AND metadata; returns false when the authRef is unknown.
  readonly delete: (authRef: string) => boolean;
}

export interface AtlassianCredentialCustodyDeps {
  readonly vault: AtlassianCredentialVaultPort;
  readonly metadataStore: AtlassianCredentialMetadataStore;
  readonly now?: () => number;
}

export interface CreatedAtlassianCredentialCustody {
  readonly custody: AtlassianCredentialCustody;
  readonly executionResolver: AtlassianCredentialExecutionResolver;
}

// Additive v1 envelopes preserve existing Cloud vault records.
type VaultSecretEnvelope = AtlassianResolvedCredential & {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
};

function isVaultSecretEnvelope(value: unknown): value is VaultSecretEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== ATLASSIAN_CONNECTOR_SCHEMA_VERSION ||
    !isSafeAtlassianApiToken(value.apiToken)
  )
    return false;
  const keys =
    value.scheme === "basic-api-token"
      ? new Set(["schemaVersion", "scheme", "accountEmail", "apiToken"])
      : new Set(["schemaVersion", "scheme", "apiToken"]);
  if (Object.keys(value).some((key) => !keys.has(key))) return false;
  return (
    value.scheme === "bearer-pat" ||
    (value.scheme === "basic-api-token" && isSafeAtlassianAccountEmail(value.accountEmail))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Total order over metadata rows: createdAt ascending, then authRef ascending by code unit
// (matching adf-to-text.ts's compareByCodeUnit convention — deliberately not localeCompare, for
// locale-independent, byte-identical output). Exported package-internally (not part of the public
// barrel) so its equal-case behavior is independently testable: a two-way ternary tie-breaker
// previously reported compare(a, a) === 1 (KEIKO-0810) instead of 0, which is not a valid total
// order and risks an implementation-defined Array.prototype.sort outcome.
export function compareAtlassianCredentialMetadata(
  left: AtlassianCredentialMetadata,
  right: AtlassianCredentialMetadata,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.authRef < right.authRef) return -1;
  if (left.authRef > right.authRef) return 1;
  return 0;
}

const CREATE_INPUT_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "deployment",
  "accountEmail",
  "apiToken",
  "livePodCreationRequestId",
]);

type ValidatedCreateInput = AtlassianCredentialCreateRequest;

function assertSupportedAuthScheme(input: Record<string, unknown>, errors: string[]): void {
  validateLivePodCreateIntent(input, errors);
  validateAuthVariant(input, errors);
}

function validateLivePodCreateIntent(input: Record<string, unknown>, errors: string[]): void {
  if (
    input.livePodCreationRequestId !== undefined &&
    (input.authScheme !== "bearer-pat" || !isChatJiraPodId(input.livePodCreationRequestId))
  )
    errors.push("livePodCreationRequestId must identify a Data Center Pod creation");
}

function validateAuthVariant(input: Record<string, unknown>, errors: string[]): void {
  if (input.authScheme === "basic-api-token") {
    if (input.deployment !== undefined && input.deployment !== "cloud")
      errors.push("deployment must match authScheme");
    if (!isSafeAtlassianAccountEmail(input.accountEmail))
      errors.push("accountEmail must be a bounded email address");
    return;
  }
  if (input.authScheme === "bearer-pat") {
    if (input.provider !== "jira" || input.deployment !== "data-center")
      throw new AtlassianCredentialCustodyError("unsupported-auth-scheme");
    if (Object.hasOwn(input, "accountEmail"))
      errors.push("accountEmail must be absent for bearer-pat");
    return;
  }
  errors.push("authScheme must be basic-api-token or bearer-pat");
}

function validatedCreateVariant(input: Record<string, unknown>): ValidatedCreateInput {
  const common = {
    displayName: input.displayName as string,
    baseUrl: input.baseUrl as string,
    apiToken: input.apiToken as string,
  };
  if (input.authScheme === "bearer-pat")
    return {
      ...common,
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      ...(input.livePodCreationRequestId === undefined
        ? {}
        : { livePodCreationRequestId: input.livePodCreationRequestId as string }),
    };
  return {
    ...common,
    provider: input.provider as AtlassianConnectorProvider,
    authScheme: "basic-api-token",
    accountEmail: input.accountEmail as string,
    ...(input.deployment === "cloud" ? { deployment: "cloud" } : {}),
  };
}

// Every message names the field and its rule only — never the submitted value, so a rejected
// hostile payload (which may contain a live token) cannot echo through the error path.
function validateCreateInput(input: unknown): ValidatedCreateInput {
  if (!isRecord(input)) {
    throw new AtlassianCredentialCustodyError("invalid-input", ["input must be a JSON object"]);
  }
  const errors: string[] = [];
  // Unlike the sibling contracts validators, the offending key NAME is deliberately not echoed:
  // on a secret-bearing payload an unexpected field name is itself attacker-controlled content
  // that could carry a token into the error path.
  if (Object.keys(input).some((key) => !CREATE_INPUT_KEYS.has(key))) {
    errors.push("input must not include unexpected fields");
  }
  assertSupportedAuthScheme(input, errors);
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("provider must be confluence or jira");
  }
  if (!isSafeAtlassianDisplayName(input.displayName)) {
    errors.push("displayName must be bounded redaction-safe display text");
  }
  if (!isSafeAtlassianConnectorBaseUrl(input.baseUrl)) {
    errors.push("baseUrl must be an https URL without credentials, query, or fragment");
  }
  if (!isSafeAtlassianApiToken(input.apiToken)) {
    errors.push("apiToken must be printable ASCII between 8 and 1024 characters");
  }
  if (errors.length > 0) {
    throw new AtlassianCredentialCustodyError("invalid-input", errors);
  }
  return validatedCreateVariant(input);
}

// `atlassian-cred:<16 random bytes, base64url>` — 22 unpadded characters (ADR-0128 D2), matching
// the contracts' isAtlassianConnectorAuthRef pattern. Independent of every non-secret field so
// renaming or re-pointing a connector never requires rekeying the vault.
function mintAuthRef(): string {
  return `${ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX}${randomBytes(16).toString("base64url")}`;
}

// Wraps a vault-port operation so an infrastructure fault surfaces as the closed, content-free
// `vault-unavailable` code (the underlying cause is preserved for correlation-keyed operator
// diagnostics; vault errors are secret-free by keiko-security's construction).
function vaultOp<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new AtlassianCredentialCustodyError("vault-unavailable", [], error);
  }
}

function serializeSecret(input: ValidatedCreateInput): string {
  const envelope: VaultSecretEnvelope =
    input.authScheme === "bearer-pat"
      ? {
          schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
          scheme: "bearer-pat",
          apiToken: input.apiToken,
        }
      : {
          schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
          scheme: "basic-api-token",
          accountEmail: input.accountEmail,
          apiToken: input.apiToken,
        };
  return JSON.stringify(envelope);
}

function parseSecretEnvelope(raw: string): AtlassianResolvedCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AtlassianCredentialCustodyError("credential-unreadable", [], error);
  }
  if (!isVaultSecretEnvelope(parsed)) {
    throw new AtlassianCredentialCustodyError("credential-unreadable");
  }
  if (parsed.scheme === "bearer-pat") return { scheme: parsed.scheme, apiToken: parsed.apiToken };
  return { scheme: parsed.scheme, accountEmail: parsed.accountEmail, apiToken: parsed.apiToken };
}

function createCredential(
  deps: AtlassianCredentialCustodyDeps,
  now: () => number,
  input: unknown,
  livePodOwnerDigest?: string,
): AtlassianCredentialMetadata {
  const validated = validateCreateInput(input);
  const livePod = newLivePodMetadata(deps, validated, livePodOwnerDigest);
  // Fail closed once the storage cap is reached (KEIKO-0826), before the vault write — a caller
  // who can already reach the credential-creation route must not be able to grow the vault
  // unboundedly. Deliberately not folded into validateCreateInput: that function validates the
  // untrusted payload SHAPE only; the count check needs deps.metadataStore, which only this
  // function has in scope.
  if (deps.metadataStore.list().length >= ATLASSIAN_CREDENTIAL_CUSTODY_MAX_ENTRIES) {
    throw new AtlassianCredentialCustodyError("credential-limit-exceeded");
  }
  const authRef = mintAuthRef();
  const metadata: AtlassianCredentialMetadata = {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    authRef,
    displayName: validated.displayName,
    baseUrl: validated.baseUrl,
    createdAt: now(),
    ...(validated.authScheme === "bearer-pat"
      ? ({
          provider: "jira",
          authScheme: "bearer-pat",
          deployment: "data-center",
          generation: 1,
          ...(livePod === undefined ? {} : { livePod }),
        } as const)
      : ({
          provider: validated.provider,
          authScheme: "basic-api-token",
          ...(validated.deployment === "cloud" ? ({ deployment: "cloud" } as const) : {}),
        } as const)),
  };
  // Vault write FIRST (mirroring the provider-credential migration ordering): if the metadata
  // insert fails, the orphaned ciphertext is removed best-effort so no unreferenced secret
  // lingers on disk, and the failure propagates.
  vaultOp(() => {
    deps.vault.set(authRef, serializeSecret(validated));
  });
  try {
    deps.metadataStore.insert(metadata);
  } catch (error) {
    try {
      deps.vault.delete(authRef);
    } catch {
      // Best-effort rollback only: the primary failure below is the one that must surface.
    }
    throw error;
  }
  return metadata;
}

function newLivePodMetadata(
  deps: AtlassianCredentialCustodyDeps,
  input: ValidatedCreateInput,
  ownerDigest: string | undefined,
): JiraLivePodMetadata | undefined {
  if (input.authScheme !== "bearer-pat" || input.livePodCreationRequestId === undefined)
    return undefined;
  if (!ownerDigestIsValid(ownerDigest)) throw new AtlassianCredentialCustodyError("invalid-input");
  const duplicate = deps.metadataStore
    .list()
    .some(
      (row) =>
        row.deployment === "data-center" &&
        row.livePod?.ownerDigest === ownerDigest &&
        row.livePod.creationRequestId === input.livePodCreationRequestId,
    );
  if (duplicate) throw new AtlassianCredentialCustodyError("creation-conflict");
  return {
    podId: randomUUID(),
    ownerDigest,
    creationRequestId: input.livePodCreationRequestId,
    verificationRevision: 0,
    verificationInProgress: false,
    verificationStatus: "unverified",
  };
}

type LivePodCredential = Extract<
  AtlassianCredentialMetadata,
  { readonly deployment: "data-center" }
> & { readonly livePod: JiraLivePodMetadata };

function livePodCredential(
  deps: AtlassianCredentialCustodyDeps,
  authRef: string,
): LivePodCredential | undefined {
  if (!isAtlassianConnectorAuthRef(authRef)) return undefined;
  const metadata = deps.metadataStore.get(authRef);
  if (
    !isAtlassianCredentialMetadata(metadata) ||
    metadata.deployment !== "data-center" ||
    metadata.livePod === undefined
  )
    return undefined;
  return { ...metadata, livePod: metadata.livePod };
}

function advanceGeneration(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) throw new AtlassianCredentialCustodyError("invalid-input");
  return next;
}

function beginVerification(
  deps: AtlassianCredentialCustodyDeps,
  authRef: string,
  expectedGeneration?: number,
): ReturnType<AtlassianCredentialCustody["beginVerification"]> {
  const metadata = livePodCredential(deps, authRef);
  if (metadata === undefined) return undefined;
  if (expectedGeneration !== undefined && metadata.generation !== expectedGeneration)
    throw new AtlassianCredentialCustodyError("credential-changed");
  const revision = advanceGeneration(metadata.livePod.verificationRevision);
  const next = {
    ...metadata,
    livePod: { ...metadata.livePod, verificationRevision: revision, verificationInProgress: true },
  };
  deps.metadataStore.insert(next);
  return { metadata: next, revision };
}

function finishVerification(
  deps: AtlassianCredentialCustodyDeps,
  authRef: string,
  generation: number,
  revision: number,
  status: JiraLivePodMetadata["verificationStatus"],
): boolean {
  const metadata = livePodCredential(deps, authRef);
  if (
    metadata?.generation !== generation ||
    metadata.livePod.verificationRevision !== revision ||
    !metadata.livePod.verificationInProgress
  )
    return false;
  if (status !== "unverified" && !isAtlassianConnectionVerificationStatus(status))
    throw new AtlassianCredentialCustodyError("invalid-input");
  deps.metadataStore.insert({
    ...metadata,
    generation: status === "ok" ? generation : advanceGeneration(generation),
    livePod: { ...metadata.livePod, verificationInProgress: false, verificationStatus: status },
  });
  return true;
}

// Fails closed on every path: a malformed reference, missing metadata, missing ciphertext, or an
// unreadable/mismatched envelope each produce a closed, content-free reason. A deleted credential
// resolves to `credential-not-found` — the authRef is invalidated, exactly as ADR-0128 D2 requires.
function resolveForExecution(
  deps: AtlassianCredentialCustodyDeps,
  authRef: string,
  expectedGeneration?: number,
): AtlassianResolvedCredential {
  if (!isAtlassianConnectorAuthRef(authRef)) {
    throw new AtlassianCredentialCustodyError("credential-not-found");
  }
  const metadata = deps.metadataStore.get(authRef);
  // Re-validate the metadata read back from the injected store (KEIKO-0894), mirroring
  // parseSecretEnvelope's re-validation of the vault side just below: the store is expected to
  // only ever hold what `create` wrote, but a tainted record — hand-edited, corrupted, or written
  // by a future store implementation that skips the key allowlist — must never resolve a
  // credential. Indistinguishable from "never existed": no oracle for which case occurred.
  if (metadata === undefined || !isAtlassianCredentialMetadata(metadata)) {
    throw new AtlassianCredentialCustodyError("credential-not-found");
  }
  if (expectedGeneration !== undefined && expectedGeneration !== (metadata.generation ?? 1)) {
    throw new AtlassianCredentialCustodyError("credential-changed");
  }
  const sealed = vaultOp(() => deps.vault.get(authRef));
  if (sealed === undefined) {
    throw new AtlassianCredentialCustodyError("credential-not-found");
  }
  const resolved = parseSecretEnvelope(sealed);
  if (resolved.scheme !== metadata.authScheme) {
    throw new AtlassianCredentialCustodyError("credential-unreadable");
  }
  return resolved;
}

export function createAtlassianCredentialCustody(
  deps: AtlassianCredentialCustodyDeps,
): CreatedAtlassianCredentialCustody {
  const now = deps.now ?? ((): number => Date.now());
  const custody: AtlassianCredentialCustody = {
    create: (input: unknown, ownerDigest?: string): AtlassianCredentialMetadata =>
      createCredential(deps, now, input, ownerDigest),
    beginVerification: (authRef, expectedGeneration) =>
      beginVerification(deps, authRef, expectedGeneration),
    finishVerification: (authRef, generation, revision, status) =>
      finishVerification(deps, authRef, generation, revision, status),
    // Re-validated on read (KEIKO-0894), matching resolveForExecution below: an authRef that
    // resolves to a record failing the key allowlist is indistinguishable from one that was never
    // stored.
    getMetadata: (authRef: string): AtlassianCredentialMetadata | undefined => {
      if (!isAtlassianConnectorAuthRef(authRef)) return undefined;
      const raw = deps.metadataStore.get(authRef);
      return raw !== undefined && isAtlassianCredentialMetadata(raw) ? raw : undefined;
    },
    // list() is UI-facing (the credentials panel), so a tainted record is silently DROPPED rather
    // than failing the whole call closed: one corrupted row must not hide every other legitimate
    // credential from the UI, and this mirrors getMetadata's per-item "not there" posture above
    // rather than treating the entire list as unreadable (KEIKO-0894 — this is the documented
    // choice the finding asked for).
    list: (): readonly AtlassianCredentialMetadata[] =>
      [...deps.metadataStore.list()]
        .filter(isAtlassianCredentialMetadata)
        .sort(compareAtlassianCredentialMetadata),
    delete: (authRef: string): boolean => {
      if (!isAtlassianConnectorAuthRef(authRef)) return false;
      if (deps.metadataStore.get(authRef) === undefined) return false;
      // Ciphertext removal first: if it fails the metadata row remains and the delete is
      // retryable; the reverse order could silently orphan a sealed secret on disk.
      vaultOp(() => {
        deps.vault.delete(authRef);
      });
      return deps.metadataStore.delete(authRef);
    },
  };
  return {
    custody,
    executionResolver: {
      resolveForExecution: (
        authRef: string,
        expectedGeneration?: number,
      ): AtlassianResolvedCredential => resolveForExecution(deps, authRef, expectedGeneration),
    },
  };
}

// Builds the `Authorization` header value for a resolved credential. Exported for the SINGLE
// sanctioned caller — keiko-server's outbound AtlassianHttpPort adapter — which materialises it
// immediately before the platform fetch call and never logs or re-emits it (ADR-0128 D2).
export function atlassianAuthorizationHeaderValue(credential: AtlassianResolvedCredential): string {
  if (credential.scheme === "bearer-pat") return `Bearer ${credential.apiToken}`;
  const basicToken = `${credential.accountEmail}:${credential.apiToken}`;
  return `Basic ${Buffer.from(basicToken, "utf8").toString("base64")}`;
}
