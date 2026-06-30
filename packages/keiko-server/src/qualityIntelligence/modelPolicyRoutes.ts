// Quality Intelligence model-policy routes and preflight orchestration.
//
// The browser receives only configured capability metadata and redacted routing/preflight status.
// Provider URLs, headers, keys, and raw provider errors never cross this surface.

import type { IncomingMessage } from "node:http";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Gateway,
  listConfiguredCapabilities,
  findConfiguredCapability,
} from "@oscharko-dev/keiko-model-gateway";
import type { GatewayRequest, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type {
  QualityIntelligenceModelPolicy,
  QualityIntelligenceModelPolicyPreflightResponse,
  QualityIntelligenceModelPolicyResponse,
  QualityIntelligenceModelPreflightErrorCategory,
  QualityIntelligenceModelPreflightStageResult,
  QualityIntelligenceModelPreflightSummary,
  QualityIntelligenceModelRouting,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  normaliseQiModelPolicy,
  recommendQiModelPolicy,
  repairQiModelPolicy,
  resolveQiModelPolicy,
  validateQiModelPolicy,
} from "./modelSelection.js";

const QI_POLICY_DIR = "quality-intelligence";
const QI_POLICY_FILE = "model-policy.json";
const MAX_POLICY_BODY_BYTES = 64 * 1024;
const PREFLIGHT_ERROR_RULES: readonly {
  readonly category: QualityIntelligenceModelPreflightErrorCategory;
  readonly patterns: readonly string[];
}[] = [
  { category: "timeout", patterns: ["timeout", "timed out", "etimedout"] },
  { category: "auth", patterns: ["unauthorized", "forbidden", "auth", "401", "403"] },
  { category: "rate-limit", patterns: ["rate", "429"] },
  { category: "context", patterns: ["context", "token", "too large"] },
  {
    category: "transport",
    patterns: ["econn", "enotfound", "eai_again", "network", "fetch", "tls"],
  },
];

export class QiModelPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QiModelPolicyError";
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super("QI model-policy request body is too large");
    this.name = "BodyTooLargeError";
  }
}

export function resolveQiPolicyPath(evidenceDir: string): string {
  return join(dirname(evidenceDir), QI_POLICY_DIR, QI_POLICY_FILE);
}

function errorResult(status: number, code: string, message: string): RouteResult {
  return { status, body: { error: { code, message } } };
}

function isRouteResult(value: Record<string, unknown> | RouteResult): value is RouteResult {
  return typeof value.status === "number" && "body" in value;
}

function configuredModels(deps: UiHandlerDeps): readonly ModelCapability[] {
  return deps.config === undefined ? [] : listConfiguredCapabilities(deps.config);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_POLICY_BODY_BYTES) {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePolicyValue(raw: unknown): QualityIntelligenceModelPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const policyVersion = raw.policyVersion === 1 ? 1 : undefined;
  if (policyVersion !== 1) return undefined;
  return normaliseQiModelPolicy({
    policyVersion,
    ...(typeof raw.testDesignModelId === "string"
      ? { testDesignModelId: raw.testDesignModelId }
      : {}),
    ...(typeof raw.judgeModelId === "string" ? { judgeModelId: raw.judgeModelId } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? errorResult(413, "QI_BAD_MODEL_POLICY", "Request body is too large.")
      : errorResult(400, "QI_BAD_MODEL_POLICY", "Could not read request body.");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed)
      ? parsed
      : errorResult(400, "QI_BAD_MODEL_POLICY", "Body must be JSON.");
  } catch {
    return errorResult(400, "QI_BAD_MODEL_POLICY", "Body is not valid JSON.");
  }
}

function loadStoredPolicy(
  evidenceDir: string | undefined,
): QualityIntelligenceModelPolicy | undefined {
  if (evidenceDir === undefined) return undefined;
  try {
    const raw = readFileSync(resolveQiPolicyPath(evidenceDir), "utf8");
    return parsePolicyValue(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function savePolicy(evidenceDir: string, policy: QualityIntelligenceModelPolicy): void {
  const target = resolveQiPolicyPath(evidenceDir);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function getQiModelPolicyResponse(
  deps: UiHandlerDeps,
): QualityIntelligenceModelPolicyResponse {
  const recommendedPolicy = recommendQiModelPolicy(deps);
  const stored = loadStoredPolicy(deps.evidenceDir);
  const loaded = stored ?? recommendedPolicy;
  const repaired = repairQiModelPolicy(deps, loaded);
  if (repaired.repaired && deps.evidenceDir !== undefined) {
    savePolicy(deps.evidenceDir, repaired.policy);
  }
  const resolved = resolveQiModelPolicy(deps, { modelPolicy: repaired.policy }).resolved;
  return {
    policy: repaired.policy,
    recommendedPolicy,
    resolved,
    models: configuredModels(deps),
    validation: validateQiModelPolicy(deps, repaired.policy),
    repaired: repaired.repaired,
  };
}

function policyForRequest(
  deps: UiHandlerDeps,
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): QualityIntelligenceModelPolicy {
  if (request.modelPolicy !== undefined) return normaliseQiModelPolicy(request.modelPolicy);
  const stored = loadStoredPolicy(deps.evidenceDir);
  if (stored !== undefined && request.modelId === undefined) return normaliseQiModelPolicy(stored);
  return normaliseQiModelPolicy({
    policyVersion: 1,
    ...(typeof request.modelId === "string" ? { testDesignModelId: request.modelId } : {}),
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { readonly code?: unknown }).code;
  return `${error.name} ${typeof code === "string" ? code : ""} ${error.message}`;
}

function classifyPreflightError(error: unknown): QualityIntelligenceModelPreflightErrorCategory {
  const lower = errorText(error).toLowerCase();
  const match = PREFLIGHT_ERROR_RULES.find((rule) =>
    rule.patterns.some((pattern) => lower.includes(pattern)),
  );
  if (match !== undefined) return match.category;
  if (lower.includes("http") || /\b5\d\d\b/u.test(lower) || /\b4\d\d\b/u.test(lower)) {
    return "provider-http";
  }
  return "transport";
}

function preflightMessage(category: QualityIntelligenceModelPreflightErrorCategory): string {
  switch (category) {
    case "timeout":
      return "The model gateway did not answer within the preflight window.";
    case "auth":
      return "The model gateway rejected the request as unauthorised.";
    case "rate-limit":
      return "The model gateway rate-limited the preflight request.";
    case "context":
      return "The model rejected the preflight request because of context or token limits.";
    case "transport":
      return "The model gateway could not be reached.";
    case "provider-http":
      return "The model provider returned an HTTP error.";
    case "unavailable":
      return "No compatible model is available for this stage.";
  }
  return "The model gateway preflight failed.";
}

function requestForPreflight(
  stage: "generate" | "judge",
  modelId: string,
  capability: ModelCapability,
): GatewayRequest {
  const wantsResponseFormat = stage === "judge" && capability.supportsResponseFormat === true;
  return {
    modelId,
    messages: [
      {
        role: "system",
        content:
          stage === "judge"
            ? "Return a compact JSON object that says whether the test case is acceptable."
            : "Answer with the word ok.",
      },
      {
        role: "user",
        content:
          stage === "judge"
            ? "Evaluate this synthetic one-line test case: verify that a required field is rejected when empty."
            : "Quality Intelligence preflight.",
      },
    ],
    ...(wantsResponseFormat
      ? {
          responseFormat: {
            type: "json_schema" as const,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok"],
              properties: { ok: { type: "boolean" } },
            },
          },
        }
      : {}),
  };
}

async function preflightStage(
  deps: UiHandlerDeps,
  stage: "generate" | "judge",
  modelId: string | undefined,
): Promise<QualityIntelligenceModelPreflightStageResult> {
  if (modelId === undefined || deps.config === undefined) {
    return {
      stage,
      status: "unavailable",
      category: "unavailable",
      message: preflightMessage("unavailable"),
    };
  }
  const capability = findConfiguredCapability(deps.config, modelId);
  if (capability?.kind !== "chat") {
    return {
      stage,
      modelId,
      status: "unavailable",
      category: "unavailable",
      message: preflightMessage("unavailable"),
    };
  }
  try {
    await new Gateway(deps.config).chat(requestForPreflight(stage, modelId, capability));
    return { stage, modelId, status: "passed" };
  } catch (error) {
    const category = classifyPreflightError(error);
    return {
      stage,
      modelId,
      status: "failed",
      category,
      message: preflightMessage(category),
    };
  }
}

function summarizePreflight(
  generation: QualityIntelligenceModelPreflightStageResult,
  judge: QualityIntelligenceModelPreflightStageResult | undefined,
): QualityIntelligenceModelPreflightSummary {
  const status =
    generation.status === "failed" || judge?.status === "failed"
      ? "failed"
      : generation.status === "unavailable"
        ? "unavailable"
        : "passed";
  return {
    status,
    generation,
    ...(judge !== undefined ? { judge } : {}),
  };
}

export async function buildQiModelRouting(
  deps: UiHandlerDeps,
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): Promise<QualityIntelligenceModelRouting> {
  const requested = policyForRequest(deps, request);
  const resolution = resolveQiModelPolicy(deps, { ...request, modelPolicy: requested });
  if (!resolution.validation.ok) {
    throw new QiModelPolicyError(
      "QI_BAD_MODEL_POLICY",
      "The selected Quality Intelligence model policy is invalid.",
    );
  }
  const generation = await preflightStage(deps, "generate", resolution.resolved.testDesignModelId);
  const judge =
    resolution.resolved.judgeModelId === undefined
      ? await preflightStage(deps, "judge", undefined)
      : await preflightStage(deps, "judge", resolution.resolved.judgeModelId);
  return {
    policyVersion: 1,
    requested,
    resolved: resolution.resolved,
    preflight: summarizePreflight(generation, judge),
  };
}

export async function buildQiModelRoutingForRun(
  deps: UiHandlerDeps,
  request: Pick<QualityIntelligenceStartRunRequest, "modelId" | "modelPolicy">,
): Promise<QualityIntelligenceModelRouting> {
  const routing = await buildQiModelRouting(deps, request);
  const generation = routing.preflight.generation;
  if (generation?.status !== "passed" && routing.resolved.testDesignModelId !== undefined) {
    throw new QiModelPolicyError(
      "QI_MODEL_PREFLIGHT_FAILED",
      generation?.message ?? "The selected Quality Intelligence generation model is unavailable.",
    );
  }
  if (routing.preflight.judge?.status === "failed") {
    throw new QiModelPolicyError(
      "QI_MODEL_PREFLIGHT_FAILED",
      routing.preflight.judge.message ??
        "The selected Quality Intelligence judge model failed preflight.",
    );
  }
  return routing;
}

export function handleGetQiModelPolicy(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  return { status: 200, body: getQiModelPolicyResponse(deps) };
}

export async function handlePutQiModelPolicy(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const parsed = await parseJsonBody(ctx.req);
  if (isRouteResult(parsed)) return parsed;
  const policy = parsePolicyValue(parsed.modelPolicy ?? parsed.policy ?? parsed);
  if (policy === undefined) {
    return errorResult(
      400,
      "QI_BAD_MODEL_POLICY",
      "The Quality Intelligence model policy is malformed.",
    );
  }
  const validation = validateQiModelPolicy(deps, policy);
  if (!validation.ok) {
    return errorResult(
      400,
      "QI_BAD_MODEL_POLICY",
      "The selected Quality Intelligence model policy is invalid.",
    );
  }
  const saved = { ...policy, updatedAt: new Date().toISOString() };
  savePolicy(deps.evidenceDir, saved);
  return { status: 200, body: getQiModelPolicyResponse(deps) };
}

export async function handlePreflightQiModelPolicy(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await parseJsonBody(ctx.req);
  if (isRouteResult(parsed)) return parsed;
  const modelPolicy = parsePolicyValue(parsed.modelPolicy);
  if (parsed.modelPolicy !== undefined && modelPolicy === undefined) {
    return errorResult(
      400,
      "QI_BAD_MODEL_POLICY",
      "The Quality Intelligence model policy is malformed.",
    );
  }
  try {
    const modelRouting = await buildQiModelRouting(deps, {
      ...(modelPolicy !== undefined ? { modelPolicy } : {}),
      ...(typeof parsed.modelId === "string" ? { modelId: parsed.modelId } : {}),
    });
    const body: QualityIntelligenceModelPolicyPreflightResponse = { modelRouting };
    return { status: 200, body };
  } catch (error) {
    if (error instanceof QiModelPolicyError) {
      return errorResult(400, error.code, error.message);
    }
    return errorResult(
      500,
      "QI_PREFLIGHT_FAILED",
      "The Quality Intelligence model preflight failed.",
    );
  }
}

export const QI_MODEL_POLICY_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/quality-intelligence/model-policy",
    handler: handleGetQiModelPolicy,
  },
  {
    method: "PUT",
    pattern: "/api/quality-intelligence/model-policy",
    handler: handlePutQiModelPolicy,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/model-policy/preflight",
    handler: handlePreflightQiModelPolicy,
  },
];
