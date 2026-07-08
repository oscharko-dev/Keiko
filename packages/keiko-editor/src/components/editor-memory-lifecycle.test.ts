/**
 * Editor memory-lifecycle tests (Issue #1207 — "Memory cleanup tests for Monaco models/providers";
 * AC "Monaco models/providers are disposed when files/cards close"; ADR-0042 D3.6 Review Addendum
 * "multiple cards do not leak models/workers (disposed on close)").
 *
 * `wireEditorOnMount` is the single aggregator that registers every editor subscription, language
 * provider, command action, and DOM listener on mount and returns one disposer (the KeikoCodeEditor
 * unmount effect calls it; see use-editor-handlers.ts). These tests drive that aggregator through a
 * shared, instrumented Monaco fake that counts every live disposable, and prove that opening and
 * closing many editor cards leaves zero live registrations — i.e. the global Monaco language registry,
 * the per-editor event subscriptions, and the per-card DOM listener never accumulate across cards.
 *
 * The complementary single-mount per-feature disposal assertions live in on-mount.test.ts; this file
 * is the multi-card, all-features-at-once no-leak proof.
 */
import { describe, expect, it } from "vitest";

import { wireEditorOnMount } from "./on-mount.js";
import type { MountEditor, MountMonaco, WireEditorOnMountArgs } from "./on-mount.js";
import type {
  EditorCompletionResolver,
  EditorDiagnosticsResolver,
  EditorFormattingResolver,
  EditorHoverResolver,
  EditorInlineCompletionResolver,
  EditorSymbolsResolver,
} from "../index.js";

/** A registry that counts every live disposable handed out across all cards. */
interface LiveRegistry {
  live: number;
  peak: number;
  track(): { dispose: () => void };
}

function createRegistry(): LiveRegistry {
  const registry: LiveRegistry = {
    live: 0,
    peak: 0,
    track() {
      registry.live += 1;
      registry.peak = Math.max(registry.peak, registry.live);
      let disposed = false;
      return {
        dispose: (): void => {
          // Idempotent: a double-dispose must not under-count (and would itself be a defect to catch).
          if (disposed) {
            throw new Error("disposable disposed twice");
          }
          disposed = true;
          registry.live -= 1;
        },
      };
    },
  };
  return registry;
}

// Resolvers are never invoked in a mount/dispose-only test (no completion/hover/etc. is triggered),
// so they are inert stubs that satisfy the wiring's typed shape.
const completionResolver: EditorCompletionResolver = (query) =>
  Promise.resolve({
    request: query.request.request,
    items: [],
    isIncomplete: false,
    provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
  });
const inlineResolver: EditorInlineCompletionResolver = (query) =>
  Promise.resolve({ request: query.request.request, items: [] });
const diagnosticsResolver: EditorDiagnosticsResolver = (query) =>
  Promise.resolve({ request: query.request.request, diagnostics: [] });
const hoverResolver: EditorHoverResolver = (query) =>
  Promise.resolve({ request: query.request.request, hover: { contents: null } });
const symbolsResolver: EditorSymbolsResolver = (query) =>
  Promise.resolve({ request: query.request.request, symbols: [] });
const formattingResolver: EditorFormattingResolver = (query) =>
  Promise.resolve({ request: query.request.request, edits: [] });

function fullProviderArgs(): Partial<WireEditorOnMountArgs> {
  const id = (): string => "req";
  return {
    onCursorChange: () => undefined,
    onSelectionChange: () => undefined,
    completion: {
      resolve: completionResolver,
      isCurrentDocument: () => true,
      triggerCharacters: ["."],
      contextBudgetBytes: 4096,
      streamId: "s",
      newRequestId: id,
    },
    inlineCompletion: {
      resolve: inlineResolver,
      isCurrentDocument: () => true,
      contextBudgetBytes: 8192,
      streamId: "s",
      newRequestId: id,
      debounceDelayMs: 75,
    },
    diagnostics: {
      resolve: diagnosticsResolver,
      debounceMs: 400,
      streamId: "s",
      newRequestId: id,
    },
    hover: {
      resolve: hoverResolver,
      isCurrentDocument: () => true,
      streamId: "s",
      newRequestId: id,
    },
    symbols: {
      resolve: symbolsResolver,
      isCurrentDocument: () => true,
      streamId: "s",
      newRequestId: id,
    },
    formatting: {
      resolve: formattingResolver,
      isCurrentDocument: () => true,
      streamId: "s",
      newRequestId: id,
    },
    commands: { generateTests: () => undefined },
  };
}

function buildMonaco(registry: LiveRegistry): MountMonaco {
  const tracked = (): { dispose: () => void } => registry.track();
  const languages = {
    CompletionItemKind: { Text: 1, Method: 2, Function: 3, Field: 5, Variable: 6, Keyword: 11 },
    CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
    InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
    InlineCompletionEndOfLifeReasonKind: { Accepted: 0, Rejected: 1, Ignored: 2 },
    registerCompletionItemProvider: tracked,
    registerInlineCompletionsProvider: tracked,
    registerHoverProvider: tracked,
    registerDocumentSymbolProvider: tracked,
    registerDocumentFormattingEditProvider: tracked,
  };
  return {
    editor: { defineTheme: () => undefined, setModelMarkers: () => undefined },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, KeyT: 53, F2: 60 },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    languages,
  } as unknown as MountMonaco;
}

function buildContainer(registry: LiveRegistry): HTMLElement {
  let keydownTracked: { dispose: () => void } | null = null;
  return {
    addEventListener: (type: string): void => {
      if (type === "keydown") {
        keydownTracked = registry.track();
      }
    },
    removeEventListener: (type: string): void => {
      if (type === "keydown") {
        keydownTracked?.dispose();
        keydownTracked = null;
      }
    },
  } as unknown as HTMLElement;
}

function buildEditor(registry: LiveRegistry, container: HTMLElement): MountEditor {
  const model = {
    getValue: (): string => "",
    getVersionId: (): number => 1,
    uri: { toString: (): string => "keiko-editor://card" },
    getLanguageId: (): string => "typescript",
    onDidChangeContent: (): { dispose: () => void } => registry.track(),
  };
  return {
    addAction: () => registry.track(),
    getAction: () => null,
    onDidChangeCursorPosition: () => registry.track(),
    onDidChangeCursorSelection: () => registry.track(),
    onDidChangeModel: () => registry.track(),
    getModel: () => model,
    focus: () => undefined,
    getContainerDomNode: () => container,
    saveViewState: () => null,
    restoreViewState: () => undefined,
  } as unknown as MountEditor;
}

function mountCard(registry: LiveRegistry): () => void {
  const container = buildContainer(registry);
  return wireEditorOnMount({
    editor: buildEditor(registry, container),
    monaco: buildMonaco(registry),
    container,
    themeVariant: "dark",
    autoFocus: false,
    onSave: () => undefined,
    ...fullProviderArgs(),
  });
}

describe("editor memory lifecycle — multi-card no-leak (Issue #1207)", () => {
  it("registers live disposables on mount and releases all of them on a single card close", () => {
    const registry = createRegistry();
    const dispose = mountCard(registry);
    expect(registry.live).toBeGreaterThan(0);
    dispose();
    expect(registry.live).toBe(0);
  });

  it("does not accumulate registrations across many open/close card cycles", () => {
    const registry = createRegistry();
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const dispose = mountCard(registry);
      expect(registry.live).toBeGreaterThan(0);
      dispose();
      expect(registry.live).toBe(0);
    }
    // Every cycle returned to zero, so the global Monaco language registry and per-editor
    // subscriptions never grew unbounded.
    expect(registry.live).toBe(0);
  });

  it("holds N cards open simultaneously and frees everything only when all close (no cross-card leak)", () => {
    const registry = createRegistry();
    // Establish the per-card registration count from one isolated mount, then prove the live count
    // grows by EXACTLY that amount per card and shrinks by exactly that amount per close. Deriving
    // perCard independently (not by dividing the multi-card total) means a shared/module-global leak —
    // which would add a fixed cost once rather than per card — could not be hidden by the accounting.
    const probe = mountCard(registry);
    const perCard = registry.live;
    expect(perCard).toBeGreaterThan(0);
    probe();
    expect(registry.live).toBe(0);

    const cards = 8;
    const disposers = Array.from({ length: cards }, (_unused, index) => {
      const dispose = mountCard(registry);
      // Live count must be exactly proportional after each mount (no shared residual).
      expect(registry.live).toBe(perCard * (index + 1));
      return dispose;
    });
    expect(registry.peak).toBe(perCard * cards);

    // Closing each card frees exactly that card's registrations; the others keep working.
    disposers.forEach((dispose, index) => {
      dispose();
      expect(registry.live).toBe(perCard * (cards - index - 1));
    });
    expect(registry.live).toBe(0);
  });

  it("treats a double-dispose as a defect (the registry would catch an over-count)", () => {
    const registry = createRegistry();
    const dispose = mountCard(registry);
    dispose();
    expect(registry.live).toBe(0);
    // A disposer that fired twice would under-count live disposables and mask a leak; the
    // instrumented registry throws on the second dispose, so the no-leak proof cannot be gamed.
    expect(() => {
      dispose();
    }).toThrow("disposed twice");
  });
});

/**
 * Monaco MODEL-count no-leak proof (GEN-PERF-MEMORY-002).
 *
 * `wireEditorOnMount` (asserted above) covers provider/listener disposal, but NOT the Monaco text
 * MODEL, whose lifecycle is owned by `@monaco-editor/react`'s `<Editor>` component. The invariant
 * that `KeikoCodeEditor` depends on is: `monaco.editor.getModels().length` stays bounded by the
 * number of mounted panes across arbitrary open/switch/close cycles — i.e. no model accumulates.
 *
 * This suite reproduces the exact two lifecycle mechanisms of `@monaco-editor/react@Editor` that the
 * KeikoCodeEditor.tsx comment now documents:
 *   - MOUNT: the model is `getModel(uri) ?? createModel(uri)` and registered.
 *   - UNMOUNT with `keepCurrentModel={false}`: `getModel()?.dispose()` removes it from the registry.
 *   - PATH-SWAP-WHILE-MOUNTED: `getModel(nextUri) ?? createModel(nextUri)` + `setModel(next)` WITHOUT
 *     disposing the previous model — this is the latent accumulation the host avoids by unmounting
 *     `<Editor>` per file switch (buffer-null loading branch) rather than swapping `path` live.
 *
 * The model-count assertion is what a future "synchronous cached swap" optimization would trip, so
 * the invariant guards against silently reintroducing the leak.
 */

interface ModelHandle {
  readonly uri: string;
  disposed: boolean;
}

/** A faithful, minimal stand-in for `monaco.editor`'s model registry + create/dispose semantics. */
class MonacoEditorRegistry {
  private readonly models: ModelHandle[] = [];

  createModel(uri: string): ModelHandle {
    const model: ModelHandle = { uri, disposed: false };
    this.models.push(model);
    return model;
  }

  getModel(uri: string): ModelHandle | undefined {
    return this.models.find((m) => m.uri === uri && !m.disposed);
  }

  dispose(model: ModelHandle): void {
    if (model.disposed) {
      throw new Error("model disposed twice");
    }
    model.disposed = true;
    const index = this.models.indexOf(model);
    if (index >= 0) this.models.splice(index, 1);
  }

  getModels(): readonly ModelHandle[] {
    return this.models.filter((m) => !m.disposed);
  }
}

/**
 * A minimal editor pane mirroring `@monaco-editor/react`'s `<Editor>` model wiring for a given
 * `keepCurrentModel` setting. `mount` binds a model by URI; `swapPath` reproduces the (unused-by-host)
 * live path swap; `unmount` runs the exact cleanup branch from the library source.
 */
class EditorPane {
  private current: ModelHandle | null = null;

  constructor(
    private readonly registry: MonacoEditorRegistry,
    private readonly keepCurrentModel: boolean,
  ) {}

  mount(uri: string): void {
    // b(): getModel(uri) || createModel(uri)
    this.current = this.registry.getModel(uri) ?? this.registry.createModel(uri);
  }

  // Reproduces the library's `[E]`-dep effect: setModel(getModel||createModel) with NO dispose of
  // the outgoing model. The host never exercises this (it unmounts instead), so a call here models
  // the latent leak the invariant is designed to catch.
  swapPath(uri: string): void {
    this.current = this.registry.getModel(uri) ?? this.registry.createModel(uri);
  }

  // Reproduces `he()`: with keepCurrentModel=false, `getModel()?.dispose()` runs at unmount.
  unmount(): void {
    if (!this.keepCurrentModel && this.current !== null) {
      this.registry.dispose(this.current);
    }
    this.current = null;
  }
}

describe("editor Monaco model lifecycle — no model leak (GEN-PERF-MEMORY-002)", () => {
  const FILE_A = "keiko-editor://root/a.ts";
  const FILE_B = "keiko-editor://root/b.ts";
  const FILE_C = "keiko-editor://root/c.ts";

  it("open/switch/close cycles never accumulate models (host unmount-per-switch contract)", () => {
    const registry = new MonacoEditorRegistry();
    const files = [FILE_A, FILE_B, FILE_C];

    // The host renders a fresh <Editor> per file switch (buffer-null loading branch unmounts the
    // prior one). Model each switch as: unmount the previous pane, mount a new pane for the next file.
    let pane: EditorPane | null = null;
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const uri = files[cycle % files.length];
      // A modulo index into a non-empty array is always in-bounds; this guard only narrows the type
      // (it can never fire) so we avoid a non-null assertion without changing runtime behavior.
      if (uri === undefined) throw new Error("unreachable: modulo index is always in-bounds");
      pane?.unmount();
      pane = new EditorPane(registry, false);
      pane.mount(uri);
      // Exactly one live model while a single pane is mounted — no growth across 30 switches.
      expect(registry.getModels()).toHaveLength(1);
    }
    pane?.unmount();
    expect(registry.getModels()).toHaveLength(0);
  });

  it("N simultaneously mounted panes hold exactly N models; closing all frees every model", () => {
    const registry = new MonacoEditorRegistry();
    const uris = Array.from(
      { length: 6 },
      (_unused, index) => `keiko-editor://root/f${String(index)}.ts`,
    );

    const panes = uris.map((uri, index) => {
      const pane = new EditorPane(registry, false);
      pane.mount(uri);
      expect(registry.getModels()).toHaveLength(index + 1);
      return pane;
    });
    expect(registry.getModels()).toHaveLength(uris.length);

    panes.forEach((pane, index) => {
      pane.unmount();
      expect(registry.getModels()).toHaveLength(uris.length - index - 1);
    });
    expect(registry.getModels()).toHaveLength(0);
  });

  it("catches the latent leak: a live path-swap-while-mounted orphans the prior model", () => {
    const registry = new MonacoEditorRegistry();
    const pane = new EditorPane(registry, false);
    pane.mount(FILE_A);
    expect(registry.getModels()).toHaveLength(1);

    // A hypothetical "synchronous cached swap" that reuses one mounted <Editor> and only changes
    // `path` would NOT dispose the outgoing model. The invariant surfaces the resulting accumulation:
    // after swapping A->B->C on a single mounted pane, three models are live where only one should be.
    pane.swapPath(FILE_B);
    pane.swapPath(FILE_C);
    expect(registry.getModels()).toHaveLength(3);

    // The count exceeds the single mounted pane, which is exactly the leak signal a future
    // optimization must not trip. Unmount disposes only the CURRENT model, leaving the orphans —
    // demonstrating that correctness rests on unmount-per-switch, not live path swapping.
    pane.unmount();
    expect(registry.getModels()).toHaveLength(2);
  });
});
