import { Slice } from "prosemirror-model";
import { TextSelection, type Command, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { createMarkdownDocumentState } from "../composer/composer-editor-state";
import { ComposerCodeView } from "../composer/composer-code-view";
import type { ComposerEditorLabels } from "../composer/composer-editor-types";
import {
  parseMarkdownDocument,
  serializeMarkdownDocument,
  supportsFormattedEditing,
} from "./markdown-document";

export interface MarkdownDocumentOptions {
  readonly body: string;
  readonly maxLength: number;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly className: string;
  readonly labels: ComposerEditorLabels;
  readonly onChange: (body: string) => void;
  /** Selection or history changed, so the toolbar re-reads its pressed and enabled states. */
  readonly onState: () => void;
  readonly onLimit: () => void;
  /**
   * Pasted Markdown the formatted view would rewrite (strikethrough, tables, task lists, ...):
   * the document with the paste inserted unchanged, for the Markdown source view to take over.
   */
  readonly onSourcePaste: (body: string) => void;
}

function clipboardText(event: ClipboardEvent): string | undefined {
  const data = event.clipboardData;
  const text = data?.types.includes("text/markdown")
    ? data.getData("text/markdown")
    : data?.getData("text/plain");
  // Line endings are Markdown line breaks, never literal carriage returns.
  return text === undefined || text === "" ? undefined : text.replace(/\r\n?/gu, "\n");
}

/** A marker the document does not contain, standing where the paste goes while it serializes. */
function pasteMarker(body: string): string {
  const base = "KEIKOPASTEMARKER";
  // The base cannot overlap itself, so the X runs that follow its occurrences are disjoint and one
  // pass bounds them all: a run one longer than the longest cannot occur in the body.
  let longestRun = 0;
  for (let at = body.indexOf(base); at >= 0; at = body.indexOf(base, at + base.length)) {
    let end = at + base.length;
    while (body.charCodeAt(end) === 88) end += 1;
    longestRun = Math.max(longestRun, end - at - base.length);
  }
  return base + "X".repeat(longestRun + 1);
}

/**
 * The document serialized with the marker as its own paragraph where the selection is. A text
 * block is split at the selection (its halves keep their inline marks, so strong, emphasis and
 * links close before the marker and reopen after it) instead of cutting delimiters apart.
 */
function bodyWithMarkerBlock(view: EditorView, marker: string): string {
  const { schema } = view.state;
  const paragraph = schema.nodes["paragraph"];
  const tr = view.state.tr.deleteSelection();
  const $at = tr.doc.resolve(tr.selection.from);
  if (paragraph === undefined || !$at.parent.isTextblock) return "";
  const block = paragraph.create(null, schema.text(marker));
  if ($at.parentOffset === 0) tr.insert($at.before(), block);
  else if ($at.parentOffset === $at.parent.content.size) tr.insert($at.after(), block);
  else {
    tr.split($at.pos, 1, [{ type: paragraph }]);
    tr.insert($at.pos + 1, block);
  }
  return serializeMarkdownDocument(tr.doc);
}

/** The pieces around a marker, joined by blank lines when they are not empty. */
function joinAroundMarker(body: string, marker: string, text: string): string {
  const at = body.indexOf(marker);
  const parts = [
    body.slice(0, at).trimEnd(),
    text.replace(/\s+$/u, ""),
    body.slice(at + marker.length).trimStart(),
  ];
  return parts.filter((part) => part.length > 0).join("\n\n");
}

const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-*+][ \t]|\d+[.)][ \t]))*[ \t]*/u;
const BLOCK_START = /^[ \t]*(?:[|>#]|[-*+][ \t]|\d+[.)][ \t]|`{3}|~{3})/mu;

/** Continuation lines of a paste inside a list item or quote stay inside it. */
function continuationIndent(linePrefix: string): string {
  const prefix = CONTAINER_PREFIX.exec(linePrefix)?.[0] ?? "";
  return prefix.replace(/[-*+]|\d+[.)]/gu, (marker) => " ".repeat(marker.length));
}

/** A paste inside a list item or quote: block syntax gets its own paragraph within that item. */
function pasteInContainer(before: string, text: string, after: string, indent: string): string {
  const prefixLength = CONTAINER_PREFIX.exec(before.slice(before.lastIndexOf("\n") + 1))?.[0]
    .length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const hasLead = before.slice(lineStart + (prefixLength ?? 0)).trim() !== "";
  const lines = text.replace(/\s+$/u, "").replace(/\n/gu, `\n${indent}`);
  if (!BLOCK_START.test(text) || !hasLead)
    return `${before}${text.replace(/\n/gu, `\n${indent}`)}${after}`;
  const blank = `\n${indent.trimEnd()}\n`;
  const tail = after.trimStart();
  return `${before.trimEnd()}${blank}${indent}${lines}${tail === "" ? "" : `${blank}${indent}${tail}`}`;
}

/**
 * The document as Markdown with the clipboard text inserted verbatim at the selection (which it
 * replaces). Inside a list item or quote the text stays in that block; in a plain paragraph, text
 * that starts block constructs (a table, a list) is set apart by blank lines so they still start.
 */
function bodyWithPaste(view: EditorView, text: string): string {
  const marker = pasteMarker(serializeMarkdownDocument(view.state.doc) + text);
  const body = serializeMarkdownDocument(view.state.tr.insertText(marker).doc);
  const at = body.indexOf(marker);
  const before = body.slice(0, at);
  const after = body.slice(at + marker.length);
  if (!text.includes("\n")) return `${before}${text}${after}`;
  const linePrefix = before.slice(before.lastIndexOf("\n") + 1);
  const indent = continuationIndent(linePrefix);
  if (indent.length > 0) return pasteInContainer(before, text, after, indent);
  if (linePrefix.trim() === "" && after.startsWith("\n")) return `${before}${text}${after}`;
  if (!BLOCK_START.test(text)) return `${before}${text}${after}`;
  const blocks = bodyWithMarkerBlock(view, marker);
  if (blocks.includes(marker)) return joinAroundMarker(blocks, marker, text);
  const parts = [before.trimEnd(), text.replace(/\s+$/u, ""), after.trimStart()];
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Pasted Markdown or plain text is read as Markdown: this edits a Markdown document. Text the
 * formatted view cannot hold is not parsed (it would be escaped into literal characters); it
 * goes in unchanged and the document continues in Markdown source. Inside a code block the
 * text is code, so the fidelity check does not apply.
 */
function pasteMarkdown(
  options: MarkdownDocumentOptions,
): (view: EditorView, event: ClipboardEvent) => boolean {
  return (view, event) => {
    const text = clipboardText(event);
    if (text === undefined) return false;
    const inCode = view.state.selection.$from.parent.type.name === "code_block";
    if (!inCode && !supportsFormattedEditing(text)) {
      options.onSourcePaste(bodyWithPaste(view, text));
      return true;
    }
    view.dispatch(
      view.state.tr
        .replaceSelection(Slice.maxOpen(parseMarkdownDocument(text).content))
        .scrollIntoView(),
    );
    return true;
  };
}

function placeholder(text: string): (state: EditorView["state"]) => DecorationSet | null {
  return (state) => {
    const first = state.doc.firstChild;
    if (state.doc.childCount !== 1 || first?.type.name !== "paragraph" || first.content.size > 0)
      return null;
    return DecorationSet.create(state.doc, [
      Decoration.node(0, first.nodeSize, { "data-placeholder": text }),
    ]);
  };
}

/**
 * The formatted view of the shared Markdown editor: the chat composer's schema, input rules,
 * shortcuts and code blocks, in document mode (Enter starts a new block) with its own serializer.
 */
export class MarkdownDocumentController {
  readonly view: EditorView;
  private body: string;

  constructor(
    host: HTMLElement,
    private readonly options: MarkdownDocumentOptions,
  ) {
    this.body = options.body;
    this.view = new EditorView(host, {
      state: createMarkdownDocumentState(
        parseMarkdownDocument(options.body),
        options.maxLength,
        options.onLimit,
        serializeMarkdownDocument,
      ),
      attributes: {
        class: options.className,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": options.ariaLabel,
        // A contenteditable is already a tab stop; stating it lets the scrolling page around it
        // count as keyboard-reachable for accessibility checks, without adding a second stop.
        tabindex: "0",
        spellcheck: "true",
        "data-shell-chord-bypass": "",
      },
      dispatchTransaction: (tr): void => this.dispatch(tr),
      handlePaste: pasteMarkdown(options),
      nodeViews: {
        code_block: (node, view, getPos): ComposerCodeView =>
          ComposerCodeView.create(node, view, getPos, options.labels),
      },
      decorations: placeholder(options.placeholder),
    });
    reportClientDiagnostic("Keiko Markdown editor initialized.", {
      composerActivity: "initialized",
    });
  }

  private dispatch(tr: Transaction): void {
    const before = this.view.state;
    const next = before.apply(tr);
    this.view.updateState(next);
    if (!before.doc.eq(next.doc)) {
      const body = serializeMarkdownDocument(next.doc);
      if (body !== this.body) {
        this.body = body;
        this.options.onChange(body);
      }
    }
    this.options.onState();
  }

  run(command: Command): void {
    command(this.view.state, (tr) => this.view.dispatch(tr), this.view);
    this.view.focus();
  }

  /** Focuses the document with the text of its first block selected, so typing replaces it. */
  selectFirstBlock(): void {
    const first = this.view.state.doc.firstChild;
    if (first?.isTextblock === true && first.content.size > 0) {
      const { tr } = this.view.state;
      this.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1, 1 + first.content.size)));
    }
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
