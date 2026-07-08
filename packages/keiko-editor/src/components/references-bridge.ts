/**
 * Monaco find-references bridge (Epic #2089, Issue #2104, ADR-0042 D4).
 *
 * Wires Monaco's `registerReferenceProvider` to the host resolver. Monaco supplies the reference
 * context, including whether declarations should be included; the bridge preserves that flag in the
 * content-free request and maps host-resolved workspace locations to Monaco locations.
 */
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorLocation,
  EditorReferencesQuery,
  EditorReferencesRequest,
  EditorReferencesResolver,
  EditorReferencesResponse,
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
import type { MonacoUriForPath, MonacoUriLike } from "./definition-bridge.js";

export interface MonacoReferencesModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoReferenceContext {
  readonly includeDeclaration: boolean;
}

export interface MonacoReferenceLocation {
  readonly uri: MonacoUriLike;
  readonly range: MonacoRange;
}

export interface MonacoReferenceProvider {
  provideReferences(
    model: MonacoReferencesModel,
    position: MonacoPositionLike,
    context: MonacoReferenceContext,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoReferenceLocation[]>;
}

export interface MonacoReferenceRegistrar {
  registerReferenceProvider(
    languageSelector: string | readonly string[],
    provider: MonacoReferenceProvider,
  ): MonacoDisposable;
}

export function referenceToMonacoLocation(
  location: EditorLocation,
  currentModelUri: MonacoUriLike,
  uriForPath: MonacoUriForPath,
): MonacoReferenceLocation {
  return {
    uri: uriForPath(location.path, currentModelUri),
    range: editorRangeToMonaco(location.range),
  };
}

export function referencesResponseToMonaco(
  response: EditorReferencesResponse,
  currentModelUri: MonacoUriLike,
  uriForPath: MonacoUriForPath,
): readonly MonacoReferenceLocation[] {
  return response.locations.map((location) =>
    referenceToMonacoLocation(location, currentModelUri, uriForPath),
  );
}

export interface KeikoReferencesProviderDeps {
  readonly resolve: EditorReferencesResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly uriForPath?: MonacoUriForPath | undefined;
}

function buildRequest(
  deps: KeikoReferencesProviderDeps,
  documentUri: string,
  position: MonacoPositionLike,
  context: MonacoReferenceContext,
  sequence: number,
): EditorReferencesRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    position: monacoPositionToEditor(position),
    includeDeclaration: context.includeDeclaration,
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
const EMPTY_REFERENCES: readonly MonacoReferenceLocation[] = [];

export function createKeikoReferencesProvider(
  deps: KeikoReferencesProviderDeps,
): MonacoReferenceProvider {
  let sequence = 0;
  return {
    async provideReferences(
      model,
      position,
      context,
      token,
    ): Promise<readonly MonacoReferenceLocation[]> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return EMPTY_REFERENCES;
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, position, context, sequence);
      const controller = controllerForToken(token);
      try {
        const query: EditorReferencesQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        return referencesResponseToMonaco(
          response,
          model.uri,
          deps.uriForPath ?? defaultUriForPath,
        );
      } catch {
        return EMPTY_REFERENCES;
      }
    },
  };
}

export interface RegisterKeikoReferencesProviderArgs {
  readonly languages: MonacoReferenceRegistrar;
  readonly resolve: EditorReferencesResolver;
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

export function registerKeikoReferencesProvider(
  args: RegisterKeikoReferencesProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoReferencesProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
      ...(args.uriForPath === undefined ? {} : { uriForPath: args.uriForPath }),
    });
    return args.languages.registerReferenceProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

export const REFERENCES_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
