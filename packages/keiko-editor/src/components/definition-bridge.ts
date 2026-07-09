/**
 * Monaco go-to-definition bridge (Epic #2089, Issue #2104, ADR-0042 D4).
 *
 * Bridges Monaco's `languages.registerDefinitionProvider` to the host-injected resolver. The bridge
 * maps Monaco coordinates to a content-free request, passes the live buffer text to the host, and
 * maps the returned workspace-relative locations back to Monaco locations. It performs no I/O and
 * imports no Monaco value.
 */
import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorDefinitionQuery,
  EditorDefinitionRequest,
  EditorDefinitionResolver,
  EditorDefinitionResponse,
  EditorLocation,
  EditorRequestIdentity,
} from "../types.js";
import {
  editorRangeToMonaco,
  monacoPositionToEditor,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoPositionLike,
  type MonacoRange,
} from "./completion-bridge.js";

export interface MonacoUriLike {
  toString(): string;
}

export interface MonacoDefinitionModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoLocation {
  readonly uri: MonacoUriLike;
  readonly range: MonacoRange;
}

export interface MonacoDefinitionProvider {
  provideDefinition(
    model: MonacoDefinitionModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoLocation[] | undefined>;
}

export interface MonacoDefinitionRegistrar {
  registerDefinitionProvider(
    languageSelector: string | readonly string[],
    provider: MonacoDefinitionProvider,
  ): MonacoDisposable;
}

export type MonacoUriForPath = (path: string, currentModelUri: MonacoUriLike) => MonacoUriLike;

export function locationToMonacoLocation(
  location: EditorLocation,
  currentModelUri: MonacoUriLike,
  uriForPath: MonacoUriForPath,
): MonacoLocation {
  return {
    uri: uriForPath(location.path, currentModelUri),
    range: editorRangeToMonaco(location.range),
  };
}

export function definitionResponseToMonaco(
  response: EditorDefinitionResponse,
  currentModelUri: MonacoUriLike,
  uriForPath: MonacoUriForPath,
): readonly MonacoLocation[] {
  return response.locations.map((location) =>
    locationToMonacoLocation(location, currentModelUri, uriForPath),
  );
}

export interface KeikoDefinitionProviderDeps {
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
}

function buildRequest(
  deps: KeikoDefinitionProviderDeps,
  documentUri: string,
  position: MonacoPositionLike,
  sequence: number,
): EditorDefinitionRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    position: monacoPositionToEditor(position),
  };
}

function controllerForToken(token: MonacoCancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

const defaultUriForPath: MonacoUriForPath = (_path, currentModelUri) => currentModelUri;
const EMPTY_LOCATIONS: readonly MonacoLocation[] = [];

export function createKeikoDefinitionProvider(
  deps: KeikoDefinitionProviderDeps,
): MonacoDefinitionProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  return {
    async provideDefinition(
      model,
      position,
      token,
    ): Promise<readonly MonacoLocation[] | undefined> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return undefined;
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, position, sequence);
      latest = request.request;
      const controller = controllerForToken(token);
      try {
        const query: EditorDefinitionQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        if (shouldDiscardResponse(response.request, latest)) {
          return undefined;
        }
        return definitionResponseToMonaco(
          response,
          model.uri,
          deps.uriForPath ?? defaultUriForPath,
        );
      } catch {
        return EMPTY_LOCATIONS;
      }
    },
  };
}

export interface RegisterKeikoDefinitionProviderArgs {
  readonly languages: MonacoDefinitionRegistrar;
  readonly resolve: EditorDefinitionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
}

function composeDisposers(disposers: readonly MonacoDisposable[]): MonacoDisposable {
  return {
    dispose(): void {
      for (const disposer of disposers) {
        disposer.dispose();
      }
    },
  };
}

export function registerKeikoDefinitionProvider(
  args: RegisterKeikoDefinitionProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoDefinitionProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
      ...(args.uriForPath === undefined ? {} : { uriForPath: args.uriForPath }),
    });
    return args.languages.registerDefinitionProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

export const DEFINITION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
