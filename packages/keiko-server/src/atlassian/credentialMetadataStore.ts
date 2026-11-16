// Atlassian connector credential METADATA persistence (Issue #2241, ADR-0128 D1/D2).
//
// Implements keiko-connectors' AtlassianCredentialMetadataStore port over a private, versioned
// JSON file in the same `<config-dir>/credentials/` custody domain as the sealed vault. The
// metadata (display name, provider, base URL, auth scheme, created-at) carries NO secret, but it
// IS backend topology — which is exactly the field class ADR-0013 D8 bans from the UI SQLite
// store (its forbidden-fields gate rejects `provider`/`base_url`/`credential`-class columns in
// the UI DB). Keeping metadata beside the ciphertext also makes the credential domain one
// hardened directory: copy, audit, or remove it as a unit, with the UI database untouched.
//
// Durability follows the secret-vault store conventions: reads re-load the file on every
// operation and FAIL CLOSED on unparseable or schema-invalid content (never treating a corrupt
// store as empty), writes go through the shared atomic 0o600 temp-then-rename writer
// (savePrivateJson), and the file holds a versioned envelope so a future shape change is a
// migration, not a silent re-interpretation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isAtlassianCredentialMetadata,
  type AtlassianCredentialMetadata,
  type AtlassianCredentialMetadataStore as AtlassianCredentialMetadataStorePort,
} from "@oscharko-dev/keiko-connectors";
import { canonicalAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { savePrivateJson } from "../private-json.js";
import { atlassianCredentialVaultDir } from "./credentialVault.js";
import {
  isAtlassianTargetAdmission,
  isCurrentAtlassianDataCenterMetadata,
  type AtlassianTargetAdmission,
} from "./targetAdmission.js";

const METADATA_STORE_FILE = "atlassian-connector-credentials.metadata.json";
const STORE_VERSION = 1;

export function atlassianCredentialMetadataPath(configPath: string): string {
  return join(atlassianCredentialVaultDir(configPath), METADATA_STORE_FILE);
}

export type AtlassianCredentialMetadataStoreErrorCode =
  "METADATA_STORE_INVALID_JSON" | "METADATA_STORE_INVALID_SCHEMA";

export class AtlassianCredentialMetadataStoreError extends Error {
  readonly code: AtlassianCredentialMetadataStoreErrorCode;

  constructor(code: AtlassianCredentialMetadataStoreErrorCode, cause?: unknown) {
    const reason =
      code === "METADATA_STORE_INVALID_JSON"
        ? "not valid JSON"
        : "not a supported credential metadata store";
    super(
      `Atlassian connector credential metadata store is unreadable (${reason}); refusing to treat it as empty`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "AtlassianCredentialMetadataStoreError";
    this.code = code;
  }
}

interface MetadataStoreFile {
  readonly version: number;
  readonly credentials: Record<string, AtlassianCredentialMetadata>;
  readonly targetAdmissions?: Record<string, AtlassianTargetAdmission>;
}

function admissionMatchesMetadata(
  metadata: AtlassianCredentialMetadata | undefined,
  admission: AtlassianTargetAdmission,
): boolean {
  return (
    metadata?.deployment === "data-center" &&
    canonicalAtlassianConnectorBaseUrl(metadata.baseUrl) === admission.baseUrl
  );
}

function validTargetAdmissions(
  value: unknown,
  credentials: Record<string, AtlassianCredentialMetadata>,
): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([authRef, admission]) =>
      isAtlassianTargetAdmission(admission) &&
      admissionMatchesMetadata(credentials[authRef], admission),
  );
}

function isMetadataStoreFile(value: unknown): value is MetadataStoreFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION) return false;
  if (
    Object.keys(record).some(
      (key) => key !== "version" && key !== "credentials" && key !== "targetAdmissions",
    )
  )
    return false;
  const credentials = record.credentials;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    return false;
  }
  return (
    Object.entries(credentials).every(
      ([authRef, entry]) => isAtlassianCredentialMetadata(entry) && entry.authRef === authRef,
    ) &&
    validTargetAdmissions(
      record.targetAdmissions,
      credentials as Record<string, AtlassianCredentialMetadata>,
    )
  );
}

function readStore(storePath: string): MetadataStoreFile {
  if (!existsSync(storePath)) return { version: STORE_VERSION, credentials: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (error) {
    throw new AtlassianCredentialMetadataStoreError("METADATA_STORE_INVALID_JSON", error);
  }
  if (!isMetadataStoreFile(parsed)) {
    throw new AtlassianCredentialMetadataStoreError("METADATA_STORE_INVALID_SCHEMA");
  }
  return parsed;
}

function writeStore(storePath: string, payload: MetadataStoreFile): void {
  if (!isMetadataStoreFile(payload))
    throw new AtlassianCredentialMetadataStoreError("METADATA_STORE_INVALID_SCHEMA");
  savePrivateJson(storePath, payload as unknown as Record<string, unknown>);
}

export interface AtlassianCredentialMetadataStore extends AtlassianCredentialMetadataStorePort {
  readonly getTargetAdmission: (
    metadata: AtlassianCredentialMetadata,
  ) => AtlassianTargetAdmission | undefined;
  readonly bindTargetAdmission: (
    metadata: AtlassianCredentialMetadata,
    admission: AtlassianTargetAdmission,
  ) => AtlassianTargetAdmission | undefined;
}

export interface CreateAtlassianCredentialMetadataStoreOptions {
  readonly configPath: string;
}

function bindTargetAdmission(
  storePath: string,
  metadata: AtlassianCredentialMetadata,
  admission: AtlassianTargetAdmission,
): AtlassianTargetAdmission | undefined {
  const store = readStore(storePath);
  if (
    !isCurrentAtlassianDataCenterMetadata(store.credentials[metadata.authRef], metadata) ||
    !isAtlassianTargetAdmission(admission) ||
    !admissionMatchesMetadata(metadata, admission)
  )
    return undefined;
  const existing = store.targetAdmissions?.[metadata.authRef];
  if (existing !== undefined)
    return existing.baseUrl === admission.baseUrl &&
      existing.addressClass === admission.addressClass
      ? existing
      : undefined;
  writeStore(storePath, {
    ...store,
    targetAdmissions: { ...store.targetAdmissions, [metadata.authRef]: admission },
  });
  return { ...admission };
}

export function createAtlassianCredentialMetadataStore(
  options: CreateAtlassianCredentialMetadataStoreOptions,
): AtlassianCredentialMetadataStore {
  const storePath = atlassianCredentialMetadataPath(options.configPath);
  return {
    insert: (metadata: AtlassianCredentialMetadata): void => {
      const store = readStore(storePath);
      writeStore(storePath, {
        ...store,
        credentials: { ...store.credentials, [metadata.authRef]: metadata },
      });
    },
    get: (authRef: string): AtlassianCredentialMetadata | undefined =>
      readStore(storePath).credentials[authRef],
    list: (): readonly AtlassianCredentialMetadata[] =>
      Object.values(readStore(storePath).credentials),
    delete: (authRef: string): boolean => {
      const store = readStore(storePath);
      const entries = store.credentials;
      if (!(authRef in entries)) return false;
      const next: Record<string, AtlassianCredentialMetadata> = {};
      for (const [storedRef, entry] of Object.entries(entries)) {
        if (storedRef !== authRef) next[storedRef] = entry;
      }
      const targetAdmissions = Object.fromEntries(
        Object.entries(store.targetAdmissions ?? {}).filter(([storedRef]) => storedRef !== authRef),
      );
      writeStore(storePath, { version: STORE_VERSION, credentials: next, targetAdmissions });
      return true;
    },
    getTargetAdmission: (metadata): AtlassianTargetAdmission | undefined => {
      const store = readStore(storePath);
      if (!isCurrentAtlassianDataCenterMetadata(store.credentials[metadata.authRef], metadata))
        return undefined;
      return store.targetAdmissions?.[metadata.authRef];
    },
    bindTargetAdmission: (metadata, admission): AtlassianTargetAdmission | undefined =>
      bindTargetAdmission(storePath, metadata, admission),
  };
}
