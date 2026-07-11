import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const assets = new URL("../assets/", import.meta.url);
const canonical = new URL("../../../design-system/", import.meta.url);

describe("hosted maintainer UI assets", () => {
  it.each(["keiko-tokens.css", "keiko-semantic-tokens.css"])(
    "keeps emitted %s byte-identical to the canonical design-system asset",
    async (name) => {
      const [emitted, source] = await Promise.all([
        readFile(new URL(name, assets)),
        readFile(new URL(name, canonical)),
      ]);
      expect(emitted.equals(source)).toBe(true);
    },
  );

  it("keeps executable assets inert and below the production line cap", async () => {
    const names = ["maintainer-ui.js", "maintainer-ui-copy.js", "maintainer-ui-dom.js"];
    for (const name of names) {
      const source = await readFile(new URL(name, assets), "utf8");
      expect(source).not.toContain("innerHTML");
      expect(source.split("\n").length - 1, name).toBeLessThanOrEqual(400);
    }
  });

  it("limits component CSS literals to the governed structural exception set", async () => {
    const source = await readFile(new URL("maintainer-ui.css", assets), "utf8");
    const literals = [...new Set(source.match(/\b\d+(?:px|ms)\b/gu) ?? [])].sort();
    expect(literals).toEqual(["1200px", "1px", "240px", "320px", "420px", "640px", "720px"]);
    expect(source).not.toMatch(/font-weight:\s*\d/gu);
    expect(source).not.toContain("prefers-reduced-motion");
  });
});
