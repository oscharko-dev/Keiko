import type {
  ManagedLspSemanticTokenData,
  ManagedLspSemanticTokenLegend,
  ManagedLspSemanticTokenType,
  ManagedLspSemanticTokenModifier,
} from "@oscharko-dev/keiko-contracts";
import {
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  managedLspSemanticTokensFitDocument,
  parseManagedLspSemanticTokenData,
  parseManagedLspSemanticTokenLegend,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";
import type {
  EditorLanguageId,
  EditorRequestIdentity,
  KeikoCodeEditorProps,
} from "@oscharko-dev/keiko-editor";

interface EditorSemanticTokensRequest {
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

interface SemanticResponseContext {
  readonly uri: string;
  readonly version: number;
  readonly sequence: number;
  readonly response: ManagedLspSemanticTokenData;
  readonly signal: AbortSignal;
}

function capturedExtent(value: readonly unknown[], maximum: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const extent = value.length;
  return Number.isSafeInteger(extent) && extent >= 0 && extent <= maximum ? extent : undefined;
}

function ownedTokenTypes(
  value: readonly ManagedLspSemanticTokenType[],
): readonly ManagedLspSemanticTokenType[] | undefined {
  const extent = capturedExtent(value, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES);
  if (extent === undefined) return undefined;
  const entries: ManagedLspSemanticTokenType[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member = value[index];
    if (member === undefined) return undefined;
    entries.push(member);
  }
  return value.length === extent ? entries : undefined;
}

function ownedTokenModifiers(
  value: readonly ManagedLspSemanticTokenModifier[],
): readonly ManagedLspSemanticTokenModifier[] | undefined {
  const extent = capturedExtent(value, MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS);
  if (extent === undefined) return undefined;
  const entries: ManagedLspSemanticTokenModifier[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member = value[index];
    if (member === undefined) return undefined;
    entries.push(member);
  }
  return value.length === extent ? entries : undefined;
}

function ownedLegend(
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspSemanticTokenLegend | undefined {
  if (!parseManagedLspSemanticTokenLegend(legend).ok) return undefined;
  const tokenTypes = ownedTokenTypes(legend.tokenTypes);
  if (tokenTypes === undefined) return undefined;
  const tokenModifiers = ownedTokenModifiers(legend.tokenModifiers);
  if (tokenModifiers === undefined) return undefined;
  const value = {
    schemaVersion: legend.schemaVersion,
    legendVersion: legend.legendVersion,
    tokenTypes,
    tokenModifiers,
    returnedTypeCount: legend.returnedTypeCount,
    totalTypeCount: legend.totalTypeCount,
    returnedModifierCount: legend.returnedModifierCount,
    totalModifierCount: legend.totalModifierCount,
    truncated: legend.truncated,
  };
  const parsed = parseManagedLspSemanticTokenLegend(value);
  return parsed.ok ? parsed.value : undefined;
}

function ownedTokenNumbers(value: readonly number[]): readonly number[] | undefined {
  const extent = capturedExtent(value, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS * 5);
  if (extent === undefined || extent % 5 !== 0) return undefined;
  const entries: number[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member = value[index];
    if (typeof member !== "number") return undefined;
    entries.push(member);
  }
  return value.length === extent ? entries : undefined;
}

function ownedResponse(
  response: ManagedLspSemanticTokenData,
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspSemanticTokenData | undefined {
  if (!parseManagedLspSemanticTokenData(response, legend).ok) return undefined;
  const data = ownedTokenNumbers(response.data);
  if (data === undefined) return undefined;
  const value = {
    schemaVersion: response.schemaVersion,
    legendVersion: response.legendVersion,
    documentVersion: response.documentVersion,
    dataVersion: response.dataVersion,
    data,
    returnedTokenCount: response.returnedTokenCount,
    totalTokenCount: response.totalTokenCount,
    truncated: response.truncated,
  };
  const parsed = parseManagedLspSemanticTokenData(value, legend);
  return parsed.ok ? parsed.value : undefined;
}

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
  context: SemanticResponseContext,
): boolean {
  return (
    !runtime.disposed &&
    !context.signal.aborted &&
    runtime.sequence === context.sequence &&
    args.isCurrentDocument(context.uri) &&
    model.getVersionId() === context.version &&
    context.response.documentVersion === context.version
  );
}

function settleSemanticResponse(
  args: CreateEditorSemanticTokensHostArgs,
  runtime: SemanticRuntime,
  model: SemanticModel,
  context: SemanticResponseContext,
  legend: ManagedLspSemanticTokenLegend,
): { readonly data: Uint32Array } | null {
  if (!responseIsCurrent(args, runtime, model, context)) return null;
  const captured = ownedResponse(context.response, legend);
  if (
    captured === undefined ||
    !responseIsCurrent(args, runtime, model, { ...context, response: captured })
  ) {
    return null;
  }
  return managedLspSemanticTokensFitDocument(captured.data, lineLengths(model))
    ? { data: Uint32Array.from(captured.data) }
    : null;
}

function semanticTokenQuery(
  args: CreateEditorSemanticTokensHostArgs,
  uri: string,
  version: number,
  sequence: number,
  text: string,
): EditorSemanticTokensQuery {
  return {
    request: {
      request: { requestId: args.newRequestId(), streamId: args.streamId, sequence },
      document: { uri, language: args.language, version },
    },
    documentText: text,
  };
}

async function resolveTokens(
  args: CreateEditorSemanticTokensHostArgs,
  runtime: SemanticRuntime,
  model: SemanticModel,
  token: CancellationToken,
  legend: ManagedLspSemanticTokenLegend,
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
      semanticTokenQuery(args, uri, version, sequence, text),
      controller.signal,
    );
    if (response === null) return null;
    return settleSemanticResponse(
      args,
      runtime,
      model,
      {
        uri,
        version,
        sequence,
        response,
        signal: controller.signal,
      },
      legend,
    );
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
  legend: ManagedLspSemanticTokenLegend,
): SemanticProvider {
  return {
    getLegend: () => ({
      tokenTypes: [...legend.tokenTypes],
      tokenModifiers: [...legend.tokenModifiers],
    }),
    provideDocumentSemanticTokens: (model, _lastResultId, token) =>
      resolveTokens(args, runtime, model, token, legend),
    releaseDocumentSemanticTokens: (): void => undefined,
  };
}

export function createEditorSemanticTokensHost(
  args: CreateEditorSemanticTokensHostArgs,
): SemanticHost | undefined {
  const legend = ownedLegend(args.legend);
  if (legend === undefined) return undefined;
  const runtime: SemanticRuntime = { disposed: false, sequence: 0, controllers: new Set() };
  return {
    languages: [args.language],
    legendVersion: legend.legendVersion,
    provider: semanticProvider(args, runtime, legend),
    dispose: (): void => {
      runtime.disposed = true;
      for (const controller of runtime.controllers) controller.abort();
      runtime.controllers.clear();
    },
  };
}
