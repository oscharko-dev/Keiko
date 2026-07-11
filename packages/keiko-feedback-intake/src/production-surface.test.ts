import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as surface from "./index.js";

describe("hosted production package surface", () => {
  it("does not export in-memory intake or key-ring implementations", async () => {
    expect(surface).not.toHaveProperty("createInMemoryFeedbackIntake");
    expect(surface).not.toHaveProperty("InMemorySecretRing");
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly exports?: Readonly<Record<string, unknown>> };
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
  });
});
