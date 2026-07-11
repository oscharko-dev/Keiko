import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorDefinitionQuery,
  EditorDefinitionRequest,
  EditorDefinitionResolver,
  EditorRequestIdentity,
} from "../types.js";
import {
  definitionResponseToMonaco,
  type MonacoDefinitionModel,
  type MonacoLocation,
  type MonacoUriLike,
  type MonacoUriForPath,
} from "./definition-bridge.js";
import {
  monacoPositionToEditor,
  type MonacoCancellationToken,
  type MonacoPositionLike,
} from "./completion-bridge.js";

export interface LocationNavigationProvider {
  provideLocation(
    model: MonacoDefinitionModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoLocation[] | undefined>;
}

export interface LocationNavigationProviderDeps {
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
}

function requestFor(
  deps: LocationNavigationProviderDeps,
  documentUri: string,
  position: MonacoPositionLike,
  sequence: number,
): EditorDefinitionRequest {
  return {
    request: { requestId: deps.newRequestId(), streamId: deps.streamId, sequence },
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    position: monacoPositionToEditor(position),
  };
}

function abortControllerFor(token: MonacoCancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

const EMPTY_LOCATIONS: readonly MonacoLocation[] = [];

export function createLocationNavigationProvider(
  deps: LocationNavigationProviderDeps,
): LocationNavigationProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  return {
    async provideLocation(model, position, token): Promise<readonly MonacoLocation[] | undefined> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) return undefined;
      sequence += 1;
      const request = requestFor(deps, documentUri, position, sequence);
      latest = request.request;
      try {
        const query: EditorDefinitionQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, abortControllerFor(token).signal);
        if (shouldDiscardResponse(response.request, latest)) return undefined;
        return definitionResponseToMonaco(
          response,
          model.uri,
          deps.uriForPath ?? ((_path, uri): MonacoUriLike => uri),
        );
      } catch {
        return EMPTY_LOCATIONS;
      }
    },
  };
}
