import { describe, expect, it } from "vitest";

import {
  readBoundedOoxmlPackage,
  type BoundedOoxmlPackageOptions,
} from "./bounded-ooxml-package.js";
import { zipTextEntries } from "./parsers/parser-test-fixtures.js";

const OPTIONS: BoundedOoxmlPackageOptions = {
  maxInputBytes: 1024 * 1024,
  maxEntries: 16,
  maxInflatedBytes: 1024 * 1024,
  timeoutMs: 10_000,
  now: () => 0,
};

describe("readBoundedOoxmlPackage (#4176)", () => {
  it("returns every part as raw bytes, not only the parts a text extractor reads", async () => {
    const bytes = zipTextEntries([
      { name: "word/document.xml", content: "<w:document/>" },
      { name: "word/comments.xml", content: "<w:comment>note</w:comment>" },
      { name: "customXml/item1.xml", content: "\u0001binary-ish\u0002" },
    ]);
    const result = await readBoundedOoxmlPackage(bytes, OPTIONS);
    if (!result.ok) throw new Error(`expected a readable package, got ${result.reason}`);
    expect([...result.parts.keys()]).toEqual([
      "word/document.xml",
      "word/comments.xml",
      "customXml/item1.xml",
    ]);
    expect(result.parts.get("customXml/item1.xml")?.toString("utf8")).toBe(
      "\u0001binary-ish\u0002",
    );
  });

  it("refuses a package larger than its input bound before opening it", async () => {
    const bytes = zipTextEntries([{ name: "a.xml", content: "<a/>" }]);
    expect(await readBoundedOoxmlPackage(bytes, { ...OPTIONS, maxInputBytes: 8 })).toEqual({
      ok: false,
      reason: "oversized",
    });
  });

  it("names a malformed archive and an exhausted entry budget", async () => {
    expect(await readBoundedOoxmlPackage(Uint8Array.from([0x50, 0x4b, 3, 4, 9]), OPTIONS)).toEqual({
      ok: false,
      reason: "malformed",
    });
    const many = zipTextEntries(
      Array.from({ length: 4 }, (_, index) => ({ name: `p${String(index)}.xml`, content: "<p/>" })),
    );
    expect(await readBoundedOoxmlPackage(many, { ...OPTIONS, maxEntries: 2 })).toEqual({
      ok: false,
      reason: "budget",
    });
  });

  it("refuses a part that inflates past the bound", async () => {
    const bytes = zipTextEntries([{ name: "big.xml", content: "x".repeat(4096) }]);
    expect(await readBoundedOoxmlPackage(bytes, { ...OPTIONS, maxInflatedBytes: 1024 })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
