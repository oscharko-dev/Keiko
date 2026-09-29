import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  composerSchema,
  parseComposerMarkdown,
  serializeComposerMarkdown,
} from "./composer-markdown";
import { openComposerCodeBlock } from "./composer-input-rules";

describe("composer Markdown", () => {
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
    ).toEqual(["span", { "data-markdown-image": "" }, "private"]);
    expect(
      composerSchema.marks.link!.spec.toDOM?.(
        composerSchema.marks.link!.create({ href: "javascript:alert(1)" }),
        true,
      ),
    ).toEqual(["span", { "data-markdown-link": "" }, 0]);
  });
});
