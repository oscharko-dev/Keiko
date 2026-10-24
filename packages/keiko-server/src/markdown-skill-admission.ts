import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { MarkdownSkillReference } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { GatewayCallRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { MarkdownSkillStore } from "./store/markdownSkills.js";
import { assertMarkdownSkillAuthority } from "./markdown-skill-authority.js";
import { logMarkdownSkillWorkflowAttachment } from "./markdown-skill-log.js";
import { withLeadingMarkdownSkillInstructions } from "./markdown-skill-prompt.js";

type AttemptAdmission = NonNullable<GatewayCallRequest["attemptAdmission"]>;

// Every physical attempt, a gateway retry included, passes `check` first; the request's own
// admission, when it has one, then decides as before. Composes with it, never replaces it.
function withAttemptCheck(request: GatewayCallRequest, check: () => void): GatewayCallRequest {
  return {
    ...request,
    attemptAdmission: (input): ReturnType<AttemptAdmission> => {
      check();
      return request.attemptAdmission === undefined
        ? { settle: (): void => undefined }
        : request.attemptAdmission(input);
    },
  };
}

/** Narrow every physical attempt, including Gateway transport retries, to the pinned revision. */
export function protectMarkdownSkillRequest(
  request: GatewayCallRequest,
  library: MarkdownSkillStore,
  messageId: string | undefined,
  authority?: () => boolean,
): GatewayCallRequest {
  if (messageId === undefined || library.forTurn(messageId) === undefined) return request;
  assertMarkdownSkillAuthority(authority, request.logContext?.correlationId);
  return withAttemptCheck(request, () => {
    assertMarkdownSkillAuthority(authority, request.logContext?.correlationId);
    library.forTurn(messageId);
  });
}

export function withMarkdownSkillAdmission(
  model: ModelPort,
  library: MarkdownSkillStore,
  messageId: string | undefined,
  authority?: () => boolean,
): ModelPort {
  if (messageId === undefined || library.forTurn(messageId) === undefined) return model;
  const protect = (request: GatewayCallRequest): GatewayCallRequest =>
    protectMarkdownSkillRequest(request, library, messageId, authority);
  return guardedModelPort(model, protect);
}

function guardedModelPort(
  model: ModelPort,
  protect: (request: GatewayCallRequest) => GatewayCallRequest,
): ModelPort {
  const call: ModelPort["call"] = async (request, signal) => {
    const response = await model.call(protect(request), signal);
    return response;
  };
  if (model.callStream === undefined) return { call };
  const stream = model.callStream.bind(model);
  return {
    call,
    callStream: async function* (request, signal): AsyncIterable<GatewayStreamChunk> {
      for await (const chunk of stream(protect(request), signal)) yield chunk;
    },
  };
}

/** The skill a workflow run was launched with, bound on the server when the run began. */
export interface SelectedMarkdownSkillBinding {
  readonly library: MarkdownSkillStore;
  readonly reference: MarkdownSkillReference;
  /** The run's own authority, asked again for every attempt: a revoked run sends no attempt. */
  readonly authorityCurrent: () => boolean;
  readonly runId: string;
  readonly workflow: "unit-tests" | "bug-investigation";
}

/** A model call or attempt the run's selected skill refused; the run ends failed, never applied. */
export class SelectedMarkdownSkillUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super("The skill selected for this run is no longer available.", { cause });
    this.name = "SelectedMarkdownSkillUnavailableError";
  }
}

/**
 * A workflow run's explicitly selected private skill at the model boundary (#4025 AC1). Every model
 * call of the run, a generation, a repair after a rejected patch and the gated apply alike, carries
 * the bound revision's instructions ahead of its first user message, once. Every physical attempt,
 * a gateway retry included, resolves that exact revision again and asks the run's authority again:
 * a deleted, replaced-away or corrupted revision, or a revoked run, sends nothing further. Wrapped
 * outside the run's budget port, so the skill is counted like the rest of the prompt; the body
 * never enters the workflow's input, its report or its evidence.
 */
export function withSelectedMarkdownSkill(
  model: ModelPort,
  binding: SelectedMarkdownSkillBinding,
): ModelPort {
  const current = (): ReturnType<MarkdownSkillStore["resolve"]> => {
    if (!binding.authorityCurrent()) throw refusal(binding, "authority-invalid");
    try {
      return binding.library.resolve(binding.reference);
    } catch (error) {
      throw refusal(binding, "skill-unavailable", error);
    }
  };
  return guardedModelPort(model, (request) => {
    const skill = current();
    logMarkdownSkillWorkflowAttachment({
      runId: binding.runId,
      workflow: binding.workflow,
      skill,
      outcome: { phase: "attached", byteCount: skill.byteCount },
    });
    return withAttemptCheck(
      { ...request, messages: withLeadingMarkdownSkillInstructions(request.messages, skill) },
      () => void current(),
    );
  });
}

function refusal(
  binding: SelectedMarkdownSkillBinding,
  reason: "skill-unavailable" | "authority-invalid",
  cause?: unknown,
): SelectedMarkdownSkillUnavailableError {
  logMarkdownSkillWorkflowAttachment({
    runId: binding.runId,
    workflow: binding.workflow,
    skill: binding.reference,
    outcome: { phase: "refused", reason },
  });
  return new SelectedMarkdownSkillUnavailableError(cause);
}
