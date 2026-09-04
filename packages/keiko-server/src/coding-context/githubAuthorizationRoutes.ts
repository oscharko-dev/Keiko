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
 * The repository is resolved by the SERVER from the selected project, never named by the caller:
 * a request that could name its own repository would let a user grant access to a repository they
 * are not working in. `revision` is echoed back on update so a stale client cannot silently
 * re-authorize a repository whose grant someone else has just withdrawn.
 */
function selectedRepositoryRoot(deps: UiHandlerDeps): string | undefined {
  const root = deps.preferredProjectPath;
  return root === undefined || root === "" ? undefined : root;
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

function noRepositorySelected(ctx: RouteContext, verb: string): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "NO_REPOSITORY_SELECTED",
      `Select a repository before ${verb} GitHub issue access.`,
      ctx.correlationId,
    ),
  };
}

export function handleGetGitHubIssueReaderAuthorization(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const root = selectedRepositoryRoot(deps);
  if (root === undefined) return noRepositorySelected(ctx, "reviewing");
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
  const root = selectedRepositoryRoot(deps);
  if (root === undefined) return noRepositorySelected(ctx, "changing");
  const parsed = await readUpdate(ctx);
  if (parsed === undefined) return badRequest(ctx.correlationId);

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
