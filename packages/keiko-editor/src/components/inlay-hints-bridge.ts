import { shouldDiscardAgainstLatest } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type { EditorPosition, EditorRange, EditorRequestIdentity } from "../types.js";
import type {
  MonacoCancellationToken,
  MonacoDisposable,
  MonacoPositionLike,
  MonacoRange,
} from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import {
  classifyResultKind,
  composeDisposers,
  controllerForToken,
  runLanguageBridgeCall,
  type EditorLanguageIntelligenceReporter,
} from "./language-intelligence.js";

export type EditorInlayHintKind = "type" | "parameter" | "enum" | "value";
export type EditorInlayHintStyle = "standard" | "debug-value";

export interface EditorInlayHint {
  readonly position: EditorPosition;
  readonly label: string;
  readonly kind: EditorInlayHintKind;
  /** Semantic projection metadata; paused values render through the dedicated decoration bridge. */
  readonly style?: EditorInlayHintStyle | undefined;
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
  /** True when the host dropped hints to honour a server cap; the overlay is then partial. */
  readonly truncated?: boolean | undefined;
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
  readonly style: EditorInlayHintStyle;
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
  /** Outcome sink so a hint-free buffer stays distinguishable from a hint lookup that failed. */
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

function editorRange(range: MonacoRange): EditorRange {
  return {
    start: { line: range.startLineNumber - 1, column: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, column: range.endColumn - 1 },
  };
}

function toMonacoHint(hint: EditorInlayHint): MonacoInlayHint {
  return {
    label: hint.label,
    position: { lineNumber: hint.position.line + 1, column: hint.position.column + 1 },
    kind: hint.kind === "parameter" ? 2 : 1,
    style: hint.kind === "value" ? "debug-value" : (hint.style ?? "standard"),
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
    provideInlayHints(model, range, token): Promise<MonacoInlayHintList | undefined> {
      const uri = model.uri.toString();
      if (!deps.isCurrentDocument(uri)) return Promise.resolve(undefined);
      sequence += 1;
      const identity = { requestId: deps.newRequestId(), streamId: deps.streamId, sequence };
      latest = identity;
      const request: EditorInlayHintsRequest = {
        request: identity,
        document: { uri, language: deps.documentLanguage, version: sequence },
        range: editorRange(range),
      };
      const { controller, dispose } = controllerForToken(token);
      return runLanguageBridgeCall<EditorInlayHintsResponse, MonacoInlayHintList | undefined>({
        operation: "inlay-hints",
        resolve: () => deps.resolve({ request, documentText: model.getValue() }, controller.signal),
        isDiscarded: (response) => shouldDiscardAgainstLatest(response.request, latest),
        discardedValue: undefined,
        failedValue: { hints: [], dispose: (): void => undefined },
        classify: (response) => classifyResultKind(response.hints.length, response.truncated),
        present: (response) => ({
          hints: response.hints.map(toMonacoHint),
          dispose: (): void => undefined,
        }),
        report: deps.report,
      }).finally(() => {
        dispose();
      });
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
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
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
  return composeDisposers(disposers);
}

export const INLAY_HINTS_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
