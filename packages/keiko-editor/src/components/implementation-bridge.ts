import type { EditorLanguageId } from "../languages.js";
import type { EditorDefinitionResolver } from "../types.js";
import type {
  MonacoDisposable,
  MonacoPositionLike,
  MonacoCancellationToken,
} from "./completion-bridge.js";
import type {
  MonacoDefinitionModel,
  MonacoLocation,
  MonacoUriForPath,
} from "./definition-bridge.js";
import { createLocationNavigationProvider } from "./location-navigation-bridge.js";
import {
  composeDisposers,
  type EditorLanguageIntelligenceReporter,
} from "./language-intelligence.js";

export interface MonacoImplementationProvider {
  provideImplementation(
    model: MonacoDefinitionModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoLocation[] | undefined>;
}

export interface MonacoImplementationRegistrar {
  registerImplementationProvider(
    languageSelector: string | readonly string[],
    provider: MonacoImplementationProvider,
  ): MonacoDisposable;
}

export interface RegisterKeikoImplementationProviderArgs {
  readonly languages: MonacoImplementationRegistrar;
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

export function registerKeikoImplementationProvider(
  args: RegisterKeikoImplementationProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const base = createLocationNavigationProvider({
      ...args,
      documentLanguage,
      operation: "implementation",
    });
    return args.languages.registerImplementationProvider(documentLanguage, {
      provideImplementation: (model, position, token) =>
        base.provideLocation(model, position, token),
    });
  });
  return composeDisposers(disposers);
}

export const IMPLEMENTATION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
