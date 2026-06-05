// Quality Intelligence connector BFF routes (Epic #270, Issue #278).
//
// Four additive HTTP handlers under `/api/quality-intelligence/sources/*`:
//   * POST /api/quality-intelligence/sources/select         — plan a user-selected envelope set
//   * POST /api/quality-intelligence/sources/dryrun-figma   — DRY-RUN only; disabled by default
//   * POST /api/quality-intelligence/sources/dryrun-jira    — DRY-RUN only; disabled by default
//   * GET  /api/quality-intelligence/sources/capabilities   — boolean capability summary
//
// Hard constraints:
//   * No provider SDK imports (no figma-api, no jira.js, no @atlassian/*).
//   * No outbound network request from any handler in this file.
//   * Authorisation defaults to FALSE — only flips on explicit `*_connector_authorized: true`.
//   * Error JSON never carries credentials, payloads, URLs, or header pairs.
//   * Composes existing route plumbing (RouteContext / UiHandlerDeps); does not modify
//     any sibling handler.

import type { IncomingMessage } from "node:http";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { QualityIntelligenceIngestion } from "@oscharko-dev/keiko-quality-intelligence";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  isFigmaConnectorAuthorized,
  isJiraConnectorAuthorized,
  summariseQiConnectorCapabilities,
  type QiConnectorConfig,
} from "./connectorAuthorization.js";
import { payloadContainsForbiddenSecretShape, qiConnectorErrorBody } from "./connectorErrors.js";

const MAX_BODY_BYTES = 256 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds connector route cap");
    this.name = "BodyTooLargeError";
  }
}

const readBody = (req: IncomingMessage): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
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
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ParsedBody {
  readonly ok: true;
  readonly body: Readonly<Record<string, unknown>>;
}
interface ParsedBodyError {
  readonly ok: false;
  readonly result: RouteResult;
}

const parseConnectorBody = async (req: IncomingMessage): Promise<ParsedBody | ParsedBodyError> => {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return { ok: false, result: { status: 413, body: qiConnectorErrorBody("QI_BAD_REQUEST") } };
    }
    return { ok: false, result: { status: 400, body: qiConnectorErrorBody("QI_BAD_REQUEST") } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, result: { status: 400, body: qiConnectorErrorBody("QI_BAD_REQUEST") } };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, result: { status: 400, body: qiConnectorErrorBody("QI_BAD_REQUEST") } };
  }
  if (payloadContainsForbiddenSecretShape(parsed)) {
    return {
      ok: false,
      result: { status: 400, body: qiConnectorErrorBody("QI_FORBIDDEN_PAYLOAD") },
    };
  }
  return { ok: true, body: parsed };
};

const resolveConnectorConfig = (deps: UiHandlerDeps): QiConnectorConfig => {
  const env = deps.env;
  return {
    figma_connector_authorized: env.FIGMA_CONNECTOR_AUTHORIZED === "true",
    jira_connector_authorized: env.JIRA_CONNECTOR_AUTHORIZED === "true",
  };
};

// ─── /sources/select ───────────────────────────────────────────────────────────

const collectIds = (
  raw: unknown,
): readonly QualityIntelligence.QualityIntelligenceSourceEnvelopeId[] | null => {
  if (!Array.isArray(raw)) return null;
  const ids: QualityIntelligence.QualityIntelligenceSourceEnvelopeId[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") return null;
    try {
      ids.push(QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(candidate));
    } catch {
      return null;
    }
  }
  return ids;
};

const buildSelectionEnvelopes = (
  ids: readonly QualityIntelligence.QualityIntelligenceSourceEnvelopeId[],
  registeredAt: string,
): readonly QualityIntelligence.QualityIntelligenceSourceEnvelope[] => {
  // Selection routes accept opaque envelope IDS — no display label or hash is supplied
  // by the browser tier. The planner only needs id+kind+priority, so we synthesise a
  // minimal repository-context envelope (the default kind for selection) and let the
  // QI domain decide what to do downstream when the real envelope catalogue is wired
  // in #274. Hash is the zero-digest so the planner's "kind+id" stable key still works.
  return ids.map((id) => ({
    id,
    kind: "repository-context" as const,
    displayLabel: `selected:${id}`,
    provenance: {
      origin: "user-selection",
      registeredAt,
      integrityHashSha256Hex: "0".repeat(64),
    },
    localRef: id,
  }));
};

export const handleQiSourceSelect = async (
  ctx: RouteContext,
  _deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const parsed = await parseConnectorBody(ctx.req);
  if (!parsed.ok) return parsed.result;
  const ids = collectIds(parsed.body.envelopeIds);
  if (ids === null) {
    return { status: 400, body: qiConnectorErrorBody("QI_INVALID_ENVELOPE_SELECTION") };
  }
  const registeredAt =
    typeof parsed.body.registeredAt === "string"
      ? parsed.body.registeredAt
      : "1970-01-01T00:00:00Z";
  const envelopes = buildSelectionEnvelopes(ids, registeredAt);
  const plan = QualityIntelligenceIngestion.planSourceMix(envelopes);
  return { status: 200, body: { plan } };
};

// ─── /sources/dryrun-figma + dryrun-jira ───────────────────────────────────────

interface DryRunOutcome {
  readonly status: "DISABLED" | "DRYRUN_OK";
  readonly connector: "figma" | "jira";
  readonly wouldUseFieldCount: number;
}

const buildDryRunOutcome = (
  connector: "figma" | "jira",
  body: Readonly<Record<string, unknown>>,
  authorized: boolean,
): DryRunOutcome => ({
  status: authorized ? "DRYRUN_OK" : "DISABLED",
  connector,
  wouldUseFieldCount: Object.keys(body).length,
});

export const handleQiDryRunFigma = async (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const parsed = await parseConnectorBody(ctx.req);
  if (!parsed.ok) return parsed.result;
  const config = resolveConnectorConfig(deps);
  const authorized = isFigmaConnectorAuthorized(config);
  const outcome = buildDryRunOutcome("figma", parsed.body, authorized);
  return { status: 200, body: outcome };
};

export const handleQiDryRunJira = async (
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> => {
  const parsed = await parseConnectorBody(ctx.req);
  if (!parsed.ok) return parsed.result;
  const config = resolveConnectorConfig(deps);
  const authorized = isJiraConnectorAuthorized(config);
  const outcome = buildDryRunOutcome("jira", parsed.body, authorized);
  return { status: 200, body: outcome };
};

// ─── /sources/capabilities ─────────────────────────────────────────────────────

export const handleQiCapabilities = (_ctx: RouteContext, deps: UiHandlerDeps): RouteResult => {
  const config = resolveConnectorConfig(deps);
  const capabilities = summariseQiConnectorCapabilities(config);
  return { status: 200, body: { capabilities } };
};
