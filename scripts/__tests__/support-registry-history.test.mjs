import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import {
  captureSupportRegistries,
  FIRST_SUPPORTED_RELEASE,
  generateSupportRegistryHistory,
  main,
  MAX_DECODED_SNAPSHOT_BYTES,
  supportedReleases,
} from "../generate-support-registry-history.mjs";
import { compareStableVersions, parseStableVersion } from "../lib/stable-version.mjs";

const HISTORY = "packages/keiko-activity-log/src/reader/support-registry-history.ts";
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

function shippedSnapshots() {
  const text = readFileSync(HISTORY, "utf8");
  return [
    ...text.matchAll(
      /release: "([0-9.]+)",\s*sourceCommit: "([a-f0-9]{40})",[\s\S]*?catalogDigest: "([a-f0-9]{64})",\s*payload:\s*"([A-Za-z0-9+/=]+)"/gu,
    ),
  ].map(([, release, sourceCommit, catalogDigest, payload]) => ({
    release,
    sourceCommit,
    catalogDigest,
    decoded: inflateSync(Buffer.from(payload, "base64")),
  }));
}

function olderThanCurrent(release) {
  return compareStableVersions(parseStableVersion(release), parseStableVersion(VERSION)) < 0;
}

// A fake git that answers exactly the three commands the generator issues.
function fakeGit({ tags, commits, catalogs }) {
  return (_executable, args) => {
    if (args[0] === "tag") return `${tags.join("\n")}\n`;
    if (args[0] === "rev-parse") return `${commits[args[2].replace("^{commit}", "")]}\n`;
    if (args[0] === "show") return catalogs[args[1].split(":")[0]];
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function catalog(catalogDigest) {
  return JSON.stringify({
    typedRegistry: {
      schemaVersion: 1,
      schemaDigest: "a".repeat(64),
      catalogDigest,
      operations: [],
      failureClassCoverage: { classes: [] },
    },
  });
}

describe("trusted support registry history", () => {
  it("ships exactly the immutable registry of every supported release older than this version", () => {
    // Discovery: every stable release tag the analyzer of this version must keep validating.
    const allowed = captureSupportRegistries(supportedReleases(VERSION));
    const required = allowed.filter((snapshot) => olderThanCurrent(snapshot.release));
    const shipped = shippedSnapshots();
    expect(required.length).toBeGreaterThan(0);
    const missing = required.filter(
      (snapshot) => !shipped.some((entry) => entry.catalogDigest === snapshot.catalogDigest),
    );
    // A release-preparing bump that forgot to regenerate names every missing release here.
    expect(
      missing.map((snapshot) => snapshot.release),
      "npm run set-version regenerates",
    ).toEqual([]);
    for (const entry of shipped) {
      const expected = allowed.find((snapshot) => snapshot.catalogDigest === entry.catalogDigest);
      expect(expected, `${entry.release} is not a supported release`).toBeDefined();
      // A moved tag or an edited payload no longer matches the reviewed commit's exact registry.
      expect(entry.release).toBe(expected.release);
      expect(entry.sourceCommit).toBe(expected.sourceCommit);
      const captured = inflateSync(Buffer.from(expected.payload, "base64"));
      // Native byte equality: deflate streams differ across zlib versions, decoded bytes never.
      expect(entry.decoded.equals(captured), entry.release).toBe(true);
      expect(entry.decoded.length).toBeLessThanOrEqual(MAX_DECODED_SNAPSHOT_BYTES);
    }
    const committed = readFileSync(HISTORY, "utf8");
    expect(committed).toContain(`maxOutputLength: ${String(MAX_DECODED_SNAPSHOT_BYTES)}`);
  });

  it("is formatted exactly as the generator writes it", async () => {
    const committed = readFileSync(HISTORY, "utf8");
    expect(await format(committed, { parser: "typescript", printWidth: 100 })).toBe(committed);
  });

  it("selects stable tags from the first supported release up to the given version", () => {
    const execute = fakeGit({
      tags: ["v1.1.8", "v1.1.10", "v1.1.9", "v1.1.10-rc.1", "v1.2.0", "vnext", ""],
      commits: { "v1.1.9": "9".repeat(40), "v1.1.10": "a".repeat(40) },
      catalogs: {},
    });
    expect(supportedReleases("1.1.10", execute)).toEqual([
      { release: "1.1.9", sourceCommit: "9".repeat(40) },
      { release: "1.1.10", sourceCommit: "a".repeat(40) },
    ]);
    expect(FIRST_SUPPORTED_RELEASE).toBe("1.1.9");
  });

  it("fails closed when no release tag is reachable or the version is not a release", () => {
    const empty = fakeGit({ tags: [], commits: {}, catalogs: {} });
    expect(() => supportedReleases("1.1.14", empty)).toThrow("fetch the tags");
    expect(supportedReleases(FIRST_SUPPORTED_RELEASE, empty)).toEqual([]);
    expect(() => supportedReleases("1.2.0-rc.1", empty)).toThrow(TypeError);
  });

  it("keeps one snapshot per registry identity and refuses refs or oversized registries", () => {
    const execute = fakeGit({
      tags: [],
      commits: {},
      catalogs: {
        ["1".repeat(40)]: catalog("c".repeat(64)),
        ["2".repeat(40)]: catalog("c".repeat(64)),
      },
    });
    const snapshots = captureSupportRegistries(
      [
        { release: "1.1.9", sourceCommit: "1".repeat(40) },
        { release: "1.1.10", sourceCommit: "2".repeat(40) },
      ],
      execute,
    );
    expect(snapshots.map(({ release }) => release)).toEqual(["1.1.9"]);
    expect(() =>
      captureSupportRegistries([{ release: "1.1.9", sourceCommit: "dev" }], () => {
        throw new Error("git must not run");
      }),
    ).toThrow(TypeError);
    const huge = JSON.stringify({
      typedRegistry: {
        schemaVersion: 1,
        schemaDigest: "a".repeat(64),
        catalogDigest: "d".repeat(64),
        operations: ["x".repeat(MAX_DECODED_SNAPSHOT_BYTES)],
        failureClassCoverage: { classes: [] },
      },
    });
    expect(() =>
      captureSupportRegistries([{ release: "1.1.9", sourceCommit: "3".repeat(40) }], () => huge),
    ).toThrow(RangeError);
  });

  it("writes only the selected destination and reports the captured releases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-registry-history-"));
    const output = join(directory, "history.ts");
    const writes = [];
    try {
      const execute = fakeGit({
        tags: ["v1.1.9", "v1.1.10"],
        commits: { "v1.1.9": "1".repeat(40), "v1.1.10": "2".repeat(40) },
        catalogs: {
          ["1".repeat(40)]: catalog("e".repeat(64)),
          ["2".repeat(40)]: catalog("f".repeat(64)),
        },
      });
      const generate = () =>
        generateSupportRegistryHistory({ version: "1.1.10", destination: output, execute });
      expect(await main(generate, { write: (text) => writes.push(text) })).toBe(2);
      const rendered = readFileSync(output, "utf8");
      expect(rendered).toContain("Supported releases 1.1.9–1.1.10.");
      expect(rendered).toContain("findSupportRegistry");
      expect(writes.join("")).toContain("captured 2 release registries (1.1.9–1.1.10)");
      expect(await format(rendered, { parser: "typescript", printWidth: 100 })).toBe(rendered);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
