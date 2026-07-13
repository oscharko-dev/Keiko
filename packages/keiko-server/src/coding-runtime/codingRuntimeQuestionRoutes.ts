// Transient OpenCode question BFF. Question text is browser-rendered untrusted content and never
// enters diagnostics, snapshots, evidence, or persistence.
import type { IncomingMessage } from "node:http";

import {
  parseCodingWorkbenchRuntimeQuestionAnswerRequest,
  parseCodingWorkbenchRuntimeQuestionPath,
  parseCodingWorkbenchRuntimeQuestionRejectRequest,
  parseCodingWorkbenchRuntimeQuestionsPath,
  validateCodingWorkbenchRuntimeQuestionAcceptedResponse,
  validateCodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";

interface ActiveQuestionDeps {
  readonly port: CodingRuntimeQuestionPort;
  readonly runId: string;
}

interface ActiveQuestionTarget extends ActiveQuestionDeps {
  readonly questionId: string;
}

const MAX_BODY_BYTES = 64 * 1024;
class BodyTooLargeError extends Error {}

function rejected(status = 409): RouteResult {
  return {
    status,
    body: {
      error: {
        code: "CODING_RUNTIME_QUESTION_REJECTED",
        message: "Runtime question request was rejected.",
      },
    },
  };
}

function requireActiveQuestionRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): ActiveQuestionDeps | RouteResult {
  const parsed = parseCodingWorkbenchRuntimeQuestionsPath({ runId: ctx.params.runId });
  if (!parsed.ok) return rejected(400);
  const snapshot = deps.codingRuntimeOrchestrator?.status();
  if (
    deps.codingRuntimeQuestionPort === undefined ||
    snapshot?.state !== "running" ||
    snapshot.runId !== parsed.value.runId
  ) {
    return rejected();
  }
  return { port: deps.codingRuntimeQuestionPort, runId: parsed.value.runId };
}

function requireActiveQuestionTarget(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): ActiveQuestionTarget | RouteResult {
  const parsed = parseCodingWorkbenchRuntimeQuestionPath({
    runId: ctx.params.runId,
    questionId: ctx.params.questionId,
  });
  if (!parsed.ok) return rejected(400);
  const active = requireActiveQuestionRun(ctx, deps);
  return isRouteResult(active) ? active : { ...active, questionId: parsed.value.questionId };
}

function isRouteResult(value: ActiveQuestionDeps | RouteResult): value is RouteResult {
  return "status" in value;
}

export async function handleCodingRuntimeQuestions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const active = requireActiveQuestionRun(ctx, deps);
  if (isRouteResult(active)) return active;
  try {
    const response = await active.port.list(active.runId);
    return response !== undefined && validateCodingWorkbenchRuntimeQuestionsResponse(response).ok
      ? { status: 200, body: response }
      : rejected();
  } catch {
    return rejected();
  }
}

export function handleCodingRuntimeQuestionAnswer(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return mutateQuestion(ctx, deps, "answer");
}

export function handleCodingRuntimeQuestionReject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return mutateQuestion(ctx, deps, "reject");
}

async function mutateQuestion(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  action: "answer" | "reject",
): Promise<RouteResult> {
  const active = requireActiveQuestionTarget(ctx, deps);
  if (isRouteResult(active)) return active;
  try {
    const body = await readJsonBody(ctx.req);
    const accepted = action === "answer" ? await answer(active, body) : await reject(active, body);
    return accepted ? acceptedResult() : rejected();
  } catch (error) {
    return rejected(error instanceof BodyTooLargeError ? 413 : 400);
  }
}

async function answer(active: ActiveQuestionTarget, body: unknown): Promise<boolean> {
  const parsed = parseCodingWorkbenchRuntimeQuestionAnswerRequest(body);
  return parsed.ok
    ? active.port.answer(active.runId, active.questionId, parsed.value.answers)
    : false;
}

async function reject(active: ActiveQuestionTarget, body: unknown): Promise<boolean> {
  return parseCodingWorkbenchRuntimeQuestionRejectRequest(body).ok
    ? active.port.reject(active.runId, active.questionId)
    : false;
}

function acceptedResult(): RouteResult {
  const body = { accepted: true as const };
  return validateCodingWorkbenchRuntimeQuestionAcceptedResponse(body).ok
    ? { status: 200, body }
    : rejected();
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      if (capped) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        capped = true;
        chunks.length = 0;
        rejectBody(new BodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(parseBody(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", rejectBody);
  });
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return undefined;
  }
}

export const CODING_RUNTIME_QUESTION_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions",
    handler: handleCodingRuntimeQuestions,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions/:questionId/answer",
    handler: handleCodingRuntimeQuestionAnswer,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions/:questionId/reject",
    handler: handleCodingRuntimeQuestionReject,
  },
];
