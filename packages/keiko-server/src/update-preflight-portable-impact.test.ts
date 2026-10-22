import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReleaseImpactCatalog } from "@oscharko-dev/keiko-contracts";
import {
  portableImpactMetadataValid,
  portableReleaseImpactCatalog,
} from "./update-preflight-portable-impact.js";

function impact(): { entryId: string; catalog: ReleaseImpactCatalog } {
  const raw = JSON.parse(
    readFileSync(new URL("../../../release-impact.catalog.json", import.meta.url), "utf8"),
  ) as ReleaseImpactCatalog;
  const entries = raw.entries.filter(({ packageVersion }) =>
    /^\d+\.\d+\.\d+$/u.test(packageVersion),
  );
  const entry = entries.at(-1);
  if (entry === undefined) throw new Error("catalog fixture is missing");
  return { entryId: entry.id, catalog: { schemaVersion: 1, entries } };
}

describe("authenticated future release impact", () => {
  it("retains intermediate state changes and the exact reviewed target entry", () => {
    const source = impact();
    const version = source.catalog.entries.at(-1)?.packageVersion ?? "";
    expect(portableReleaseImpactCatalog(source, version, true)).toEqual(source.catalog);
    expect(portableReleaseImpactCatalog(source, version, false)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    { catalog: {} },
    { catalog: { schemaVersion: 1, entries: [null] } },
    { catalog: { schemaVersion: 1, entries: [] } },
  ])("refuses incomplete remote impact metadata %#", (source) => {
    expect(portableReleaseImpactCatalog(source, "1.2.5", true)).toBeUndefined();
  });

  it("refuses duplicate entries, a target mismatch and records beyond the selected version", () => {
    const source = impact();
    const entry = source.catalog.entries.at(-1);
    if (entry === undefined) throw new Error("catalog fixture is missing");
    const duplicate = { ...source, catalog: { schemaVersion: 1, entries: [entry, entry] } };
    expect(portableReleaseImpactCatalog(duplicate, entry.packageVersion, true)).toBeUndefined();
    expect(
      portableReleaseImpactCatalog({ ...source, entryId: "missing" }, entry.packageVersion, true),
    ).toBeUndefined();
    expect(portableReleaseImpactCatalog(source, "0.2.0", true)).toBeUndefined();
    const wrongTag = {
      ...source,
      catalog: { schemaVersion: 1, entries: [{ ...entry, releaseTag: "v0.0.0" }] },
    };
    expect(portableReleaseImpactCatalog(wrongTag, entry.packageVersion, true)).toBeUndefined();
  });

  it("allows legacy absence while refusing a present catalog that did not validate", () => {
    expect(portableImpactMetadataValid(undefined, undefined)).toBe(true);
    expect(portableImpactMetadataValid({}, undefined)).toBe(true);
    expect(portableImpactMetadataValid(impact(), undefined)).toBe(false);
    const source = impact();
    expect(portableImpactMetadataValid(source, source.catalog)).toBe(true);
  });
});
