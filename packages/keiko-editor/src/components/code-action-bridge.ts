/**
 * Monaco code-action bridge (Epic #2089, Issue #2104, ADR-0058 D3).
 *
 * The bridge exposes server-resolved quick fixes through Monaco's lightbulb. It maps only active
 * model text edits into Monaco workspace edits; actions with `edits: null` are deliberately omitted
 * so multi-file/review-required changes cannot bypass Keiko's human-review invariant.
 */
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorCodeAction,
  EditorCodeActionKind,
  EditorCodeActionsQuery,
  EditorCodeActionsRequest,
  EditorCodeActionsResolver,
  EditorCodeActionsResponse,
  EditorDiagnostic,
  EditorDiagnosticSeverity,
  EditorRange,
  EditorRequestIdentity,
  EditorTextEdit,
} from "../types.js";
import {
  editorRangeToMonaco,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoRange,
} from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";

export interface MonacoCodeActionModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoCodeActionContext {
  readonly markers: readonly MonacoMarkerLike[];
  readonly only?: string | undefined;
}

export interface MonacoMarkerLike {
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly source?: string | undefined;
  readonly code?: string | number | undefined;
}

export interface MonacoResourceTextEdit {
  readonly resource: MonacoUriLike;
  readonly textEdit: MonacoTextEdit;
  readonly versionId: number | undefined;
}

export interface MonacoTextEdit {
  readonly range: MonacoRange;
  readonly text: string;
}

export interface MonacoWorkspaceEdit {
  readonly edits: readonly MonacoResourceTextEdit[];
}

export interface MonacoCodeAction {
  readonly title: string;
  readonly kind: string;
  readonly edit: MonacoWorkspaceEdit;
  readonly diagnostics: readonly MonacoMarkerLike[];
}

export interface MonacoCodeActionList {
  readonly actions: readonly MonacoCodeAction[];
  dispose(): void;
}

export interface MonacoCodeActionProvider {
  provideCodeActions(
    model: MonacoCodeActionModel,
    range: MonacoRange,
    context: MonacoCodeActionContext,
    token: MonacoCancellationToken,
  ): Promise<MonacoCodeActionList>;
}

export interface MonacoCodeActionKindLike {
  readonly value?: string | undefined;
}

export interface MonacoCodeActionKinds {
  readonly QuickFix: string | MonacoCodeActionKindLike;
  readonly Refactor: string | MonacoCodeActionKindLike;
  readonly Source: string | MonacoCodeActionKindLike;
}

export const DEFAULT_MONACO_CODE_ACTION_KINDS: MonacoCodeActionKinds = {
  QuickFix: "quickfix",
  Refactor: "refactor",
  Source: "source",
};

export interface MonacoCodeActionProviderMetadata {
  readonly providedCodeActionKinds: readonly string[];
}

export interface MonacoCodeActionRegistrar {
  readonly CodeActionKind?: MonacoCodeActionKinds | undefined;
  registerCodeActionProvider(
    languageSelector: string | readonly string[],
    provider: MonacoCodeActionProvider,
    metadata?: MonacoCodeActionProviderMetadata,
  ): MonacoDisposable;
}

function monacoSeverityToEditor(severity: number): EditorDiagnosticSeverity {
  if (severity >= 8) return "error";
  if (severity >= 4) return "warning";
  if (severity >= 2) return "info";
  return "hint";
}

export function monacoRangeToEditor(range: MonacoRange): EditorRange {
  return {
    start: { line: range.startLineNumber - 1, column: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, column: range.endColumn - 1 },
  };
}

export function markerToEditorDiagnostic(marker: MonacoMarkerLike): EditorDiagnostic {
  return {
    range: monacoRangeToEditor(marker),
    severity: monacoSeverityToEditor(marker.severity),
    message: marker.message,
    source: marker.source,
    ...(marker.code === undefined ? {} : { code: String(marker.code) }),
  };
}

const ACTION_KIND_TO_MONACO: Readonly<Record<EditorCodeActionKind, keyof MonacoCodeActionKinds>> = {
  quickfix: "QuickFix",
  refactor: "Refactor",
  source: "Source",
};

export function actionKindToMonaco(
  kind: EditorCodeActionKind,
  kinds: MonacoCodeActionKinds,
): string {
  const value = kinds[ACTION_KIND_TO_MONACO[kind]];
  if (typeof value === "string") return value;
  if (typeof value.value === "string") return value.value;
  return kind;
}

function editToMonaco(resource: MonacoUriLike, edit: EditorTextEdit): MonacoResourceTextEdit {
  return {
    resource,
    textEdit: { range: editorRangeToMonaco(edit.range), text: edit.newText },
    versionId: undefined,
  };
}

export function actionToMonaco(
  action: EditorCodeAction,
  resource: MonacoUriLike,
  markers: readonly MonacoMarkerLike[],
  kinds: MonacoCodeActionKinds,
): MonacoCodeAction | null {
  if (action.edits === null) {
    return null;
  }
  return {
    title: action.title,
    kind: actionKindToMonaco(action.kind, kinds),
    edit: { edits: action.edits.map((edit) => editToMonaco(resource, edit)) },
    diagnostics: markers,
  };
}

export function codeActionsResponseToMonaco(
  response: EditorCodeActionsResponse,
  resource: MonacoUriLike,
  markers: readonly MonacoMarkerLike[],
  kinds: MonacoCodeActionKinds,
): MonacoCodeActionList {
  const actions = response.actions
    .map((action) => actionToMonaco(action, resource, markers, kinds))
    .filter((action): action is MonacoCodeAction => action !== null);
  return { actions, dispose: (): void => undefined };
}

export interface KeikoCodeActionProviderDeps {
  readonly resolve: EditorCodeActionsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly codeActionKinds: MonacoCodeActionKinds;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
}

function buildRequest(
  deps: KeikoCodeActionProviderDeps,
  documentUri: string,
  range: MonacoRange,
  context: MonacoCodeActionContext,
  sequence: number,
): EditorCodeActionsRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    range: monacoRangeToEditor(range),
    diagnostics: context.markers.map(markerToEditorDiagnostic),
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

const EMPTY_ACTIONS: MonacoCodeActionList = { actions: [], dispose: (): void => undefined };

export function createKeikoCodeActionProvider(
  deps: KeikoCodeActionProviderDeps,
): MonacoCodeActionProvider {
  let sequence = 0;
  return {
    async provideCodeActions(model, range, context, token): Promise<MonacoCodeActionList> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return EMPTY_ACTIONS;
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, range, context, sequence);
      const controller = controllerForToken(token);
      try {
        const query: EditorCodeActionsQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        return codeActionsResponseToMonaco(
          response,
          model.uri,
          context.markers,
          deps.codeActionKinds,
        );
      } catch {
        return EMPTY_ACTIONS;
      }
    },
  };
}

export interface RegisterKeikoCodeActionProviderArgs {
  readonly languages: MonacoCodeActionRegistrar;
  readonly resolve: EditorCodeActionsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
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

export function registerKeikoCodeActionProvider(
  args: RegisterKeikoCodeActionProviderArgs,
): MonacoDisposable {
  const kinds = args.languages.CodeActionKind ?? DEFAULT_MONACO_CODE_ACTION_KINDS;
  const metadata = {
    providedCodeActionKinds: [
      actionKindToMonaco("quickfix", kinds),
      actionKindToMonaco("refactor", kinds),
      actionKindToMonaco("source", kinds),
    ],
  };
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoCodeActionProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      codeActionKinds: kinds,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
    });
    return args.languages.registerCodeActionProvider(documentLanguage, provider, metadata);
  });
  return composeDisposers(disposers);
}

export const CODE_ACTION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
