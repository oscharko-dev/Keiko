// Coding-context intake route (Epic #1982, wires #1989's connector layer into production).
//
// POST /api/coding-workbench/context/packs — the workbench/runtime requests a bounded,
// injection-labeled, content-free-evidenced context pack for selected GitHub/Jira refs.
// Reads are gated three times before any outbound call: the server deployment ceiling
// (the client-supplied mode can never exceed it), the connector-scope grant on the
// request, and the default-false connector authorization. That third gate is no longer
// read from the server environment for GitHub (#3385): it is a persisted grant for the
// caller's own checkout, consulted per request. Jira still reads its environment gate.
// Port failures surface as an opaque 502 with a correlation id; no provider detail,
// endpoint, credential, or body content reaches the response.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";

import type {
  CodingWorkbenchMode,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentAuthorizedConnectorScopes,
} from "../editor/agentAuthorityRegistry.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import {
  GitDeliveryBodyTooLargeError,
  hasOnlyAllowedKeys,
  isPlainObject,
  readGitDeliveryBody,
} from "../gitDelivery/requestGuards.js";
import {
  buildCodeContextPack,
  type CodeContextConnector,
  type CodeContextConnectorConfig,
  type CodeContextReadRequest,
  type CodeContextRef,
} from "./codeContextConnector.js";
import { createGitHubCodeContextConnector } from "./githubCodeContextConnector.js";
import { createJiraCodeContextConnector } from "./jiraCodeContextConnector.js";
import {
  gitHubCodeContextPortFor,
  githubRemoteOwnerAndRepoFor,
  isGitHubIssueReaderAuthorized,
} from "./githubIssueReaderAuthorization.js";

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "authority",
  "refs",
  "maxBodyBytes",
]);
const AUTHORITY_KEYS: ReadonlySet<string> = new Set(["runId", "envelopeDigest", "workspaceRoot"]);
const REF_KEYS: ReadonlySet<string> = new Set([
  "source",
  "objectKind",
  "ownerAndRepo",
  "projectKey",
  "objectId",
]);

const MAX_REFS = 16;
const DEFAULT_MAX_BODY_BYTES = 16_384;
const MIN_MAX_BODY_BYTES = 256;
const MAX_MAX_BODY_BYTES = 65_536;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const OWNER_AND_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const JIRA_PROJECT_PATTERN = /^[A-Z][A-Z0-9_]{1,20}$/u;
const OBJECT_ID_PATTERN = /^[1-9]\d{0,9}$/u;

// Local, cycle-free error envelope (mirrors routes.ts errorBody; a runtime import from
// routes.ts would create an ESM cycle because routes.ts spreads this file's route group).
function errBody(
  code: string,
  message: string,
  correlationId?: string,
): { readonly error: Record<string, unknown> } {
  return { error: { code, message, ...(correlationId === undefined ? {} : { correlationId }) } };
}

function badRequest(): RouteResult {
  return { status: 400, body: errBody("CODING_CONTEXT_BAD_REQUEST", "Invalid request.") };
}

function authorityDenied(): RouteResult {
  return {
    status: 403,
    body: errBody("CODING_CONTEXT_AUTHORITY_DENIED", "Coding context authority was denied."),
  };
}

function parseRunId(value: unknown): string | undefined {
  return typeof value === "string" && RUN_ID_PATTERN.test(value) ? value : undefined;
}

function parseGitHubRef(record: Record<string, unknown>): CodeContextRef | undefined {
  const objectKind = record.objectKind;
  if (objectKind !== "issue" && objectKind !== "pull-request") return undefined;
  const ownerAndRepo = record.ownerAndRepo;
  const objectId = record.objectId;
  if (typeof ownerAndRepo !== "string" || !OWNER_AND_REPO_PATTERN.test(ownerAndRepo)) {
    return undefined;
  }
  if (typeof objectId !== "string" || !OBJECT_ID_PATTERN.test(objectId)) return undefined;
  return { source: "github", objectKind, ownerAndRepo, objectId };
}

function parseJiraRef(record: Record<string, unknown>): CodeContextRef | undefined {
  if (record.objectKind !== "issue") return undefined;
  const projectKey = record.projectKey;
  const objectId = record.objectId;
  if (typeof projectKey !== "string" || !JIRA_PROJECT_PATTERN.test(projectKey)) return undefined;
  if (typeof objectId !== "string" || !OBJECT_ID_PATTERN.test(objectId)) return undefined;
  return { source: "jira", objectKind: "issue", projectKey, objectId };
}

function parseRef(value: unknown): CodeContextRef | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, REF_KEYS)) return undefined;
  if (value.source === "github") return parseGitHubRef(value);
  if (value.source === "jira") return parseJiraRef(value);
  return undefined;
}

function parseRefs(value: unknown): readonly CodeContextRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REFS) return undefined;
  const refs: CodeContextRef[] = [];
  for (const entry of value) {
    const ref = parseRef(entry);
    if (ref === undefined) return undefined;
    refs.push(ref);
  }
  return refs;
}

function parseMaxBodyBytes(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_MAX_BODY_BYTES ||
    value > MAX_MAX_BODY_BYTES
  ) {
    return undefined;
  }
  return value;
}

function serverCeiling(deps: UiHandlerDeps): CodingWorkbenchMode {
  return deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
}

interface ParsedAuthority {
  readonly reference: EditorAgentGovernedAuthorityReference;
  readonly workspaceRoot: string;
}

interface ParsedRequest {
  readonly authority: ParsedAuthority;
  readonly refs: readonly CodeContextRef[];
  readonly maxBodyBytes: number;
}

function parseAuthority(value: unknown): ParsedAuthority | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, AUTHORITY_KEYS)) return undefined;
  const runId = parseRunId(value.runId);
  const envelopeDigest = value.envelopeDigest;
  const workspaceRoot = value.workspaceRoot;
  if (
    runId === undefined ||
    typeof envelopeDigest !== "string" ||
    !DIGEST_PATTERN.test(envelopeDigest) ||
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length > 4_096 ||
    workspaceRoot.includes("\0") ||
    !isAbsolute(workspaceRoot)
  ) {
    return undefined;
  }
  return { reference: { runId, envelopeDigest }, workspaceRoot };
}

function parseRequest(input: unknown): ParsedRequest | undefined {
  if (!isPlainObject(input) || !hasOnlyAllowedKeys(input, TOP_LEVEL_KEYS)) return undefined;
  if (input.schemaVersion !== "1") return undefined;
  const authority = parseAuthority(input.authority);
  const refs = parseRefs(input.refs);
  const maxBodyBytes = parseMaxBodyBytes(input.maxBodyBytes);
  if (authority === undefined || refs === undefined || maxBodyBytes === undefined) {
    return undefined;
  }
  return { authority, refs, maxBodyBytes };
}

function resolveRequest(
  parsed: ParsedRequest,
  deps: UiHandlerDeps,
): CodeContextReadRequest | undefined {
  const ceiling = serverCeiling(deps);
  const nowIso = new Date().toISOString();
  const preflight = editorAgentAuthorityRegistry.resolve(
    parsed.authority.reference,
    parsed.authority.workspaceRoot,
    ceiling,
    nowIso,
  );
  if (!preflight.ok) return undefined;
  if (editorAgentAuthorizedConnectorScopes(preflight.envelope) === undefined) return undefined;
  const reserved = editorAgentAuthorityRegistry.reserveForConnector(
    parsed.authority.reference,
    parsed.authority.workspaceRoot,
    ceiling,
    nowIso,
  );
  if (!reserved.ok) return undefined;
  const connectorScopes = editorAgentAuthorizedConnectorScopes(reserved.envelope);
  if (connectorScopes === undefined) return undefined;
  return {
    runId: reserved.envelope.runId,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(reserved.envelope.effectiveMode, ceiling),
    connectorScopes,
    refs: parsed.refs,
    maxBodyBytes: parsed.maxBodyBytes,
  };
}

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: RouteResult };

async function readParsedBody(req: IncomingMessage): Promise<BodyRead> {
  let raw: string;
  try {
    raw = await readGitDeliveryBody(req);
  } catch (error) {
    if (error instanceof GitDeliveryBodyTooLargeError) {
      return {
        ok: false,
        result: {
          status: 413,
          body: errBody("CODING_CONTEXT_PAYLOAD_TOO_LARGE", "Request body is too large."),
        },
      };
    }
    return { ok: false, result: badRequest() };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: badRequest() };
  }
}

function connectorConfigFor(
  deps: UiHandlerDeps,
  githubConfigured: boolean,
  jiraConfigured: boolean,
  repositoryRoot: string | undefined,
  correlationId: string | undefined,
  allowedOwnerAndRepo: string | undefined,
): CodeContextConnectorConfig {
  return {
    // #3385: server-persisted and scoped to one local checkout, re-read on every composition so a
    // revocation takes effect without a restart. The port merely has to exist; this decides.
    //
    // The root is the one the caller's own authority was validated against, NOT the process-wide
    // launch directory. Using the launch path would deny a request whose authority names repository
    // B just because Keiko started in repository A, and — worse — would let A's grant authorize B's
    // reads.
    github_connector_authorized:
      githubConfigured && isGitHubIssueReaderAuthorized(deps, repositoryRoot, { correlationId }),
    // The grant admits GitHub; this says WHICH repository it admits. Undefined denies every ref.
    github_allowed_owner_and_repo: allowedOwnerAndRepo,
    jira_connector_authorized: deps.env.JIRA_CONNECTOR_AUTHORIZED === "true" && jiraConfigured,
  };
}

interface ComposedConnectors {
  readonly connectors: Readonly<Record<"github" | "jira", CodeContextConnector>>;
  readonly connectorConfig: CodeContextConnectorConfig;
}

const NO_CONNECTOR: CodeContextConnector = {
  read: () => Promise.reject(new Error("coding context connector is not configured")),
};

export function composeCodingContextConnectors(
  deps: UiHandlerDeps,
  // The repository the caller's authority was validated against. Omitted only by callers that have
  // no request context, which then fall back to the launch project and are authorized only if that
  // repository itself carries a grant.
  repositoryRoot: string | undefined = deps.preferredProjectPath,
  correlationId?: string,
  // The `owner/repo` this checkout's own remote resolves to. Resolved by the async caller, because
  // reading a git remote is a subprocess and this composition is synchronous.
  allowedOwnerAndRepo?: string,
): ComposedConnectors {
  // The port follows the repository the caller is working in, not the launch snapshot: evaluating
  // the grant for B while `gh` is confined to A would authorize one repository and read another.
  // `deps.env`, not `process.env`: the composed environment is what carries the reviewed `PATH`,
  // `GH_TOKEN` and `HOME`, and reading the ambient one here let a stray `gh` on the host — or the
  // host's own credentials — serve a read the deployment thought it had pinned. The editor twin
  // already passed `deps.env`; this is the route catching up.
  const githubPort =
    deps.codingContextGitHubPort ?? gitHubCodeContextPortFor(repositoryRoot, deps.env);
  const jiraPort = deps.codingContextJiraPort;
  const jiraConfigured =
    jiraPort !== undefined &&
    (deps.atlassianConnectorCredentials === undefined ||
      deps.atlassianConnectorCredentials.custody
        .list()
        .some((credential) => credential.provider === "jira"));
  return {
    connectors: {
      github:
        githubPort === undefined ? NO_CONNECTOR : createGitHubCodeContextConnector(githubPort),
      jira: jiraConfigured ? createJiraCodeContextConnector(jiraPort) : NO_CONNECTOR,
    },
    connectorConfig: connectorConfigFor(
      deps,
      githubPort !== undefined,
      jiraConfigured,
      repositoryRoot,
      correlationId,
      allowedOwnerAndRepo,
    ),
  };
}

export async function handleCodingContextPack(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const read = await readParsedBody(ctx.req);
  if (!read.ok) return read.result;
  const parsed = parseRequest(read.value);
  if (parsed === undefined) return badRequest();
  const request = resolveRequest(parsed, deps);
  if (request === undefined) return authorityDenied();
  try {
    const composed = composeCodingContextConnectors(
      deps,
      parsed.authority.workspaceRoot,
      ctx.correlationId,
      await githubRemoteOwnerAndRepoFor(
        parsed.authority.workspaceRoot,
        deps.env,
        deps.codingContextGitHubRemoteResolver,
        { correlationId: ctx.correlationId },
      ),
    );
    const pack = await buildCodeContextPack(request, {
      connectors: composed.connectors,
      connectorConfig: composed.connectorConfig,
      nowIso: (): string => new Date().toISOString(),
    });
    return { status: 200, body: { schemaVersion: "1", ...pack } };
  } catch (error) {
    // Port failures stay opaque: content-free code + correlation id only. The
    // connector layer never places endpoints, credentials, or bodies on errors.
    // Threads the request's own correlation id (ADR-0173 D5 / g12) rather than minting a
    // disconnected one — this IS the request whose failure is being reported.
    const correlationId = ctx.correlationId ?? randomUUID();
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "coding-context.pack",
        source: "coding-context.handleCodingContextPack",
        error,
        redact: (): string => "The server operation failed.",
      }),
    );
    return {
      status: 502,
      body: errBody(
        "CODING_CONTEXT_UPSTREAM_FAILED",
        "Coding context intake failed.",
        correlationId,
      ),
    };
  }
}

export const CODING_CONTEXT_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/coding-workbench/context/packs",
    handler: handleCodingContextPack,
  },
];
