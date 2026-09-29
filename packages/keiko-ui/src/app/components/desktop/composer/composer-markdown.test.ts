import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  composerSchema,
  parseComposerMarkdown,
  parseComposerText,
  serializeComposerMarkdown,
  markdownCursor,
  selectionFromMarkdown,
} from "./composer-markdown";
import { openComposerCodeBlock } from "./composer-input-rules";

describe("composer Markdown", () => {
  it("shows the complete inert link and image destinations and titles, including empty image alt", () => {
    const destination = "https://example.com/private-reference";
    const image = composerSchema.nodes.image!;
    expect(
      JSON.stringify(
        image.spec.toDOM?.(image.create({ src: destination, alt: "", title: "Image title" })),
      ),
    ).toContain(destination);
    expect(
      JSON.stringify(
        image.spec.toDOM?.(image.create({ src: destination, alt: "", title: "Image title" })),
      ),
    ).toContain("Image title");
    const link = composerSchema.marks.link!;
    expect(
      JSON.stringify(
        link.spec.toDOM?.(link.create({ href: destination, title: "Link title" }), true),
      ),
    ).toContain(destination);
    expect(
      JSON.stringify(
        link.spec.toDOM?.(link.create({ href: destination, title: "Link title" }), true),
      ),
    ).toContain("Link title");
  });
  it("maps cursor offsets without colliding with private-use characters in pasted text", () => {
    const value = "\uE000 Grüße 😀 \uE000\uE000 Ziel \uE000\uE000\uE000\uE000";
    const doc = parseComposerMarkdown(value);
    const offset = value.indexOf("Ziel") + 2;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, offset + 1),
    });
    expect(markdownCursor(state)).toBe(offset);
    expect(selectionFromMarkdown(state, offset, value).head).toBe(offset + 1);
    expect(serializeComposerMarkdown(state.doc)).toBe(value);
  });

  it.each(["a\uE000", "\uE000\uE001a", "a\uE000\uE000\uE001\uE000", "\uE001\uE000\uE001"])(
    "maps every caret next to adjacent private-use runs in %s",
    (value) => {
      for (const marked of [false, true]) {
        const plain = parseComposerText(value);
        const doc = marked
          ? composerSchema.node(
              "doc",
              null,
              composerSchema.node(
                "paragraph",
                null,
                composerSchema.text(value, [composerSchema.marks.strong!.create()]),
              ),
            )
          : plain;
        const serialized = serializeComposerMarkdown(doc);
        for (let offset = 0; offset <= value.length; offset += 1) {
          const state = EditorState.create({
            doc,
            selection: TextSelection.create(doc, offset + 1),
          });
          const markdownOffset = marked ? offset + 2 : offset;
          expect(markdownCursor(state)).toBe(markdownOffset);
          expect(selectionFromMarkdown(state, markdownOffset, serialized).head).toBe(offset + 1);
        }
        expect(serializeComposerMarkdown(doc)).toBe(serialized);
      }
    },
  );

  it("maps text positions through headings, marks, lists, code and Unicode", () => {
    const doc = parseComposerMarkdown(
      "# Grüße 😀\n\n**Owner**: Anna und `@team`\n\n* Budget: 900 Euro\n\n```typescript\nconst value = 2;\n```",
    );
    const value = serializeComposerMarkdown(doc);
    doc.descendants((node, position) => {
      if (!node.isText) return;
      for (let index = 0; index <= node.nodeSize; index += 1) {
        const state = EditorState.create({
          doc,
          selection: TextSelection.create(doc, position + index),
        });
        const offset = markdownCursor(state);
        expect(selectionFromMarkdown(state, offset, value).head).toBe(state.selection.head);
      }
    });
  });

  it("round-trips mixed Markdown, Unicode and code with embedded fences", () => {
    const source =
      '# Aufgabe\n\n**Prüfe** diese Liste:\n\n* eins\n* zwei\n\n````typescript\nconst prompt = "```";\n  // Grüße\n````\n\n> Weiter';
    const doc = parseComposerMarkdown(source);
    expect(parseComposerMarkdown(serializeComposerMarkdown(doc)).toJSON()).toEqual(doc.toJSON());
    expect(serializeComposerMarkdown(doc)).toContain('const prompt = "```";\n  // Grüße');
  });

  it("opens an empty language-aware code block only at the end of a fence paragraph", () => {
    const paragraph = composerSchema.nodes.paragraph!;
    const doc = composerSchema.node(
      "doc",
      null,
      paragraph.create(null, composerSchema.text("```typescript")),
    );
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    expect(
      openComposerCodeBlock(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(state.doc.firstChild?.type.name).toBe("code_block");
    expect(state.doc.firstChild?.attrs.params).toBe("typescript");
    expect(state.doc.firstChild?.textContent).toBe("");
    expect(openComposerCodeBlock(state)).toBe(false);
  });

  it("keeps HTML literal and renders remote images and links as inert spans", () => {
    const doc = parseComposerMarkdown(
      "<script>alert(1)</script>\n\n![private](https://example.com/image) [link](https://example.com)",
    );
    expect(doc.firstChild?.textContent).toContain("<script>");
    const image = composerSchema.nodes.image!;
    expect(
      image.spec.toDOM?.(image.create({ src: "https://example.com", alt: "private" })),
    ).toEqual(["span", { "data-markdown-image": "" }, "![private](https://example.com)"]);
    expect(
      composerSchema.marks.link!.spec.toDOM?.(
        composerSchema.marks.link!.create({ href: "javascript:alert(1)" }),
        true,
      ),
    ).toEqual([
      "span",
      { "data-markdown-link": "" },
      ["span", {}, 0],
      ["span", { "data-markdown-destination": "" }, " (javascript:alert(1))"],
    ]);
  });
});
