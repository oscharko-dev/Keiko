import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountComposerCode, type ComposerCodePort } from "./composer-code-runtime";

const runtime = vi.hoisted(() => ({
  supported: true,
  language: vi.fn(),
  create: vi.fn(),
  theme: vi.fn(() => "keiko-dark"),
  tokens: vi.fn(() => ({})),
  setModelLanguage: vi.fn(),
}));
const keys = {
  CtrlCmd: 256,
  Shift: 512,
  KeyZ: 90,
  KeyY: 89,
  Enter: 13,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
};
vi.mock("../widgets/cards/editorMonacoRuntime", () => ({
  ensureMonacoRuntime: (): { supported: boolean } => ({ supported: runtime.supported }),
  ensureMonacoLanguage: runtime.language,
  getMonacoNamespace: (): object => ({
    editor: { create: runtime.create, setModelLanguage: runtime.setModelLanguage },
    KeyMod: keys,
    KeyCode: keys,
  }),
  registerKeikoEditorTheme: runtime.theme,
  resolveEditorThemeTokensFromDom: runtime.tokens,
}));

function testPort(): ComposerCodePort {
  return {
    value: "const answer = 42;",
    language: "typescript",
    label: "Code input",
    onChange: vi.fn(),
    onSelect: vi.fn(),
    onExit: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onEmptyBackspace: vi.fn(),
    onStage: vi.fn(),
  };
}

class EditorDouble {
  readonly state = {
    value: "const answer = 42;",
    focused: true,
    modelPresent: true,
    selectionPresent: true,
    height: 120,
  };
  readonly content: Array<() => void> = [];
  readonly cursor: Array<() => void> = [];
  readonly size: Array<() => void> = [];
  readonly commands = new Map<number, () => void>();
  readonly model = {
    getValue: (): string => this.state.value,
    setValue: vi.fn((value: string): void => {
      this.state.value = value;
    }),
    getOffsetAt: (position: { column: number }): number => position.column - 1,
    getPositionAt: (offset: number): { lineNumber: number; column: number } => ({
      lineNumber: 1,
      column: offset + 1,
    }),
    dispose: vi.fn(),
    isDisposed: vi.fn(() => false),
  };
  readonly selection = {
    getSelectionStart: (): { column: number } => ({ column: 3 }),
    getPosition: (): { column: number } => ({ column: 8 }),
  };
  readonly empty = { set: vi.fn() };
  readonly instance = {
    getModel: (): typeof this.model | null => (this.state.modelPresent ? this.model : null),
    getSelection: (): typeof this.selection | null =>
      this.state.selectionPresent ? this.selection : null,
    getValue: (): string => this.state.value,
    getContentHeight: (): number => this.state.height,
    hasTextFocus: (): boolean => this.state.focused,
    addCommand: vi.fn((key: number, handler: () => void): void => {
      this.commands.set(key, handler);
    }),
    createContextKey: vi.fn(() => this.empty),
    onDidChangeModelContent: (handler: () => void): void => {
      this.content.push(handler);
    },
    onDidChangeCursorSelection: (handler: () => void): void => {
      this.cursor.push(handler);
    },
    onDidContentSizeChange: (handler: () => void): void => {
      this.size.push(handler);
    },
    setSelection: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    layout: vi.fn(),
  };
}

function editorDouble(): EditorDouble {
  return new EditorDouble();
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.supported = true;
  runtime.language.mockResolvedValue(undefined);
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

function hostElement(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

describe("Composer shared Monaco runtime", () => {
  it("changes language on the existing model and ignores stale or disposed updates", async () => {
    const fake = editorDouble();
    runtime.create.mockReturnValue(fake.instance);
    const adapter = await mountComposerCode(hostElement(), testPort());
    let release!: () => void;
    runtime.language.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stale = adapter.setLanguage("python");
    await adapter.setLanguage("json");
    release();
    await stale;
    expect(runtime.setModelLanguage).toHaveBeenCalledExactlyOnceWith(fake.model, "javascript");
    expect(runtime.create).toHaveBeenCalledOnce();
    expect(fake.model.setValue).not.toHaveBeenCalled();
    fake.model.isDisposed.mockReturnValue(true);
    await adapter.setLanguage("typescript");
    expect(runtime.setModelLanguage).toHaveBeenCalledOnce();
    fake.state.modelPresent = false;
    await adapter.setLanguage("plaintext");
    expect(runtime.setModelLanguage).toHaveBeenCalledOnce();
    adapter.dispose();
  });
  it("mounts locally with the shared theme and loads the JSON-compatible language before creating the editor", async () => {
    const fake = editorDouble();
    runtime.create.mockReturnValue(fake.instance);
    const host = hostElement();
    const port = { ...testPort(), language: "json" };
    const adapter = await mountComposerCode(host, port);
    expect(runtime.language).toHaveBeenCalledWith("javascript");
    expect(runtime.language.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.create.mock.invocationCallOrder[0]!,
    );
    expect(runtime.create).toHaveBeenCalledWith(
      host,
      expect.objectContaining({
        language: "javascript",
        value: port.value,
        theme: "keiko-dark",
        ariaLabel: port.label,
      }),
    );
    expect(runtime.tokens).toHaveBeenCalledWith(host);
    expect(host.style.height).toBe("120px");
    document.documentElement.setAttribute("data-theme", "light");
    await vi.waitFor(() => expect(runtime.theme).toHaveBeenCalledTimes(2));
    adapter.dispose();
    document.documentElement.setAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(runtime.theme).toHaveBeenCalledTimes(2);
    expect(fake.instance.dispose).toHaveBeenCalledOnce();
    expect(fake.model.dispose).toHaveBeenCalledOnce();
  });

  it("keeps edits, selection and empty-block state synchronized without resetting an unchanged model", async () => {
    const fake = editorDouble();
    runtime.create.mockReturnValue(fake.instance);
    const port = testPort();
    const adapter = await mountComposerCode(hostElement(), port);
    adapter.update(port.value);
    expect(fake.model.setValue).not.toHaveBeenCalled();
    adapter.update("pasted code");
    fake.content.forEach((notify) => notify());
    expect(port.onChange).toHaveBeenLastCalledWith("pasted code", 2, 7);
    expect(fake.empty.set).toHaveBeenLastCalledWith(false);
    fake.state.value = "";
    fake.content.forEach((notify) => notify());
    expect(fake.empty.set).toHaveBeenLastCalledWith(true);
    fake.cursor.forEach((notify) => notify());
    expect(port.onSelect).toHaveBeenCalledWith(2, 7);
    fake.state.focused = false;
    fake.cursor.forEach((notify) => notify());
    expect(port.onSelect).toHaveBeenCalledOnce();
    adapter.select(4, 9);
    expect(fake.instance.setSelection).toHaveBeenCalledWith({
      selectionStartLineNumber: 1,
      selectionStartColumn: 5,
      positionLineNumber: 1,
      positionColumn: 10,
    });
    adapter.focus();
    expect(fake.instance.focus).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("routes history, exit and empty-block keys to the outer Markdown editor", async () => {
    const fake = editorDouble();
    runtime.create.mockReturnValue(fake.instance);
    const port = testPort();
    const adapter = await mountComposerCode(hostElement(), port);
    fake.commands.get(keys.CtrlCmd | keys.KeyZ)?.();
    expect(port.onUndo).toHaveBeenCalledOnce();
    fake.commands.get(keys.CtrlCmd | keys.Shift | keys.KeyZ)?.();
    fake.commands.get(keys.CtrlCmd | keys.KeyY)?.();
    expect(port.onRedo).toHaveBeenCalledTimes(2);
    fake.commands.get(keys.CtrlCmd | keys.Enter)?.();
    fake.commands.get(keys.Escape)?.();
    expect(port.onExit).toHaveBeenCalledTimes(2);
    fake.commands.get(keys.Backspace)?.();
    fake.commands.get(keys.Delete)?.();
    expect(port.onEmptyBackspace).toHaveBeenCalledTimes(2);
    expect(fake.instance.addCommand).toHaveBeenCalledWith(
      keys.Backspace,
      port.onEmptyBackspace,
      "keikoComposerCodeEmpty && editorTextFocus",
    );
    adapter.dispose();
  });

  it("handles a detached model or selection and bounds editor height while allowing internal scrolling", async () => {
    const fake = editorDouble();
    runtime.create.mockReturnValue(fake.instance);
    const host = hostElement();
    const port = testPort();
    const adapter = await mountComposerCode(host, port);
    fake.state.height = 800;
    fake.size.forEach((notify) => notify());
    expect(host.style.height).toBe("240px");
    fake.state.height = 20;
    fake.size.forEach((notify) => notify());
    expect(host.style.height).toBe("84px");
    fake.state.selectionPresent = false;
    fake.content.forEach((notify) => notify());
    expect(port.onChange).toHaveBeenLastCalledWith(port.value, 0, 0);
    fake.state.modelPresent = false;
    adapter.update("detached");
    adapter.select(1, 2);
    expect(fake.model.setValue).not.toHaveBeenCalled();
    expect(fake.instance.setSelection).not.toHaveBeenCalled();
    adapter.dispose();
    expect(fake.model.dispose).not.toHaveBeenCalled();
    expect(fake.instance.dispose).toHaveBeenCalledOnce();
  });

  it("rejects unsupported runtimes and language failures before editor creation", async () => {
    runtime.supported = false;
    await expect(mountComposerCode(hostElement(), testPort())).rejects.toThrow(TypeError);
    expect(runtime.language).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
    runtime.supported = true;
    runtime.language.mockRejectedValue(new TypeError("Language unavailable"));
    await expect(mountComposerCode(hostElement(), testPort())).rejects.toThrow(
      "Language unavailable",
    );
    expect(runtime.create).not.toHaveBeenCalled();
  });
});
