import type { IncomingMessage } from "node:http";
import { MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts";
import type { ConversationAttachmentUploadResponseWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "./bounded-request-body.js";
import { resolveAppSessionReadAuthority } from "./coding-app-session/appSessionReadAuthority.js";
import { ConversationAttachmentStoreError } from "./conversation-attachment-store.js";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4_096;

function unavailable(): RouteResult {
  return { status: 404, body: errorBody("NOT_FOUND", "Conversation attachment is unavailable.") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readBoundedRequestBody(req, MAX_UPLOAD_BODY_BYTES);
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function chatMatches(deps: UiHandlerDeps, projectPath: string, chatId: string): boolean {
  return deps.store.findChatById(chatId)?.projectPath === projectPath;
}

interface AttachmentUploadBody {
  readonly projectPath: string;
  readonly chatId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

type AttachmentDeleteBody = Omit<AttachmentUploadBody, "contentBase64"> & {
  readonly attachmentRef: string;
};

function uploadBody(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): AttachmentUploadBody | undefined {
  const { projectPath, chatId, mimeType, sizeBytes, sha256, contentBase64 } = body;
  if (
    typeof projectPath !== "string" ||
    typeof chatId !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof sha256 !== "string" ||
    typeof contentBase64 !== "string"
  ) {
    return undefined;
  }
  return chatMatches(deps, projectPath, chatId)
    ? { projectPath, chatId, mimeType, sizeBytes, sha256, contentBase64 }
    : undefined;
}

function deleteBody(
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): AttachmentDeleteBody | undefined {
  const { attachmentRef, projectPath, chatId, mimeType, sizeBytes, sha256 } = body;
  if (
    typeof attachmentRef !== "string" ||
    typeof projectPath !== "string" ||
    typeof chatId !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof sha256 !== "string"
  ) {
    return undefined;
  }
  return chatMatches(deps, projectPath, chatId)
    ? { attachmentRef, projectPath, chatId, mimeType, sizeBytes, sha256 }
    : undefined;
}

export async function handleUploadConversationAttachment(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined || deps.conversationAttachmentStore === undefined) {
    return unavailable();
  }
  const body = await readBody(ctx.req);
  if (body === undefined) return unavailable();
  const upload = uploadBody(body, deps);
  if (upload === undefined) return unavailable();
  try {
    const uploaded = deps.conversationAttachmentStore.put({
      sessionId: session.sessionId,
      sessionRotationCount: session.rotationCount,
      projectPath: upload.projectPath,
      chatId: upload.chatId,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
      bytes: Buffer.from(upload.contentBase64, "base64"),
    });
    return {
      status: 201,
      body: {
        attachmentRef: uploaded.ref,
        expiresAt: uploaded.expiresAt,
      } satisfies ConversationAttachmentUploadResponseWire,
    };
  } catch (error) {
    if (error instanceof ConversationAttachmentStoreError) return unavailable();
    throw error;
  }
}

export async function handleDeleteConversationAttachment(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined || deps.conversationAttachmentStore === undefined) {
    return unavailable();
  }
  const body = await readBody(ctx.req);
  if (body === undefined) return unavailable();
  const deletion = deleteBody(body, deps);
  if (deletion === undefined) return unavailable();
  try {
    deps.conversationAttachmentStore.deleteBound(deletion.attachmentRef, {
      sessionId: session.sessionId,
      sessionRotationCount: session.rotationCount,
      projectPath: deletion.projectPath,
      chatId: deletion.chatId,
      mimeType: deletion.mimeType,
      sizeBytes: deletion.sizeBytes,
      sha256: deletion.sha256,
    });
    return { status: 204, body: null };
  } catch (error) {
    if (error instanceof ConversationAttachmentStoreError) return unavailable();
    throw error;
  }
}
