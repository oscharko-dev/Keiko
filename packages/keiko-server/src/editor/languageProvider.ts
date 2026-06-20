// Provider abstraction for the deterministic language service (Issue #1198, Review Addendum 2). A
// provider is a deterministic, model-free language-intelligence backend bound to a set of
// `languageId`s. TypeScript/JavaScript is the first provider; the staged LSP expansion for
// Java/Python/Rust/Go (#1213) registers further providers without any contract change. The registry
// resolves a request's `languageId` to the provider that serves it.

import type {
  LanguageCompletionResult,
  LanguageDiagnostic,
  LanguageDocumentSymbol,
  LanguageFormattingOptions,
  LanguageHoverResult,
  LanguagePosition,
  LanguageProviderDescriptor,
  LanguageServiceLimits,
  LanguageTextEdit,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { LanguageCancellation } from "./languageCancellation.js";

// Everything a provider needs to analyse one document. `root` and `overlayPath` are already
// symlink-resolved and proven contained by the route; `overlayText` is the unsaved buffer. All
// filesystem access goes through the audited `fs` port so reads stay inside the workspace root.
export interface LanguageProviderContext {
  readonly fs: WorkspaceFs;
  readonly root: string;
  readonly overlayPath: string;
  readonly overlayText: string;
  readonly languageId: string;
  readonly limits: LanguageServiceLimits;
  readonly cancellation: LanguageCancellation;
}

// Providers return count-capped results (using `ctx.limits`) so mapping stays bounded; the
// orchestrator additionally sanitises every string before it reaches the browser.
export interface LanguageProvider {
  readonly descriptor: LanguageProviderDescriptor;
  supports(languageId: string): boolean;
  getDiagnostics(ctx: LanguageProviderContext): LanguageDiagnosticsRaw;
  getCompletions(
    ctx: LanguageProviderContext,
    position: LanguagePosition,
  ): LanguageCompletionResult;
  getHover(ctx: LanguageProviderContext, position: LanguagePosition): LanguageHoverResult;
  getSymbols(ctx: LanguageProviderContext): LanguageSymbolsRaw;
  // Returns the reformatting edits an explicit "format document" command applies (Issue #1201).
  // `options` carries the caller's indentation preferences; the provider falls back to its language
  // default for any absent field. Edits are non-overlapping so the editor can apply them directly.
  getFormatting(
    ctx: LanguageProviderContext,
    options: LanguageFormattingOptions | undefined,
  ): LanguageFormattingRaw;
}

export interface LanguageDiagnosticsRaw {
  readonly diagnostics: readonly LanguageDiagnostic[];
  readonly truncated: boolean;
}

export interface LanguageSymbolsRaw {
  readonly symbols: readonly LanguageDocumentSymbol[];
  readonly truncated: boolean;
}

export interface LanguageFormattingRaw {
  readonly edits: readonly LanguageTextEdit[];
  readonly truncated: boolean;
}

export interface LanguageProviderRegistry {
  resolve(languageId: string): LanguageProvider | undefined;
  describe(): readonly LanguageProviderDescriptor[];
}

export function createLanguageProviderRegistry(
  providers: readonly LanguageProvider[],
): LanguageProviderRegistry {
  return {
    resolve: (languageId: string): LanguageProvider | undefined =>
      providers.find((provider) => provider.supports(languageId)),
    describe: (): readonly LanguageProviderDescriptor[] =>
      providers.map((provider) => provider.descriptor),
  };
}
