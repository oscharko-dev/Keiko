// Offline operator maintenance only. Reuse the owning validated metadata store and its private,
// atomic writer; never open the encrypted vault or resolve credential material.
import { existsSync } from "node:fs";
import {
  atlassianCredentialMetadataPath,
  createAtlassianCredentialMetadataStore,
} from "../../packages/keiko-server/dist/atlassian/credentialMetadataStore.js";
import { assertNoSymlinkedPathSegments } from "../../packages/keiko-server/dist/private-json.js";

function nextCounter(value) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(value + 1))
    throw new Error("counter-exhausted");
  return value + 1;
}

export function downgradeJiraCompatibility({ configPath, apply = false, serverStopped = false }) {
  if (apply && !serverStopped) throw new Error("server-must-be-stopped");
  const storePath = atlassianCredentialMetadataPath(configPath);
  assertNoSymlinkedPathSegments(storePath);
  if (!existsSync(storePath)) throw new Error("metadata-store-missing");
  const store = createAtlassianCredentialMetadataStore({ configPath });
  const changes = downgradeRecords(store.list());
  if (apply) for (const record of changes) store.insert(record);
  return { affected: changes.length, changed: apply ? changes.length : 0 };
}

function downgradeRecords(records) {
  const changes = [];
  // Validate the whole batch before writing. An interrupted apply is safely repeatable: each
  // atomic record update removes its observation and advances authority exactly once.
  for (const record of records) {
    const pod = record.livePod;
    if (pod?.verificationInProgress || pod?.credentialOperation !== undefined)
      throw new Error("operation-pending");
    if (pod?.compatibility === undefined) continue;
    const legacyPod = Object.fromEntries(
      Object.entries(pod).filter(([key]) => key !== "compatibility"),
    );
    changes.push({
      ...record,
      generation: nextCounter(record.generation),
      livePod: {
        ...legacyPod,
        verificationRevision: nextCounter(pod.verificationRevision),
        verificationInProgress: false,
        verificationStatus: "unverified",
      },
    });
  }
  return changes;
}
