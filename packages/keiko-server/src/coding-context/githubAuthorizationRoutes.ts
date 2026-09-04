import type { IncomingMessage } from "node:http";

import type { GitHubIssueReaderAuthorizationWire } from "@oscharko-dev/keiko-contracts";
import { parseUpdateGitHubIssueReaderAuthorizationWire } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";

import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { githubIssueReaderRepositoryId } from "./githubIssueReaderAuthorization.js";

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

/**
 * The stored key for a registered repository: `deriveRepositoryId` of its CANONICAL root.
 *
 * Registration is a lexical question ("is this spelling an opened project?") and stays one. The
 * key is not: the editor reader consults the grant under the identity of the resolved workspace
 * root (`ctx.realRoot`), which is what `deriveRepositoryId` documents, while the store keeps the
 * path as registered — `validateProjectPath` normalises without resolving links. A repository
 * opened through a symlink (a checkout under macOS `/tmp`, which is `/private/tmp`) therefore had
 * its grant written under one id and read under another, so it never took effect. Both verbs go
 * through this one resolver so the identity they agree on cannot drift apart again.
 *
 * A registered path whose directory is gone has no canonical root to key on. The lexical spelling
 * must not stand in for one — that writes a row no reader will ever consult — so the answer is
 * the same refusal an unregistered path receives, and the 409 carries the correlation id.
 */
function registeredRepositoryId(deps: UiHandlerDeps, path: string): string | undefined {
  const root = registeredRepositoryRoot(deps, path);
  // ONE derivation of the grant identity, shared with both readers, so the writer cannot drift from
  // them again. It already fails closed on a root that does not resolve.
  return root === undefined ? undefined : githubIssueReaderRepositoryId(root);
}

function requestedRepositoryPath(ctx: RouteContext): string | undefined {
  const value = ctx.url.searchParams.get("repositoryPath");
  return value === null || value.length === 0 ? undefined : value;
}

function projection(deps: UiHandlerDeps, repositoryId: string): GitHubIssueReaderAuthorizationWire {
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
  const repositoryId = registeredRepositoryId(deps, requested);
  if (repositoryId === undefined) return unknownRepository(ctx, "reviewing");
  return { status: 200, body: projection(deps, repositoryId) };
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
  const repositoryId = registeredRepositoryId(deps, parsed.repositoryPath);
  if (repositoryId === undefined) return unknownRepository(ctx, "changing");

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
