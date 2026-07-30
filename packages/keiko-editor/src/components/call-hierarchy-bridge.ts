import type * as monaco from "monaco-editor";
import { shouldDiscardAgainstLatest } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorLocation,
  EditorPosition,
  EditorRange,
  EditorRequestIdentity,
  EditorSymbolKind,
} from "../types.js";
import type { MonacoDisposable } from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import {
  classifyResultKind,
  runLanguageBridgeCall,
  type EditorLanguageIntelligenceReporter,
} from "./language-intelligence.js";

export interface EditorCallHierarchyItem extends EditorLocation {
  readonly name: string;
  readonly kind: EditorSymbolKind;
  readonly selectionRange: EditorRange;
  readonly containerName?: string | undefined;
}

export interface EditorCallHierarchyCall {
  readonly item: EditorCallHierarchyItem;
  readonly fromRanges: readonly EditorRange[];
}

export interface EditorCallHierarchyRoot {
  readonly item: EditorCallHierarchyItem;
  readonly incomingCalls: readonly EditorCallHierarchyCall[];
  readonly outgoingCalls: readonly EditorCallHierarchyCall[];
}

export interface EditorCallHierarchyRequest {
  readonly request: EditorRequestIdentity;
  readonly document: {
    readonly uri: string;
    readonly language: EditorLanguageId;
    readonly version: number;
  };
  readonly position: EditorPosition;
}

export interface EditorCallHierarchyQuery {
  readonly request: EditorCallHierarchyRequest;
  readonly documentText: string;
}

export interface EditorCallHierarchyResponse {
  readonly request: EditorRequestIdentity;
  readonly roots: readonly EditorCallHierarchyRoot[];
  /** True when the host dropped roots to honour a server cap; the tree is then partial. */
  readonly truncated?: boolean | undefined;
}

export type EditorCallHierarchyResolver = (
  query: EditorCallHierarchyQuery,
  signal: AbortSignal,
) => Promise<EditorCallHierarchyResponse>;

export interface MonacoCallHierarchyModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoCallHierarchyEditor {
  addAction(descriptor: monaco.editor.IActionDescriptor): MonacoDisposable;
  getPosition(): { readonly lineNumber: number; readonly column: number } | null;
  getModel(): MonacoCallHierarchyModel | null;
}

export interface CallHierarchyActionLabels {
  readonly command: string;
}

export interface RegisterKeikoCallHierarchyActionArgs {
  readonly editor: MonacoCallHierarchyEditor;
  readonly resolve: EditorCallHierarchyResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly labels: CallHierarchyActionLabels;
  readonly onResult: (result: EditorCallHierarchyResponse) => void;
  /** Outcome sink so an empty hierarchy stays distinguishable from a hierarchy that failed to build. */
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

export const EDITOR_CALL_HIERARCHY_ACTION_ID = "keiko.editor.showCallHierarchy";

function requestFor(
  args: RegisterKeikoCallHierarchyActionArgs,
  uri: string,
  position: { readonly lineNumber: number; readonly column: number },
  sequence: number,
): EditorCallHierarchyRequest {
  return {
    request: { requestId: args.newRequestId(), streamId: args.streamId, sequence },
    document: { uri, language: args.documentLanguage, version: sequence },
    position: { line: position.lineNumber - 1, column: position.column - 1 },
  };
}

export function registerKeikoCallHierarchyAction(
  args: RegisterKeikoCallHierarchyActionArgs,
): MonacoDisposable {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  let controller: AbortController | null = null;
  const action = args.editor.addAction({
    id: EDITOR_CALL_HIERARCHY_ACTION_ID,
    label: args.labels.command,
    contextMenuGroupId: "1_navigation",
    contextMenuOrder: 3,
    run: async (): Promise<void> => {
      const model = args.editor.getModel();
      const position = args.editor.getPosition();
      if (model === null || position === null || !args.isCurrentDocument(model.uri.toString()))
        return;
      controller?.abort();
      controller = new AbortController();
      sequence += 1;
      const request = requestFor(args, model.uri.toString(), position, sequence);
      latest = request.request;
      const signal = controller.signal;
      const empty: EditorCallHierarchyResponse = { request: request.request, roots: [] };
      const result = await runLanguageBridgeCall<
        EditorCallHierarchyResponse,
        EditorCallHierarchyResponse | null
      >({
        operation: "call-hierarchy",
        resolve: () => args.resolve({ request, documentText: model.getValue() }, signal),
        isDiscarded: (response) => shouldDiscardAgainstLatest(response.request, latest),
        discardedValue: null,
        failedValue: empty,
        classify: (response) => classifyResultKind(response.roots.length, response.truncated),
        present: (response) => response,
        report: args.report,
      });
      if (result !== null) args.onResult(result);
    },
  });
  return {
    dispose(): void {
      controller?.abort();
      action.dispose();
    },
  };
}

export const CALL_HIERARCHY_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
