// The deterministic language-service orchestrator (Issue #1198, ADR-0042 D4). It is the single
// governed, model-free entry point: it resolves the request's language to a provider, enforces the
// document-size and wall-clock bounds, runs the requested operation under a deadline/abort
// cancellation token, and sanitises every result for browser display. It never calls a model and
// never routes through the Model Gateway. Provider registration is the only thing that changes to
// add a language (#1213), so this orchestrator stays language-agnostic.

import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageCompletionResult,
  type LanguageDiagnosticsResult,
  type LanguageHoverResult,
  type LanguageServiceCapabilities,
  type LanguageServiceErrorCode,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
  type LanguageSymbolResult,
  LANGUAGE_SERVICE_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { createDeadlineCancellation, isCancellation } from "./languageCancellation.js";
import {
  createLanguageProviderRegistry,
  type LanguageProvider,
  type LanguageProviderContext,
  type LanguageProviderRegistry,
} from "./languageProvider.js";
import { createTypescriptLanguageProvider } from "./typescriptLanguageProvider.js";
import {
  sanitizeCompletion,
  sanitizeDiagnostics,
  sanitizeHover,
  sanitizeSymbols,
} from "./languageSanitize.js";

// The default registry: TypeScript/JavaScript only for the first release. Providers are stateless
// and deterministic, so a single shared instance is safe.
const defaultRegistry = createLanguageProviderRegistry([createTypescriptLanguageProvider()]);

export function languageServiceRegistry(): LanguageProviderRegistry {
  return defaultRegistry;
}

export function describeLanguageCapabilities(
  registry: LanguageProviderRegistry = defaultRegistry,
): LanguageServiceCapabilities {
  return {
    schemaVersion: LANGUAGE_SERVICE_SCHEMA_VERSION,
    providers: registry.describe(),
  };
}

export type LanguageServiceOutcome =
  | { readonly kind: "diagnostics"; readonly result: LanguageDiagnosticsResult }
  | { readonly kind: "completion"; readonly result: LanguageCompletionResult }
  | { readonly kind: "hover"; readonly result: LanguageHoverResult }
  | { readonly kind: "symbols"; readonly result: LanguageSymbolResult }
  | { readonly kind: "error"; readonly code: LanguageServiceErrorCode; readonly message: string };

export interface RunLanguageOperationOptions {
  readonly fs: WorkspaceFs;
  // Symlink-resolved absolute workspace root; the route proves containment before calling.
  readonly realRoot: string;
  // Absolute path of the overlay file, already proven contained inside `realRoot`.
  readonly overlayAbsolutePath: string;
  readonly limits?: LanguageServiceLimits | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  readonly registry?: LanguageProviderRegistry | undefined;
}

function errorOutcome(code: LanguageServiceErrorCode, message: string): LanguageServiceOutcome {
  return { kind: "error", code, message };
}

function runOperation(
  request: LanguageServiceRequest,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  switch (request.operation) {
    case "diagnostics":
      return {
        kind: "diagnostics",
        result: sanitizeDiagnostics(provider.getDiagnostics(ctx), limits),
      };
    case "completion":
      return {
        kind: "completion",
        result: sanitizeCompletion(provider.getCompletions(ctx, request.position), limits),
      };
    case "hover":
      return {
        kind: "hover",
        result: sanitizeHover(provider.getHover(ctx, request.position), limits),
      };
    case "symbols":
      return { kind: "symbols", result: sanitizeSymbols(provider.getSymbols(ctx), limits) };
  }
}

export function runLanguageOperation(
  request: LanguageServiceRequest,
  options: RunLanguageOperationOptions,
): LanguageServiceOutcome {
  const limits = options.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;
  const registry = options.registry ?? defaultRegistry;
  if (Buffer.byteLength(request.document.text, "utf8") > limits.maxDocumentBytes) {
    return errorOutcome("DOCUMENT_TOO_LARGE", "The document exceeds the analysis size limit.");
  }
  const provider = registry.resolve(request.document.languageId);
  if (provider === undefined) {
    return errorOutcome("UNSUPPORTED_LANGUAGE", "No deterministic provider serves this language.");
  }
  if (!provider.descriptor.operations.includes(request.operation)) {
    return errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.");
  }
  const cancellation = createDeadlineCancellation({
    signal: options.signal,
    deadlineMs: limits.deadlineMs,
    now: options.now,
  });
  const ctx: LanguageProviderContext = {
    fs: options.fs,
    root: options.realRoot,
    overlayPath: options.overlayAbsolutePath,
    overlayText: request.document.text,
    languageId: request.document.languageId,
    limits,
    cancellation,
  };
  try {
    cancellation.throwIfCancellationRequested();
    return runOperation(request, provider, ctx, limits);
  } catch (error) {
    if (isCancellation(error)) {
      return cancellation.reason() === "timeout"
        ? errorOutcome("TIMED_OUT", "Analysis exceeded the time budget.")
        : errorOutcome("CANCELLED", "The request was cancelled.");
    }
    throw error;
  }
}
