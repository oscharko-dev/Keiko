import {
  managedLspSemanticTokensFitDocument,
  parseManagedLspSemanticTokenData,
  parseManagedLspSemanticTokenLegend,
  type ManagedLspSemanticTokenData,
  type ManagedLspSemanticTokenLegend,
} from "@oscharko-dev/keiko-contracts";
import type {
  EditorLanguageId,
  EditorRequestIdentity,
  KeikoCodeEditorProps,
} from "@oscharko-dev/keiko-editor";

export interface EditorSemanticTokensRequest {
  readonly request: EditorRequestIdentity;
  readonly document: {
    readonly uri: string;
    readonly language: EditorLanguageId;
    readonly version: number;
  };
}

export interface EditorSemanticTokensQuery {
  readonly request: EditorSemanticTokensRequest;
  readonly documentText: string;
}

export type EditorSemanticTokensResolver = (
  query: EditorSemanticTokensQuery,
  signal: AbortSignal,
) => Promise<ManagedLspSemanticTokenData | null>;

interface SemanticModel {
  getValue(): string;
  getVersionId(): number;
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
  readonly uri: { toString(): string };
}

interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

interface SemanticRuntime {
  disposed: boolean;
  sequence: number;
  readonly controllers: Set<AbortController>;
}

interface CreateEditorSemanticTokensHostArgs {
  readonly legend: ManagedLspSemanticTokenLegend;
  readonly resolve: EditorSemanticTokensResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly language: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly isLargeDocument: (text: string) => boolean;
}

type SemanticHost = NonNullable<KeikoCodeEditorProps["semanticTokens"]>;
type SemanticProvider = SemanticHost["provider"];

function lineLengths(model: SemanticModel): readonly number[] {
  return Array.from(
    { length: model.getLineCount() },
    (_, index) => model.getLineMaxColumn(index + 1) - 1,
  );
}

function responseIsCurrent(
  args: CreateEditorSemanticTokensHostArgs,
  runtime: SemanticRuntime,
  model: SemanticModel,
  uri: string,
  version: number,
  sequence: number,
  response: ManagedLspSemanticTokenData,
  signal: AbortSignal,
): boolean {
  return (
    !runtime.disposed &&
    !signal.aborted &&
    runtime.sequence === sequence &&
    args.isCurrentDocument(uri) &&
    model.getVersionId() === version &&
    response.documentVersion === version
  );
}

async function resolveTokens(
  args: CreateEditorSemanticTokensHostArgs,
  runtime: SemanticRuntime,
  model: SemanticModel,
  token: CancellationToken,
): Promise<{ readonly data: Uint32Array } | null> {
  const uri = model.uri.toString();
  const text = model.getValue();
  if (
    runtime.disposed ||
    token.isCancellationRequested ||
    !args.isCurrentDocument(uri) ||
    args.isLargeDocument(text)
  )
    return null;
  const sequence = (runtime.sequence += 1);
  const version = model.getVersionId();
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  runtime.controllers.add(controller);
  try {
    const response = await args.resolve(
      {
        request: {
          request: { requestId: args.newRequestId(), streamId: args.streamId, sequence },
          document: { uri, language: args.language, version },
        },
        documentText: text,
      },
      controller.signal,
    );
    if (
      response === null ||
      !responseIsCurrent(args, runtime, model, uri, version, sequence, response, controller.signal)
    )
      return null;
    const parsed = parseManagedLspSemanticTokenData(response, args.legend);
    return parsed.ok && managedLspSemanticTokensFitDocument(parsed.value.data, lineLengths(model))
      ? { data: Uint32Array.from(parsed.value.data) }
      : null;
  } catch {
    return null;
  } finally {
    runtime.controllers.delete(controller);
    subscription.dispose();
  }
}

function semanticProvider(
  args: CreateEditorSemanticTokensHostArgs,
  runtime: SemanticRuntime,
): SemanticProvider {
  return {
    getLegend: () => ({
      tokenTypes: [...args.legend.tokenTypes],
      tokenModifiers: [...args.legend.tokenModifiers],
    }),
    provideDocumentSemanticTokens: (model, _lastResultId, token) =>
      resolveTokens(args, runtime, model, token),
    releaseDocumentSemanticTokens: (): void => undefined,
  };
}

export function createEditorSemanticTokensHost(
  args: CreateEditorSemanticTokensHostArgs,
): SemanticHost | undefined {
  if (!parseManagedLspSemanticTokenLegend(args.legend).ok) return undefined;
  const runtime: SemanticRuntime = { disposed: false, sequence: 0, controllers: new Set() };
  return {
    languages: [args.language],
    legendVersion: args.legend.legendVersion,
    provider: semanticProvider(args, runtime),
    dispose: (): void => {
      runtime.disposed = true;
      for (const controller of runtime.controllers) controller.abort();
      runtime.controllers.clear();
    },
  };
}
