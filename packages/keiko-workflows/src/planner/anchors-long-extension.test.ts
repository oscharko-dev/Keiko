import { describe, expect, it } from "vitest";
import { extractAnchors, PATH_RE } from "./anchors.js";
import { extractPathReferences } from "./references.js";

describe("complete bounded filename extensions", () => {
  it.each([
    "src/z-final/application.properties",
    "src/z-final/application.properties:301",
    "src/z-final/application.properties:301:12",
    "src/z-final/application.abcdefghijklmnop",
  ])("retains the complete path anchor: %s", (target) => {
    const anchors = extractAnchors({ text: `Explain ${target}`, maxAnchors: 8 }).anchors;
    expect(anchors.filter((anchor) => anchor.kind === "path").map((anchor) => anchor.term)).toEqual(
      [target],
    );
  });

  it.each(["", ".", ",", ";", ")", "?"])(
    "retains complete supported reference before punctuation %s",
    (punctuation) => {
      expect(
        extractPathReferences(`Explain src/z-final/application.properties${punctuation}`),
      ).toEqual([{ path: "src/z-final/application.properties", origin: "query" }]);
    },
  );

  it.each(["src/config.abcdefghijklmnopq", "src/config.properties-with-extra"])(
    "never admits a truncated filename prefix: %s",
    (target) => {
      const regex = new RegExp(PATH_RE.source, PATH_RE.flags);
      expect([...target.matchAll(regex)]).toEqual([]);
    },
  );
});
