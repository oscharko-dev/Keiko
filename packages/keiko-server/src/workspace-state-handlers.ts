import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";

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

function requestMatchesWorkspaceState(req: IncomingMessage): boolean {
  const header = req.headers["if-none-match"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined) return false;
  const current = workspaceStateEtag(workspaceState.revision);
  return value
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === current || item === "*");
}

export function handleGetWorkspaceState(ctx: RouteContext): RouteResult {
  const etag = workspaceStateEtag(workspaceState.revision);
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (requestMatchesWorkspaceState(ctx.req)) {
    return { status: 304, body: null, headers };
  }
  return { status: 200, body: { workspace: workspaceState }, headers };
}

export async function handlePutWorkspaceState(ctx: RouteContext): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const windows = requireArray(body, "windows", MAX_WORKSPACE_WINDOWS);
    const connections = requireArray(body, "connections", MAX_WORKSPACE_CONNECTIONS);
    workspaceState = {
      revision: workspaceState.revision + 1,
      windows,
      connections,
      updatedAtMs: Date.now(),
    };
    return { status: 200, body: { workspace: workspaceState } };
  } catch (error) {
    if (error instanceof WorkspaceStateBodyTooLarge) {
      return {
        status: 413,
        body: errorBody("payload_too_large", "Workspace state exceeds the size limit."),
      };
    }
    if (error instanceof InvalidWorkspaceState) {
      return { status: 400, body: errorBody("invalid_request", error.message) };
    }
    throw error;
  }
}

export function resetWorkspaceStateForTests(): void {
  workspaceState = { revision: 0, windows: [], connections: [], updatedAtMs: 0 };
}
