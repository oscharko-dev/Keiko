import type { IncomingMessage } from "node:http";

import type {
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import {
  authorizePdfCitationPreview,
  getPdfCitationPreviewStatus,
} from "./local-knowledge-preview-service.js";
import { normalizePreviewMarkerIndex } from "./local-knowledge-preview-authority.js";

const MAX_BODY_BYTES = 16_000;

class InvalidRequest extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new InvalidRequest("Request body is too large."));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequest("Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseBaseBody(body: Record<string, unknown>): {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly stableId?: string;
} {
  if (typeof body.chatId !== "string" || body.chatId.trim().length === 0) {
    throw new InvalidRequest("Field \"chatId\" must be a non-empty string.");
  }
  if (
    typeof body.assistantMessageId !== "string" ||
    body.assistantMessageId.trim().length === 0
  ) {
    throw new InvalidRequest("Field \"assistantMessageId\" must be a non-empty string.");
  }
  if (body.stableId !== undefined && typeof body.stableId !== "string") {
    throw new InvalidRequest("Field \"stableId\" must be a string when present.");
  }
  return {
    chatId: body.chatId,
    assistantMessageId: body.assistantMessageId,
    ...(typeof body.stableId === "string" ? { stableId: body.stableId } : {}),
  };
}

function parseMarker(body: Record<string, unknown>, required: boolean): string | number | undefined {
  if (!("marker" in body)) {
    if (required) {
      throw new InvalidRequest("Field \"marker\" is required.");
    }
    return undefined;
  }
  const marker = body.marker;
  if (typeof marker !== "string" && typeof marker !== "number") {
    throw new InvalidRequest("Field \"marker\" must be a string or number.");
  }
  if (normalizePreviewMarkerIndex(marker) === undefined) {
    throw new InvalidRequest("Field \"marker\" must resolve to a positive citation index.");
  }
  return marker;
}

function invalidRequestResult(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

export async function handleGetPdfCitationPreviewStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const base = parseBaseBody(body);
    const marker = parseMarker(body, false);
    const input: PdfCitationPreviewStatusRequest = {
      ...base,
      ...(marker !== undefined ? { marker } : {}),
    };
    return { status: 200, body: getPdfCitationPreviewStatus(deps, input) };
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}

export async function handleAuthorizePdfCitationPreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const base = parseBaseBody(body);
    const marker = parseMarker(body, true);
    const input: PdfCitationPreviewSelection = { ...base, marker: marker ?? "[1]" };
    return { status: 200, body: authorizePdfCitationPreview(deps, input) };
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}
