import type { editor } from "monaco-editor";
import {
  ensureMonacoRuntime,
  ensureMonacoLanguage,
  getMonacoNamespace,
  registerKeikoEditorTheme,
  resolveEditorThemeTokensFromDom,
} from "../widgets/cards/editorMonacoRuntime";
import { readEditorThemeVariant } from "../hooks/useEditorThemeVariant";

import type { ClientComposerCodeStage as ComposerCodeStage } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
export type { ClientComposerCodeStage as ComposerCodeStage } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

export interface ComposerCodePort {
  readonly value: string;
  readonly language: string;
  readonly label: string;
  readonly onChange: (value: string, anchor: number, head: number) => void;
  readonly onSelect: (anchor: number, head: number) => void;
  readonly onExit: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onEmptyBackspace: () => void;
  readonly onStage: (stage: ComposerCodeStage) => void;
}

export interface ComposerCodeEditor {
  update(value: string): void;
  setLanguage(language: string): Promise<void>;
  select(anchor: number, head: number): void;
  focus(): void;
  dispose(): void;
}

function applyTheme(host: HTMLElement, port: ComposerCodePort): string {
  port.onStage("theme-tokens");
  const tokens = resolveEditorThemeTokensFromDom(host);
  port.onStage("theme-register");
  const monaco = getMonacoNamespace();
  const variant = readEditorThemeVariant();
  return registerKeikoEditorTheme(monaco.editor, variant, tokens);
}

function codeSelection(instance: editor.IStandaloneCodeEditor): [number, number] {
  const model = instance.getModel();
  const selection = instance.getSelection();
  if (!model || !selection) return [0, 0];
  return [
    model.getOffsetAt(selection.getSelectionStart()),
    model.getOffsetAt(selection.getPosition()),
  ];
}

function wireCodeKeys(instance: editor.IStandaloneCodeEditor, port: ComposerCodePort): void {
  const { KeyMod, KeyCode } = getMonacoNamespace();
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, port.onUndo);
  instance.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, port.onRedo);
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, port.onRedo);
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, port.onExit);
  instance.addCommand(KeyCode.Escape, port.onExit, "!suggestWidgetVisible && !findWidgetVisible");
  const empty = instance.createContextKey("keikoComposerCodeEmpty", instance.getValue() === "");
  instance.onDidChangeModelContent(() => empty.set(instance.getValue() === ""));
  instance.addCommand(
    KeyCode.Backspace,
    port.onEmptyBackspace,
    "keikoComposerCodeEmpty && editorTextFocus",
  );
  instance.addCommand(
    KeyCode.Delete,
    port.onEmptyBackspace,
    "keikoComposerCodeEmpty && editorTextFocus",
  );
}

function codeAdapter(
  instance: editor.IStandaloneCodeEditor,
  observer: MutationObserver,
): ComposerCodeEditor {
  let selectedLanguage = "";
  return {
    update(value): void {
      const model = instance.getModel();
      if (model && model.getValue() !== value) model.setValue(value);
    },
    async setLanguage(language): Promise<void> {
      selectedLanguage = language;
      const monacoLanguage = language === "json" ? "javascript" : language;
      await ensureMonacoLanguage(monacoLanguage);
      const model = instance.getModel();
      if (selectedLanguage === language && model && !model.isDisposed()) {
        getMonacoNamespace().editor.setModelLanguage(model, monacoLanguage);
      }
    },
    select(anchor, head): void {
      const model = instance.getModel();
      if (!model) return;
      const start = model.getPositionAt(anchor);
      const end = model.getPositionAt(head);
      instance.setSelection({
        selectionStartLineNumber: start.lineNumber,
        selectionStartColumn: start.column,
        positionLineNumber: end.lineNumber,
        positionColumn: end.column,
      });
    },
    focus(): void {
      instance.focus();
    },
    dispose(): void {
      observer.disconnect();
      const model = instance.getModel();
      instance.dispose();
      model?.dispose();
    },
  };
}

function codeOptions(
  host: HTMLElement,
  port: ComposerCodePort,
  language: string,
): editor.IStandaloneEditorConstructionOptions {
  return {
    value: port.value,
    language,
    theme: applyTheme(host, port),
    ariaLabel: port.label,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "off",
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 12,
    lineNumbersMinChars: 0,
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineHeight: 21,
    fontFamily: getComputedStyle(host).getPropertyValue("--font-mono"),
    padding: { top: 10, bottom: 10 },
    tabSize: 2,
    insertSpaces: true,
    wordWrap: "on",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "none",
    contextmenu: false,
    stickyScroll: { enabled: false },
    quickSuggestions: false,
    wordBasedSuggestions: "off",
    suggestOnTriggerCharacters: false,
    bracketPairColorization: { enabled: true },
    scrollbar: { alwaysConsumeMouseWheel: false },
  };
}

export async function mountComposerCode(
  host: HTMLElement,
  port: ComposerCodePort,
): Promise<ComposerCodeEditor> {
  port.onStage("runtime");
  if (!ensureMonacoRuntime().supported) throw new TypeError("Composer editor runtime unavailable");
  const language = port.language === "json" ? "javascript" : port.language;
  port.onStage("language");
  await ensureMonacoLanguage(language);
  const monaco = getMonacoNamespace();
  port.onStage("theme");
  const options = codeOptions(host, port, language);
  port.onStage("editor-mount");
  const instance = monaco.editor.create(host, options);
  port.onStage("editor-wiring");
  const resize = (): void => {
    host.style.height = `${String(Math.min(240, Math.max(84, instance.getContentHeight())))}px`;
    instance.layout();
  };
  instance.onDidContentSizeChange(resize);
  instance.onDidChangeModelContent(() =>
    port.onChange(instance.getValue(), ...codeSelection(instance)),
  );
  instance.onDidChangeCursorSelection(() => {
    if (instance.hasTextFocus()) port.onSelect(...codeSelection(instance));
  });
  wireCodeKeys(instance, port);
  const observer = new MutationObserver(() => {
    applyTheme(host, port);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  resize();
  return codeAdapter(instance, observer);
}
