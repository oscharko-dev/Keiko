import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type { EditorPosition, EditorRange, EditorRequestIdentity } from "../types.js";
import type {
  MonacoCancellationToken,
  MonacoDisposable,
  MonacoPositionLike,
  MonacoRange,
} from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";

export type EditorInlayHintKind = "type" | "parameter" | "enum";

export interface EditorInlayHint {
  readonly position: EditorPosition;
  readonly label: string;
  readonly kind: EditorInlayHintKind;
  readonly paddingLeft?: boolean | undefined;
  readonly paddingRight?: boolean | undefined;
}

export interface EditorInlayHintsRequest {
  readonly request: EditorRequestIdentity;
  readonly document: {
    readonly uri: string;
    readonly language: EditorLanguageId;
    readonly version: number;
  };
  readonly range: EditorRange;
}

export interface EditorInlayHintsQuery {
  readonly request: EditorInlayHintsRequest;
  readonly documentText: string;
}

export interface EditorInlayHintsResponse {
  readonly request: EditorRequestIdentity;
  readonly hints: readonly EditorInlayHint[];
}

export type EditorInlayHintsResolver = (
  query: EditorInlayHintsQuery,
  signal: AbortSignal,
) => Promise<EditorInlayHintsResponse>;

export interface MonacoInlayHintsModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoInlayHint {
  readonly label: string;
  readonly position: MonacoPositionLike;
  readonly kind: 1 | 2;
  readonly paddingLeft: boolean;
  readonly paddingRight: boolean;
}

export interface MonacoInlayHintList {
  readonly hints: readonly MonacoInlayHint[];
  dispose(): void;
}

export interface MonacoInlayHintsProvider {
  provideInlayHints(
    model: MonacoInlayHintsModel,
    range: MonacoRange,
    token: MonacoCancellationToken,
  ): Promise<MonacoInlayHintList | undefined>;
}

export interface MonacoInlayHintsRegistrar {
  registerInlayHintsProvider(
    languageSelector: string | readonly string[],
    provider: MonacoInlayHintsProvider,
  ): MonacoDisposable;
}

export interface KeikoInlayHintsProviderDeps {
  readonly resolve: EditorInlayHintsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
}

function editorRange(range: MonacoRange): EditorRange {
  return {
    start: { line: range.startLineNumber - 1, column: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, column: range.endColumn - 1 },
  };
}

function controllerFor(token: MonacoCancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

function toMonacoHint(hint: EditorInlayHint): MonacoInlayHint {
  return {
    label: hint.label,
    position: { lineNumber: hint.position.line + 1, column: hint.position.column + 1 },
    kind: hint.kind === "parameter" ? 2 : 1,
    paddingLeft: hint.paddingLeft ?? false,
    paddingRight: hint.paddingRight ?? false,
  };
}

export function createKeikoInlayHintsProvider(
  deps: KeikoInlayHintsProviderDeps,
): MonacoInlayHintsProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  return {
    async provideInlayHints(model, range, token): Promise<MonacoInlayHintList | undefined> {
      const uri = model.uri.toString();
      if (!deps.isCurrentDocument(uri)) return undefined;
      sequence += 1;
      const identity = { requestId: deps.newRequestId(), streamId: deps.streamId, sequence };
      latest = identity;
      const request: EditorInlayHintsRequest = {
        request: identity,
        document: { uri, language: deps.documentLanguage, version: sequence },
        range: editorRange(range),
      };
      try {
        const response = await deps.resolve(
          { request, documentText: model.getValue() },
          controllerFor(token).signal,
        );
        if (shouldDiscardResponse(response.request, latest)) return undefined;
        return { hints: response.hints.map(toMonacoHint), dispose: (): void => undefined };
      } catch {
        return { hints: [], dispose: (): void => undefined };
      }
    },
  };
}

export interface RegisterKeikoInlayHintsProviderArgs {
  readonly languages: MonacoInlayHintsRegistrar;
  readonly resolve: EditorInlayHintsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
}

export function registerKeikoInlayHintsProvider(
  args: RegisterKeikoInlayHintsProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) =>
    args.languages.registerInlayHintsProvider(
      documentLanguage,
      createKeikoInlayHintsProvider({ ...args, documentLanguage }),
    ),
  );
  return {
    dispose(): void {
      disposers.forEach((disposer) => {
        disposer.dispose();
      });
    },
  };
}

export const INLAY_HINTS_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
