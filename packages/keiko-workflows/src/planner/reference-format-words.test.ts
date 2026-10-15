import { describe, expect, it } from "vitest";
import { extractPathReferences, extractRetrievalChannels } from "./references.js";

describe("format words preserve the ordinary question channel", () => {
  it.each(["HTML-Handbuch", "HTML manuals", "txt reports", "PDF documents"])(
    "does not invent a filename reference from %s",
    (text) => {
      expect(extractPathReferences(text)).toEqual([]);
      expect(extractRetrievalChannels(text, 8).anchors.length).toBeGreaterThan(0);
    },
  );

  it.each(["foo.html", "deep/foo.HTML", "foo.txt", "deep/foo.PDF"])(
    "keeps a complete real basename extension in %s",
    (path) => {
      expect(extractPathReferences(`Read ${path}`)).toEqual([{ path, origin: "query" }]);
    },
  );

  it.each(["Dockerfile", "Makefile", ".gitignore"])(
    "preserves the existing quoted extensionless selector %s",
    (name) => {
      expect(extractRetrievalChannels(`Read \`${name}\``, 8).anchors).toContainEqual({
        term: name.toLowerCase(),
        kind: "identifier",
        weight: 0.9,
      });
    },
  );

  it("retains an explicit sensitive hidden filename for closed admission", () => {
    expect(extractPathReferences("Read .env")).toContainEqual({ path: ".env", origin: "query" });
  });
});
