import { describe, expect, it } from "vitest";

import { classifyOoxmlZipError, readOoxmlZipEntries, type OoxmlZipReadPlan } from "./ooxml-zip.js";
import { zipTextEntries } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

const PLAN: OoxmlZipReadPlan = {
  format: "test",
  isWanted: (name) => name.startsWith("a/"),
  maxEntryInflatedBytes: 1024,
};

const TWICE = zipTextEntries([
  { name: "a/one.xml", content: "first" },
  { name: "b/skip.xml", content: "skipped" },
  { name: "a/one.xml", content: "second" },
]);

async function failureOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to fail");
}

describe("readOoxmlZipEntries plan options", () => {
  const options = buildParserOptions();

  it("rejects a part listed twice by default", async () => {
    const error = await failureOf(readOoxmlZipEntries(TWICE, options, options.now(), PLAN));
    expect(classifyOoxmlZipError(error)).toBe("malformed");
  });

  it("lets the later listing win when duplicates are replaced", async () => {
    const parts = await readOoxmlZipEntries(TWICE, options, options.now(), {
      ...PLAN,
      duplicateParts: "replace",
    });
    expect([...parts]).toEqual([["a/one.xml", "second"]]);
  });

  it("leaves the walk unbounded when the plan carries no entry or total ceiling", async () => {
    const bytes = zipTextEntries([
      { name: "a/one.xml", content: "x".repeat(40) },
      { name: "a/two.xml", content: "y".repeat(40) },
      { name: "b/three.xml", content: "z" },
    ]);
    const parts = await readOoxmlZipEntries(bytes, options, options.now(), PLAN);
    expect([...parts.keys()]).toEqual(["a/one.xml", "a/two.xml"]);
  });

  it("enforces the entry and total ceilings when the plan sets them", async () => {
    const bytes = zipTextEntries([
      { name: "a/one.xml", content: "x".repeat(40) },
      { name: "a/two.xml", content: "y".repeat(40) },
    ]);
    const entries = await failureOf(
      readOoxmlZipEntries(bytes, options, options.now(), { ...PLAN, maxEntries: 1 }),
    );
    expect(classifyOoxmlZipError(entries)).toBe("budget");
    const total = await failureOf(
      readOoxmlZipEntries(bytes, options, options.now(), { ...PLAN, maxTotalInflatedBytes: 60 }),
    );
    expect(classifyOoxmlZipError(total)).toBe("malformed");
  });

  it("honours an abort signal unless the plan opts out of the scan budget", async () => {
    const aborted = buildParserOptions({ signal: AbortSignal.abort() });
    const stopped = await failureOf(readOoxmlZipEntries(TWICE, aborted, aborted.now(), PLAN));
    expect(classifyOoxmlZipError(stopped)).toBe("cancelled");
    const parts = await readOoxmlZipEntries(TWICE, aborted, aborted.now(), {
      ...PLAN,
      duplicateParts: "replace",
      scanBudget: "none",
    });
    expect(parts.get("a/one.xml")).toBe("second");
  });
});
