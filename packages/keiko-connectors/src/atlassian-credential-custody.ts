// Atlassian connector credential custody (Issue #2241, Epic #2238, ADR-0128 D2).
//
// The enforcement point for the mode-independent hard denial from ADR-0127 D3: a stored Atlassian
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

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorProvider,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianDisplayName,
  type AtlassianConnectorAuthScheme,
  type AtlassianConnectorProvider,
} from "@oscharko-dev/keiko-contracts";
import type { LocalSecretVault } from "@oscharko-dev/keiko-security/secret-vault";

// ─── Bounds for the credential material itself (hostile-input guards) ─────────
// The account email and API token feed `Authorization: Basic base64(email:token)` downstream, so
// both are restricted to printable ASCII with no whitespace — a value carrying CR/LF or other
// control bytes could otherwise attempt header injection at the transport layer.
export const ATLASSIAN_ACCOUNT_EMAIL_MAX_CHARS = 254;
export const ATLASSIAN_API_TOKEN_MIN_CHARS = 8;
export const ATLASSIAN_API_TOKEN_MAX_CHARS = 1024;

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
  | "vault-unavailable";

// Fixed, content-free messages per code. Field-level `details` name FIELDS only, never values.
const CUSTODY_ERROR_MESSAGES: Readonly<Record<AtlassianCredentialCustodyErrorCode, string>> = {
  "invalid-input": "Atlassian connector credential input failed validation.",
  "unsupported-auth-scheme":
    "The requested Atlassian auth scheme is declared but not supported in this release.",
  "credential-not-found": "Atlassian connector credential is not available.",
  "credential-unreadable": "Atlassian connector credential could not be read from custody.",
  "vault-unavailable": "Atlassian connector credential vault operation failed.",
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
export interface AtlassianCredentialMetadata {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly authRef: string;
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authScheme: AtlassianConnectorAuthScheme;
  readonly createdAt: number;
}

const METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "authRef",
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "createdAt",
]);

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Fail-closed key allowlist: an unexpected field on a redacted, wire-facing shape (a potential
// secret carrier) is a validation failure, never silently carried through.
function hasOnlyMetadataKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => METADATA_KEYS.has(key));
}

function hasValidMetadataFields(record: Record<string, unknown>): boolean {
  return (
    record.schemaVersion === ATLASSIAN_CONNECTOR_SCHEMA_VERSION &&
    isAtlassianConnectorAuthRef(record.authRef) &&
    isAtlassianConnectorProvider(record.provider) &&
    isSafeAtlassianDisplayName(record.displayName) &&
    isSafeAtlassianConnectorBaseUrl(record.baseUrl) &&
    record.authScheme === "basic-api-token" &&
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
export interface AtlassianResolvedCredential {
  readonly scheme: "basic-api-token";
  readonly accountEmail: string;
  readonly apiToken: string;
}

// The narrow execution-only resolver. NOT part of `AtlassianCredentialCustody`: keiko-server
// injects it exclusively into the outbound HTTP adapter (ADR-0128 D2 write-only rule), so no
// route, event, or serialized surface can ever reach the secret.
export interface AtlassianCredentialExecutionResolver {
  readonly resolveForExecution: (authRef: string) => AtlassianResolvedCredential;
}

// ─── Custody surface ───────────────────────────────────────────────────────────
export interface AtlassianCredentialCustody {
  // Accepts the raw secret exactly once (unknown-shaped: hostile input is validated here, at the
  // enforcement point). Returns metadata only. Throws AtlassianCredentialCustodyError.
  readonly create: (input: unknown) => AtlassianCredentialMetadata;
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

// The sealed vault envelope. Versioned so a future `bearer-pat` payload (ADR-0128 D7) is an
// additive envelope variant, not a breaking change.
interface VaultSecretEnvelope {
  readonly schemaVersion: typeof ATLASSIAN_CONNECTOR_SCHEMA_VERSION;
  readonly scheme: "basic-api-token";
  readonly accountEmail: string;
  readonly apiToken: string;
}

function isVaultSecretEnvelope(value: unknown): value is VaultSecretEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === ATLASSIAN_CONNECTOR_SCHEMA_VERSION &&
    record.scheme === "basic-api-token" &&
    isSafeAtlassianAccountEmail(record.accountEmail) &&
    isSafeAtlassianApiToken(record.apiToken)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREATE_INPUT_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "accountEmail",
  "apiToken",
]);

interface ValidatedCreateInput {
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly accountEmail: string;
  readonly apiToken: string;
}

// Validates the auth scheme separately so the declared-but-unimplemented `bearer-pat` value
// (ADR-0128 D2/D7) is refused with its own closed code rather than a generic validation error.
function assertSupportedAuthScheme(value: unknown, errors: string[]): void {
  if (value === "basic-api-token") return;
  if (value === "bearer-pat") {
    throw new AtlassianCredentialCustodyError("unsupported-auth-scheme");
  }
  errors.push("authScheme must be basic-api-token");
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
  assertSupportedAuthScheme(input.authScheme, errors);
  if (!isAtlassianConnectorProvider(input.provider)) {
    errors.push("provider must be confluence or jira");
  }
  if (!isSafeAtlassianDisplayName(input.displayName)) {
    errors.push("displayName must be bounded redaction-safe display text");
  }
  if (!isSafeAtlassianConnectorBaseUrl(input.baseUrl)) {
    errors.push("baseUrl must be an https URL without credentials, query, or fragment");
  }
  if (!isSafeAtlassianAccountEmail(input.accountEmail)) {
    errors.push("accountEmail must be a bounded email address");
  }
  if (!isSafeAtlassianApiToken(input.apiToken)) {
    errors.push("apiToken must be printable ASCII between 8 and 1024 characters");
  }
  if (errors.length > 0) {
    throw new AtlassianCredentialCustodyError("invalid-input", errors);
  }
  return {
    provider: input.provider as AtlassianConnectorProvider,
    displayName: input.displayName as string,
    baseUrl: input.baseUrl as string,
    accountEmail: input.accountEmail as string,
    apiToken: input.apiToken as string,
  };
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
  const envelope: VaultSecretEnvelope = {
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
  return {
    scheme: parsed.scheme,
    accountEmail: parsed.accountEmail,
    apiToken: parsed.apiToken,
  };
}

function createCredential(
  deps: AtlassianCredentialCustodyDeps,
  now: () => number,
  input: unknown,
): AtlassianCredentialMetadata {
  const validated = validateCreateInput(input);
  const authRef = mintAuthRef();
  const metadata: AtlassianCredentialMetadata = {
    schemaVersion: ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
    authRef,
    provider: validated.provider,
    displayName: validated.displayName,
    baseUrl: validated.baseUrl,
    authScheme: "basic-api-token",
    createdAt: now(),
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

// Fails closed on every path: a malformed reference, missing metadata, missing ciphertext, or an
// unreadable/mismatched envelope each produce a closed, content-free reason. A deleted credential
// resolves to `credential-not-found` — the authRef is invalidated, exactly as ADR-0128 D2 requires.
function resolveForExecution(
  deps: AtlassianCredentialCustodyDeps,
  authRef: string,
): AtlassianResolvedCredential {
  if (!isAtlassianConnectorAuthRef(authRef)) {
    throw new AtlassianCredentialCustodyError("credential-not-found");
  }
  const metadata = deps.metadataStore.get(authRef);
  if (metadata === undefined) {
    throw new AtlassianCredentialCustodyError("credential-not-found");
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
    create: (input: unknown): AtlassianCredentialMetadata => createCredential(deps, now, input),
    getMetadata: (authRef: string): AtlassianCredentialMetadata | undefined =>
      isAtlassianConnectorAuthRef(authRef) ? deps.metadataStore.get(authRef) : undefined,
    list: (): readonly AtlassianCredentialMetadata[] =>
      [...deps.metadataStore.list()].sort(
        (left, right) =>
          left.createdAt - right.createdAt || (left.authRef < right.authRef ? -1 : 1),
      ),
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
      resolveForExecution: (authRef: string): AtlassianResolvedCredential =>
        resolveForExecution(deps, authRef),
    },
  };
}

// Builds the `Authorization` header value for a resolved credential. Exported for the SINGLE
// sanctioned caller — keiko-server's outbound AtlassianHttpPort adapter — which materialises it
// immediately before the platform fetch call and never logs or re-emits it (ADR-0128 D2).
export function atlassianAuthorizationHeaderValue(credential: AtlassianResolvedCredential): string {
  return `Basic ${Buffer.from(`${credential.accountEmail}:${credential.apiToken}`, "utf8").toString(
    "base64",
  )}`;
}
