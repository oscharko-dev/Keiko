// BFF routes for the deterministic language service (Issue #1198, ADR-0042 D4). `POST
// /api/editor/language` runs one governed, model-free operation (diagnostics, completion, hover, or
// symbols) over an in-editor overlay; `GET /api/editor/language/capabilities` advertises the
// registered providers so the editor can feature-detect. Workspace-root containment reuses the same
// realpath + deny-list resolution as the files routes (`resolveRoot`), and the overlay path is
// proven contained before any analysis runs. The success payload is redacted (D9) and the body is
// already length-capped and control-character-stripped by the orchestrator.

import { isAbsolute, resolve } from "node:path";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  parseLanguageServiceRequest,
  type LanguageServiceErrorCode,
} from "@oscharko-dev/keiko-contracts";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import { describeLanguageCapabilities, runLanguageOperation } from "./languageService.js";
import type { LanguageServiceOutcome } from "./languageService.js";

// The overlay buffer may be up to the document-size cap; allow 64 KiB of JSON envelope on top.
const MAX_LANGUAGE_BODY_BYTES = DEFAULT_LANGUAGE_SERVICE_LIMITS.maxDocumentBytes + 64 * 1024;

// Exported for reuse by the completion route (#1199), which maps the same deterministic
// language-service error codes to HTTP status.
export const STATUS_BY_CODE: Readonly<Record<LanguageServiceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_LANGUAGE: 422,
  UNSUPPORTED_OPERATION: 422,
  DOCUMENT_TOO_LARGE: 413,
  DENIED: 403,
  TIMED_OUT: 503,
  CANCELLED: 499,
};

function denied(): FilesError {
  return new FilesError(403, "DENIED", DENIED_MESSAGE);
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

// Resolves the overlay's absolute path and proves it is contained in the workspace root. An absolute
// or escaping path, a symlink that escapes, or a denied segment (.git/.ssh/credentials) is rejected
// before any file is read. Exported for reuse by the completion route (#1199).
export function resolveOverlayPath(realRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath) || pathIsDenied(relativePath)) {
    throw denied();
  }
  const overlayAbsolute = resolve(realRoot, relativePath);
  try {
    containedRealPathInfo(nodeWorkspaceFs, realRoot, overlayAbsolute);
  } catch {
    throw denied();
  }
  return overlayAbsolute;
}

// Exported for reuse by the completion route (#1199): aborts in-flight analysis when the client
// disconnects.
export function clientAbortSignal(ctx: RouteContext): AbortSignal {
  const controller = new AbortController();
  ctx.req.on("close", () => {
    controller.abort();
  });
  if (typeof ctx.res.on === "function") {
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) {
        controller.abort();
      }
    });
  }
  return controller.signal;
}

function successBody(outcome: Exclude<LanguageServiceOutcome, { kind: "error" }>): unknown {
  return { operation: outcome.kind, result: outcome.result };
}

function outcomeToResult(outcome: LanguageServiceOutcome, deps: UiHandlerDeps): RouteResult {
  if (outcome.kind === "error") {
    return { status: STATUS_BY_CODE[outcome.code], body: errorBody(outcome.code, outcome.message) };
  }
  return { status: 200, body: deps.redactor(successBody(outcome)) };
}

export async function handleEditorLanguage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_LANGUAGE_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseLanguageServiceRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const overlayAbsolutePath = resolveOverlayPath(root.realRoot, request.document.path);
    const outcome = runLanguageOperation(request, {
      fs: nodeWorkspaceFs,
      realRoot: root.realRoot,
      overlayAbsolutePath,
      signal: clientAbortSignal(ctx),
    });
    return outcomeToResult(outcome, deps);
  });
}

export function handleEditorLanguageCapabilities(): RouteResult {
  return { status: 200, body: describeLanguageCapabilities() };
}
