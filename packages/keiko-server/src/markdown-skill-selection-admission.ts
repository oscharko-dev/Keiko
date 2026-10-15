import type { UiHandlerDeps } from "./deps.js";
import { logMarkdownSkillOperation } from "./markdown-skill-log.js";
import { errorBody } from "./route-error.js";
import type { RouteResult } from "./routes.js";

/** The separate PR-description workflow does not yet own protected skill assembly (#4025). */
export function gitDescriptionSkillRefusal(
  deps: Pick<UiHandlerDeps, "store">,
  chatId: string,
  correlationId?: string,
): RouteResult | undefined {
  if (deps.store.markdownSkills.selection(chatId).skill === null) return undefined;
  logMarkdownSkillOperation(correlationId, "selection-read", "rejected", 409);
  return {
    status: 409,
    body: errorBody(
      "SKILL_SURFACE_UNSUPPORTED",
      "Skills are not available in the connected Git description workflow. Remove the skill or use a regular Chat.",
      correlationId,
    ),
  };
}

export function parseExpectedSkillSelectionRevision(
  value: unknown,
): number | null | undefined | RouteResult {
  if (value === undefined || value === null) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return { status: 400, body: errorBody("BAD_REQUEST", "Invalid skill selection revision.") };
}

/** Called synchronously with message admission: no asynchronous gap before the pinned binding. */
export function markdownSkillSelectionRefusal(
  deps: Pick<UiHandlerDeps, "store" | "markdownSkillAuthority">,
  chatId: string,
  expectedRevision: number | null | undefined,
  correlationId?: string,
): RouteResult | undefined {
  const selection = deps.store.markdownSkills.selection(chatId);
  if (selection.skill !== null && deps.markdownSkillAuthority?.() !== true) {
    logMarkdownSkillOperation(correlationId, "selection-read", "rejected", 404);
    return { status: 404, body: errorBody("NOT_FOUND", "Skill not found.", correlationId) };
  }
  if (expectedRevision === undefined) return undefined;
  if (
    expectedRevision === null ? selection.skill === null : selection.revision === expectedRevision
  )
    return undefined;
  logMarkdownSkillOperation(correlationId, "selection-read", "rejected", 409);
  return {
    status: 409,
    body: errorBody(
      "SKILL_SELECTION_CHANGED",
      "The selected skill changed. Review the current selection and send again.",
      correlationId,
    ),
  };
}
