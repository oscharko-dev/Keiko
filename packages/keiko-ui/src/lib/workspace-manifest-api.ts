import {
  validateWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootDispatch,
  type WorkspaceRootDispatchOperationClass,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "./http";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

const WORKSPACES_URL = "/api/workspaces";

export const WORKSPACE_MANIFEST_CHANGED_EVENT = "keiko:workspace-manifest-changed";

/**
 * The launcher-pairing marker the workspaces read carries, as ASSERTED by the server.
 *
 * `"unknown"` is not a server state: it is what this client resolves to when the response carries no
 * marker at all. Pairing is an authority input (an unpaired window's run start is guaranteed to fail
 * authority resolution, ADR-0141), so it may never be inferred from silence — a caller that gates on
 * a pairing must require the explicit `"paired"` assertion and treat `"unknown"` as not-granted.
 */
export type WorkspaceManifestSessionPairing = "paired" | "unpaired" | "unknown";

export interface WorkspaceManifestAccess {
  readonly session: WorkspaceManifestSessionPairing;
  readonly manifests: readonly WorkspaceManifest[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidManifestResponse(path: string): Error {
  return new Error(`Workspace manifest response invalid for ${path}.`);
}

function assertManifest(path: string, value: unknown): WorkspaceManifest {
  if (!validateWorkspaceManifest(value).ok) {
    throw invalidManifestResponse(path);
  }
  return value as WorkspaceManifest;
}

// A present marker must be one of the two server assertions; an absent one is NOT read as a pairing.
// Coercing silence into "paired" let a response the server never marked claim a pairing, which fails
// open for every caller that gates an authority decision on it.
function sessionPairing(path: string, marker: unknown): WorkspaceManifestSessionPairing {
  if (marker === undefined) return "unknown";
  if (marker !== "paired" && marker !== "unpaired") throw invalidManifestResponse(path);
  return marker;
}

function manifestListValidator(path: string, value: unknown): WorkspaceManifestAccess {
  if (!isRecord(value) || !Array.isArray(value["manifests"])) {
    throw invalidManifestResponse(path);
  }
  const session = sessionPairing(path, value["session"]);
  const manifests = value["manifests"].map((candidate) => assertManifest(path, candidate));
  if (session === "unpaired" && manifests.length > 0) {
    throw invalidManifestResponse(path);
  }
  return { session, manifests };
}

function manifestMutationValidator(path: string, value: unknown): WorkspaceManifest {
  if (!isRecord(value)) throw invalidManifestResponse(path);
  return assertManifest(path, value["manifest"]);
}

function workspaceUrl(manifest: WorkspaceManifest, suffix = ""): string {
  return `${WORKSPACES_URL}/${encodeURIComponent(manifest.workspaceId)}${suffix}`;
}

function publishManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_MANIFEST_CHANGED_EVENT, { detail: { manifest } }),
    );
  }
  return manifest;
}

export function workspaceManifestEventValue(event: Event): WorkspaceManifest | null {
  if (!(event instanceof CustomEvent) || !isRecord(event.detail)) return null;
  const manifest = event.detail["manifest"];
  return validateWorkspaceManifest(manifest).ok ? (manifest as WorkspaceManifest) : null;
}

export async function fetchWorkspaceManifestAccess(): Promise<WorkspaceManifestAccess> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(WORKSPACES_URL, undefined, {
    validator: manifestListValidator,
    parseFailureMessage: () => "workspace manifest request rejected",
  });
}

export async function fetchWorkspaceManifests(): Promise<readonly WorkspaceManifest[]> {
  return (await fetchWorkspaceManifestAccess()).manifests;
}

export function workspaceRootDispatch(
  manifest: WorkspaceManifest,
  actorRootRef: WorkspaceRootRef,
  operationClass: WorkspaceRootDispatchOperationClass = "mutating",
): WorkspaceRootDispatch {
  const root = manifest.roots.find((candidate) => candidate.rootRef === actorRootRef);
  if (root === undefined) throw new Error("workspace root is not a current member");
  return {
    kind: "workspace-root-dispatch",
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
    operationClass,
  };
}

async function mutateManifest(
  manifest: WorkspaceManifest,
  actor: WorkspaceRootDescriptor,
  suffix: string,
  method: "DELETE" | "POST" | "PUT",
  body: Record<string, unknown>,
): Promise<WorkspaceManifest> {
  const path = workspaceUrl(manifest, suffix);
  const next = await bffFetchJson(
    path,
    {
      method,
      body: JSON.stringify({
        dispatch: workspaceRootDispatch(manifest, actor.rootRef),
        ...body,
      }),
    },
    {
      validator: manifestMutationValidator,
      parseFailureMessage: () => "workspace manifest request rejected",
    },
  );
  return publishManifest(next);
}

export function addWorkspaceRoot(
  manifest: WorkspaceManifest,
  actor: WorkspaceRootDescriptor,
  projectPath: string,
): Promise<WorkspaceManifest> {
  return mutateManifest(manifest, actor, "/roots", "POST", { projectPath });
}

export function removeWorkspaceRoot(
  manifest: WorkspaceManifest,
  actor: WorkspaceRootDescriptor,
  targetRootRef: WorkspaceRootRef,
): Promise<WorkspaceManifest> {
  return mutateManifest(
    manifest,
    actor,
    `/roots/${encodeURIComponent(targetRootRef)}`,
    "DELETE",
    {},
  );
}

export function reorderWorkspaceRoots(
  manifest: WorkspaceManifest,
  actor: WorkspaceRootDescriptor,
  orderedRootRefs: readonly WorkspaceRootRef[],
): Promise<WorkspaceManifest> {
  return mutateManifest(manifest, actor, "/roots/order", "PUT", { orderedRootRefs });
}

export function focusWorkspaceRoot(
  manifest: WorkspaceManifest,
  actor: WorkspaceRootDescriptor,
  focusedRootRef: WorkspaceRootRef,
): Promise<WorkspaceManifest> {
  return mutateManifest(manifest, actor, "/focus", "PUT", { focusedRootRef });
}
