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
  type AtlassianCredentialMetadataStore,
} from "@oscharko-dev/keiko-connectors";
import { savePrivateJson } from "../private-json.js";
import { atlassianCredentialVaultDir } from "./credentialVault.js";

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
}

function isMetadataStoreFile(value: unknown): value is MetadataStoreFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION) return false;
  const credentials = record.credentials;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    return false;
  }
  return Object.entries(credentials).every(
    ([authRef, entry]) => isAtlassianCredentialMetadata(entry) && entry.authRef === authRef,
  );
}

function readEntries(storePath: string): Record<string, AtlassianCredentialMetadata> {
  if (!existsSync(storePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (error) {
    throw new AtlassianCredentialMetadataStoreError("METADATA_STORE_INVALID_JSON", error);
  }
  if (!isMetadataStoreFile(parsed)) {
    throw new AtlassianCredentialMetadataStoreError("METADATA_STORE_INVALID_SCHEMA");
  }
  return { ...parsed.credentials };
}

function writeEntries(
  storePath: string,
  entries: Record<string, AtlassianCredentialMetadata>,
): void {
  const payload: MetadataStoreFile = { version: STORE_VERSION, credentials: entries };
  savePrivateJson(storePath, payload as unknown as Record<string, unknown>);
}

export interface CreateAtlassianCredentialMetadataStoreOptions {
  readonly configPath: string;
}

export function createAtlassianCredentialMetadataStore(
  options: CreateAtlassianCredentialMetadataStoreOptions,
): AtlassianCredentialMetadataStore {
  const storePath = atlassianCredentialMetadataPath(options.configPath);
  return {
    insert: (metadata: AtlassianCredentialMetadata): void => {
      const entries = readEntries(storePath);
      entries[metadata.authRef] = metadata;
      writeEntries(storePath, entries);
    },
    get: (authRef: string): AtlassianCredentialMetadata | undefined =>
      readEntries(storePath)[authRef],
    list: (): readonly AtlassianCredentialMetadata[] => Object.values(readEntries(storePath)),
    delete: (authRef: string): boolean => {
      const entries = readEntries(storePath);
      if (!(authRef in entries)) return false;
      const next: Record<string, AtlassianCredentialMetadata> = {};
      for (const [storedRef, entry] of Object.entries(entries)) {
        if (storedRef !== authRef) next[storedRef] = entry;
      }
      writeEntries(storePath, next);
      return true;
    },
  };
}
