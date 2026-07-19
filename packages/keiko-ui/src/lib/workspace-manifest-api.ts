import {
  validateWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootDispatch,
  type WorkspaceRootDispatchOperationClass,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";

const WORKSPACES_URL = "/api/workspaces";
const MUTATION_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;

export const WORKSPACE_MANIFEST_CHANGED_EVENT = "keiko:workspace-manifest-changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertManifest(value: unknown): WorkspaceManifest {
  if (!validateWorkspaceManifest(value).ok) {
    throw new Error("workspace manifest response invalid");
  }
  return value as WorkspaceManifest;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("workspace manifest request rejected");
  return response.json();
}

async function responseManifest(response: Response): Promise<WorkspaceManifest> {
  const body = await responseJson(response);
  if (!isRecord(body)) throw new Error("workspace manifest response invalid");
  return assertManifest(body["manifest"]);
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

export async function fetchWorkspaceManifests(): Promise<readonly WorkspaceManifest[]> {
  const body = await responseJson(await fetch(WORKSPACES_URL));
  if (!isRecord(body) || !Array.isArray(body["manifests"])) {
    throw new Error("workspace manifest response invalid");
  }
  return body["manifests"].map(assertManifest);
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
  const next = await responseManifest(
    await fetch(workspaceUrl(manifest, suffix), {
      method,
      headers: MUTATION_HEADERS,
      body: JSON.stringify({
        dispatch: workspaceRootDispatch(manifest, actor.rootRef),
        ...body,
      }),
    }),
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
