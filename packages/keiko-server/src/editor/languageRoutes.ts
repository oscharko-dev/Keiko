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
  MANAGED_LSP_LANGUAGES,
  parseLanguageServiceRequest,
  parseManagedLspSemanticTokenRequest,
  type LanguageProviderDescriptor,
  type LanguageServiceErrorCode,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
  type ManagedLspEffectiveState,
  type ManagedLspLanguage,
  type ManagedLspRuntimeConfiguration,
  type ManagedLspSemanticTokenResponse,
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
  defaultHostLanguageCommandRules,
  HOST_LANGUAGE_PROVIDER_SPECS,
  HOST_LSP_DISABLED_REASON,
} from "./lsp/hostLanguageProviders.js";
import {
  runHostLanguageOperation,
  runHostLanguageSemanticTokens,
  type HostLanguageOperationOptions,
} from "./lsp/hostLanguageOperation.js";
import type { LspSpawnFn } from "./lsp/lspNodeAdapter.js";
import type { ManagedLspControlSnapshot } from "./lsp/managedLspControl.js";
import { managedProviderProtocolConfiguration } from "./lsp/providers/providerConfiguration.js";

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

function redactStringLeaf(value: string, deps: UiHandlerDeps): string {
  const redacted = deps.redactor(value);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
}

function redactedCodeActionsBody(
  outcome: Extract<LanguageServiceOutcome, { kind: "codeActions" }>,
  deps: UiHandlerDeps,
): unknown {
  return {
    operation: outcome.kind,
    result: {
      ...outcome.result,
      actions: outcome.result.actions.map((action) => ({
        ...action,
        title: redactStringLeaf(action.title, deps),
        kind: redactStringLeaf(action.kind, deps),
      })),
    },
  };
}

function outcomeToResult(outcome: LanguageServiceOutcome, deps: UiHandlerDeps): RouteResult {
  if (outcome.kind === "error") {
    return { status: STATUS_BY_CODE[outcome.code], body: errorBody(outcome.code, outcome.message) };
  }
  if (outcome.kind === "codeActions") {
    return { status: 200, body: redactedCodeActionsBody(outcome, deps) };
  }
  const body = successBody(outcome);
  // Edit-bearing results are applied to buffers or reviewed byte-for-byte. Redacting the success
  // envelope would mutate secret-shaped string literals in valid edits; each result was already
  // capped and display strings were sanitized before this boundary, and the route never logs it.
  const editBearing = outcome.kind === "formatting" || outcome.kind === "renameApply";
  return { status: 200, body: editBearing ? body : deps.redactor(body) };
}

export async function handleEditorLanguage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorLanguageRouteOptions = {},
  signalOverride?: AbortSignal,
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
      signalOverride ?? clientAbortSignal(ctx),
      options,
    );
    return outcomeToResult(outcome, deps);
  });
}

export function handleEditorLanguageCapabilities(): RouteResult {
  return { status: 200, body: describeLanguageCapabilities() };
}

function semanticFallback(): ManagedLspSemanticTokenResponse {
  return { schemaVersion: "1", supported: false };
}

export async function handleEditorLanguageSemanticTokens(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorLanguageRouteOptions = {},
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_LANGUAGE_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseManagedLspSemanticTokenRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  return runFilesHandler(async () => {
    const request = parsed.value;
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const overlayAbsolutePath = resolveOverlayPath(root.realRoot, request.document.path);
    const authorization = await managedActivationAuthorization(deps, root.realRoot, "rust");
    if (authorization?.authorized !== true) return { status: 200, body: semanticFallback() };
    const result = await runHostLanguageSemanticTokens(request.document, {
      workspace: workspaceForRoot(root.realRoot),
      processEnv: deps.env,
      commandRules: options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules(),
      overlayAbsolutePath,
      signal: clientAbortSignal(ctx),
      now: options.now,
      ...(options.hostLanguageSpawn === undefined ? {} : { spawn: options.hostLanguageSpawn }),
      ...managedHostOptions(authorization, root.realRoot),
    });
    const response: ManagedLspSemanticTokenResponse =
      result === undefined
        ? semanticFallback()
        : { schemaVersion: "1", supported: true, legend: result.legend, data: result.data };
    return { status: 200, body: response };
  });
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
  const authorization = await managedActivationAuthorization(
    deps,
    realRoot,
    request.document.languageId,
  );
  if (authorization?.authorized === false) {
    return runInProcessLanguageOperation(request, realRoot, overlayAbsolutePath, signal, options);
  }
  const hostOutcome = await runHostLanguageOperation(request, {
    workspace: workspaceForRoot(realRoot),
    processEnv: deps.env,
    commandRules: options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules(),
    overlayAbsolutePath,
    signal,
    limits: options.limits,
    now: options.now,
    ...(options.hostLanguageSpawn !== undefined ? { spawn: options.hostLanguageSpawn } : {}),
    ...managedHostOptions(authorization, realRoot),
  });
  if (hostOutcome !== undefined) {
    return hostOutcome;
  }
  return runInProcessLanguageOperation(request, realRoot, overlayAbsolutePath, signal, options);
}

function runInProcessLanguageOperation(
  request: LanguageServiceRequest,
  realRoot: string,
  overlayAbsolutePath: string,
  signal: AbortSignal,
  options: EditorLanguageRouteOptions,
): LanguageServiceOutcome {
  return runLanguageOperation(request, {
    fs: nodeWorkspaceFs,
    realRoot,
    overlayAbsolutePath,
    signal,
    limits: options.limits,
    now: options.now,
  });
}

const SPAWNABLE_MANAGED_STATES: readonly ManagedLspEffectiveState[] = [
  "available",
  "starting",
  "active",
  "degraded",
  "restartRequired",
];

function snapshotAuthorizesLanguage(
  snapshot: ManagedLspControlSnapshot,
  languageId: string,
): boolean {
  const status = snapshot.languages.find((entry) => entry.ok && entry.language === languageId);
  return status?.ok === true && SPAWNABLE_MANAGED_STATES.includes(status.state);
}

async function managedActivationAuthorization(
  deps: UiHandlerDeps,
  realRoot: string,
  languageId: string,
): Promise<ManagedActivationAuthorization | undefined> {
  if (!HOST_LANGUAGE_PROVIDER_SPECS.some((spec) => spec.languages.includes(languageId))) {
    return undefined;
  }
  if (deps.managedLspControl === undefined) return undefined;
  const language = managedLanguage(languageId);
  if (language === undefined) return { authorized: false };
  const [snapshot, configuration] = await Promise.all([
    deps.managedLspControl.read(realRoot),
    deps.managedLspControl.readConfiguration(realRoot, language),
  ]);
  return {
    authorized: snapshotAuthorizesLanguage(snapshot, languageId),
    ...(configuration === undefined ? {} : { configuration }),
  };
}

interface ManagedActivationAuthorization {
  readonly authorized: boolean;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

function managedHostOptions(
  authorization: ManagedActivationAuthorization | undefined,
  realRoot: string,
): Pick<HostLanguageOperationOptions, "activationAuthorized" | "protocolConfiguration"> {
  if (authorization?.authorized !== true) return {};
  return {
    activationAuthorized: true,
    ...(authorization.configuration === undefined
      ? {}
      : {
          protocolConfiguration: managedProviderProtocolConfiguration(
            authorization.configuration,
            realRoot,
          ),
        }),
  };
}

function managedLanguage(languageId: string): ManagedLspLanguage | undefined {
  return MANAGED_LSP_LANGUAGES.find((language) => language === languageId);
}

function disabledDescriptor(
  spec: (typeof HOST_LANGUAGE_PROVIDER_SPECS)[number],
): LanguageProviderDescriptor {
  return {
    id: spec.id,
    languages: spec.languages,
    operations: spec.operations,
    availability: "unavailable",
    unavailableReason: HOST_LSP_DISABLED_REASON,
  };
}

function controlledDescriptors(
  snapshot: ManagedLspControlSnapshot,
  realRoot: string,
  deps: UiHandlerDeps,
  options: EditorLanguageRouteOptions,
): readonly LanguageProviderDescriptor[] {
  const commandRules = options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules();
  return HOST_LANGUAGE_PROVIDER_SPECS.map((spec) => {
    if (!spec.languages.some((language) => snapshotAuthorizesLanguage(snapshot, language))) {
      return disabledDescriptor(spec);
    }
    return (
      detectHostLanguageProviderDescriptors({
        workspace: workspaceForRoot(realRoot),
        processEnv: deps.env,
        commandRules,
        specs: [spec],
        ignoreActivationFlag: true,
      })[0] ?? disabledDescriptor(spec)
    );
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
    const detected =
      deps.managedLspControl === undefined
        ? detectHostLanguageProviderDescriptors({
            workspace: workspaceForRoot(resolved.realRoot),
            processEnv: deps.env,
            commandRules: options.hostLanguageCommandRules ?? defaultHostLanguageCommandRules(),
          })
        : controlledDescriptors(
            await deps.managedLspControl.read(resolved.realRoot),
            resolved.realRoot,
            deps,
            options,
          );
    return {
      status: 200,
      body: describeLanguageCapabilities(undefined, [
        ...detected,
        ...(options.capabilityDescriptorOverrides ?? []),
      ]),
    };
  });
}
