// Coding-context intake route (Epic #1982, wires #1989's connector layer into production).
//
// POST /api/coding-workbench/context/packs — the workbench/runtime requests a bounded,
// injection-labeled, content-free-evidenced context pack for selected GitHub/Jira refs.
// Reads are gated three times before any outbound call: the server deployment ceiling
// (the client-supplied mode can never exceed it), the connector-scope grant on the
// request, and the default-false connector authorization resolved from server env.
// Port failures surface as an opaque 502 with a correlation id; no provider detail,
// endpoint, credential, or body content reaches the response.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  isCodingWorkbenchMode,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../deps.js";
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
import { createGitHubCodeContextApiPort } from "./githubCodeContextPort.js";
import {
  createJiraCodeContextHttpPort,
  parseJiraCodeContextPortConfig,
} from "./jiraCodeContextPort.js";

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "runId",
  "effectiveMode",
  "connectorScopes",
  "refs",
  "maxBodyBytes",
]);
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
const OWNER_AND_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const JIRA_PROJECT_PATTERN = /^[A-Z][A-Z0-9_]{1,20}$/u;
const OBJECT_ID_PATTERN = /^[1-9][0-9]{0,9}$/u;

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

function parseRunId(value: unknown): string | undefined {
  return typeof value === "string" && RUN_ID_PATTERN.test(value) ? value : undefined;
}

function parseConnectorScopes(
  value: unknown,
): readonly CodingWorkbenchConnectorScope[] | undefined {
  if (!Array.isArray(value) || value.length > CODING_WORKBENCH_CONNECTOR_SCOPES.length) {
    return undefined;
  }
  const scopes: CodingWorkbenchConnectorScope[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(CODING_WORKBENCH_CONNECTOR_SCOPES as readonly string[]).includes(entry)
    ) {
      return undefined;
    }
    scopes.push(entry as CodingWorkbenchConnectorScope);
  }
  return scopes;
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

function parseRequest(input: unknown, deps: UiHandlerDeps): CodeContextReadRequest | undefined {
  if (!isPlainObject(input) || !hasOnlyAllowedKeys(input, TOP_LEVEL_KEYS)) return undefined;
  if (input.schemaVersion !== "1") return undefined;
  const runId = parseRunId(input.runId);
  const requestedMode = isCodingWorkbenchMode(input.effectiveMode)
    ? input.effectiveMode
    : undefined;
  const connectorScopes = parseConnectorScopes(input.connectorScopes);
  const refs = parseRefs(input.refs);
  const maxBodyBytes = parseMaxBodyBytes(input.maxBodyBytes);
  if (
    runId === undefined ||
    requestedMode === undefined ||
    connectorScopes === undefined ||
    refs === undefined ||
    maxBodyBytes === undefined
  ) {
    return undefined;
  }
  return {
    runId,
    // The client-supplied mode is a REQUEST; the server deployment ceiling caps it
    // fail-closed so a hostile browser payload can never widen connector authority.
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, serverCeiling(deps)),
    connectorScopes,
    refs,
    maxBodyBytes,
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
  jiraConfigured: boolean,
): CodeContextConnectorConfig {
  return {
    github_connector_authorized: deps.env.GITHUB_CONNECTOR_AUTHORIZED === "true",
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

function composeConnectors(deps: UiHandlerDeps): ComposedConnectors {
  const jiraPortConfig = parseJiraCodeContextPortConfig(deps.env);
  const githubPort =
    deps.codingContextGitHubPort ??
    (deps.preferredProjectPath === undefined
      ? undefined
      : createGitHubCodeContextApiPort({
          workspace: {
            root: deps.preferredProjectPath,
            name: undefined,
            version: undefined,
            testFramework: "unknown",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            ignoreLines: [],
          },
          processEnv: process.env,
        }));
  const jiraPort =
    deps.codingContextJiraPort ??
    (jiraPortConfig === undefined ? undefined : createJiraCodeContextHttpPort(jiraPortConfig));
  return {
    connectors: {
      github:
        githubPort === undefined ? NO_CONNECTOR : createGitHubCodeContextConnector(githubPort),
      jira: jiraPort === undefined ? NO_CONNECTOR : createJiraCodeContextConnector(jiraPort),
    },
    connectorConfig: connectorConfigFor(
      deps,
      jiraPortConfig !== undefined || deps.codingContextJiraPort !== undefined,
    ),
  };
}

export async function handleCodingContextPack(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const read = await readParsedBody(ctx.req);
  if (!read.ok) return read.result;
  const request = parseRequest(read.value, deps);
  if (request === undefined) return badRequest();
  const composed = composeConnectors(deps);
  try {
    const pack = await buildCodeContextPack(request, {
      connectors: composed.connectors,
      connectorConfig: composed.connectorConfig,
      nowIso: (): string => new Date().toISOString(),
    });
    return { status: 200, body: { schemaVersion: "1", ...pack } };
  } catch {
    // Port failures stay opaque: content-free code + correlation id only. The
    // connector layer never places endpoints, credentials, or bodies on errors.
    const correlationId = randomUUID();
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
