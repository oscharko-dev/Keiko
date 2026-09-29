import type { RefObject } from "react";

export interface ComposerInputHandle {
  focus(): void;
  readonly selectionStart: number;
  setSelectionRange(start: number, end: number): void;
}

export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly nativeEvent?: { readonly isComposing: boolean };
  preventDefault(): void;
}

export interface ComposerEditorLabels {
  readonly code: string;
  readonly plainText: string;
  readonly language: string;
  readonly continueText: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly limit: string;
  readonly hint: string;
}

export interface MarkdownComposerProps {
  readonly value: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly ariaControls?: string | undefined;
  readonly maxLength: number;
  readonly documentKey: string;
  readonly inputRef: RefObject<ComposerInputHandle | null>;
  readonly labels: ComposerEditorLabels;
  readonly onChange: (value: string, cursor: number) => void;
  readonly onSelect: (value: string, cursor: number) => void;
  readonly onKeyDown: (event: ComposerKeyEvent) => void;
}
