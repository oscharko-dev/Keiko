import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildArtifacts,
  buildSpecification,
  FILE_BASE,
  main,
} from "../generate-lastenheft-golden.mjs";
import { GROUPS } from "../lastenheft-golden-features.mjs";

const COMMITTED = new URL(
  "../../tests/fixtures/requirements/lastenheft-kundenportal/",
  import.meta.url,
);
const directories = [];

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "lastenheft-golden-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  process.exitCode = undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("lastenheft feature catalogue", () => {
  it("parses every group with its path, prefix, subject, style and title/predicate pairs", () => {
    expect(GROUPS.length).toBeGreaterThan(40);
    for (const group of GROUPS) {
      expect(group.path.length).toBeGreaterThan(0);
      expect(group.prefix.length).toBeGreaterThan(0);
      expect(["heading", "plain", "table", "bracket"]).toContain(group.style);
      expect(group.features.length).toBeGreaterThan(0);
      for (const feature of group.features) {
        expect(feature).toHaveLength(2);
        expect(feature.every((part) => part.length > 0)).toBe(true);
      }
    }
  });

  it("keeps the optional group fields only where the catalogue declares them", () => {
    expect(GROUPS.some((group) => group.dotted === true)).toBe(true);
    expect(GROUPS.some((group) => Array.isArray(group.priorityValues))).toBe(true);
    expect(GROUPS.some((group) => group.priorityKey === undefined)).toBe(true);
  });
});

describe("generate-lastenheft-golden", () => {
  it("states every catalogue requirement once in the manifest", () => {
    const { manifest } = buildSpecification();
    const total = GROUPS.reduce((sum, group) => sum + group.features.length, 0);
    expect(manifest.requirementCount).toBe(total);
    expect(manifest.requirements).toHaveLength(total);
  });

  it("produces the committed fixture bytes (the --check mode passes against them)", () => {
    for (const [name, bytes] of Object.entries(buildArtifacts())) {
      expect(readFileSync(new URL(name, COMMITTED)).equals(bytes)).toBe(true);
    }
    main(["--check"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("writes the four artifacts to --out and then verifies them", () => {
    const directory = scratch();
    main(["--out", directory]);
    expect(readFileSync(join(directory, `${FILE_BASE}.md`), "utf8")).toContain("REQ-");
    main(["--check", "--out", directory]);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports stale and missing artifacts through the exit code", () => {
    const directory = scratch();
    main(["--out", directory]);
    writeFileSync(join(directory, "manifest.json"), "{}\n");
    main(["--check", "--out", directory]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    main(["--check", "--out", join(directory, "missing")]);
    expect(process.exitCode).toBe(1);
  });
});
