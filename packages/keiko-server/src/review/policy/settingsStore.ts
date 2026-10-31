// The per-repository review settings documents (ADR-0182 D8, Issue #4137): one versioned JSON
// document per repository under `<stateDir>/review-settings/`, named by the content-free repository
// id and published atomically through the shared model-policy document store. A stored document is
// untrusted on read: one that does not validate is reported as `invalid` and never used.

import { realpathSync } from "node:fs";

import {
  REVIEW_SETTINGS_SCHEMA_VERSION,
  type ReviewSettingsDocument,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewSettingsDocument } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import {
  locateOwnedDocument,
  publishOwnedJsonDocument,
  readOwnedJsonDocument,
  type OwnedDocumentLocation,
} from "../../modelRolePolicy/documentStore.js";

const REVIEW_SETTINGS_DIR = "review-settings";
/** Repository ids that are also safe file names on every platform (`repo_<16 hex>` and alike). */
const FILE_SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class ReviewSettingsStorageError extends Error {
  public constructor() {
    super("The review settings store is not a safe owned directory.");
    this.name = "ReviewSettingsStorageError";
  }
}

type StoredReviewSettings =
  | { readonly kind: "absent" }
  | { readonly kind: "stored"; readonly document: ReviewSettingsDocument }
  | { readonly kind: "invalid" };

export interface ReviewSettingsStore {
  read(repositoryId: string): StoredReviewSettings;
  /** Publishes the document atomically; throws `ReviewSettingsStorageError` for an unsafe store. */
  write(document: ReviewSettingsDocument): void;
}

export function isReviewSettingsRepositoryId(value: string): boolean {
  return FILE_SAFE_REPOSITORY_ID.test(value);
}

/** The document a repository has before anything was saved. */
export function emptyReviewSettings(repositoryId: string): ReviewSettingsDocument {
  return { schemaVersion: REVIEW_SETTINGS_SCHEMA_VERSION, repositoryId, revision: 0 };
}

function unsafe(): Error {
  return new ReviewSettingsStorageError();
}

function parsedDocument(raw: unknown, repositoryId: string): StoredReviewSettings {
  const validated = validateReviewSettingsDocument(raw);
  return validated.ok && validated.value.repositoryId === repositoryId
    ? { kind: "stored", document: validated.value }
    : { kind: "invalid" };
}

export function createReviewSettingsStore(stateDir: string): ReviewSettingsStore {
  const locate = (repositoryId: string, create: boolean): OwnedDocumentLocation | undefined => {
    if (!isReviewSettingsRepositoryId(repositoryId)) throw unsafe();
    let parent: string;
    try {
      parent = realpathSync(stateDir);
    } catch {
      if (!create) return undefined;
      throw unsafe();
    }
    const place = {
      parent,
      dirName: REVIEW_SETTINGS_DIR,
      fileName: `${repositoryId}.json`,
      unsafe,
    };
    return locateOwnedDocument(place, { create });
  };
  return {
    read: (repositoryId): StoredReviewSettings => {
      const location = locate(repositoryId, false);
      if (location === undefined) return { kind: "absent" };
      let raw: unknown;
      try {
        raw = readOwnedJsonDocument(location, unsafe);
      } catch (error) {
        if (error instanceof ReviewSettingsStorageError) throw error;
        return { kind: "invalid" };
      }
      return raw === undefined ? { kind: "absent" } : parsedDocument(raw, repositoryId);
    },
    write: (document): void => {
      const location = locate(document.repositoryId, true);
      if (location === undefined) throw unsafe();
      publishOwnedJsonDocument(location, document, unsafe, 0o600);
    },
  };
}
