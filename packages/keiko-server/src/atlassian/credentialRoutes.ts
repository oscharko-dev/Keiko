// Issue #2241 — Atlassian connector credential custody BFF routes (ADR-0128 D2/D3, ADR-0129 D3).
//
//   POST   /api/atlassian-connectors/credentials                  create (write-only: responds
//                                                                 authRef + metadata, never the
//                                                                 secret — the request body is the
//                                                                 ONLY hop the token ever makes)
//   GET    /api/atlassian-connectors/credentials                  list metadata
//   DELETE /api/atlassian-connectors/credentials/:authRef         delete (removes ciphertext;
//                                                                 invalidates the authRef)
//   POST   /api/atlassian-connectors/credentials/:authRef/verify  bounded connection probe →
//                                                                 closed union ok | auth-failed |
//                                                                 forbidden | unreachable | timeout
//
// CSRF + JSON content-type are enforced by the server's state-changing-request gate (POST/DELETE
// flow through it). Expected failures answer typed 4xx codes whose messages are content-free by
// construction (custody errors carry field NAMES, never submitted values). Unexpected failures
// (vault or metadata-store faults) propagate to the server's top-level catch, which answers an
// opaque 500 carrying the request correlation id and routes the redacted cause to the operator
// diagnostic sink — the exact contract `check:error-observability` enforces.

import type { IncomingMessage } from "node:http";
import {
  AtlassianCredentialCustodyError,
  verifyAtlassianConnection,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpPort,
} from "@oscharko-dev/keiko-connectors";
import { isAtlassianConnectorAuthRef } from "@oscharko-dev/keiko-contracts";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

const MAX_CREDENTIAL_BODY_BYTES = 16_000;

// The injected handler dependencies (composed in deps.ts via wiring.ts). The custody surface is
// write-only; the narrow execution resolver is NOT here — it lives inside the two port-factory
// closures, so no route can reach a stored secret (ADR-0128 D2). The body-less port serves the
// verify probe; the bounded-body port serves the sync lane (Issue #2242).
export interface AtlassianConnectorCredentialDeps {
  readonly custody: AtlassianCredentialCustody;
  readonly httpPortFactory: (metadata: AtlassianCredentialMetadata) => AtlassianHttpPort;
  readonly httpBodyPortFactory: (metadata: AtlassianCredentialMetadata) => AtlassianHttpBodyPort;
}

class BodyTooLargeError extends Error {
  public constructor() {
    super("atlassian connector credential request body too large");
    this.name = "BodyTooLargeError";
  }
}

function unavailable(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "ATLASSIAN_CONNECTORS_UNAVAILABLE",
      "Atlassian connector credential custody is not configured for this BFF.",
    ),
  };
}

type DepsOrResult = AtlassianConnectorCredentialDeps | RouteResult;

function requireCustody(deps: UiHandlerDeps): DepsOrResult {
  return deps.atlassianConnectorCredentials ?? unavailable();
}

function isRouteResult(value: DepsOrResult): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_CREDENTIAL_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
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

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AtlassianCredentialCustodyError("invalid-input", ["request body must be valid JSON"]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request body must be a JSON object",
    ]);
  }
  return parsed as Record<string, unknown>;
}

// Maps the closed custody error codes to typed HTTP results. Messages join the content-free
// field-level details (field names + rules only — never submitted values). Custody-storage health
// codes are NOT mapped: they rethrow to the top-level catch (opaque 500 + correlation id +
// redacted operator diagnostic).
function custodyErrorResult(error: AtlassianCredentialCustodyError): RouteResult | undefined {
  switch (error.code) {
    case "invalid-input":
      return {
        status: 400,
        body: errorBody(
          "VALIDATION_FAILED",
          error.details.length > 0 ? error.details.join("; ") : error.message,
        ),
      };
    case "unsupported-auth-scheme":
      return { status: 400, body: errorBody("AUTH_SCHEME_UNSUPPORTED", error.message) };
    case "credential-not-found":
      return { status: 404, body: errorBody("CREDENTIAL_NOT_FOUND", error.message) };
    case "credential-unreadable":
    case "vault-unavailable":
      return undefined;
  }
}

async function runHandler(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof AtlassianCredentialCustodyError) {
      const mapped = custodyErrorResult(error);
      if (mapped !== undefined) return mapped;
    }
    throw error;
  }
}

// Route params arrive percent-encoded; decode defensively, then validate against the contracts'
// authRef pattern. Malformed and unknown references both answer 404 (fail closed, no oracle
// distinguishing "never existed" from "wrong shape").
function decodeAuthRefParam(ctx: RouteContext): string | undefined {
  const raw = ctx.params.authRef ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isAtlassianConnectorAuthRef(decoded) ? decoded : undefined;
}

function credentialNotFound(): RouteResult {
  return {
    status: 404,
    body: errorBody("CREDENTIAL_NOT_FOUND", "Atlassian connector credential is not available."),
  };
}

// POST /api/atlassian-connectors/credentials — accepts the raw secret exactly once, seals it into
// the dedicated vault, and answers the non-secret metadata (authRef included). The parsed body is
// handed to custody and never echoed, logged, or attached to an error.
export async function handleCreateAtlassianConnectorCredential(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireCustody(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    return { status: 200, body: guard.custody.create(body) };
  });
}

// GET /api/atlassian-connectors/credentials — non-secret metadata projection only.
export function handleListAtlassianConnectorCredentials(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireCustody(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => ({ status: 200, body: { credentials: guard.custody.list() } }));
}

// DELETE /api/atlassian-connectors/credentials/:authRef — removes ciphertext and metadata in one
// server-side operation; the authRef is invalidated (later resolution fails closed).
export function handleDeleteAtlassianConnectorCredential(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireCustody(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const authRef = decodeAuthRefParam(ctx);
    if (authRef === undefined || !guard.custody.delete(authRef)) {
      return credentialNotFound();
    }
    return { status: 200, body: { ok: true } };
  });
}

// POST /api/atlassian-connectors/credentials/:authRef/verify — one bounded, read-only probe
// against the credential's configured base URL through the injected transport port. Always
// answers the closed status union on 200; no response body is read, persisted, or echoed.
export function handleVerifyAtlassianConnectorCredential(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> | RouteResult {
  const guard = requireCustody(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const authRef = decodeAuthRefParam(ctx);
    const metadata = authRef === undefined ? undefined : guard.custody.getMetadata(authRef);
    if (metadata === undefined) return credentialNotFound();
    const status = await verifyAtlassianConnection(guard.httpPortFactory(metadata), {
      provider: metadata.provider,
      baseUrl: metadata.baseUrl,
    });
    return { status: 200, body: { authRef: metadata.authRef, status } };
  });
}
