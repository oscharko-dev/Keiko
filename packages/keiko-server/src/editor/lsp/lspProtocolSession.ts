import { pathToFileURL } from "node:url";

import {
  MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  type LanguageServiceOperation,
  type ManagedLspLanguage,
  type ManagedLspNegotiatedCapabilitySnapshot,
  type ManagedLspPositionEncoding,
  type ManagedLspTextSync,
} from "@oscharko-dev/keiko-contracts";

import { LspServerRequestError } from "./lspJsonRpcClient.js";
import {
  negotiateSemanticTokenLegend,
  type LspSemanticTokenNegotiation,
} from "./lspSemanticTokens.js";

const MAX_CONFIGURATION_ITEMS = 16;
const MAX_CONFIGURATION_RESPONSE_BYTES = 64 * 1024;
const MAX_CONFIGURATION_DEPTH = 4;
const MAX_CONFIGURATION_KEYS = 64;
const MAX_CONFIGURATION_STRING_LENGTH = 4_096;

const METHOD_OPERATIONS: Readonly<Record<string, LanguageServiceOperation>> = Object.freeze({
  "textDocument/diagnostic": "diagnostics",
  "textDocument/completion": "completion",
  "textDocument/hover": "hover",
  "textDocument/documentSymbol": "symbols",
  "textDocument/formatting": "formatting",
  "textDocument/definition": "definition",
  "textDocument/typeDefinition": "typeDefinition",
  "textDocument/implementation": "implementation",
  "textDocument/references": "references",
  "textDocument/prepareCallHierarchy": "callHierarchy",
  "textDocument/inlayHint": "inlayHints",
  "textDocument/prepareRename": "renamePrepare",
  "textDocument/rename": "renameApply",
  "textDocument/codeAction": "codeActions",
  "textDocument/signatureHelp": "signatureHelp",
});

const CAPABILITY_OPERATIONS: readonly (readonly [string, LanguageServiceOperation])[] = [
  ["diagnosticProvider", "diagnostics"],
  ["completionProvider", "completion"],
  ["hoverProvider", "hover"],
  ["documentSymbolProvider", "symbols"],
  ["documentFormattingProvider", "formatting"],
  ["definitionProvider", "definition"],
  ["typeDefinitionProvider", "typeDefinition"],
  ["implementationProvider", "implementation"],
  ["referencesProvider", "references"],
  ["callHierarchyProvider", "callHierarchy"],
  ["inlayHintProvider", "inlayHints"],
  ["codeActionProvider", "codeActions"],
  ["signatureHelpProvider", "signatureHelp"],
];

export interface LspProtocolSessionDeps {
  readonly language: ManagedLspLanguage;
  readonly candidateOperations: readonly LanguageServiceOperation[];
  readonly semanticTokensCandidate: boolean;
  readonly configurationRevision: number;
  readonly processId: number;
  readonly workspaceRoot: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly initializationOptions?: Readonly<Record<string, unknown>> | undefined;
}

export interface LspProtocolSession {
  initializeParams(): Record<string, unknown>;
  acceptInitializeResult(result: unknown): void;
  snapshot(): ManagedLspNegotiatedCapabilitySnapshot;
  handleServerRequest(method: string, params: unknown): unknown;
  handleServerNotification(method: string, params: unknown): void;
  notificationCounts(): Readonly<Record<string, number>>;
  semanticTokenNegotiation(): LspSemanticTokenNegotiation | undefined;
}

interface SessionState {
  snapshotVersion: number;
  staticOperations: Set<LanguageServiceOperation>;
  dynamicRegistrations: Map<string, LanguageServiceOperation>;
  unregistered: Set<LanguageServiceOperation>;
  positionEncoding: ManagedLspPositionEncoding;
  textSync: ManagedLspTextSync;
  semanticTokens: LspSemanticTokenNegotiation | undefined;
  notificationCounts: Map<string, number>;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

export function createLspProtocolSession(deps: LspProtocolSessionDeps): LspProtocolSession {
  const state: SessionState = {
    snapshotVersion: 1,
    staticOperations: new Set(),
    dynamicRegistrations: new Map(),
    unregistered: new Set(),
    positionEncoding: "utf-16",
    textSync: "none",
    semanticTokens: undefined,
    notificationCounts: new Map(),
  };
  return {
    initializeParams: () => buildInitializeParams(deps),
    acceptInitializeResult: (result): void => {
      acceptInitializeResult(state, deps, result);
    },
    snapshot: () => buildSnapshot(state, deps),
    handleServerRequest: (method, params): unknown =>
      handleServerRequest(state, deps, method, params),
    handleServerNotification: (method, params): void => {
      handleServerNotification(state, method, params);
    },
    notificationCounts: () => Object.fromEntries(state.notificationCounts),
    semanticTokenNegotiation: () => state.semanticTokens,
  };
}

function buildInitializeParams(deps: LspProtocolSessionDeps): Record<string, unknown> {
  const rootUri = pathToFileURL(deps.workspaceRoot).href;
  return {
    processId: deps.processId,
    clientInfo: { name: "Keiko", version: "1" },
    locale: "en",
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    capabilities: clientCapabilities(),
    initializationOptions: deps.initializationOptions ?? {},
    trace: "off",
  };
}

function clientCapabilities(): Record<string, unknown> {
  return {
    general: { positionEncodings: ["utf-16", "utf-8"] },
    workspace: { configuration: true, workspaceFolders: true },
    textDocument: {
      synchronization: { dynamicRegistration: true, didSave: false },
      completion: { dynamicRegistration: true },
      hover: { dynamicRegistration: true, contentFormat: ["plaintext", "markdown"] },
      documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
      formatting: { dynamicRegistration: true },
      definition: { dynamicRegistration: true },
      typeDefinition: { dynamicRegistration: true, linkSupport: true },
      implementation: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      callHierarchy: { dynamicRegistration: true },
      inlayHint: { dynamicRegistration: true, resolveSupport: { properties: [] } },
      rename: { dynamicRegistration: true, prepareSupport: true },
      codeAction: { dynamicRegistration: true },
      signatureHelp: { dynamicRegistration: true },
      semanticTokens: {
        dynamicRegistration: true,
        requests: { full: true, range: false },
        tokenTypes: MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
        tokenModifiers: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
        formats: ["relative"],
      },
    },
  };
}

function acceptInitializeResult(
  state: SessionState,
  deps: LspProtocolSessionDeps,
  result: unknown,
): void {
  const capabilities = recordValue(result, "capabilities");
  state.staticOperations = capabilitiesFromServer(capabilities, deps.candidateOperations);
  state.positionEncoding = positionEncoding(capabilities?.positionEncoding);
  state.textSync = textSyncMode(capabilities?.textDocumentSync);
  if (deps.candidateOperations.includes("diagnostics") && state.textSync !== "none") {
    state.staticOperations.add("diagnostics");
  }
  state.semanticTokens = deps.semanticTokensCandidate
    ? negotiateSemanticTokenLegend(capabilities?.semanticTokensProvider)
    : undefined;
  state.dynamicRegistrations.clear();
  state.unregistered.clear();
  state.snapshotVersion += 1;
}

function capabilitiesFromServer(
  capabilities: UnknownRecord | undefined,
  candidates: readonly LanguageServiceOperation[],
): Set<LanguageServiceOperation> {
  const supported = new Set<LanguageServiceOperation>();
  if (capabilities === undefined) return supported;
  for (const [key, operation] of CAPABILITY_OPERATIONS) {
    if (candidates.includes(operation) && capabilityEnabled(capabilities[key])) {
      supported.add(operation);
    }
  }
  addRenameCapabilities(capabilities.renameProvider, candidates, supported);
  return supported;
}

function addRenameCapabilities(
  provider: unknown,
  candidates: readonly LanguageServiceOperation[],
  supported: Set<LanguageServiceOperation>,
): void {
  if (!capabilityEnabled(provider)) return;
  if (candidates.includes("renameApply")) supported.add("renameApply");
  const prepare = provider === true || (isRecord(provider) && provider.prepareProvider === true);
  if (prepare && candidates.includes("renamePrepare")) supported.add("renamePrepare");
}

function capabilityEnabled(value: unknown): boolean {
  return value === true || isRecord(value);
}

function positionEncoding(value: unknown): ManagedLspPositionEncoding {
  return value === "utf-8" ? "utf-8" : "utf-16";
}

function textSyncMode(value: unknown): ManagedLspTextSync {
  const change = isRecord(value) ? value.change : value;
  if (change === 1) return "full";
  if (change === 2) return "incremental";
  return "none";
}

function buildSnapshot(
  state: SessionState,
  deps: LspProtocolSessionDeps,
): ManagedLspNegotiatedCapabilitySnapshot {
  const dynamic = new Set(state.dynamicRegistrations.values());
  const negotiated = orderedOperations(
    deps.candidateOperations.filter(
      (operation) =>
        (state.staticOperations.has(operation) || dynamic.has(operation)) &&
        !state.unregistered.has(operation),
    ),
  );
  return {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    snapshotVersion: state.snapshotVersion,
    configurationRevision: deps.configurationRevision,
    language: deps.language,
    protocolVersion: "3.18",
    positionEncoding: state.positionEncoding,
    textSync: state.textSync,
    candidateOperations: [...deps.candidateOperations],
    negotiatedOperations: negotiated,
    dynamicallyUnregisteredOperations: orderedOperations([...state.unregistered]),
    semanticTokens:
      state.semanticTokens !== undefined
        ? { supported: true, legendVersion: 1 }
        : { supported: false, legendVersion: null },
  };
}

function orderedOperations(
  operations: readonly LanguageServiceOperation[],
): LanguageServiceOperation[] {
  return [...new Set(operations)].sort((left, right) => left.localeCompare(right));
}

function handleServerRequest(
  state: SessionState,
  deps: LspProtocolSessionDeps,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case "workspace/configuration":
      return workspaceConfiguration(deps.configuration, params);
    case "client/registerCapability":
      applyRegistrations(state, deps.candidateOperations, params);
      return null;
    case "client/unregisterCapability":
      applyUnregistrations(state, params);
      return null;
    default:
      throw new LspServerRequestError(-32601, "Server request denied");
  }
}

interface DynamicRegistration {
  readonly id: string;
  readonly operation: LanguageServiceOperation;
}

function applyRegistrations(
  state: SessionState,
  candidates: readonly LanguageServiceOperation[],
  params: unknown,
): void {
  const values = arrayField(params, "registrations");
  const registrations = values.map((value) => parseRegistration(value, candidates));
  if (new Set(registrations.map(({ id }) => id)).size !== registrations.length) invalidParams();
  for (const registration of registrations) {
    if (state.dynamicRegistrations.has(registration.id)) invalidParams();
  }
  for (const registration of registrations) {
    state.dynamicRegistrations.set(registration.id, registration.operation);
    state.unregistered.delete(registration.operation);
  }
  state.snapshotVersion += 1;
}

function parseRegistration(
  value: unknown,
  candidates: readonly LanguageServiceOperation[],
): DynamicRegistration {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 128) invalidParams();
  const operation = typeof value.method === "string" ? METHOD_OPERATIONS[value.method] : undefined;
  if (operation === undefined || !candidates.includes(operation)) invalidParams();
  return { id: value.id, operation };
}

function applyUnregistrations(state: SessionState, params: unknown): void {
  const record = isRecord(params) ? params : undefined;
  const raw = record?.unregisterations ?? record?.unregistrations;
  if (!Array.isArray(raw) || raw.length > 64) invalidParams();
  const removals = raw.map((value) => parseUnregistration(state, value));
  if (new Set(removals.map(({ id }) => id)).size !== removals.length) invalidParams();
  for (const removal of removals) {
    state.dynamicRegistrations.delete(removal.id);
    state.unregistered.add(removal.operation);
  }
  state.snapshotVersion += 1;
}

function parseUnregistration(state: SessionState, value: unknown): DynamicRegistration {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.method !== "string") {
    invalidParams();
  }
  const operation = METHOD_OPERATIONS[value.method];
  if (operation === undefined || state.dynamicRegistrations.get(value.id) !== operation) {
    invalidParams();
  }
  return { id: value.id, operation };
}

function workspaceConfiguration(
  configuration: Readonly<Record<string, unknown>>,
  params: unknown,
): readonly unknown[] {
  const items = arrayField(params, "items", MAX_CONFIGURATION_ITEMS);
  const result = items.map((item) => configurationItem(configuration, item));
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CONFIGURATION_RESPONSE_BYTES) {
    throw new LspServerRequestError(-32603, "Configuration response rejected");
  }
  return result;
}

function configurationItem(
  configuration: Readonly<Record<string, unknown>>,
  item: unknown,
): unknown {
  if (!isRecord(item) || typeof item.section !== "string" || item.section.length > 128) {
    invalidParams();
  }
  const value = configuration[item.section];
  return safeConfigurationValue(value, 0) ? value : null;
}

function safeConfigurationValue(value: unknown, depth: number): boolean {
  if (depth > MAX_CONFIGURATION_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") return safeConfigurationString(value);
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_CONFIGURATION_KEYS &&
      value.every((item) => safeConfigurationValue(item, depth + 1))
    );
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_CONFIGURATION_KEYS) return false;
  return Object.entries(value).every(
    ([key, item]) => !isSensitiveConfigurationKey(key) && safeConfigurationValue(item, depth + 1),
  );
}

function isSensitiveConfigurationKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    ["secret", "token", "password", "credential", "executable", "command", "uri"].some((part) =>
      normalized.includes(part),
    ) ||
    normalized === "env" ||
    normalized === "environment"
  );
}

function safeConfigurationString(value: string): boolean {
  return (
    value.length <= MAX_CONFIGURATION_STRING_LENGTH &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.startsWith("file:") &&
    !/^[a-z]:[\\/]/iu.test(value)
  );
}

function handleServerNotification(state: SessionState, method: string, _params: unknown): void {
  if (
    !["$/progress", "window/logMessage", "window/showMessage", "telemetry/event"].includes(method)
  ) {
    return;
  }
  const current = state.notificationCounts.get(method) ?? 0;
  state.notificationCounts.set(method, Math.min(current + 1, Number.MAX_SAFE_INTEGER));
}

function arrayField(value: unknown, key: string, maximum = 64): readonly unknown[] {
  const field = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(field) || field.length > maximum) invalidParams();
  return field;
}

function recordValue(value: unknown, key: string): UnknownRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidParams(): never {
  throw new LspServerRequestError(-32602, "Invalid server request");
}
