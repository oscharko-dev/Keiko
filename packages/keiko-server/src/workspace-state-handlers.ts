import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { RouteContext, RouteResult } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody } from "./routes.js";
import type { UiStore } from "./store/index.js";

const MAX_WORKSPACE_STATE_BODY_BYTES = 256_000;
const MAX_WORKSPACE_WINDOWS = 128;
const MAX_WORKSPACE_CONNECTIONS = 512;

interface WorkspaceStateSnapshot {
  readonly revision: number;
  readonly windows: readonly unknown[];
  readonly connections: readonly unknown[];
  readonly updatedAtMs: number;
}

let workspaceState: WorkspaceStateSnapshot = {
  revision: 0,
  windows: [],
  connections: [],
  updatedAtMs: 0,
};
let storeSnapshots = new WeakMap<UiStore, WorkspaceStateSnapshot>();
let storageIdentities = new WeakMap<UiStore, string>();
// Durable layout belongs to browser localStorage (ADR-0027); the BFF only coordinates revisions.

class InvalidWorkspaceState extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceState";
  }
}

class WorkspaceStateBodyTooLarge extends Error {
  public constructor() {
    super("body too large");
    this.name = "WorkspaceStateBodyTooLarge";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_WORKSPACE_STATE_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new WorkspaceStateBodyTooLarge());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidWorkspaceState("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof WorkspaceStateBodyTooLarge) throw error;
    throw new InvalidWorkspaceState("Request body is not valid JSON.");
  }
  return asRecord(parsed);
}

function requireArray(
  body: Record<string, unknown>,
  key: string,
  maxItems: number,
): readonly unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new InvalidWorkspaceState(`Field "${key}" must be an array.`);
  if (value.length > maxItems) {
    throw new InvalidWorkspaceState(`Field "${key}" exceeds the item limit.`);
  }
  return value;
}

function workspaceStateEtag(revision: number): string {
  return `"workspace-state-${String(revision)}"`;
}

function emptyWorkspaceState(): WorkspaceStateSnapshot {
  return { revision: 0, windows: [], connections: [], updatedAtMs: 0 };
}

function headerValues(req: IncomingMessage, name: "if-match" | "if-none-match"): readonly string[] {
  const header = req.headers[name];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function requestMatchesWorkspaceState(
  req: IncomingMessage,
  state: WorkspaceStateSnapshot,
): boolean {
  const values = headerValues(req, "if-none-match");
  if (values.length === 0) return false;
  const current = workspaceStateEtag(state.revision);
  return values.some((item) => item === current || item === "*");
}

function requestHasWorkspaceWritePrecondition(
  req: IncomingMessage,
  state: WorkspaceStateSnapshot,
): boolean {
  const values = headerValues(req, "if-match");
  if (values.length === 0) return false;
  const current = workspaceStateEtag(state.revision);
  return values.includes(current);
}

function workspacePayloadMatches(
  windows: readonly unknown[],
  connections: readonly unknown[],
  state: WorkspaceStateSnapshot,
): boolean {
  return (
    JSON.stringify(state.windows) === JSON.stringify(windows) &&
    JSON.stringify(state.connections) === JSON.stringify(connections)
  );
}

type WorkspaceStateDeps = Pick<UiHandlerDeps, "env"> & Partial<Pick<UiHandlerDeps, "store">>;

/** Reuse the UI database's existing installation identity; this digest grants no authority. */
export function workspaceLayoutStorageId(store: UiStore): string | undefined {
  const cached = storageIdentities.get(store);
  if (cached !== undefined) return cached;
  const installationId = store.browserApprovals?.installationId();
  if (installationId === undefined) return undefined;
  const identity = createHash("sha256")
    .update("keiko-workspace-layout-v1\u0000")
    .update(installationId)
    .digest("hex");
  storageIdentities.set(store, identity);
  return identity;
}

function currentWorkspaceState(deps: WorkspaceStateDeps | undefined): WorkspaceStateSnapshot {
  return deps?.store === undefined
    ? workspaceState
    : (storeSnapshots.get(deps.store) ?? emptyWorkspaceState());
}

function workspaceStateBody(
  deps: WorkspaceStateDeps | undefined,
  state: WorkspaceStateSnapshot,
): unknown {
  return {
    workspace: {
      ...state,
      ...(deps?.store === undefined ? {} : { storageId: workspaceLayoutStorageId(deps.store) }),
    },
  };
}

function workspaceStorageMismatch(
  ctx: RouteContext,
  deps: WorkspaceStateDeps | undefined,
): RouteResult | undefined {
  const supplied = ctx.req.headers["x-keiko-workspace-storage"];
  if (supplied === undefined && ctx.req.method === "PUT" && deps?.store !== undefined) {
    return {
      status: 428,
      body: errorBody(
        "PRECONDITION_REQUIRED",
        "Workspace updates require their data store identity.",
      ),
    };
  }
  if (
    supplied === undefined ||
    (deps?.store !== undefined && supplied === workspaceLayoutStorageId(deps.store))
  )
    return undefined;
  return {
    status: 409,
    body: errorBody(
      "WORKSPACE_STORAGE_CHANGED",
      "The saved workspace belongs to another data store.",
    ),
  };
}

export function handleGetWorkspaceState(ctx: RouteContext, deps?: WorkspaceStateDeps): RouteResult {
  if (deps?.store !== undefined && workspaceLayoutStorageId(deps.store) === undefined) {
    return {
      status: 503,
      body: errorBody(
        "WORKSPACE_STORAGE_UNAVAILABLE",
        "Workspace layout ownership is unavailable.",
      ),
    };
  }
  const mismatch = workspaceStorageMismatch(ctx, deps);
  if (mismatch !== undefined) return mismatch;
  const state = currentWorkspaceState(deps);
  const etag = workspaceStateEtag(state.revision);
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (requestMatchesWorkspaceState(ctx.req, state)) {
    return { status: 304, body: null, headers };
  }
  return { status: 200, body: workspaceStateBody(deps, state), headers };
}

// Evaluates the If-Match / stale-revision / no-op-payload preconditions for a workspace write.
// Returns a RouteResult to short-circuit (428/412/200) or undefined when the write should proceed.
// Extracted so handlePutWorkspaceState stays under the LOC bound.
function workspaceWritePreconditionResult(
  ctx: RouteContext,
  windows: readonly unknown[],
  connections: readonly unknown[],
  state: WorkspaceStateSnapshot,
): RouteResult | undefined {
  if (headerValues(ctx.req, "if-match").length === 0) {
    return {
      status: 428,
      body: errorBody(
        "PRECONDITION_REQUIRED",
        "Workspace state updates require an If-Match revision.",
      ),
    };
  }
  if (!requestHasWorkspaceWritePrecondition(ctx.req, state)) {
    return {
      status: 412,
      body: errorBody("PRECONDITION_FAILED", "Workspace state revision is stale."),
      headers: { ETag: workspaceStateEtag(state.revision) },
    };
  }
  if (workspacePayloadMatches(windows, connections, state)) {
    return {
      status: 200,
      body: { workspace: state },
      headers: { ETag: workspaceStateEtag(state.revision) },
    };
  }
  return undefined;
}

export async function handlePutWorkspaceState(
  ctx: RouteContext,
  deps?: WorkspaceStateDeps,
): Promise<RouteResult> {
  const mismatch = workspaceStorageMismatch(ctx, deps);
  if (mismatch !== undefined) return mismatch;
  try {
    const body = await readJsonObject(ctx.req);
    const windows = requireArray(body, "windows", MAX_WORKSPACE_WINDOWS);
    const connections = requireArray(body, "connections", MAX_WORKSPACE_CONNECTIONS);
    const state = currentWorkspaceState(deps);
    const precondition = workspaceWritePreconditionResult(ctx, windows, connections, state);
    if (precondition !== undefined) return precondition;
    const updated = {
      revision: state.revision + 1,
      windows,
      connections,
      updatedAtMs: Date.now(),
    };
    if (deps?.store === undefined) workspaceState = updated;
    else storeSnapshots.set(deps.store, updated);
    return {
      status: 200,
      body: workspaceStateBody(deps, updated),
      headers: { ETag: workspaceStateEtag(updated.revision) },
    };
  } catch (error) {
    if (error instanceof WorkspaceStateBodyTooLarge) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Workspace state exceeds the size limit."),
      };
    }
    if (error instanceof InvalidWorkspaceState) {
      return { status: 400, body: errorBody("INVALID_REQUEST", error.message) };
    }
    throw error;
  }
}

export function resetWorkspaceStateForTests(): void {
  workspaceState = emptyWorkspaceState();
  storeSnapshots = new WeakMap();
  storageIdentities = new WeakMap();
}
