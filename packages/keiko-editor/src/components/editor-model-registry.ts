/**
 * Host-owned Monaco model retention registry (Epic #2095 / Issue #2322).
 *
 * Monaco text models own undo/redo stacks, markers, and tokenization state. Keiko keeps those
 * models alive across normal tab switches through this bounded registry instead of relying on
 * `@monaco-editor/react`'s unbounded `keepCurrentModel` behaviour. The module is intentionally
 * structural and injectable so lifecycle, pressure, and diagnostics are testable without Monaco.
 */

export type EditorModelDisposalReason =
  "count-budget" | "byte-budget" | "root-disposed" | "shutdown" | "identity-reused";

export interface RetainedEditorUri {
  toString(): string;
}

export interface RetainedEditorModel {
  readonly uri: RetainedEditorUri;
  getValue(): string;
  setValue?(text: string): void;
  dispose(): void;
  isDisposed?(): boolean;
}

export interface RetainedEditorModelNamespace {
  createModel(text: string, language: string, uri: RetainedEditorUri): RetainedEditorModel;
  getModel(uri: RetainedEditorUri): RetainedEditorModel | null;
}

export interface RetainedEditorModelEditor {
  getModel?(): RetainedEditorModel | null;
  setModel?(model: RetainedEditorModel | null): void;
  saveViewState(): unknown;
  restoreViewState(state: unknown): void;
}

export interface EditorModelProtection {
  readonly dirty: boolean;
  readonly active: boolean;
  readonly pendingSave: boolean;
  readonly pendingConflict: boolean;
  readonly hotExitRecovery: boolean;
  readonly agentReview: boolean;
  readonly pinned: boolean;
}

export interface RetainedEditorModelAttachInput {
  readonly key: string;
  readonly rootKey: string;
  readonly uri: RetainedEditorUri;
  readonly language: string;
  readonly text: string;
  readonly sizeBytes: number;
  readonly degraded: boolean;
  readonly viewStateKey: string;
  readonly namespace: RetainedEditorModelNamespace;
  readonly editor: RetainedEditorModelEditor;
  readonly protection: EditorModelProtection;
}

export interface RetainedEditorModelAttachment {
  readonly key: string;
  readonly model: RetainedEditorModel;
  detach(): void;
}

export interface EditorModelRegistryOptions {
  readonly countBudget: number;
  readonly byteBudget: number;
}

export interface EditorModelRegistryDiagnosticsEntry {
  readonly identityHash: string;
  readonly rootHash: string;
  readonly attachmentCount: number;
  readonly estimatedBytes: number;
  readonly protected: boolean;
  readonly dirty: boolean;
  readonly active: boolean;
  readonly degraded: boolean;
  readonly lastAccess: number;
}

export interface EditorModelRegistryDiagnostics {
  readonly schemaVersion: "1";
  readonly liveModelCount: number;
  readonly attachedModelCount: number;
  readonly estimatedBytes: number;
  readonly countBudget: number;
  readonly byteBudget: number;
  readonly pressure: "healthy" | "degraded";
  readonly entries: readonly EditorModelRegistryDiagnosticsEntry[];
}

interface RegistryEntry {
  readonly key: string;
  readonly rootKey: string;
  readonly uriString: string;
  readonly model: RetainedEditorModel;
  readonly viewStates: Map<string, unknown>;
  attachmentCount: number;
  estimatedBytes: number;
  lastAccess: number;
  degraded: boolean;
  protection: EditorModelProtection;
  disposed: boolean;
  disposalReason: EditorModelDisposalReason | null;
}

const DEFAULT_COUNT_BUDGET = 16;
const DEFAULT_BYTE_BUDGET = 128 * 1024 * 1024;
const MODEL_METADATA_OVERHEAD_BYTES = 8 * 1024;
const LARGE_FILE_MINIMUM_COST_BYTES = 8 * 1024 * 1024;

export const DEFAULT_EDITOR_MODEL_REGISTRY_OPTIONS: EditorModelRegistryOptions = Object.freeze({
  countBudget: DEFAULT_COUNT_BUDGET,
  byteBudget: DEFAULT_BYTE_BUDGET,
});

function protectionFalse(): EditorModelProtection {
  return {
    dirty: false,
    active: false,
    pendingSave: false,
    pendingConflict: false,
    hotExitRecovery: false,
    agentReview: false,
    pinned: false,
  };
}

export const UNPROTECTED_EDITOR_MODEL: EditorModelProtection = Object.freeze(protectionFalse());

function safeBudget(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function estimateEditorModelBytes(input: {
  readonly text: string;
  readonly sizeBytes: number;
  readonly degraded: boolean;
}): number {
  const textCost = input.text.length * 2;
  const observedCost = Math.max(textCost, input.sizeBytes);
  const base = observedCost + MODEL_METADATA_OVERHEAD_BYTES;
  return input.degraded ? Math.max(base, LARGE_FILE_MINIMUM_COST_BYTES, input.sizeBytes * 4) : base;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function modelDisposed(model: RetainedEditorModel): boolean {
  return model.isDisposed?.() === true;
}

function protectedEntry(entry: RegistryEntry): boolean {
  return (
    entry.attachmentCount > 0 ||
    entry.protection.dirty ||
    entry.protection.active ||
    entry.protection.pendingSave ||
    entry.protection.pendingConflict ||
    entry.protection.hotExitRecovery ||
    entry.protection.agentReview ||
    entry.protection.pinned
  );
}

function compareEvictionCandidates(left: RegistryEntry, right: RegistryEntry): number {
  if (left.lastAccess !== right.lastAccess) return left.lastAccess - right.lastAccess;
  return left.key.localeCompare(right.key);
}

export class EditorModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly options: EditorModelRegistryOptions;
  private sequence = 0;

  constructor(options: Partial<EditorModelRegistryOptions> = {}) {
    this.options = {
      countBudget: safeBudget(options.countBudget ?? DEFAULT_COUNT_BUDGET, DEFAULT_COUNT_BUDGET),
      byteBudget: safeBudget(options.byteBudget ?? DEFAULT_BYTE_BUDGET, DEFAULT_BYTE_BUDGET),
    };
  }

  attach(input: RetainedEditorModelAttachInput): RetainedEditorModelAttachment {
    const entry = this.entryFor(input);
    entry.attachmentCount += 1;
    entry.lastAccess = this.nextAccess();
    entry.protection = { ...input.protection, active: true };
    this.bindEditor(input.editor, entry, input.viewStateKey);
    this.enforceBudgets();
    return {
      key: input.key,
      model: entry.model,
      detach: (): void => {
        this.detach(input.key, input.editor, input.viewStateKey);
      },
    };
  }

  updateProtection(key: string, protection: EditorModelProtection): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.disposed) return;
    entry.protection = { ...protection, active: entry.attachmentCount > 0 || protection.active };
    entry.lastAccess = this.nextAccess();
    this.enforceBudgets();
  }

  disposeRoot(rootKey: string, reason: EditorModelDisposalReason = "root-disposed"): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.rootKey === rootKey && entry.attachmentCount === 0) {
        this.disposeEntry(entry, reason);
      }
    }
  }

  disposeAll(reason: EditorModelDisposalReason = "shutdown"): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.attachmentCount === 0) this.disposeEntry(entry, reason);
    }
  }

  diagnostics(): EditorModelRegistryDiagnostics {
    const entries = [...this.entries.values()].filter((entry) => !entry.disposed);
    const estimatedBytes = entries.reduce((total, entry) => total + entry.estimatedBytes, 0);
    return {
      schemaVersion: "1",
      liveModelCount: entries.length,
      attachedModelCount: entries.filter((entry) => entry.attachmentCount > 0).length,
      estimatedBytes,
      countBudget: this.options.countBudget,
      byteBudget: this.options.byteBudget,
      pressure: this.pressure(entries, estimatedBytes),
      entries: entries.map((entry) => ({
        identityHash: fnv1a32(entry.key),
        rootHash: fnv1a32(entry.rootKey),
        attachmentCount: entry.attachmentCount,
        estimatedBytes: entry.estimatedBytes,
        protected: protectedEntry(entry),
        dirty: entry.protection.dirty,
        active: entry.attachmentCount > 0,
        degraded: entry.degraded,
        lastAccess: entry.lastAccess,
      })),
    };
  }

  private entryFor(input: RetainedEditorModelAttachInput): RegistryEntry {
    const existing = this.entries.get(input.key);
    if (existing !== undefined && !existing.disposed) {
      this.updateEntry(existing, input);
      return existing;
    }
    const model =
      input.namespace.getModel(input.uri) ??
      input.namespace.createModel(input.text, input.language, input.uri);
    if (model.getValue() !== input.text) model.setValue?.(input.text);
    const entry = this.createEntry(input, model);
    this.entries.set(input.key, entry);
    return entry;
  }

  private createEntry(
    input: RetainedEditorModelAttachInput,
    model: RetainedEditorModel,
  ): RegistryEntry {
    return {
      key: input.key,
      rootKey: input.rootKey,
      uriString: input.uri.toString(),
      model,
      viewStates: new Map<string, unknown>(),
      attachmentCount: 0,
      estimatedBytes: estimateEditorModelBytes(input),
      lastAccess: this.nextAccess(),
      degraded: input.degraded,
      protection: input.protection,
      disposed: false,
      disposalReason: null,
    };
  }

  private updateEntry(entry: RegistryEntry, input: RetainedEditorModelAttachInput): void {
    entry.estimatedBytes = estimateEditorModelBytes(input);
    entry.degraded = input.degraded;
    const preserveDirtyBuffer = entry.protection.dirty && input.protection.dirty;
    if (
      entry.attachmentCount === 0 &&
      !preserveDirtyBuffer &&
      entry.model.getValue() !== input.text
    ) {
      entry.model.setValue?.(input.text);
    }
  }

  private bindEditor(
    editor: RetainedEditorModelEditor,
    entry: RegistryEntry,
    viewStateKey: string,
  ): void {
    const current = editor.getModel?.();
    if (current !== entry.model) {
      editor.setModel?.(entry.model);
    }
    const viewState = entry.viewStates.get(viewStateKey);
    if (viewState !== undefined) editor.restoreViewState(viewState);
  }

  private detach(key: string, editor: RetainedEditorModelEditor, viewStateKey: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.disposed) return;
    const viewState = editor.saveViewState();
    if (viewState !== null) entry.viewStates.set(viewStateKey, viewState);
    if (editor.getModel?.() === entry.model) editor.setModel?.(null);
    entry.attachmentCount = Math.max(0, entry.attachmentCount - 1);
    entry.protection = { ...entry.protection, active: entry.attachmentCount > 0 };
    entry.lastAccess = this.nextAccess();
    this.enforceBudgets();
  }

  private nextAccess(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private totalBytes(): number {
    return [...this.entries.values()].reduce(
      (total, entry) => (entry.disposed ? total : total + entry.estimatedBytes),
      0,
    );
  }

  private liveEntries(): RegistryEntry[] {
    return [...this.entries.values()].filter((entry) => !entry.disposed);
  }

  private pressure(
    entries: readonly RegistryEntry[],
    estimatedBytes: number,
  ): "healthy" | "degraded" {
    return entries.length > this.options.countBudget || estimatedBytes > this.options.byteBudget
      ? "degraded"
      : "healthy";
  }

  private enforceBudgets(): void {
    while (
      this.liveEntries().length > this.options.countBudget ||
      this.totalBytes() > this.options.byteBudget
    ) {
      const candidate = this.liveEntries()
        .filter((entry) => !protectedEntry(entry))
        .sort(compareEvictionCandidates)[0];
      if (candidate === undefined) return;
      const reason =
        this.liveEntries().length > this.options.countBudget ? "count-budget" : "byte-budget";
      this.disposeEntry(candidate, reason);
    }
  }

  private disposeEntry(entry: RegistryEntry, reason: EditorModelDisposalReason): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.disposalReason = reason;
    this.entries.delete(entry.key);
    if (!modelDisposed(entry.model)) entry.model.dispose();
  }
}

const sharedRegistry = new EditorModelRegistry();

export function attachRetainedEditorModel(
  input: RetainedEditorModelAttachInput,
): RetainedEditorModelAttachment {
  return sharedRegistry.attach(input);
}

export function updateRetainedEditorModelProtection(
  key: string,
  protection: EditorModelProtection,
): void {
  sharedRegistry.updateProtection(key, protection);
}

export function getEditorModelRegistryDiagnostics(): EditorModelRegistryDiagnostics {
  return sharedRegistry.diagnostics();
}

export function resetEditorModelRegistryForTests(): void {
  sharedRegistry.disposeAll("shutdown");
}
