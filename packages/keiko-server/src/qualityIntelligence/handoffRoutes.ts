// Quality Intelligence Conversation Center → workflow handoff route (Epic #270, Issue #281).
//
// Single additive HTTP handler:
//   * POST /api/quality-intelligence/handoff
//
// Hard constraints:
//   * The Conversation Center is the existing chat surface — QI integration is via WORKFLOW
//     HANDOFF only, never a parallel chat/agent/memory channel.
//   * The request body IS a `QualityIntelligenceConversationCenterHandoff` envelope. The envelope
//     carries ONLY refs (chat-message id, run id, source-envelope ids) — never chat content,
//     never an excerpt, never a body. Unknown top-level keys are REJECTED so a misbehaving
//     client cannot smuggle content through the seam.
//   * The route resolves `requestedByChatMessageId` against the existing chat-store seam
//     (`UiStore`). If recognised, the handoff is persisted as a single system message on the
//     owning chat (taskType=`qi-handoff`); the message content is a fixed, non-echoing
//     descriptor — the envelope itself stays out of the message body.
//   * If the chat-message ref is unknown → `404 QI_HANDOFF_UNKNOWN_CHAT_MESSAGE`.
//   * No provider SDK imports. No new runtime dependency. A "design-tests" handoff additionally
//     starts a model-routed QI run in the BACKGROUND from the chat's connected folder (through the
//     Keiko Model Gateway + Harness, like any QI run) and links the run id back to the chat — this
//     is the governed workflow handoff (Issue #281), not a parallel chat/agent/model channel.
//   * Test Intelligence reference (TI) is acknowledged only by plain phrase; this file MUST
//     NOT contain any reference to the prior external TI-namespace packages — enforced by
//     `independenceGuard.test.ts` and the repo-wide `npm run check:qi-supply-chain` gate.
//
// Group export `QI_HANDOFF_ROUTE_GROUP` keeps the route registration mechanically merge-safe
// with sibling QI epic work (e.g. #280) — the dispatcher in `routes.ts` only needs to spread
// the group.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ChatMessage, NewChatMessage } from "../store/types.js";
import {
  qiHandoffErrorBody,
  type QiHandoffErrorCode,
  type QiHandoffErrorBody,
} from "./handoffErrors.js";
import { containsForbiddenSecretShape } from "./connectorErrors.js";
import { executeQiRun } from "./runExecution.js";
import { qiRunRegistry } from "./runRegistry.js";

// ─── Body reading ──────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("Handoff body exceeds the route cap");
    this.name = "BodyTooLargeError";
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ─── Envelope validation (envelope-only invariant) ─────────────────────────────

// The envelope's permitted top-level keys. Anything else MUST be rejected so a leaky
// client cannot smuggle chat content, bodies, excerpts, or unstructured payloads
// through this seam.
const ALLOWED_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "requestedByChatMessageId",
  "runId",
  "promptedAction",
  "payloadRef",
]);

// `payloadRef` carries strictly envelope-id refs and nothing else. The branded
// `sourceEnvelopeIds` array is the only permitted member.
const ALLOWED_PAYLOAD_REF_KEYS: ReadonlySet<string> = new Set(["sourceEnvelopeIds"]);

const errResult = (status: number, code: QiHandoffErrorCode): RouteResult => ({
  status,
  body: qiHandoffErrorBody(code) satisfies QiHandoffErrorBody,
});

const scanForbiddenStrings = (value: unknown): boolean => {
  if (typeof value === "string") return containsForbiddenSecretShape(value);
  if (Array.isArray(value)) return value.some(scanForbiddenStrings);
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) {
      if (scanForbiddenStrings(v)) return true;
    }
    return false;
  }
  return false;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isAllowedAction = (
  value: unknown,
): value is QualityIntelligence.QualityIntelligenceHandoffPromptedAction => {
  if (typeof value !== "string") return false;
  for (const action of QualityIntelligence.QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS) {
    if (action === value) return true;
  }
  return false;
};

interface ValidatedEnvelope {
  readonly kind: "ok";
  readonly envelope: QualityIntelligence.QualityIntelligenceConversationCenterHandoff;
}

interface ValidationError {
  readonly kind: "err";
  readonly result: RouteResult;
}

type Validation = ValidatedEnvelope | ValidationError;

const fail = (code: QiHandoffErrorCode = "QI_HANDOFF_BAD_REQUEST"): ValidationError => ({
  kind: "err",
  result: errResult(code === "QI_HANDOFF_FORBIDDEN_PAYLOAD" ? 400 : 400, code),
});

const hasOnlyAllowedKeys = (
  obj: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
};

const parseSourceEnvelopeIds = (
  raw: unknown,
): readonly QualityIntelligence.QualityIntelligenceSourceEnvelopeId[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const ids: QualityIntelligence.QualityIntelligenceSourceEnvelopeId[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") return undefined;
    try {
      ids.push(QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(candidate));
    } catch {
      return undefined;
    }
  }
  return ids;
};

const parseOptionalRunId = (
  raw: unknown,
):
  | { readonly ok: true; readonly value: QualityIntelligence.QualityIntelligenceRunId | undefined }
  | { readonly ok: false } => {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false };
  try {
    return { ok: true, value: QualityIntelligence.asQualityIntelligenceRunId(raw) };
  } catch {
    return { ok: false };
  }
};

const validatePayloadRef = (
  raw: unknown,
): readonly QualityIntelligence.QualityIntelligenceSourceEnvelopeId[] | undefined => {
  if (!isPlainObject(raw)) return undefined;
  if (!hasOnlyAllowedKeys(raw, ALLOWED_PAYLOAD_REF_KEYS)) return undefined;
  return parseSourceEnvelopeIds(raw.sourceEnvelopeIds);
};

const validateEnvelope = (parsed: unknown): Validation => {
  if (!isPlainObject(parsed)) return fail();
  if (!hasOnlyAllowedKeys(parsed, ALLOWED_ENVELOPE_KEYS)) return fail();
  if (!isNonEmptyString(parsed.id)) return fail();
  if (!isNonEmptyString(parsed.requestedByChatMessageId)) return fail();
  if (!isAllowedAction(parsed.promptedAction)) return fail();

  const sourceEnvelopeIds = validatePayloadRef(parsed.payloadRef);
  if (sourceEnvelopeIds === undefined) return fail();

  const runIdResult = parseOptionalRunId(parsed.runId);
  if (!runIdResult.ok) return fail();

  // Defence-in-depth: scrub every string value for credential-shaped substrings.
  if (scanForbiddenStrings(parsed)) return fail("QI_HANDOFF_FORBIDDEN_PAYLOAD");

  const envelope: QualityIntelligence.QualityIntelligenceConversationCenterHandoff = {
    id: parsed.id,
    requestedByChatMessageId: parsed.requestedByChatMessageId,
    promptedAction: parsed.promptedAction,
    payloadRef: { sourceEnvelopeIds },
    ...(runIdResult.value !== undefined ? { runId: runIdResult.value } : {}),
  };
  return { kind: "ok", envelope };
};

// ─── Chat-message resolution via the existing UiStore seam ─────────────────────

interface ResolvedMessage {
  readonly chatId: string;
  readonly message: ChatMessage;
}

// Single indexed lookup — replaces O(P×C×M) triple scan on every handoff POST.
const findChatMessage = (deps: UiHandlerDeps, messageId: string): ResolvedMessage | undefined => {
  const message = deps.store.findMessageById(messageId);
  if (message === undefined) return undefined;
  return { chatId: message.chatId, message };
};

// ─── Persisted handoff record ──────────────────────────────────────────────────
//
// We persist the handoff as a single system message on the owning chat. The message
// content is a fixed, non-echoing descriptor — the envelope itself is NOT serialised
// into the message body. This preserves the envelope-only invariant on the persisted
// row and keeps the chat surface free of secret-shaped content.

const HANDOFF_TASK_TYPE = "qi-handoff";

const HANDOFF_CONTENT_BY_ACTION: Readonly<
  Record<QualityIntelligence.QualityIntelligenceHandoffPromptedAction, string>
> = {
  "design-tests": "Quality Intelligence: design-tests handoff requested.",
  "validate-tests": "Quality Intelligence: validate-tests handoff requested.",
  "review-coverage": "Quality Intelligence: review-coverage handoff requested.",
  "request-export": "Quality Intelligence: request-export handoff requested.",
};

const buildHandoffMessage = (
  resolved: ResolvedMessage,
  envelope: QualityIntelligence.QualityIntelligenceConversationCenterHandoff,
  now: () => number,
  linkedRunId: string | undefined,
): NewChatMessage => ({
  chatId: resolved.chatId,
  role: "system",
  content: HANDOFF_CONTENT_BY_ACTION[envelope.promptedAction],
  timestamp: now(),
  runId: linkedRunId,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: HANDOFF_TASK_TYPE,
});

// For a "design-tests" handoff, start a model-routed QI run in the BACKGROUND from the chat's
// connected workspace folder. Fire-and-forget: the run registers with the in-flight registry (so it
// surfaces in the run list) and persists to evidence on completion; the handoff returns the run id
// immediately so the Conversation Center can link + poll it. The run goes through the Keiko Model
// Gateway + Harness like any QI run — this is the governed workflow handoff (Issue #281), not a
// parallel chat/agent/model path.
const startHandoffRun = (deps: UiHandlerDeps, root: string): string => {
  const runId = `qi-run-${randomUUID()}`;
  const registeredAt = new Date().toISOString();
  const controller = qiRunRegistry.register(runId, registeredAt);
  const totals = { candidates: 0, findings: 0, exports: 0 };
  void executeQiRun({
    request: { sources: [{ kind: "workspace", label: "Conversation Center", path: root }] },
    runId,
    deps,
    registeredAt,
    signal: controller.signal,
    onAccepted: () => undefined,
    onEvent: (event: QualityIntelligence.QualityIntelligenceRunEvent) => {
      if (event.payload.kind === "candidate:proposed") totals.candidates += 1;
      if (event.payload.kind === "finding:recorded") totals.findings += 1;
      qiRunRegistry.updateTotals(runId, totals);
    },
  })
    .then((summary) => {
      qiRunRegistry.complete(runId, summary.status);
    })
    .catch(() => {
      qiRunRegistry.complete(runId, "failed");
    });
  return runId;
};

// Resolve the run id linked to a handoff: a "design-tests" handoff over a chat with a connected
// folder starts a background run; otherwise it falls back to any run id the envelope already carried.
const resolveHandoffRunId = (
  deps: UiHandlerDeps,
  envelope: QualityIntelligence.QualityIntelligenceConversationCenterHandoff,
  chatId: string,
): string | undefined => {
  if (envelope.promptedAction !== "design-tests") return envelope.runId;
  const chat = deps.store.findChatById(chatId);
  const root = chat?.connectedScope?.root;
  if (root !== undefined && root.length > 0) return startHandoffRun(deps, root);
  return envelope.runId;
};

// ─── Handler ───────────────────────────────────────────────────────────────────

export interface QiHandoffSuccessBody {
  readonly handoffId: string;
  readonly chatId: string;
  readonly persistedMessageId: string;
  readonly runId?: string;
}

export interface QiHandoffRouteOptions {
  readonly now?: () => number;
}

export const createHandleQiHandoff = (
  options: QiHandoffRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const now = options.now ?? ((): number => Date.now());
  return async (ctx, deps): Promise<RouteResult> => {
    let raw: string;
    try {
      raw = await readBody(ctx.req);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        return errResult(413, "QI_HANDOFF_BAD_REQUEST");
      }
      return errResult(400, "QI_HANDOFF_BAD_REQUEST");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errResult(400, "QI_HANDOFF_BAD_REQUEST");
    }
    const validation = validateEnvelope(parsed);
    if (validation.kind === "err") return validation.result;
    const { envelope } = validation;

    const resolved = findChatMessage(deps, envelope.requestedByChatMessageId);
    if (resolved === undefined) {
      return errResult(404, "QI_HANDOFF_UNKNOWN_CHAT_MESSAGE");
    }

    const linkedRunId = resolveHandoffRunId(deps, envelope, resolved.chatId);
    const persisted = deps.store.createMessage(
      buildHandoffMessage(resolved, envelope, now, linkedRunId),
    );

    const body: QiHandoffSuccessBody = {
      handoffId: envelope.id,
      chatId: resolved.chatId,
      persistedMessageId: persisted.id,
      ...(linkedRunId !== undefined ? { runId: linkedRunId } : {}),
    };
    return { status: 200, body };
  };
};

export const handleQiHandoff = createHandleQiHandoff();

// Mechanically-mergeable route group. Sibling QI epic work (e.g. #280) registers its
// own group separately; the dispatcher in `routes.ts` spreads each group into the
// route table, so the merge surface here is a single array literal.
export const QI_HANDOFF_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/quality-intelligence/handoff",
    handler: handleQiHandoff,
  },
];
