// Adapts a managed LSP process into a `LanguageProvider` whose descriptor reflects the manager's live
// status (Issue #1381, ADR-0069 D5). This foundation ships no real provider: the language-intelligence
// operations return empty, non-truncated results and the descriptor is the sole governed surface —
// `describeLanguageCapabilities()` consumes `descriptor.availability` unchanged. A future per-language
// issue replaces these stubs with real LSP request mappings.

import { lspStatusToProviderDescriptor } from "@oscharko-dev/keiko-contracts";
import type {
  LanguageProviderDescriptor,
  LanguageServiceOperation,
  LspProcessStatus,
} from "@oscharko-dev/keiko-contracts";
import type {
  LanguageDiagnosticsRaw,
  LanguageFormattingRaw,
  LanguageProvider,
  LanguageSymbolsRaw,
} from "../languageProvider.js";
import type { LanguageCompletionResult, LanguageHoverResult } from "@oscharko-dev/keiko-contracts";

export interface LspManagerLanguageProvider extends LanguageProvider {
  readonly descriptor: LanguageProviderDescriptor;
}

const EMPTY_DIAGNOSTICS: LanguageDiagnosticsRaw = { diagnostics: [], truncated: false };
const EMPTY_SYMBOLS: LanguageSymbolsRaw = { symbols: [], truncated: false };
const EMPTY_FORMATTING: LanguageFormattingRaw = { edits: [], truncated: false };
const EMPTY_COMPLETION: LanguageCompletionResult = {
  items: [],
  isIncomplete: false,
  truncated: false,
};
const EMPTY_HOVER: LanguageHoverResult = { contents: null };

export function buildLanguageProvider(
  managerId: string,
  languages: readonly string[],
  operations: readonly LanguageServiceOperation[],
  getStatus: () => LspProcessStatus,
): LspManagerLanguageProvider {
  const supported = new Set(languages);
  return {
    get descriptor(): LanguageProviderDescriptor {
      return lspStatusToProviderDescriptor(managerId, languages, operations, getStatus());
    },
    supports: (languageId: string): boolean => supported.has(languageId),
    getDiagnostics: (): LanguageDiagnosticsRaw => EMPTY_DIAGNOSTICS,
    getCompletions: (): LanguageCompletionResult => EMPTY_COMPLETION,
    getHover: (): LanguageHoverResult => EMPTY_HOVER,
    getSymbols: (): LanguageSymbolsRaw => EMPTY_SYMBOLS,
    getFormatting: (): LanguageFormattingRaw => EMPTY_FORMATTING,
  };
}
