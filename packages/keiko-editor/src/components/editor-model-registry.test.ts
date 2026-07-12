import { describe, expect, it, vi } from "vitest";

import {
  EditorModelRegistry,
  UNPROTECTED_EDITOR_MODEL,
  estimateEditorModelBytes,
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

function uri(path: string): RetainedEditorUri {
  return new FakeUri(`keiko-editor://workspace/${path}`);
}

function attach(
  registry: EditorModelRegistry,
  namespace: FakeNamespace,
  path: string,
): { readonly attachment: ReturnType<EditorModelRegistry["attach"]>; readonly editor: FakeEditor } {
  const editor = new FakeEditor();
  const attachment = registry.attach({
    key: `scope:/repo:${path}`,
    rootKey: "scope:/repo",
    uri: uri(path),
    language: "typescript",
    text: `// ${path}\n`,
    sizeBytes: 32,
    degraded: false,
    viewStateKey: `pane:${path}`,
    namespace,
    editor,
    protection: UNPROTECTED_EDITOR_MODEL,
  });
  return { attachment, editor };
}

describe("EditorModelRegistry", () => {
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
      editor: new FakeEditor(),
      protection: UNPROTECTED_EDITOR_MODEL,
    });

    expect(attachment.model).toBe(existing);
    expect(existing.getValue()).toBe("host text\n");
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
});
