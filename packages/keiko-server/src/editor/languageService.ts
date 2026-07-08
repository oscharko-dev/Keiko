// The deterministic language-service orchestrator (Issue #1198, ADR-0042 D4). It is the single
// governed, model-free entry point: it resolves the request's language to a provider, enforces the
// document-size and wall-clock bounds, runs the requested operation under a deadline/abort
// cancellation token, and sanitises every result for browser display. It never calls a model and
// never routes through the Model Gateway. Provider registration is the only thing that changes to
// add a language (#1213), so this orchestrator stays language-agnostic.

import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageCodeActionsResult,
  type LanguageCompletionResult,
  type LanguageDefinitionResult,
  type LanguageDiagnosticsResult,
  type LanguageFormattingResult,
  type LanguageHoverResult,
  type LanguageServiceCapabilities,
  type LanguageServiceErrorCode,
  type LanguageProviderDescriptor,
  type LanguageReferencesResult,
  type LanguageRenameApplyResult,
  type LanguageRenamePrepareResult,
  type LanguageServiceLimits,
  type LanguageServiceRequest,
  type LanguageSignatureHelpResult,
  type LanguageSymbolResult,
  EDITOR_LANGUAGE_MODE_IDS,
  LANGUAGE_SERVICE_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { createDeadlineCancellation, isCancellation } from "./languageCancellation.js";
import {
  createLanguageProviderRegistry,
  type LanguageProvider,
  type LanguageProviderFailure,
  type LanguageProviderContext,
  type LanguageProviderRegistry,
} from "./languageProvider.js";
import { createTypescriptLanguageProvider } from "./typescriptLanguageProvider.js";
import {
  createBuiltinTextLanguageProvider,
  createJsonLanguageProvider,
  unavailableExternalLspDescriptors,
} from "./builtinLanguageProviders.js";
import {
  sanitizeCompletion,
  sanitizeCodeActions,
  sanitizeDefinition,
  sanitizeDiagnostics,
  sanitizeFormatting,
  sanitizeHover,
  sanitizeReferences,
  sanitizeRenameApply,
  sanitizeRenamePrepare,
  sanitizeSignatureHelp,
  sanitizeSymbols,
} from "./languageSanitize.js";

// Providers are stateless and deterministic, so a single shared instance is safe. External LSP
// descriptors are advertised as unavailable until a workspace-contained executable is configured.
const defaultRegistry = createLanguageProviderRegistry(
  [
    createTypescriptLanguageProvider(),
    createJsonLanguageProvider(),
    createBuiltinTextLanguageProvider(),
  ],
  unavailableExternalLspDescriptors(),
);

export function languageServiceRegistry(): LanguageProviderRegistry {
  return defaultRegistry;
}

// Issue #1379 AC2 (ADR-0067 D3) — the content-free reason advertised for a known mode-map language
// that no registered provider serves. Distinct from the external-LSP "no executable configured"
// reason: this language has no provider at all, real or unavailable.
export const NO_PROVIDER_UNAVAILABLE_REASON =
  "No language provider is configured for this language." as const;

// Issue #1379 AC2 (ADR-0067 D3) — exhaustive over the canonical mode-map universe. We project the
// registered descriptors (available providers + unavailable external LSP descriptors), then append a
// synthetic `unavailable` descriptor for every known mode-map language that no descriptor already
// covers. After this, `providerForLanguage` returns a descriptor for EVERY known language id, never
// null, so AC2 holds at the registry layer rather than by UI patching. The synthesis is additive and
// read-only — it changes no operation-execution path. `runLanguageOperation` is untouched: an
// unmatched/unavailable language still yields UNSUPPORTED_LANGUAGE (AC3).
export function describeLanguageCapabilities(
  registry: LanguageProviderRegistry = defaultRegistry,
  descriptorOverrides: readonly LanguageProviderDescriptor[] = [],
): LanguageServiceCapabilities {
  const overridesById = new Map(
    descriptorOverrides.map((descriptor) => [descriptor.id, descriptor]),
  );
  const descriptors = registry
    .describe()
    .map((descriptor) => overridesById.get(descriptor.id) ?? descriptor);
  for (const descriptor of descriptorOverrides) {
    if (!descriptors.some((entry) => entry.id === descriptor.id)) {
      descriptors.push(descriptor);
    }
  }
  const covered = new Set<string>();
  for (const descriptor of descriptors) {
    for (const language of descriptor.languages) {
      covered.add(language);
    }
  }
  const synthesized: LanguageProviderDescriptor[] = [];
  for (const languageId of EDITOR_LANGUAGE_MODE_IDS) {
    if (covered.has(languageId)) continue;
    synthesized.push({
      id: "none",
      languages: [languageId],
      operations: [],
      availability: "unavailable",
      unavailableReason: NO_PROVIDER_UNAVAILABLE_REASON,
    });
  }
  return {
    schemaVersion: LANGUAGE_SERVICE_SCHEMA_VERSION,
    providers: [...descriptors, ...synthesized],
  };
}

export type LanguageServiceOutcome =
  | { readonly kind: "diagnostics"; readonly result: LanguageDiagnosticsResult }
  | { readonly kind: "completion"; readonly result: LanguageCompletionResult }
  | { readonly kind: "hover"; readonly result: LanguageHoverResult }
  | { readonly kind: "symbols"; readonly result: LanguageSymbolResult }
  | { readonly kind: "formatting"; readonly result: LanguageFormattingResult }
  | { readonly kind: "definition"; readonly result: LanguageDefinitionResult }
  | { readonly kind: "references"; readonly result: LanguageReferencesResult }
  | { readonly kind: "renamePrepare"; readonly result: LanguageRenamePrepareResult }
  | { readonly kind: "renameApply"; readonly result: LanguageRenameApplyResult }
  | { readonly kind: "codeActions"; readonly result: LanguageCodeActionsResult }
  | { readonly kind: "signatureHelp"; readonly result: LanguageSignatureHelpResult }
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

function isProviderFailure(value: unknown): value is LanguageProviderFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "error" &&
    "code" in value &&
    "message" in value
  );
}

type CoreLanguageServiceRequest = Extract<
  LanguageServiceRequest,
  { operation: "diagnostics" | "completion" | "hover" | "symbols" | "formatting" }
>;

type ExtendedLanguageServiceRequest = Exclude<LanguageServiceRequest, CoreLanguageServiceRequest>;

const CORE_OPERATIONS = new Set<string>([
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
]);

function isCoreRequest(request: LanguageServiceRequest): request is CoreLanguageServiceRequest {
  return CORE_OPERATIONS.has(request.operation);
}

function runCoreOperation(
  request: CoreLanguageServiceRequest,
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
    case "formatting":
      return {
        kind: "formatting",
        result: sanitizeFormatting(provider.getFormatting(ctx, request.options), limits),
      };
  }
}

function runDefinitionOperation(
  request: Extract<LanguageServiceRequest, { operation: "definition" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return provider.getDefinition === undefined
    ? errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.")
    : {
        kind: "definition",
        result: sanitizeDefinition(provider.getDefinition(ctx, request.position), limits),
      };
}

function runReferencesOperation(
  request: Extract<LanguageServiceRequest, { operation: "references" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return provider.getReferences === undefined
    ? errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.")
    : {
        kind: "references",
        result: sanitizeReferences(provider.getReferences(ctx, request.position), limits),
      };
}

function runRenamePrepareOperation(
  request: Extract<LanguageServiceRequest, { operation: "renamePrepare" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return provider.getRenamePrepare === undefined
    ? errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.")
    : {
        kind: "renamePrepare",
        result: sanitizeRenamePrepare(provider.getRenamePrepare(ctx, request.position), limits),
      };
}

function runRenameApplyOperation(
  request: Extract<LanguageServiceRequest, { operation: "renameApply" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  if (provider.getRenameApply === undefined) {
    return errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.");
  }
  const result = provider.getRenameApply(ctx, request.position, request.newName);
  return isProviderFailure(result)
    ? errorOutcome(result.code, result.message)
    : { kind: "renameApply", result: sanitizeRenameApply(result, limits) };
}

function runCodeActionsOperation(
  request: Extract<LanguageServiceRequest, { operation: "codeActions" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return provider.getCodeActions === undefined
    ? errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.")
    : {
        kind: "codeActions",
        result: sanitizeCodeActions(
          provider.getCodeActions(ctx, request.range, request.diagnostics),
          limits,
        ),
      };
}

function runSignatureHelpOperation(
  request: Extract<LanguageServiceRequest, { operation: "signatureHelp" }>,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return provider.getSignatureHelp === undefined
    ? errorOutcome("UNSUPPORTED_OPERATION", "The provider does not serve this operation.")
    : {
        kind: "signatureHelp",
        result: sanitizeSignatureHelp(provider.getSignatureHelp(ctx, request.position), limits),
      };
}

function runExtendedOperation(
  request: ExtendedLanguageServiceRequest,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  switch (request.operation) {
    case "definition":
      return runDefinitionOperation(request, provider, ctx, limits);
    case "references":
      return runReferencesOperation(request, provider, ctx, limits);
    case "renamePrepare":
      return runRenamePrepareOperation(request, provider, ctx, limits);
    case "renameApply":
      return runRenameApplyOperation(request, provider, ctx, limits);
    case "codeActions":
      return runCodeActionsOperation(request, provider, ctx, limits);
    case "signatureHelp":
      return runSignatureHelpOperation(request, provider, ctx, limits);
  }
}

function runOperation(
  request: LanguageServiceRequest,
  provider: LanguageProvider,
  ctx: LanguageProviderContext,
  limits: LanguageServiceLimits,
): LanguageServiceOutcome {
  return isCoreRequest(request)
    ? runCoreOperation(request, provider, ctx, limits)
    : runExtendedOperation(request, provider, ctx, limits);
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
