import type { IncomingMessage } from "node:http";

import type { GitHubIssueReaderAuthorizationWire } from "@oscharko-dev/keiko-contracts";
import { parseUpdateGitHubIssueReaderAuthorizationWire } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";

import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";

// A grant carries two booleans and a counter. Anything larger is not this request.
const MAX_BODY_BYTES = 1_024;

/**
 * Settings surface for the repository-scoped GitHub issue reader (#3385).
 *
 * The caller names the repository, and the server accepts the name ONLY if it is already a
 * registered project. Resolving it from `deps.preferredProjectPath` instead — as this route first
 * did — read the project the process started in, a snapshot that opening another repository never
 * updates: launch in A, switch to B, grant, and the row landed on A while B stayed denied. The read
 * path had already been corrected to the caller's validated workspace root; this is the writer
 * catching up to it.
 *
 * Naming a repository is intent, not authority. An unregistered path is refused, so a request can
 * neither invent a path nor reach a repository the user has not opened, and the content-free
 * repository identity is always derived server-side. `revision` is echoed back so a stale client
 * cannot silently re-authorize a repository whose grant someone else has just withdrawn.
 */
function registeredRepositoryRoot(deps: UiHandlerDeps, path: string): string | undefined {
  if (path.length === 0) return undefined;
  return deps.store.listProjects().some((project) => project.path === path) ? path : undefined;
}

function requestedRepositoryPath(ctx: RouteContext): string | undefined {
  const value = ctx.url.searchParams.get("repositoryPath");
  return value === null || value.length === 0 ? undefined : value;
}

function projection(
  deps: UiHandlerDeps,
  repositoryRoot: string,
): GitHubIssueReaderAuthorizationWire {
  const repositoryId = deriveRepositoryId(repositoryRoot);
  const stored = deps.store.readGitHubIssueReaderAuthorization(repositoryId);
  return {
    repositoryId,
    authorized: stored?.authorized ?? false,
    revision: stored?.revision ?? 0,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error("authorization request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
    // A client that disconnects mid-upload emits neither "end" nor "error"; without this the
    // awaiting handler would hang until the socket is torn down.
    req.once("aborted", () => {
      fail(new Error("authorization request aborted"));
    });
  });
}

async function parseUpdate(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

function unknownRepository(ctx: RouteContext, verb: string): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "UNKNOWN_REPOSITORY",
      `Open the repository before ${verb} its GitHub issue access.`,
      ctx.correlationId,
    ),
  };
}

export function handleGetGitHubIssueReaderAuthorization(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const requested = requestedRepositoryPath(ctx);
  if (requested === undefined) return unknownRepository(ctx, "reviewing");
  const root = registeredRepositoryRoot(deps, requested);
  if (root === undefined) return unknownRepository(ctx, "reviewing");
  return { status: 200, body: projection(deps, root) };
}

function badRequest(correlationId: string | undefined): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "Invalid GitHub issue access update.", correlationId),
  };
}

async function readUpdate(
  ctx: RouteContext,
): Promise<ReturnType<typeof parseUpdateGitHubIssueReaderAuthorizationWire>> {
  try {
    return parseUpdateGitHubIssueReaderAuthorizationWire(await parseUpdate(ctx.req));
  } catch {
    return undefined;
  }
}

export async function handlePutGitHubIssueReaderAuthorization(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await readUpdate(ctx);
  if (parsed === undefined) return badRequest(ctx.correlationId);
  const root = registeredRepositoryRoot(deps, parsed.repositoryPath);
  if (root === undefined) return unknownRepository(ctx, "changing");

  const repositoryId = deriveRepositoryId(root);
  const stored = deps.store.updateGitHubIssueReaderAuthorization(
    repositoryId,
    parsed.authorized,
    parsed.expectedRevision,
  );
  if (stored === undefined) {
    return {
      status: 409,
      body: errorBody(
        "CONFLICT",
        "GitHub issue access changed. Reload and retry.",
        ctx.correlationId,
      ),
    };
  }
  // A change to who may read an external repository is exactly the kind of decision a support
  // timeline must be able to reconstruct (ADR-0173). Body-free: identity, direction and revision.
  processServerLogSink().write({
    category: "security",
    op: "coding-context.github-authorization.changed",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: { repositoryId, authorized: stored.authorized, revision: stored.revision },
  });
  return {
    status: 200,
    body: {
      repositoryId: stored.repositoryId,
      authorized: stored.authorized,
      revision: stored.revision,
    } satisfies GitHubIssueReaderAuthorizationWire,
  };
}
