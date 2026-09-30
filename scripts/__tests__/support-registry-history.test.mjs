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
} from "../generate-support-registry-history.mjs";

describe("trusted support registry history generator", () => {
  it("reproduces the shipped archive from the reviewed immutable release commits", async () => {
    const snapshots = captureSupportRegistries();
    expect(snapshots).toHaveLength(5);
    const committed = readFileSync(
      "packages/keiko-activity-log/src/reader/support-registry-history.ts",
      "utf8",
    );
    // Deflate streams may differ across supported Node/zlib versions; the decoded immutable
    // registry and reviewed identity must remain exactly equal, independently of compression.
    const payloads = [...committed.matchAll(/payload:\s*"([A-Za-z0-9+/=]+)"/gu)];
    expect(payloads).toHaveLength(snapshots.length);
    for (const [index, snapshot] of snapshots.entries()) {
      expect(committed).toContain(snapshot.sourceCommit);
      expect(committed).toContain(snapshot.schemaDigest);
      expect(committed).toContain(snapshot.catalogDigest);
      expect(inflateSync(Buffer.from(payloads[index][1], "base64"))).toEqual(
        inflateSync(Buffer.from(snapshot.payload, "base64")),
      );
    }
    expect(await format(committed, { parser: "typescript", printWidth: 100 })).toBe(committed);
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

  it("writes only the selected destination and reports the captured identities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-registry-history-"));
    const output = join(directory, "history.ts");
    const writes = [];
    try {
      expect(
        await main([], (commits) => generateSupportRegistryHistory(commits, output), {
          write: (text) => writes.push(text),
        }),
      ).toBe(5);
      expect(readFileSync(output, "utf8")).toContain("findSupportRegistry");
      expect(writes.join("")).toContain("5 immutable identities");
      expect(
        await main(
          [DEFAULT_COMMITS[0]],
          (commits) => generateSupportRegistryHistory(commits, output),
          {
            write: (text) => writes.push(text),
          },
        ),
      ).toBe(1);
      let rendered;
      expect(
        await generateSupportRegistryHistory(undefined, undefined, (_path, text) => {
          rendered = text;
        }),
      ).toBe(5);
      expect(rendered).toContain(DEFAULT_COMMITS[0]);
      expect(await format(rendered, { parser: "typescript", printWidth: 100 })).toBe(rendered);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
import { Buffer } from "node:buffer";
