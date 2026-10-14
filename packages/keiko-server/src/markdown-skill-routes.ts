import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillUpload,
  type MarkdownSkillDocument,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { readJsonRequestBodyOutcome, type JsonRequestBodyOutcome } from "./bounded-request-body.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "./deps.js";
import { logMarkdownSkillOperation, type MarkdownSkillAction } from "./markdown-skill-log.js";
import { errorBody } from "./route-error.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { invalidRequest, notFound, UiStoreError } from "./store/errors.js";

const UPLOAD_BODY_BYTES = Math.ceil(MARKDOWN_SKILL_LIMITS.importBytes / 3) * 4 + 2048;
type SkillRouteDeps = Pick<UiHandlerDeps, "store" | "codingAppSessionChannel">;

function outcomePhase(status: number): "completed" | "rejected" | "failed" {
  if (status >= 500) return "failed";
  return status >= 400 ? "rejected" : "completed";
}

async function readMutation(
  ctx: RouteContext,
  deps: SkillRouteDeps,
  maxBytes: number,
): Promise<JsonRequestBodyOutcome> {
  const body = await readJsonRequestBodyOutcome(ctx.req, maxBytes, ctx.correlationId);
  // A session can expire or be revoked while an upload is in flight.
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) throw notFound("Skill");
  return body;
}

async function withSkillAccess(
  ctx: RouteContext,
  deps: SkillRouteDeps,
  action: MarkdownSkillAction,
  operation: () => RouteResult | Promise<RouteResult>,
): Promise<RouteResult> {
  logMarkdownSkillOperation(ctx.correlationId, action, "started", 0);
  let result: RouteResult;
  try {
    if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) throw notFound("Skill");
    result = await operation();
  } catch (error) {
    if (!(error instanceof UiStoreError)) {
      logMarkdownSkillOperation(ctx.correlationId, action, "failed", 500);
      throw error;
    }
    result = {
      status: error.status,
      body: errorBody(error.code, error.message, ctx.correlationId),
    };
  }
  logMarkdownSkillOperation(ctx.correlationId, action, outcomePhase(result.status), result.status);
  return { ...result, headers: { "Cache-Control": "no-store" } };
}

function uploadInput(body: Record<string, unknown>): MarkdownSkillUpload {
  if (typeof body.fileName !== "string" || typeof body.contentBase64 !== "string") {
    throw invalidRequest("Provide a Markdown filename and encoded file contents.");
  }
  return { fileName: body.fileName, contentBase64: body.contentBase64 };
}

function expectedRevision(body: Record<string, unknown>): number {
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    throw invalidRequest("Provide the current skill revision.");
  }
  return body.expectedRevision;
}

function requestedSkill(ctx: RouteContext, deps: SkillRouteDeps): MarkdownSkillDocument {
  const value = ctx.url.searchParams.get("revision");
  if (value !== null && !/^[1-9]\d{0,9}$/u.test(value))
    throw invalidRequest("Invalid skill revision.");
  const skill = deps.store.markdownSkills.get(
    ctx.params.id ?? "",
    value === null ? undefined : Number(value),
  );
  if (skill === undefined) throw notFound("Skill");
  return skill;
}

export function handleListMarkdownSkills(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "list", () => ({
    status: 200,
    body: { skills: deps.store.markdownSkills.list() },
  }));
}

export function handleReadMarkdownSkill(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "read", () => ({
    status: 200,
    body: { skill: requestedSkill(ctx, deps) },
  }));
}

export function handleExportMarkdownSkill(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "export", () => ({
    status: 200,
    body: { fileName: "skill.md", content: requestedSkill(ctx, deps).body },
  }));
}

export function handleImportMarkdownSkill(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "import", async () => {
    const body = await readMutation(ctx, deps, UPLOAD_BODY_BYTES);
    if (body.kind === "rejected") return body.response;
    return {
      status: 201,
      body: { skill: deps.store.markdownSkills.import(uploadInput(body.value)) },
    };
  });
}

export function handleReplaceMarkdownSkill(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "replace", async () => {
    const body = await readMutation(ctx, deps, UPLOAD_BODY_BYTES);
    if (body.kind === "rejected") return body.response;
    const skill = deps.store.markdownSkills.replace(
      ctx.params.id ?? "",
      expectedRevision(body.value),
      uploadInput(body.value),
    );
    return { status: 200, body: { skill } };
  });
}

export function handleDeleteMarkdownSkill(
  ctx: RouteContext,
  deps: SkillRouteDeps,
): Promise<RouteResult> {
  return withSkillAccess(ctx, deps, "delete", async () => {
    const body = await readMutation(ctx, deps, 1024);
    if (body.kind === "rejected") return body.response;
    deps.store.markdownSkills.delete(ctx.params.id ?? "", expectedRevision(body.value));
    return { status: 204, body: null };
  });
}
