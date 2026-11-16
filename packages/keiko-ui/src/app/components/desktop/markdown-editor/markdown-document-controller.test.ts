import { afterEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import {
  LINEAR_RATIO_MAX,
  measureScaling,
  scalingRatio,
} from "../../../../../../../tests/support/property-testing.js";
import type { ComposerEditorLabels } from "../composer/composer-editor-types";
import { MarkdownDocumentController } from "./markdown-document-controller";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./markdown-document";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";
const MAX_LENGTH = 128 * 1024;

const controllers: MarkdownDocumentController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy();
});

function create(body: string, onSourcePaste: (body: string) => void): MarkdownDocumentController {
  const controller = new MarkdownDocumentController(document.createElement("div"), {
    body,
    maxLength: MAX_LENGTH,
    ariaLabel: "Document",
    placeholder: "",
    className: "editor",
    labels: {} as ComposerEditorLabels,
    onChange: vi.fn(),
    onState: vi.fn(),
    onLimit: vi.fn(),
    onSourcePaste,
  });
  controllers.push(controller);
  return controller;
}

function selectAfter(controller: MarkdownDocumentController, text: string): void {
  let found = -1;
  controller.view.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text) === true)
      found = pos + node.text.indexOf(text) + text.length;
    return found < 0;
  });
  if (found < 0) throw new TypeError("text not in document");
  const { state } = controller.view;
  controller.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, found)));
}

function pasteInto(controller: MarkdownDocumentController, text: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["text/plain"],
      getData: (wanted: string) => (wanted === "text/plain" ? text : ""),
    },
  });
  controller.view.dom.dispatchEvent(event);
}

function sourcePaste(body: string, after: string | undefined, text: string): string {
  let saved = "";
  const controller = create(body, (next) => {
    saved = next;
  });
  if (after !== undefined) selectAfter(controller, after);
  pasteInto(controller, text);
  return saved;
}

function marksOf(markdown: string, text: string): readonly string[] {
  const names: string[] = [];
  parseMarkdownDocument(markdown).descendants((node) => {
    if (node.isText && node.text === text) names.push(...node.marks.map((mark) => mark.type.name));
    return true;
  });
  return names;
}

describe("source paste marker choice", () => {
  it("keeps the pasted text and the document when the clipboard holds the marker itself", () => {
    const hostile = `~~x~~ KEIKOPASTEMARKER KEIKOPASTEMARKERXX`;
    expect(sourcePaste("Start end", "Start ", hostile)).toBe(`Start ${hostile}end`);
  });

  it("chooses the marker in linear time for a hostile prefix", { timeout: 60_000 }, () => {
    const scaling = measureScaling({
      build: (size) => `~~strike~~\n\nKEIKOPASTEMARKER${"X".repeat(size)}`,
      run: (text) => sourcePaste("", undefined, text),
      size: 2_000,
      maximumSize: 32_000,
    });
    expect(scaling.measurable, JSON.stringify(scaling)).toBe(true);
    expect(scalingRatio(scaling), JSON.stringify(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });

  it("pastes valid input near the size ceiling unchanged", () => {
    const text = `~~a~~ ${"word ".repeat(Math.floor(MAX_LENGTH / 5) - 10)}`;
    expect(sourcePaste("", undefined, text)).toBe(text);
  });
});

describe("block source paste inside inline formatting", () => {
  it("keeps strong on both sides of a pasted table", () => {
    const saved = sourcePaste("**AlphaBeta**", "Alpha", TABLE);
    expect(saved).toContain(TABLE);
    expect(marksOf(saved, "Alpha")).toEqual(["strong"]);
    expect(marksOf(saved, "Beta")).toEqual(["strong"]);
  });

  it("keeps a link on both sides of a pasted table", () => {
    const saved = sourcePaste("[AlphaBeta](https://example.invalid/help)", "Alpha", TABLE);
    expect(saved).toContain(TABLE);
    expect(marksOf(saved, "Alpha")).toEqual(["link"]);
    expect(marksOf(saved, "Beta")).toEqual(["link"]);
    expect(serializeMarkdownDocument(parseMarkdownDocument(saved))).toContain(
      "https://example.invalid/help",
    );
  });

  it("keeps the plain control unchanged", () => {
    expect(sourcePaste("AlphaBeta", "Alpha", TABLE)).toBe(`Alpha\n\n${TABLE}\n\nBeta`);
  });
});
