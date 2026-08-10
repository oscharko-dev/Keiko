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
  // Undo-preserving programmatic writes (#3070): the registry replaces retained content through
  // the edit-operations API so the model's undo history survives; `setValue` (which clears that
  // history) remains only the fallback for models without it.
  getFullModelRange?(): RetainedEditorModelRange;
  pushEditOperations?(
    beforeCursorState: null,
    edits: { readonly range: RetainedEditorModelRange; readonly text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
  pushStackElement?(): void;
}

export interface RetainedEditorModelRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

// The minimal structural surface an undo-preserving whole-model write needs. Both the retained
// registry models and the live editor's `getModel()` view satisfy it, so the controlled value
// sync and the registry share one implementation.
export interface UndoPreservingWritableModel {
  getValue(): string;
  setValue?(text: string): void;
  getFullModelRange?(): RetainedEditorModelRange;
  pushEditOperations?(
    beforeCursorState: null,
    edits: { readonly range: RetainedEditorModelRange; readonly text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
  pushStackElement?(): void;
}

/**
 * Replace a model's content while preserving its undo history: one undo-stop pair around one
 * whole-model edit operation, so a single keyboard undo returns to the pre-write buffer
 * (#1394 pin, #3070). `setValue` — which clears the undo history — remains only the fallback
 * for models without the edit-operations API.
 */
export function writeRetainedEditorModelValue(
  model: UndoPreservingWritableModel,
  text: string,
): void {
  const fullRange = model.getFullModelRange?.();
  if (fullRange !== undefined && model.pushEditOperations !== undefined) {
    model.pushStackElement?.();
    model.pushEditOperations(null, [{ range: fullRange, text }], () => null);
    model.pushStackElement?.();
  } else {
    model.setValue?.(text);
  }
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
  readonly rootKey: string;
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
  readonly identity: string;
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

export class EditorModelOwnershipError extends Error {
  constructor() {
    super("Retained editor model ownership conflicts with the workspace root.");
    this.name = "EditorModelOwnershipError";
  }
}

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
    const code = value.codePointAt(index) ?? 0;
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    if (code > 0xffff) index += 1;
  }
  return hash.toString(16).padStart(8, "0");
}

function modelDisposed(model: RetainedEditorModel): boolean {
  return model.isDisposed?.() === true;
}

function expectedEditorDetachCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "Canceled" && error.message === "Canceled";
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
  return left.identity.localeCompare(right.identity);
}

function registryIdentity(rootKey: string, key: string): string {
  return `${String(rootKey.length)}:${rootKey}${key}`;
}

export class EditorModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private options: EditorModelRegistryOptions;
  private sequence = 0;

  constructor(options: Partial<EditorModelRegistryOptions> = {}) {
    this.options = {
      countBudget: safeBudget(options.countBudget ?? DEFAULT_COUNT_BUDGET, DEFAULT_COUNT_BUDGET),
      byteBudget: safeBudget(options.byteBudget ?? DEFAULT_BYTE_BUDGET, DEFAULT_BYTE_BUDGET),
    };
  }

  // Applies the effective `modelRetentionCount`/`modelRetentionBytes` settings live. Shrinking a
  // budget evicts down to the new ceiling immediately rather than waiting for the next attach.
  configure(options: Partial<EditorModelRegistryOptions>): void {
    this.options = {
      countBudget: safeBudget(
        options.countBudget ?? this.options.countBudget,
        DEFAULT_COUNT_BUDGET,
      ),
      byteBudget: safeBudget(options.byteBudget ?? this.options.byteBudget, DEFAULT_BYTE_BUDGET),
    };
    this.enforceBudgets();
  }

  attach(input: RetainedEditorModelAttachInput): RetainedEditorModelAttachment {
    let entry: RegistryEntry;
    try {
      entry = this.entryFor(input);
    } catch (error: unknown) {
      if (!(error instanceof EditorModelOwnershipError)) throw error;
      input.editor.setModel?.(null);
      throw error;
    }
    entry.attachmentCount += 1;
    entry.lastAccess = this.nextAccess();
    entry.protection = { ...input.protection, active: true };
    this.bindEditor(input.editor, entry, input.viewStateKey);
    this.enforceBudgets();
    return {
      key: input.key,
      rootKey: input.rootKey,
      model: entry.model,
      detach: (): void => {
        this.detach(entry.identity, input.editor, input.viewStateKey);
      },
    };
  }

  updateProtection(key: string, protection: EditorModelProtection, rootKey?: string): void {
    const entry = this.entryForProtectionUpdate(key, rootKey);
    if (entry === undefined || entry.disposed) return;
    entry.protection = { ...protection, active: entry.attachmentCount > 0 || protection.active };
    entry.lastAccess = this.nextAccess();
    this.enforceBudgets();
  }

  disposeRoot(
    rootKey: string,
    reason: EditorModelDisposalReason = "root-disposed",
    force = false,
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.rootKey === rootKey && (force || !protectedEntry(entry))) {
        this.disposeEntry(entry, reason);
      }
    }
  }

  disposeAll(reason: EditorModelDisposalReason = "shutdown"): void {
    for (const entry of this.entries.values()) {
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
    const identity = registryIdentity(input.rootKey, input.key);
    const existing = this.entries.get(identity);
    if (existing !== undefined && !existing.disposed) {
      this.updateEntry(existing, input);
      return existing;
    }
    this.releaseSafeUriConflicts(input.uri.toString(), identity);
    const namespaceModel = input.namespace.getModel(input.uri);
    if (namespaceModel !== null && input.editor.getModel?.() !== namespaceModel) {
      throw new EditorModelOwnershipError();
    }
    const model =
      namespaceModel ?? input.namespace.createModel(input.text, input.language, input.uri);
    if (model.getValue() !== input.text) writeRetainedEditorModelValue(model, input.text);
    const entry = this.createEntry(identity, input, model);
    this.entries.set(identity, entry);
    return entry;
  }

  private createEntry(
    identity: string,
    input: RetainedEditorModelAttachInput,
    model: RetainedEditorModel,
  ): RegistryEntry {
    return {
      identity,
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

  private releaseSafeUriConflicts(uriString: string, identity: string): void {
    const conflicts = this.liveEntries().filter(
      (entry) => entry.identity !== identity && entry.uriString === uriString,
    );
    if (conflicts.some(protectedEntry)) throw new EditorModelOwnershipError();
    for (const conflict of conflicts) this.disposeEntry(conflict, "identity-reused");
  }

  private entryForProtectionUpdate(
    key: string,
    rootKey: string | undefined,
  ): RegistryEntry | undefined {
    if (rootKey !== undefined) return this.entries.get(registryIdentity(rootKey, key));
    const matches = this.liveEntries().filter((entry) => entry.key === key);
    return matches.length === 1 ? matches[0] : undefined;
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
      // Re-attach with newer host content (e.g. the editor remounting after an accepted agent
      // review, #3070): the retained model's undo history is the whole point of retention, so
      // the catch-up write must stay undoable — `setValue` here silently discarded the stack
      // and a keyboard undo after the accept did nothing.
      writeRetainedEditorModelValue(entry.model, input.text);
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

  private detach(identity: string, editor: RetainedEditorModelEditor, viewStateKey: string): void {
    const entry = this.entries.get(identity);
    if (entry === undefined || entry.disposed) return;
    const stillBound = editor.getModel?.() === entry.model;
    if (stillBound) {
      const viewState = editor.saveViewState();
      if (viewState !== null) entry.viewStates.set(viewStateKey, viewState);
      try {
        editor.setModel?.(null);
      } catch (error: unknown) {
        if (!expectedEditorDetachCancellation(error)) throw error;
      }
    }
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
    this.entries.delete(entry.identity);
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
  rootKey?: string,
): void {
  sharedRegistry.updateProtection(key, protection, rootKey);
}

export function getEditorModelRegistryDiagnostics(): EditorModelRegistryDiagnostics {
  return sharedRegistry.diagnostics();
}

// Applies the effective `modelRetentionCount`/`modelRetentionBytes` M7 settings to the shared
// registry. Safe to call on every settings snapshot; a no-op reconfigure just re-enforces budgets.
export function configureEditorModelRegistry(options: Partial<EditorModelRegistryOptions>): void {
  sharedRegistry.configure(options);
}

// Releases every currently unattached (zero attachment count) model owned by `rootKey`. Call this
// when a workspace root is closed/replaced so retained-but-inactive models do not linger until an
// unrelated budget eviction happens to reclaim them.
export function disposeEditorModelRegistryRoot(
  rootKey: string,
  reason: EditorModelDisposalReason = "root-disposed",
  force = false,
): void {
  sharedRegistry.disposeRoot(rootKey, reason, force);
}

// Releases every currently unattached model regardless of root at final editor-window shutdown.
// Root switches use `disposeEditorModelRegistryRoot` so sibling workspace ownership remains intact.
export function disposeAllUnattachedEditorModels(
  reason: EditorModelDisposalReason = "root-disposed",
): void {
  sharedRegistry.disposeAll(reason);
}

export function resetEditorModelRegistryForTests(): void {
  sharedRegistry.disposeAll("shutdown");
}
