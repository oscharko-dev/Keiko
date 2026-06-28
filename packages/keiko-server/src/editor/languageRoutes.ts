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
  type LanguageProviderDescriptor,
  type LanguageServiceErrorCode,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
} from "@oscharko-dev/keiko-contracts";
import type { CommandRule } from "@oscharko-dev/keiko-tools";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { FilesError, readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { DENIED_MESSAGE, pathIsDenied } from "../files-deny.js";
import { describeLanguageCapabilities, runLanguageOperation } from "./languageService.js";
import type { LanguageServiceOutcome } from "./languageService.js";
import {
  detectHostLanguageProviderDescriptors,
  HOST_LANGUAGE_PROVIDER_SPECS,
} from "./lsp/hostLanguageProviders.js";
import { runHostLanguageOperation } from "./lsp/hostLanguageOperation.js";
import type { LspSpawnFn } from "./lsp/lspNodeAdapter.js";

// The overlay buffer may be up to the document-size cap; allow 64 KiB of JSON envelope on top.
const MAX_LANGUAGE_BODY_BYTES = DEFAULT_LANGUAGE_SERVICE_LIMITS.maxDocumentBytes + 64 * 1024;

export interface EditorLanguageRouteOptions {
  /** Test-only deterministic limits seam; production keeps the default deadline. */
  readonly limits?: LanguageServiceLimits | undefined;
  /** Test-only deterministic clock seam; production keeps the real clock. */
  readonly now?: (() => number) | undefined;
  /** Test-only provider descriptor override seam for capabilities route coverage. */
  readonly capabilityDescriptorOverrides?: readonly LanguageProviderDescriptor[] | undefined;
  /** Test-only command-policy seam for host-provider detection. */
  readonly hostLanguageCommandRules?: readonly CommandRule[] | undefined;
  /** Test-only LSP spawn seam for host-provider operation coverage. */
  readonly hostLanguageSpawn?: LspSpawnFn | undefined;
}

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
  const body = successBody(outcome);
  // Formatting edits are applied to the user's buffer, not displayed. Redacting the success envelope
  // would mutate secret-shaped string literals in valid format edits; the formatter result was
  // already capped by `sanitizeFormatting`, and the route never logs it.
  return { status: 200, body: outcome.kind === "formatting" ? body : deps.redactor(body) };
}

export async function handleEditorLanguage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorLanguageRouteOptions = {},
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
    const outcome = await runEditorLanguageOperation(
      request,
      deps,
      root.realRoot,
      overlayAbsolutePath,
      clientAbortSignal(ctx),
      options,
    );
    return outcomeToResult(outcome, deps);
  });
}

export function handleEditorLanguageCapabilities(): RouteResult {
  return { status: 200, body: describeLanguageCapabilities() };
}

function defaultHostLanguageCommandRules(): readonly CommandRule[] {
  const names = new Set<string>();
  for (const spec of HOST_LANGUAGE_PROVIDER_SPECS) {
    names.add(spec.executableName);
    for (const executable of spec.requiredExecutables) names.add(executable);
  }
  return [...names].sort().map((executable) => ({ executable }));
}

function workspaceForRoot(
  realRoot: string,
): Parameters<typeof detectHostLanguageProviderDescriptors>[0]["workspace"] {
  return {
    root: realRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

export async function runEditorLanguageOperation(
  request: LanguageServiceRequest,
  deps: UiHandlerDeps,
  realRoot: string,
  overlayAbsolutePath: string,
  signal: AbortSignal,
  options: EditorLanguageRouteOptions = {},
): Promise<LanguageServiceOutcome> {
  const hostOutcome = await runHostLanguageOperation(request, {
    workspace: workspaceForRoot(realRoot),
    processEnv: deps.env,
    commandRules: options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules(),
    overlayAbsolutePath,
    signal,
    limits: options.limits,
    now: options.now,
    ...(options.hostLanguageSpawn !== undefined ? { spawn: options.hostLanguageSpawn } : {}),
  });
  if (hostOutcome !== undefined) {
    return hostOutcome;
  }
  return runLanguageOperation(request, {
    fs: nodeWorkspaceFs,
    realRoot,
    overlayAbsolutePath,
    signal,
    limits: options.limits,
    now: options.now,
  });
}

export async function handleEditorLanguageCapabilitiesForRoute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorLanguageRouteOptions = {},
): Promise<RouteResult> {
  const root = ctx.url.searchParams.get("root")?.trim() ?? "";
  if (root.length === 0) {
    return {
      status: 200,
      body: describeLanguageCapabilities(undefined, options.capabilityDescriptorOverrides),
    };
  }
  return runFilesHandler(async () => {
    const resolved = await resolveRoot(deps.store, root, deps.redactor);
    const detected = detectHostLanguageProviderDescriptors({
      workspace: workspaceForRoot(resolved.realRoot),
      processEnv: deps.env,
      commandRules: options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules(),
    });
    return {
      status: 200,
      body: describeLanguageCapabilities(undefined, [
        ...detected,
        ...(options.capabilityDescriptorOverrides ?? []),
      ]),
    };
  });
}
