import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import {
  captureSupportRegistries,
  DEFAULT_COMMITS,
  generateSupportRegistryHistory,
  main,
  renderSupportRegistryHistory,
} from "../generate-support-registry-history.mjs";

describe("trusted support registry history generator", () => {
  it("reproduces the shipped archive from the reviewed immutable release commits", async () => {
    const snapshots = captureSupportRegistries();
    expect(snapshots).toHaveLength(5);
    const generated = await format(renderSupportRegistryHistory(snapshots), {
      parser: "typescript",
      printWidth: 100,
    });
    expect(generated).toBe(
      readFileSync("packages/keiko-activity-log/src/reader/support-registry-history.ts", "utf8"),
    );
    for (const snapshot of snapshots) {
      const decoded = JSON.parse(inflateSync(Buffer.from(snapshot.payload, "base64")).toString());
      expect(decoded).toMatchObject({
        registryVersion: snapshot.registryVersion,
        schemaDigest: snapshot.schemaDigest,
        catalogDigest: snapshot.catalogDigest,
      });
      expect(decoded.operations.length).toBeGreaterThan(400);
      expect(decoded.classes.length).toBeGreaterThan(200);
    }
  });

  it("deduplicates a repeated immutable source and rejects refs before running git", () => {
    expect(captureSupportRegistries([DEFAULT_COMMITS[0], DEFAULT_COMMITS[0]])).toHaveLength(1);
    expect(() =>
      captureSupportRegistries(["dev"], () => {
        throw new Error("git must not run");
      }),
    ).toThrow(TypeError);
    expect(() => captureSupportRegistries([DEFAULT_COMMITS[0]], () => "invalid-json")).toThrow(
      SyntaxError,
    );
  });

  it("writes only the selected destination and reports the captured identities", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-registry-history-"));
    const output = join(directory, "history.ts");
    const writes = [];
    try {
      expect(
        main([], (commits) => generateSupportRegistryHistory(commits, output), {
          write: (text) => writes.push(text),
        }),
      ).toBe(5);
      expect(readFileSync(output, "utf8")).toContain("findSupportRegistry");
      expect(writes.join("")).toContain("5 immutable identities");
      expect(
        main([DEFAULT_COMMITS[0]], (commits) => generateSupportRegistryHistory(commits, output), {
          write: (text) => writes.push(text),
        }),
      ).toBe(1);
      let rendered;
      expect(
        generateSupportRegistryHistory(undefined, undefined, (_path, text) => {
          rendered = text;
        }),
      ).toBe(5);
      expect(rendered).toContain(DEFAULT_COMMITS[0]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
import { Buffer } from "node:buffer";
