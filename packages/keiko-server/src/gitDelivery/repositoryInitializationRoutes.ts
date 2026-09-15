// Bounded local repository initialization for a human-selected project (#3494).
//
// The browser supplies only the opaque project catalog key and the single supported initial
// branch literal. The server resolves the root from its own project store and constructs the fixed
// `git init` argv; paths, remotes, credentials, and arbitrary git arguments never cross the route.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  classifyGitFailure,
  defaultGitProcessRunner,
  type GitFailureReason,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/index.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  readParsedGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
  type GitDeliveryParsedBody,
} from "./requestGuards.js";
import { resolveProjectWorkspace } from "./execution.js";

const ROUTE = "/api/git-delivery/repository/initialize";
const INITIAL_BRANCH = "main";
const MAX_OUTPUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 15_000;
const ALLOWED_KEYS = new Set(["projectId", "initialBranch"]);

type InitializationOutcome =
  | "already-initialized"
  | "git-missing"
  | "invalid-request"
  | "not-authorized"
  | "succeeded"
  | "timed-out"
  | "unsafe-repository"
  | "execution-failed";

export interface GitRepositoryInitializeResponse {
  readonly schemaVersion: "1";
  readonly status: "succeeded";
  readonly initialized: true;
}

export interface GitRepositoryInitializationSeams {
  readonly runner?: GitProcessRunner | undefined;
  readonly activityLog?: ServerLogSink | undefined;
}

interface InitializationRequest {
  readonly projectId: string;
}

function errorResult(status: number, code: string, message: string): RouteResult {
  return { status, body: { error: { code, message } } };
}

function invalidRequest(): RouteResult {
  return errorResult(
    400,
    "GIT_REPOSITORY_INITIALIZE_BAD_REQUEST",
    "The request must name one selected project and initial branch main.",
  );
}

function parseRequest(value: unknown): InitializationRequest | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, ALLOWED_KEYS)) return undefined;
  if (scanForbiddenStrings(value) || scanUnsafeFormatChars(value)) return undefined;
  if (!isNonEmptyString(value.projectId) || value.initialBranch !== INITIAL_BRANCH)
    return undefined;
  return { projectId: value.projectId };
}

const readParsed = (req: IncomingMessage): Promise<GitDeliveryParsedBody<RouteResult>> =>
  readParsedGitDeliveryBody(
    req,
    () =>
      errorResult(
        413,
        "GIT_REPOSITORY_INITIALIZE_PAYLOAD_TOO_LARGE",
        "The repository initialization request exceeds the permitted size.",
      ),
    invalidRequest,
  );

function recordOutcome(
  log: ServerLogSink,
  correlationId: string,
  status: number,
  outcome: InitializationOutcome,
): void {
  log.write({
    category: "security",
    op: "git.repository.initialize",
    correlationId,
    status,
    extra: { outcome },
  });
}

function unsuccessful(result: GitProcessResult): GitFailureReason | undefined {
  return result.exitCode === 0 && !result.truncated ? undefined : classifyGitFailure(result);
}

function failureProjection(reason: GitFailureReason): {
  readonly status: number;
  readonly outcome: InitializationOutcome;
  readonly result: RouteResult;
} {
  if (reason === "git-missing") {
    return {
      status: 503,
      outcome: "git-missing",
      result: errorResult(503, "GIT_UNAVAILABLE", "Git is not available on this host."),
    };
  }
  if (reason === "timeout") {
    return {
      status: 504,
      outcome: "timed-out",
      result: errorResult(
        504,
        "GIT_REPOSITORY_INITIALIZE_TIMEOUT",
        "Repository initialization did not finish within the bounded execution window.",
      ),
    };
  }
  if (reason === "unsafe-repository") {
    return {
      status: 403,
      outcome: "unsafe-repository",
      result: errorResult(
        403,
        "GIT_REPOSITORY_INITIALIZE_UNSAFE",
        "Git refused the selected project because its ownership is unsafe.",
      ),
    };
  }
  return {
    status: 409,
    outcome: "execution-failed",
    result: errorResult(
      409,
      "GIT_REPOSITORY_INITIALIZE_FAILED",
      "The selected project could not be initialized as a Git repository.",
    ),
  };
}

async function inspectExistingRepository(
  runner: GitProcessRunner,
  root: string,
): Promise<GitFailureReason | "repository-present"> {
  const result = await runner(["rev-parse", "--show-toplevel"], {
    cwd: root,
    maxBytes: MAX_OUTPUT_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
  const failure = unsuccessful(result);
  return failure ?? "repository-present";
}

interface InitializationProjection {
  readonly status: number;
  readonly outcome: InitializationOutcome;
  readonly result: RouteResult;
}

async function initializeRepository(
  runner: GitProcessRunner,
  root: string,
): Promise<InitializationProjection> {
  const result = await runner(["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
    maxBytes: MAX_OUTPUT_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
  const failure = unsuccessful(result);
  if (failure !== undefined) return failureProjection(failure);
  return {
    status: 200,
    outcome: "succeeded",
    result: {
      status: 200,
      body: {
        schemaVersion: "1",
        status: "succeeded",
        initialized: true,
      } satisfies GitRepositoryInitializeResponse,
    },
  };
}

async function executeInitialization(
  runner: GitProcessRunner,
  root: string,
): Promise<InitializationProjection> {
  const inspection = await inspectExistingRepository(runner, root);
  if (inspection === "repository-present") {
    return {
      status: 409,
      outcome: "already-initialized",
      result: errorResult(
        409,
        "GIT_REPOSITORY_ALREADY_INITIALIZED",
        "The selected project is already inside a Git repository.",
      ),
    };
  }
  return inspection === "not-a-repository"
    ? initializeRepository(runner, root)
    : failureProjection(inspection);
}

function recordUnexpectedFailure(deps: UiHandlerDeps, correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: `POST ${ROUTE}`,
      source: "git-repository-initialization-route",
      error,
      summary: "server-operation-failed",
      redact: (value): string => String(deps.redactor(value)),
    }),
  );
}

export function createHandleGitRepositoryInitialize(
  seams: GitRepositoryInitializationSeams = {},
): (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult> {
  const runner = seams.runner ?? defaultGitProcessRunner;
  return async (ctx, deps): Promise<RouteResult> => {
    const log = seams.activityLog ?? deps.activityLog ?? processServerLogSink();
    const correlationId = ctx.correlationId ?? randomUUID();
    const parsed = await readParsed(ctx.req);
    if (!parsed.ok) {
      recordOutcome(log, correlationId, parsed.result.status, "invalid-request");
      return parsed.result;
    }
    const request = parseRequest(parsed.value);
    if (request === undefined) {
      recordOutcome(log, correlationId, 400, "invalid-request");
      return invalidRequest();
    }
    try {
      const workspace = resolveProjectWorkspace(deps, request.projectId);
      if (workspace === undefined) {
        recordOutcome(log, correlationId, 404, "not-authorized");
        return errorResult(
          404,
          "GIT_REPOSITORY_INITIALIZE_UNKNOWN_PROJECT",
          "The requested project is not a selected workspace.",
        );
      }
      const projection = await executeInitialization(runner, workspace.root);
      recordOutcome(log, correlationId, projection.status, projection.outcome);
      return projection.result;
    } catch (error) {
      recordUnexpectedFailure(deps, correlationId, error);
      recordOutcome(log, correlationId, 500, "execution-failed");
      return errorResult(
        500,
        "GIT_REPOSITORY_INITIALIZE_INTERNAL",
        "Repository initialization failed. Use the request support ID to inspect diagnostics.",
      );
    }
  };
}

export const GIT_REPOSITORY_INITIALIZATION_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: ROUTE,
    handler: createHandleGitRepositoryInitialize(),
  },
];
