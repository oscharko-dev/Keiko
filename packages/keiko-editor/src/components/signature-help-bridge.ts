/**
 * Monaco signature-help bridge (Epic #2089, Issue #2104, ADR-0042 D4).
 *
 * Wires Monaco's parameter-hints UI to the host resolver. The bridge advertises trigger/retrigger
 * characters, maps the content-free request plus live buffer text to the host, and maps the
 * deterministic response into Monaco's `SignatureHelpResult` shape.
 */
import { shouldDiscardAgainstLatest } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorRequestIdentity,
  EditorSignatureHelpQuery,
  EditorSignatureHelpRequest,
  EditorSignatureHelpResolver,
  EditorSignatureHelpResponse,
  EditorSignatureInformation,
} from "../types.js";
import {
  monacoPositionToEditor,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoPositionLike,
} from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import {
  classifyResultKind,
  composeDisposers,
  controllerForToken,
  runLanguageBridgeCall,
  type EditorLanguageIntelligenceReporter,
} from "./language-intelligence.js";

export interface MonacoSignatureHelpModel {
  getValue(): string;
  readonly uri: MonacoUriLike;
}

export interface MonacoSignatureHelpContext {
  readonly triggerCharacter?: string | undefined;
}

export interface MonacoParameterInformation {
  readonly label: string;
}

export interface MonacoSignatureInformation {
  readonly label: string;
  readonly documentation?: string;
  readonly parameters: readonly MonacoParameterInformation[];
}

export interface MonacoSignatureHelp {
  readonly signatures: readonly MonacoSignatureInformation[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

export interface MonacoSignatureHelpResult {
  readonly value: MonacoSignatureHelp;
  dispose(): void;
}

export interface MonacoSignatureHelpProvider {
  readonly signatureHelpTriggerCharacters: readonly string[];
  readonly signatureHelpRetriggerCharacters: readonly string[];
  provideSignatureHelp(
    model: MonacoSignatureHelpModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
    context: MonacoSignatureHelpContext,
  ): Promise<MonacoSignatureHelpResult | undefined>;
}

export interface MonacoSignatureHelpRegistrar {
  registerSignatureHelpProvider(
    languageSelector: string | readonly string[],
    provider: MonacoSignatureHelpProvider,
  ): MonacoDisposable;
}

export function signatureToMonaco(
  signature: EditorSignatureInformation,
): MonacoSignatureInformation {
  const documentation =
    typeof signature.documentation === "string" ? signature.documentation : undefined;
  return {
    label: signature.label,
    ...(documentation === undefined ? {} : { documentation }),
    parameters: signature.parameters.map((parameter) => ({ label: parameter.label })),
  };
}

export function signatureHelpResponseToMonaco(
  response: EditorSignatureHelpResponse,
): MonacoSignatureHelpResult | undefined {
  if (response.signatures.length === 0) {
    return undefined;
  }
  return {
    value: {
      signatures: response.signatures.map(signatureToMonaco),
      activeSignature: response.activeSignature ?? 0,
      activeParameter: response.activeParameter ?? 0,
    },
    dispose: (): void => undefined,
  };
}

export interface KeikoSignatureHelpProviderDeps {
  readonly resolve: EditorSignatureHelpResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguage: EditorLanguageId;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly triggerCharacters: readonly string[];
  readonly retriggerCharacters: readonly string[];
  /** Outcome sink so "no signature here" stays distinguishable from "parameter hints failed". */
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

function buildRequest(
  deps: KeikoSignatureHelpProviderDeps,
  documentUri: string,
  position: MonacoPositionLike,
  context: MonacoSignatureHelpContext,
  sequence: number,
): EditorSignatureHelpRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    position: monacoPositionToEditor(position),
    ...(context.triggerCharacter === undefined
      ? {}
      : { triggerCharacter: context.triggerCharacter }),
  };
}

export function createKeikoSignatureHelpProvider(
  deps: KeikoSignatureHelpProviderDeps,
): MonacoSignatureHelpProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  return {
    signatureHelpTriggerCharacters: deps.triggerCharacters,
    signatureHelpRetriggerCharacters: deps.retriggerCharacters,
    provideSignatureHelp(
      model,
      position,
      token,
      context,
    ): Promise<MonacoSignatureHelpResult | undefined> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return Promise.resolve(undefined);
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, position, context, sequence);
      latest = request.request;
      const { controller, dispose } = controllerForToken(token);
      const query: EditorSignatureHelpQuery = { request, documentText: model.getValue() };
      return runLanguageBridgeCall<
        EditorSignatureHelpResponse,
        MonacoSignatureHelpResult | undefined
      >({
        operation: "signature-help",
        resolve: () => deps.resolve(query, controller.signal),
        isDiscarded: (response) => shouldDiscardAgainstLatest(response.request, latest),
        discardedValue: undefined,
        failedValue: undefined,
        classify: (response) => classifyResultKind(response.signatures.length, response.truncated),
        present: signatureHelpResponseToMonaco,
        report: deps.report,
      }).finally(() => {
        dispose();
      });
    },
  };
}

export interface RegisterKeikoSignatureHelpProviderArgs {
  readonly languages: MonacoSignatureHelpRegistrar;
  readonly resolve: EditorSignatureHelpResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly triggerCharacters?: readonly string[] | undefined;
  readonly retriggerCharacters?: readonly string[] | undefined;
  readonly report?: EditorLanguageIntelligenceReporter | undefined;
}

export const DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS: readonly string[] = ["(", ","];
export const DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS: readonly string[] = [")", ","];

export function registerKeikoSignatureHelpProvider(
  args: RegisterKeikoSignatureHelpProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoSignatureHelpProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
      triggerCharacters: args.triggerCharacters ?? DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS,
      retriggerCharacters: args.retriggerCharacters ?? DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS,
      report: args.report,
    });
    return args.languages.registerSignatureHelpProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

export const SIGNATURE_HELP_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
