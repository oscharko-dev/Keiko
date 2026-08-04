import { Buffer } from "node:buffer";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  isWorkspaceCleanupMode,
  isWorkspaceRecoveryStrategy,
  type WorkspaceCleanupMode,
  type WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { resolveLoopbackEndpoint, type LoopbackEndpointOptions } from "./loopback-endpoint.js";
import type { CliIo } from "./runner.js";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type ValueOption = "--root" | "--host" | "--port" | "--strategy" | "--mode";

const VALUE_OPTIONS: ReadonlySet<string> = new Set<ValueOption>([
  "--root",
  "--host",
  "--port",
  "--strategy",
  "--mode",
]);
const ENDPOINT_OPTIONS: ReadonlySet<string> = new Set(["--host", "--port"]);
const RESPONSE_MAX_BYTES = 1024 * 1024;
const REQUESTED_BY = "keiko-cli";

const USAGE = `Usage:
  keiko task-workspace reconciliation [--root PATH] [--host HOST] [--port PORT]
  keiko task-workspace health [--root PATH] [--host HOST] [--port PORT]
  keiko task-workspace repair <workspaceId> --strategy <strategy> --approve [--host HOST] [--port PORT]
  keiko task-workspace cleanup <workspaceId> --mode request|complete --approve [--host HOST] [--port PORT]
  keiko task-workspace cleanup-orphans [--root PATH] --approve [--host HOST] [--port PORT]

Mutating commands require the explicit --approve flag. The local server is resolved from
--host/--port, KEIKO_UI_HOST/KEIKO_UI_PORT, or the standard loopback defaults.
`;

interface ParsedTokens {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly approved: boolean;
}

interface TaskWorkspaceRequest {
  readonly endpoint: LoopbackEndpointOptions;
  readonly path: string;
  readonly init: RequestInit;
}

export interface TaskWorkspaceCliDeps {
  readonly fetchImpl?: FetchFn | undefined;
}

function parseTokens(args: readonly string[]): ParsedTokens | null {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let approved = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return null;
    if (arg === "--approve") {
      if (approved) return null;
      approved = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(arg) || values.has(arg)) return null;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    values.set(arg, value);
    index += 1;
  }
  return { positionals, values, approved };
}

function usesOnlyOptions(tokens: ParsedTokens, allowed: ReadonlySet<string>): boolean {
  return Array.from(tokens.values.keys()).every(
    (option) => ENDPOINT_OPTIONS.has(option) || allowed.has(option),
  );
}

function endpointOptions(tokens: ParsedTokens): LoopbackEndpointOptions {
  return { host: tokens.values.get("--host"), port: tokens.values.get("--port") };
}

function reportRequest(
  kind: "reconciliation" | "health",
  tokens: ParsedTokens,
): TaskWorkspaceRequest | null {
  if (tokens.approved || tokens.positionals.length !== 0) return null;
  if (!usesOnlyOptions(tokens, new Set(["--root"]))) return null;
  const search = new URLSearchParams();
  const root = tokens.values.get("--root");
  if (root !== undefined) search.set("root", root);
  const query = search.size === 0 ? "" : `?${search.toString()}`;
  return {
    endpoint: endpointOptions(tokens),
    path: `/api/task-workspaces/${kind}${query}`,
    init: { method: "GET", headers: { accept: "application/json" } },
  };
}

function mutationInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-keiko-csrf": "1",
    },
    body: JSON.stringify(body),
  };
}

function repairRequest(tokens: ParsedTokens): TaskWorkspaceRequest | null {
  const strategy = tokens.values.get("--strategy");
  const workspaceId = tokens.positionals[0];
  if (
    !tokens.approved ||
    tokens.positionals.length !== 1 ||
    workspaceId === undefined ||
    !usesOnlyOptions(tokens, new Set(["--strategy"])) ||
    !isWorkspaceRecoveryStrategy(strategy)
  ) {
    return null;
  }
  return approvedWorkspaceMutation(tokens, workspaceId, "repair", { strategy });
}

function approvedWorkspaceMutation(
  tokens: ParsedTokens,
  workspaceId: string,
  action: "repair" | "cleanup",
  detail:
    { readonly strategy: WorkspaceRecoveryStrategy } | { readonly mode: WorkspaceCleanupMode },
): TaskWorkspaceRequest {
  return {
    endpoint: endpointOptions(tokens),
    path: `/api/task-workspaces/${encodeURIComponent(workspaceId)}/${action}`,
    init: mutationInit({ requestedBy: REQUESTED_BY, ...detail, operatorApproved: true }),
  };
}

function cleanupRequest(tokens: ParsedTokens): TaskWorkspaceRequest | null {
  const mode = tokens.values.get("--mode");
  const workspaceId = tokens.positionals[0];
  if (
    !tokens.approved ||
    tokens.positionals.length !== 1 ||
    workspaceId === undefined ||
    !usesOnlyOptions(tokens, new Set(["--mode"])) ||
    !isWorkspaceCleanupMode(mode)
  ) {
    return null;
  }
  return approvedWorkspaceMutation(tokens, workspaceId, "cleanup", { mode });
}

function cleanupOrphansRequest(tokens: ParsedTokens): TaskWorkspaceRequest | null {
  if (!tokens.approved || tokens.positionals.length !== 0) return null;
  if (!usesOnlyOptions(tokens, new Set(["--root"]))) return null;
  const root = tokens.values.get("--root");
  return {
    endpoint: endpointOptions(tokens),
    path: "/api/task-workspaces/cleanup/orphans",
    init: mutationInit({
      requestedBy: REQUESTED_BY,
      ...(root === undefined ? {} : { root }),
      operatorApproved: true,
    }),
  };
}

function parseRequest(args: readonly string[]): TaskWorkspaceRequest | "help" | null {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") return "help";
  const tokens = parseTokens(args.slice(1));
  if (tokens === null) return null;
  if (command === "reconciliation" || command === "health") return reportRequest(command, tokens);
  if (command === "repair") return repairRequest(tokens);
  if (command === "cleanup") return cleanupRequest(tokens);
  if (command === "cleanup-orphans") return cleanupOrphansRequest(tokens);
  return null;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > RESPONSE_MAX_BYTES) {
    throw new RangeError("task-workspace response exceeds the size limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) {
    throw new RangeError("task-workspace response exceeds the size limit");
  }
  return JSON.parse(text) as unknown;
}

function responseErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return undefined;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function executeRequest(
  request: TaskWorkspaceRequest,
  io: CliIo,
  env: EnvSource,
  fetchImpl: FetchFn,
): Promise<number> {
  const endpoint = resolveLoopbackEndpoint(request.endpoint, env);
  if (endpoint === null) {
    io.err(USAGE);
    return 2;
  }
  try {
    const response = await fetchImpl(`${endpoint.baseUrl}${request.path}`, request.init);
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const code = responseErrorCode(payload) ?? "UNSPECIFIED_ERROR";
      io.err(`keiko task-workspace: HTTP ${String(response.status)} (${code}).\n`);
      return 1;
    }
    io.out(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch (error: unknown) {
    const kind = error instanceof Error ? error.name : "UnknownError";
    io.err(`keiko task-workspace: request failed (${kind}).\n`);
    return 1;
  }
}

export async function runTaskWorkspaceCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource = {},
  deps: TaskWorkspaceCliDeps = {},
): Promise<number> {
  const request = parseRequest(args);
  if (request === "help") {
    io.out(USAGE);
    return 0;
  }
  if (request === null) {
    io.err(USAGE);
    return 2;
  }
  return executeRequest(request, io, env, deps.fetchImpl ?? fetch);
}
