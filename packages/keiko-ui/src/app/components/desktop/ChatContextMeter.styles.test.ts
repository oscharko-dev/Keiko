import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

function segmentStyles(
  kind: "cmpSwatch" | "cmpBarSegment",
  segment: string,
): Record<string, string> {
  const css = parse(readFileSync(join(import.meta.dirname, "ChatContextMeter.module.css"), "utf8"));
  const selector = `.${kind}[data-segment="${segment}"]`;
  const styles: Record<string, string> = {};
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      styles[declaration.prop] = declaration.value;
    });
  });
  return styles;
}

describe("context capacity visual encoding", () => {
  it.each(["cmpSwatch", "cmpBarSegment"] as const)(
    "distinguishes source capacity from conversation headroom without relying on colour: %s",
    (kind) => {
      const source = segmentStyles(kind, "source-capacity");
      const conversation = segmentStyles(kind, "free");
      expect(source["background-image"]).toBeDefined();
      expect(source["background-image"]).not.toBe(conversation["background-image"]);
      for (const segment of [
        "compaction-buffer",
        "output-reserve",
        "input-capacity-unavailable",
        "safety-margin",
      ]) {
        expect(source["background-image"]).not.toBe(
          segmentStyles(kind, segment)["background-image"],
        );
      }
    },
  );
});

describe("tool definitions visual encoding", () => {
  it.each(["cmpSwatch", "cmpBarSegment"] as const)(
    "draws the tools share solid in a categorical colour, apart from the hatched reserve: %s",
    (kind) => {
      const tools = segmentStyles(kind, "tools");
      expect(tools.background).toMatch(/^var\(--viz-[1-6]\)$/u);
      expect(tools["background-image"]).toBeUndefined();
      for (const segment of ["system", "skill", "summary", "messages", "knowledge"]) {
        expect(tools.background).not.toBe(segmentStyles(kind, segment).background);
      }
      expect(segmentStyles(kind, "output-reserve")["background-image"]).toBeDefined();
    },
  );
});
