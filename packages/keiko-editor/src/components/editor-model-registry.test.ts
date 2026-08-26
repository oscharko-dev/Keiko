import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EditorModelRegistry,
  UNPROTECTED_EDITOR_MODEL,
  attachRetainedEditorModel,
  configureEditorModelRegistry,
  disposeAllUnattachedEditorModels,
  disposeEditorModelRegistryRoot,
  estimateEditorModelBytes,
  getEditorModelRegistryDiagnostics,
  resetEditorModelRegistryForTests,
  updateRetainedEditorModelProtection,
  type RetainedEditorModel,
  type RetainedEditorModelEditor,
  type RetainedEditorModelNamespace,
  type RetainedEditorUri,
} from "./editor-model-registry.js";

class FakeUri implements RetainedEditorUri {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

class FakeModel implements RetainedEditorModel {
  disposed = false;
  readonly dispose = vi.fn(() => {
    if (this.disposed) throw new Error("disposed twice");
    this.disposed = true;
  });

  constructor(
    readonly uri: RetainedEditorUri,
    private text: string,
  ) {}

  getValue(): string {
    return this.text;
  }

  setValue(text: string): void {
    this.text = text;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

class MinimalModel implements RetainedEditorModel {
  readonly uri: RetainedEditorUri;
  readonly dispose = vi.fn();

  constructor(uri: RetainedEditorUri) {
    this.uri = uri;
  }

  getValue(): string {
    return "minimal";
  }
}

class FakeNamespace implements RetainedEditorModelNamespace {
  readonly created: FakeModel[] = [];

  createModel(text: string, _language: string, uri: RetainedEditorUri): RetainedEditorModel {
    const model = new FakeModel(uri, text);
    this.created.push(model);
    return model;
  }

  getModel(uri: RetainedEditorUri): RetainedEditorModel | null {
    return (
      this.created.find((model) => model.uri.toString() === uri.toString() && !model.disposed) ??
      null
    );
  }
}

class FakeEditor implements RetainedEditorModelEditor {
  model: RetainedEditorModel | null = null;
  viewState: unknown = null;
  readonly setModelCalls: (RetainedEditorModel | null)[] = [];

  getModel(): RetainedEditorModel | null {
    return this.model;
  }

  setModel(model: RetainedEditorModel | null): void {
    this.model = model;
    this.setModelCalls.push(model);
  }

  saveViewState(): unknown {
    return this.viewState;
  }

  restoreViewState(state: unknown): void {
    this.viewState = state;
  }
}

class CancelingDetachEditor extends FakeEditor {
  override setModel(model: RetainedEditorModel | null): void {
    if (model === null) {
      this.model = null;
      const error = new Error("Canceled");
      error.name = "Canceled";
      throw error;
    }
    super.setModel(model);
  }
}

// A retained model with the edit-operations API: undo-preserving writes must use it instead of
// `setValue` (which clears the undo history) whenever it is available (#3070).
class UndoCapableModel implements RetainedEditorModel {
  disposed = false;
  readonly dispose = vi.fn(() => {
    this.disposed = true;
  });
  readonly setValue = vi.fn((text: string): void => {
    this.text = text;
  });
  readonly pushStackElement = vi.fn();
  readonly pushEditOperations = vi.fn(
    (_cursorState: null, edits: { readonly text: string }[]): null => {
      const text = edits[0]?.text;
      if (text !== undefined) this.text = text;
      return null;
    },
  );

  constructor(
    readonly uri: RetainedEditorUri,
    private text: string,
  ) {}

  getValue(): string {
    return this.text;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getFullModelRange(): {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } {
    const lines = this.text.split("\n");
    return {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: Math.max(1, lines.length),
      endColumn: (lines.at(-1)?.length ?? 0) + 1,
    };
  }
}

class UndoCapableNamespace implements RetainedEditorModelNamespace {
  readonly created: UndoCapableModel[] = [];

  createModel(text: string, _language: string, uri: RetainedEditorUri): RetainedEditorModel {
    const model = new UndoCapableModel(uri, text);
    this.created.push(model);
    return model;
  }

  getModel(uri: RetainedEditorUri): RetainedEditorModel | null {
    return (
      this.created.find((model) => model.uri.toString() === uri.toString() && !model.disposed) ??
      null
    );
  }
}

function uri(path: string): RetainedEditorUri {
  return new FakeUri(`keiko-editor://workspace/${path}`);
}

function attach(
  registry: EditorModelRegistry,
  namespace: FakeNamespace,
  path: string,
  rootKey = "scope:/repo",
  viewStateKey = `pane:${path}`,
): { readonly attachment: ReturnType<EditorModelRegistry["attach"]>; readonly editor: FakeEditor } {
  const editor = new FakeEditor();
  const attachment = registry.attach({
    key: `${rootKey}:${path}`,
    rootKey,
    uri: uri(path),
    language: "typescript",
    text: `// ${path}\n`,
    sizeBytes: 32,
    degraded: false,
    viewStateKey,
    namespace,
    editor,
    protection: UNPROTECTED_EDITOR_MODEL,
  });
  return { attachment, editor };
}

describe("EditorModelRegistry", () => {
  it("re-attaches a clean retained model with newer text undo-preservingly, never via setValue (#3070)", () => {
    // The editor unmounts across an agent-review accept and re-attaches with the host's newer
    // buffer text. The retained model's undo history is the point of retention: the catch-up
    // write must be one undoable whole-model operation — `setValue` silently discarded the
    // stack, so a keyboard undo after the accept did nothing.
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new UndoCapableNamespace();
    const modelUri = uri("src/reviewed.ts");
    const attachInput = {
      key: "scope:/repo:src/reviewed.ts",
      rootKey: "scope:/repo",
      uri: modelUri,
      language: "typescript",
      sizeBytes: 32,
      degraded: false,
      viewStateKey: "pane:src/reviewed.ts",
      namespace,
      protection: UNPROTECTED_EDITOR_MODEL,
    };
    const firstEditor = new FakeEditor();
    const first = registry.attach({ ...attachInput, editor: firstEditor, text: "original\n" });
    first.detach();

    const secondEditor = new FakeEditor();
    const second = registry.attach({ ...attachInput, editor: secondEditor, text: "modified\n" });

    expect(second.model).toBe(first.model);
    const model = namespace.created[0];
    expect(model?.getValue()).toBe("modified\n");
    expect(model?.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(model?.pushStackElement).toHaveBeenCalledTimes(2);
    expect(model?.setValue).not.toHaveBeenCalled();
  });

  it("uses one live model per canonical identity and reference-counts split attachments", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();

    const first = attach(registry, namespace, "src/app.ts");
    const second = attach(registry, namespace, "src/app.ts");

    expect(first.attachment.model).toBe(second.attachment.model);
    expect(namespace.created).toHaveLength(1);
    expect(registry.diagnostics().entries[0]).toMatchObject({ attachmentCount: 2 });

    first.attachment.detach();
    expect(namespace.created[0]?.dispose).not.toHaveBeenCalled();
    second.attachment.detach();
    expect(registry.diagnostics().entries[0]).toMatchObject({ attachmentCount: 0 });
  });

  it("completes registry detach when Monaco reports its expected disposal cancellation", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const editor = new CancelingDetachEditor();
    const attachment = registry.attach({
      key: "scope:/repo:src/app.ts",
      rootKey: "scope:/repo",
      uri: uri("src/app.ts"),
      language: "typescript",
      text: "const value = 1;\n",
      sizeBytes: 17,
      degraded: false,
      viewStateKey: "pane:src/app.ts",
      namespace,
      editor,
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(() => {
      attachment.detach();
    }).not.toThrow();
    expect(registry.diagnostics().entries[0]).toMatchObject({ attachmentCount: 0 });
  });

  it("evicts clean inactive models in deterministic LRU order and disposes exactly once", () => {
    const registry = new EditorModelRegistry({ countBudget: 2, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();

    const first = attach(registry, namespace, "a.ts");
    first.attachment.detach();
    const second = attach(registry, namespace, "b.ts");
    second.attachment.detach();
    const third = attach(registry, namespace, "c.ts");
    third.attachment.detach();

    expect(
      namespace.created.map((model) => [model.uri.toString(), model.dispose.mock.calls.length]),
    ).toEqual([
      ["keiko-editor://workspace/a.ts", 1],
      ["keiko-editor://workspace/b.ts", 0],
      ["keiko-editor://workspace/c.ts", 0],
    ]);
    expect(registry.diagnostics().liveModelCount).toBe(2);
  });

  it("evicts clean candidates before protected models", () => {
    const registry = new EditorModelRegistry({ countBudget: 1, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();

    const protectedAttachment = registry.attach({
      key: "scope:/repo:dirty.ts",
      rootKey: "scope:/repo",
      uri: uri("dirty.ts"),
      language: "typescript",
      text: "dirty\n",
      sizeBytes: 6,
      degraded: false,
      viewStateKey: "pane:dirty",
      namespace,
      editor: new FakeEditor(),
      protection: { ...UNPROTECTED_EDITOR_MODEL, dirty: true },
    });
    protectedAttachment.detach();
    const clean = attach(registry, namespace, "clean.ts");
    clean.attachment.detach();

    expect(registry.diagnostics()).toMatchObject({ liveModelCount: 1, pressure: "healthy" });
    expect(namespace.created[0]?.dispose).not.toHaveBeenCalled();
    expect(namespace.created[1]?.dispose).toHaveBeenCalledOnce();
  });

  it("reports degraded pressure instead of evicting when only protected models remain", () => {
    const registry = new EditorModelRegistry({ countBudget: 1, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const first = attach(registry, namespace, "dirty.ts");
    registry.updateProtection(first.attachment.key, { ...UNPROTECTED_EDITOR_MODEL, dirty: true });
    first.attachment.detach();
    const second = attach(registry, namespace, "pinned.ts");
    registry.updateProtection(second.attachment.key, { ...UNPROTECTED_EDITOR_MODEL, pinned: true });
    second.attachment.detach();

    expect(registry.diagnostics()).toMatchObject({ liveModelCount: 2, pressure: "degraded" });
    expect(namespace.created.every((model) => model.dispose.mock.calls.length === 0)).toBe(true);
  });

  it("enforces one shared model budget across workspace roots", () => {
    const registry = new EditorModelRegistry({ countBudget: 2, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const rootA = attach(registry, namespace, "a.ts", "scope:/repo-a");
    rootA.attachment.detach();
    const rootB = attach(registry, namespace, "b.ts", "scope:/repo-b");
    rootB.attachment.detach();
    const rootC = attach(registry, namespace, "c.ts", "scope:/repo-c");
    rootC.attachment.detach();

    expect(registry.diagnostics()).toMatchObject({ liveModelCount: 2, pressure: "healthy" });
    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[1]?.dispose).not.toHaveBeenCalled();
    expect(namespace.created[2]?.dispose).not.toHaveBeenCalled();
  });

  it("forcibly disposes protected models only when a workspace root is removed", () => {
    const registry = new EditorModelRegistry({ countBudget: 4, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const retained = attach(registry, namespace, "dirty.ts", "scope:/removed");
    registry.updateProtection(retained.attachment.key, {
      ...UNPROTECTED_EDITOR_MODEL,
      dirty: true,
    });
    retained.attachment.detach();

    registry.disposeRoot("scope:/removed");
    expect(registry.diagnostics().liveModelCount).toBe(1);
    registry.disposeRoot("scope:/removed", "root-disposed", true);
    expect(registry.diagnostics().liveModelCount).toBe(0);
    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("uses conservative large-file byte estimates so degraded files cannot hide pressure", () => {
    expect(
      estimateEditorModelBytes({
        text: "x",
        sizeBytes: 16 * 1024 * 1024,
        degraded: true,
      }),
    ).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("captures and restores view state by attachment key without exposing file paths in diagnostics", () => {
    const registry = new EditorModelRegistry({ countBudget: 4, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const first = attach(registry, namespace, "src/app.ts");
    first.editor.viewState = { cursor: 12 };
    first.attachment.detach();

    const second = attach(registry, namespace, "src/app.ts");

    expect(second.editor.viewState).toEqual({ cursor: 12 });
    expect(JSON.stringify(registry.diagnostics())).not.toContain("src/app.ts");
  });

  it("does not save another model's view state while detaching a stale attachment", () => {
    const registry = new EditorModelRegistry({ countBudget: 4, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const stale = attach(registry, namespace, "src/old.ts");
    const replacement = namespace.createModel("new\n", "typescript", uri("src/new.ts"));
    stale.editor.model = replacement;
    stale.editor.viewState = { cursor: 99 };

    stale.attachment.detach();
    const reopened = attach(registry, namespace, "src/old.ts");

    expect(reopened.editor.viewState).toBeNull();
    expect(stale.editor.model).toBe(replacement);
  });

  it("falls back to safe budgets and survives stale protection updates", () => {
    const registry = new EditorModelRegistry({ countBudget: 0, byteBudget: Number.NaN });
    registry.updateProtection("missing", { ...UNPROTECTED_EDITOR_MODEL, dirty: true });

    expect(registry.diagnostics()).toMatchObject({
      countBudget: 16,
      byteBudget: 128 * 1024 * 1024,
    });
  });

  it("refreshes inactive models unless both retained and incoming buffers are dirty", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const clean = attach(registry, namespace, "clean.ts");
    clean.attachment.detach();

    registry.attach({
      key: clean.attachment.key,
      rootKey: "scope:/repo",
      uri: uri("clean.ts"),
      language: "typescript",
      text: "updated\n",
      sizeBytes: 8,
      degraded: false,
      viewStateKey: "pane:clean",
      namespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(namespace.created[0]?.getValue()).toBe("updated\n");

    const reloaded = attach(registry, namespace, "dirty-reloaded.ts");
    registry.updateProtection(reloaded.attachment.key, {
      ...UNPROTECTED_EDITOR_MODEL,
      dirty: true,
    });
    reloaded.attachment.detach();
    registry.attach({
      key: reloaded.attachment.key,
      rootKey: "scope:/repo",
      uri: uri("dirty-reloaded.ts"),
      language: "typescript",
      text: "disk-copy\n",
      sizeBytes: 10,
      degraded: false,
      viewStateKey: "pane:dirty-reloaded",
      namespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(namespace.created[1]?.getValue()).toBe("disk-copy\n");

    const dirty = attach(registry, namespace, "dirty-preserved.ts");
    registry.updateProtection(dirty.attachment.key, { ...UNPROTECTED_EDITOR_MODEL, dirty: true });
    dirty.attachment.detach();
    registry.attach({
      key: dirty.attachment.key,
      rootKey: "scope:/repo",
      uri: uri("dirty-preserved.ts"),
      language: "typescript",
      text: "server-copy\n",
      sizeBytes: 12,
      degraded: false,
      viewStateKey: "pane:dirty",
      namespace,
      editor: new FakeEditor(),
      protection: { ...UNPROTECTED_EDITOR_MODEL, dirty: true },
    });

    expect(namespace.created[2]?.getValue()).toBe("// dirty-preserved.ts\n");
  });

  it("syncs host text when adopting an existing Monaco namespace model", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const modelUri = uri("adopted.ts");
    const existing = namespace.createModel("stale namespace text\n", "typescript", modelUri);
    const editor = new FakeEditor();
    editor.model = existing;

    const attachment = registry.attach({
      key: "scope:/repo:adopted.ts",
      rootKey: "scope:/repo",
      uri: modelUri,
      language: "typescript",
      text: "host text\n",
      sizeBytes: 10,
      degraded: false,
      viewStateKey: "pane:adopted",
      namespace,
      editor,
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(attachment.model).toBe(existing);
    expect(existing.getValue()).toBe("host text\n");
  });

  it("fails closed when a dirty retained model collides with another root's public URI", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const sharedUri = uri("collision/src/app.ts");
    const oldEditor = new FakeEditor();
    const oldRoot = registry.attach({
      key: sharedUri.toString(),
      rootKey: "/workspace/root-a",
      uri: sharedUri,
      language: "typescript",
      text: "dirty root A\n",
      sizeBytes: 13,
      degraded: false,
      viewStateKey: "pane:a",
      namespace,
      editor: oldEditor,
      protection: { ...UNPROTECTED_EDITOR_MODEL, dirty: true },
    });
    oldRoot.detach();
    const newEditor = new FakeEditor();
    newEditor.model = oldRoot.model;

    expect(() =>
      registry.attach({
        key: sharedUri.toString(),
        rootKey: "/workspace/root-b",
        uri: sharedUri,
        language: "typescript",
        text: "clean root B\n",
        sizeBytes: 13,
        degraded: false,
        viewStateKey: "pane:b",
        namespace,
        editor: newEditor,
        protection: UNPROTECTED_EDITOR_MODEL,
      }),
    ).toThrow(/workspace root/iu);

    expect(newEditor.model).toBeNull();
    expect(oldRoot.model.getValue()).toBe("dirty root A\n");
    expect(namespace.created[0]?.dispose).not.toHaveBeenCalled();
    expect(registry.diagnostics()).toMatchObject({ liveModelCount: 1, attachedModelCount: 0 });
  });

  it("recreates a clean retained model before reusing a colliding URI for another root", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const sharedUri = uri("collision/src/app.ts");
    const oldRoot = registry.attach({
      key: sharedUri.toString(),
      rootKey: "/workspace/root-a",
      uri: sharedUri,
      language: "typescript",
      text: "clean root A\n",
      sizeBytes: 13,
      degraded: false,
      viewStateKey: "pane:a",
      namespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });
    oldRoot.detach();
    const newEditor = new FakeEditor();
    newEditor.model = oldRoot.model;

    const newRoot = registry.attach({
      key: sharedUri.toString(),
      rootKey: "/workspace/root-b",
      uri: sharedUri,
      language: "typescript",
      text: "clean root B\n",
      sizeBytes: 13,
      degraded: false,
      viewStateKey: "pane:b",
      namespace,
      editor: newEditor,
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(newRoot.model).not.toBe(oldRoot.model);
    expect(newEditor.model).toBe(newRoot.model);
    expect(newRoot.model.getValue()).toBe("clean root B\n");
    expect(namespace.created).toHaveLength(2);
    expect(registry.diagnostics()).toMatchObject({ liveModelCount: 1, attachedModelCount: 1 });
  });

  it("disposes by root and all inactive models with default reasons", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const first = attach(registry, namespace, "first.ts");
    first.attachment.detach();
    const second = attach(registry, namespace, "second.ts");
    second.attachment.detach();
    const attached = attach(registry, namespace, "attached.ts");

    registry.disposeRoot("scope:/repo");
    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[1]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[2]?.dispose).not.toHaveBeenCalled();

    attached.attachment.detach();
    registry.disposeAll();
    expect(namespace.created[2]?.dispose).toHaveBeenCalledOnce();
  });

  it("disposes only clean unattached models owned by a switched root across sibling panes", () => {
    const registry = new EditorModelRegistry({ countBudget: 16, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const clean = attach(registry, namespace, "clean.ts", "scope:/repo-a");
    clean.attachment.detach();
    const dirty = attach(registry, namespace, "dirty.ts", "scope:/repo-a");
    registry.updateProtection(dirty.attachment.key, {
      ...UNPROTECTED_EDITOR_MODEL,
      dirty: true,
    });
    dirty.attachment.detach();
    const pinned = attach(registry, namespace, "pinned.ts", "scope:/repo-a");
    registry.updateProtection(pinned.attachment.key, {
      ...UNPROTECTED_EDITOR_MODEL,
      pinned: true,
    });
    pinned.attachment.detach();
    const firstPane = attach(registry, namespace, "shared.ts", "scope:/repo-a", "pane:first");
    const siblingPane = attach(registry, namespace, "shared.ts", "scope:/repo-a", "pane:sibling");
    firstPane.attachment.detach();
    const siblingRoot = attach(registry, namespace, "other.ts", "scope:/repo-b");
    siblingRoot.attachment.detach();

    registry.disposeRoot("scope:/repo-a");

    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[1]?.dispose).not.toHaveBeenCalled();
    expect(namespace.created[2]?.dispose).not.toHaveBeenCalled();
    expect(namespace.created[3]?.dispose).not.toHaveBeenCalled();
    expect(namespace.created[4]?.dispose).not.toHaveBeenCalled();
    expect(registry.diagnostics()).toMatchObject({
      liveModelCount: 4,
      attachedModelCount: 1,
    });

    siblingPane.attachment.detach();
    registry.disposeRoot("scope:/repo-a");

    expect(namespace.created[3]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[4]?.dispose).not.toHaveBeenCalled();
  });

  it("evicts by byte budget and disposes minimal models without optional status hooks", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 10_000 });
    const namespace = new FakeNamespace();
    const first = attach(registry, namespace, "large-a.ts");
    first.attachment.detach();
    const second = attach(registry, namespace, "large-b.ts");
    second.attachment.detach();

    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(registry.diagnostics().liveModelCount).toBe(1);

    const minimalNamespace: RetainedEditorModelNamespace = {
      createModel: (_text, _language, modelUri) => new MinimalModel(modelUri),
      getModel: () => null,
    };
    const minimal = registry.attach({
      key: "scope:/repo:minimal.ts",
      rootKey: "scope:/repo",
      uri: uri("minimal.ts"),
      language: "typescript",
      text: "minimal",
      sizeBytes: 7,
      degraded: false,
      viewStateKey: "pane:minimal",
      namespace: minimalNamespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });
    minimal.detach();
    registry.disposeAll("shutdown");
    expect((minimal.model as MinimalModel).dispose).toHaveBeenCalledOnce();
  });

  it("does not dispose a retained model twice when Monaco already disposed it", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const retained = attach(registry, namespace, "already-disposed.ts");
    retained.attachment.detach();
    namespace.created[0]?.dispose();

    registry.disposeAll("shutdown");

    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("never disposes a model that is still attached, even without protection flags", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const stillOpen = attach(registry, namespace, "still-open.ts");

    registry.disposeAll();

    expect(namespace.created[0]?.dispose).not.toHaveBeenCalled();

    stillOpen.attachment.detach();
    registry.disposeAll();

    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("hashes keys containing astral characters without truncating the surrogate pair", () => {
    // KEIKO-0680: the format-only /^[0-9a-f]{8}$/ assertion is unconditional — `fnv1a32` always
    // returns eight hex chars regardless of whether the surrogate-pair skip is present. Strengthen
    // with two discriminating assertions: (1) equivalence — the astral construction via the
    // code-point escape must produce the SAME identityHash as the raw UTF-16 surrogate-pair escape
    // (they are the same JS string, so this proves the test harness constructs what it claims);
    // (2) surrogate-pair vs lone-surrogate — a key containing only the lone high surrogate must
    // produce a DIFFERENT identityHash than the paired form, proving the hash sees the surrogate
    // structure at all rather than collapsing every non-ASCII to the same digest.
    const pairViaCodePoint = "notes-\u{1F600}.ts";
    const pairViaSurrogates = "notes-😀.ts";
    const loneHighSurrogate = "notes-\uD83D.ts";

    const registry1 = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace1 = new FakeNamespace();
    const emojiA = attach(registry1, namespace1, pairViaCodePoint);
    const pairHashA = registry1.diagnostics().entries[0]?.identityHash;
    expect(pairHashA).toMatch(/^[0-9a-f]{8}$/);
    emojiA.attachment.detach();

    const registry2 = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace2 = new FakeNamespace();
    const emojiB = attach(registry2, namespace2, pairViaSurrogates);
    const pairHashB = registry2.diagnostics().entries[0]?.identityHash;
    expect(pairHashB).toBe(pairHashA);
    emojiB.attachment.detach();

    const registry3 = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace3 = new FakeNamespace();
    const emojiC = attach(registry3, namespace3, loneHighSurrogate);
    const loneHash = registry3.diagnostics().entries[0]?.identityHash;
    expect(loneHash).not.toBe(pairHashA);
    emojiC.attachment.detach();
  });
});

describe("EditorModelRegistry.configure", () => {
  it("evicts immediately when a shrinking count budget is applied", () => {
    const registry = new EditorModelRegistry({ countBudget: 8, byteBudget: 1_000_000 });
    const namespace = new FakeNamespace();
    const first = attach(registry, namespace, "a.ts");
    first.attachment.detach();
    const second = attach(registry, namespace, "b.ts");
    second.attachment.detach();

    registry.configure({ countBudget: 1 });

    expect(registry.diagnostics().liveModelCount).toBe(1);
    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[1]?.dispose).not.toHaveBeenCalled();
  });

  it("keeps the current budget for an omitted field and falls back to defaults for an invalid one", () => {
    const registry = new EditorModelRegistry({ countBudget: 3, byteBudget: 5_000_000 });

    registry.configure({ countBudget: 5 });
    expect(registry.diagnostics()).toMatchObject({ countBudget: 5, byteBudget: 5_000_000 });

    registry.configure({ countBudget: -1, byteBudget: Number.NaN });
    expect(registry.diagnostics()).toMatchObject({
      countBudget: 16,
      byteBudget: 128 * 1024 * 1024,
    });
  });
});

describe("shared editor model registry singleton", () => {
  afterEach(() => {
    resetEditorModelRegistryForTests();
  });

  it("attaches, updates protection, and reports diagnostics through the module-level wrappers", () => {
    const namespace = new FakeNamespace();
    const editor = new FakeEditor();
    const attachment = attachRetainedEditorModel({
      key: "scope:/repo:shared.ts",
      rootKey: "scope:/repo",
      uri: uri("shared.ts"),
      language: "typescript",
      text: "shared\n",
      sizeBytes: 8,
      degraded: false,
      viewStateKey: "pane:shared",
      namespace,
      editor,
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    updateRetainedEditorModelProtection(attachment.key, {
      ...UNPROTECTED_EDITOR_MODEL,
      dirty: true,
    });

    expect(getEditorModelRegistryDiagnostics().entries[0]).toMatchObject({ dirty: true });

    attachment.detach();
  });

  it("applies configureEditorModelRegistry live and disposes via the root/all wrappers with default reasons", () => {
    const namespace = new FakeNamespace();

    const inRootA = attachRetainedEditorModel({
      key: "scope:/repo-a:one.ts",
      rootKey: "scope:/repo-a",
      uri: uri("one.ts"),
      language: "typescript",
      text: "one\n",
      sizeBytes: 4,
      degraded: false,
      viewStateKey: "pane:one",
      namespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });
    inRootA.detach();

    const inRootB = attachRetainedEditorModel({
      key: "scope:/repo-b:two.ts",
      rootKey: "scope:/repo-b",
      uri: uri("two.ts"),
      language: "typescript",
      text: "two\n",
      sizeBytes: 4,
      degraded: false,
      viewStateKey: "pane:two",
      namespace,
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });
    inRootB.detach();

    configureEditorModelRegistry({ countBudget: 16, byteBudget: 128 * 1024 * 1024 });
    expect(getEditorModelRegistryDiagnostics().liveModelCount).toBe(2);

    disposeEditorModelRegistryRoot("scope:/repo-a");
    expect(namespace.created[0]?.dispose).toHaveBeenCalledOnce();
    expect(namespace.created[1]?.dispose).not.toHaveBeenCalled();

    disposeAllUnattachedEditorModels();
    expect(namespace.created[1]?.dispose).toHaveBeenCalledOnce();
  });
});
