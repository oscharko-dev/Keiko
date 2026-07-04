import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { savePrivateJson } from "./private-json.js";

const MAX_WORKSPACE_STATE_BODY_BYTES = 256_000;
const MAX_WORKSPACE_WINDOWS = 128;
const MAX_WORKSPACE_CONNECTIONS = 512;
const WORKSPACE_STATE_SCHEMA_VERSION = 1;
const WORKSPACE_STATE_FILENAME = "workspace-state.json";

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
let loadedWorkspaceStatePath: string | null | undefined;

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

function workspaceStatePathFromEnv(): string | null {
  const dir = process.env.KEIKO_UI_DATA_DIR;
  if (dir === undefined || dir.trim().length === 0 || dir.includes("\0")) return null;
  if (!isAbsolute(dir)) return null;
  return join(resolve(dir), WORKSPACE_STATE_FILENAME);
}

function isValidRevisionValue(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedArray(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length <= max;
}

function isValidUpdatedAtValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isWorkspaceStateSnapshot(value: unknown): value is WorkspaceStateSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isValidRevisionValue(record.revision) &&
    isBoundedArray(record.windows, MAX_WORKSPACE_WINDOWS) &&
    isBoundedArray(record.connections, MAX_WORKSPACE_CONNECTIONS) &&
    isValidUpdatedAtValue(record.updatedAtMs)
  );
}

function parseWorkspaceStateEnvelope(raw: unknown): WorkspaceStateSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== WORKSPACE_STATE_SCHEMA_VERSION) return null;
  const snapshot = record.workspace;
  return isWorkspaceStateSnapshot(snapshot) ? snapshot : null;
}

function quarantineWorkspaceStateFile(path: string, cause: unknown): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${path}.corrupt.${stamp}`;
  renameSync(path, quarantinePath);
  savePrivateJson(`${quarantinePath}.diagnostic.json`, {
    incidentId: randomUUID(),
    store: "workspace-state",
    timestamp: new Date().toISOString(),
    statePath: path,
    quarantinedPath: quarantinePath,
    cause: cause instanceof Error ? cause.name : typeof cause,
  });
}

function loadWorkspaceStateFromDisk(path: string): WorkspaceStateSnapshot {
  if (!existsSync(path)) return emptyWorkspaceState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const envelope = parseWorkspaceStateEnvelope(parsed);
    if (envelope === null) {
      throw new Error("unsupported workspace state envelope");
    }
    return envelope;
  } catch (error) {
    try {
      quarantineWorkspaceStateFile(path, error);
    } catch {
      // If quarantine itself fails, keep the process alive with an empty in-memory snapshot. The
      // next PUT will still require a matching revision and will attempt a normal private write.
    }
    return emptyWorkspaceState();
  }
}

function ensureWorkspaceStateLoaded(): string | null {
  const path = workspaceStatePathFromEnv();
  if (path !== loadedWorkspaceStatePath) {
    loadedWorkspaceStatePath = path;
    workspaceState = path === null ? emptyWorkspaceState() : loadWorkspaceStateFromDisk(path);
  }
  return path;
}

function persistWorkspaceState(path: string | null): void {
  if (path === null) return;
  savePrivateJson(path, {
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    workspace: workspaceState,
  });
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

function requestMatchesWorkspaceState(req: IncomingMessage): boolean {
  const values = headerValues(req, "if-none-match");
  if (values.length === 0) return false;
  const current = workspaceStateEtag(workspaceState.revision);
  return values.some((item) => item === current || item === "*");
}

function requestHasWorkspaceWritePrecondition(req: IncomingMessage): boolean {
  const values = headerValues(req, "if-match");
  if (values.length === 0) return false;
  const current = workspaceStateEtag(workspaceState.revision);
  return values.some((item) => item === current);
}

function workspacePayloadMatches(
  windows: readonly unknown[],
  connections: readonly unknown[],
): boolean {
  return (
    JSON.stringify(workspaceState.windows) === JSON.stringify(windows) &&
    JSON.stringify(workspaceState.connections) === JSON.stringify(connections)
  );
}

export function handleGetWorkspaceState(ctx: RouteContext): RouteResult {
  ensureWorkspaceStateLoaded();
  const etag = workspaceStateEtag(workspaceState.revision);
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (requestMatchesWorkspaceState(ctx.req)) {
    return { status: 304, body: null, headers };
  }
  return { status: 200, body: { workspace: workspaceState }, headers };
}

// Evaluates the If-Match / stale-revision / no-op-payload preconditions for a workspace write.
// Returns a RouteResult to short-circuit (428/412/200) or undefined when the write should proceed.
// Extracted so handlePutWorkspaceState stays under the LOC bound.
function workspaceWritePreconditionResult(
  ctx: RouteContext,
  windows: readonly unknown[],
  connections: readonly unknown[],
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
  if (!requestHasWorkspaceWritePrecondition(ctx.req)) {
    return {
      status: 412,
      body: errorBody("PRECONDITION_FAILED", "Workspace state revision is stale."),
      headers: { ETag: workspaceStateEtag(workspaceState.revision) },
    };
  }
  if (workspacePayloadMatches(windows, connections)) {
    return {
      status: 200,
      body: { workspace: workspaceState },
      headers: { ETag: workspaceStateEtag(workspaceState.revision) },
    };
  }
  return undefined;
}

export async function handlePutWorkspaceState(ctx: RouteContext): Promise<RouteResult> {
  try {
    const statePath = ensureWorkspaceStateLoaded();
    const body = await readJsonObject(ctx.req);
    const windows = requireArray(body, "windows", MAX_WORKSPACE_WINDOWS);
    const connections = requireArray(body, "connections", MAX_WORKSPACE_CONNECTIONS);
    const precondition = workspaceWritePreconditionResult(ctx, windows, connections);
    if (precondition !== undefined) return precondition;
    workspaceState = {
      revision: workspaceState.revision + 1,
      windows,
      connections,
      updatedAtMs: Date.now(),
    };
    persistWorkspaceState(statePath);
    return {
      status: 200,
      body: { workspace: workspaceState },
      headers: { ETag: workspaceStateEtag(workspaceState.revision) },
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
  loadedWorkspaceStatePath = undefined;
}
