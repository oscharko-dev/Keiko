import { workspaceStorageKey } from "../../packages/keiko-ui/src/app/components/desktop/hooks/workspace-storage.ts";
import { URL } from "node:url";
import { BASELINE_COMMIT } from "./d12-baseline.mjs";

function workspaceFixtureStorageId(workspace) {
  // The D12 runner verifies the full checkout HEAD before setting both variant fields. Only its
  // frozen pre-ownership product has no storageId; current and ambiguous runs still fail closed.
  if (
    !("storageId" in workspace) &&
    process.env.KEIKO_PERF_D12_REVISION === "baseline" &&
    process.env.KEIKO_PERF_COMMIT === BASELINE_COMMIT
  ) {
    return undefined;
  }
  const id = workspace.storageId;
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/u.test(id)) {
    throw new TypeError("Invalid workspace fixture storage identity.");
  }
  return id;
}

function workspaceFixtureUrl(origin) {
  return origin === undefined
    ? "/api/workspace/state"
    : new URL("/api/workspace/state", origin).href;
}

async function workspaceStorageKeys(page, origin) {
  const response = await page.request.get(workspaceFixtureUrl(origin));
  if (!response.ok()) throw new Error("Workspace fixture cannot resolve its data store.");
  const body = await response.json();
  if (typeof body !== "object" || body === null || !("workspace" in body)) {
    throw new TypeError("Invalid workspace fixture response.");
  }
  const workspace = body.workspace;
  if (typeof workspace !== "object" || workspace === null) {
    throw new TypeError("Missing workspace fixture storage identity.");
  }
  const id = workspaceFixtureStorageId(workspace);
  return {
    workspace: workspaceStorageKey("keiko.workspace.v4", id),
    connections: workspaceStorageKey("keiko.conns.v1", id),
    view: workspaceStorageKey("keiko.view", id),
  };
}

function scopeArgument(value, keys) {
  if (value === "keiko.workspace.v4") return keys.workspace;
  if (value === "keiko.conns.v1") return keys.connections;
  if (value === "keiko.view") return keys.view;
  if (Array.isArray(value)) return value.map((item) => scopeArgument(item, keys));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scopeArgument(item, keys)]),
  );
}

/** Fixture keys come from the real server and production key builder; browser storage stays native. */
export async function workspaceStorageArgs(page, argument, origin) {
  const storageKeys = await workspaceStorageKeys(page, origin);
  return { argument: scopeArgument(argument, storageKeys), storageKeys };
}
