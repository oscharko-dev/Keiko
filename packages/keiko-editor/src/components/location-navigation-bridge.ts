import { shouldDiscardAgainstLatest } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorDefinitionQuery,
  EditorDefinitionRequest,
  EditorDefinitionResolver,
  EditorDefinitionResponse,
  EditorRequestIdentity,
} from "../types.js";
import {
  classifyResultKind,
  runLanguageBridgeCall,
  type EditorLanguageIntelligenceReporter,
  type EditorLanguageOperation,
} from "./language-intelligence.js";
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
  /**
   * Which Monaco navigation surface this instance serves. Type-definition and implementation share
   * this provider, so the reported operation must name the caller rather than being hard-coded —
   * otherwise a failing "go to implementation" would be surfaced as a definition failure.
   */
  readonly operation: EditorLanguageOperation;
  /** Outcome sink so "no target found" stays distinguishable from "the lookup failed". */
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
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
    provideLocation(model, position, token): Promise<readonly MonacoLocation[] | undefined> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) return Promise.resolve(undefined);
      sequence += 1;
      const request = requestFor(deps, documentUri, position, sequence);
      latest = request.request;
      const query: EditorDefinitionQuery = { request, documentText: model.getValue() };
      const signal = abortControllerFor(token).signal;
      return runLanguageBridgeCall<EditorDefinitionResponse, readonly MonacoLocation[] | undefined>(
        {
          operation: deps.operation,
          resolve: () => deps.resolve(query, signal),
          isDiscarded: (response) => shouldDiscardAgainstLatest(response.request, latest),
          discardedValue: undefined,
          failedValue: EMPTY_LOCATIONS,
          classify: (response) => classifyResultKind(response.locations.length, response.truncated),
          present: (response) =>
            definitionResponseToMonaco(
              response,
              model.uri,
              deps.uriForPath ?? ((_path, uri): MonacoUriLike => uri),
            ),
          report: deps.report,
        },
      );
    },
  };
}
