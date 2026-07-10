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

export interface MonacoTypeDefinitionProvider {
  provideTypeDefinition(
    model: MonacoDefinitionModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoLocation[] | undefined>;
}

export interface MonacoTypeDefinitionRegistrar {
  registerTypeDefinitionProvider(
    languageSelector: string | readonly string[],
    provider: MonacoTypeDefinitionProvider,
  ): MonacoDisposable;
}

export interface RegisterKeikoTypeDefinitionProviderArgs {
  readonly languages: MonacoTypeDefinitionRegistrar;
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
}

export function registerKeikoTypeDefinitionProvider(
  args: RegisterKeikoTypeDefinitionProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const base = createLocationNavigationProvider({ ...args, documentLanguage });
    return args.languages.registerTypeDefinitionProvider(documentLanguage, {
      provideTypeDefinition: (model, position, token) =>
        base.provideLocation(model, position, token),
    });
  });
  return {
    dispose(): void {
      disposers.forEach((disposer) => {
        disposer.dispose();
      });
    },
  };
}

export const TYPE_DEFINITION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
