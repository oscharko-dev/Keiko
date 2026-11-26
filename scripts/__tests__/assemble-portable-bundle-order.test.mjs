import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers";

import { afterEach, describe, expect, it } from "vitest";

import { copyPortableBundleFiles, settledInOrder } from "../assemble-portable-release-assets.mjs";

const manifest = {
  evidence: { checksumsPath: "c", sbomPath: "s", licenseNoticePath: "l" },
  security: { verificationSummaryPath: "v" },
  provenance: { provenanceStatementPath: "p" },
};
const target = { assetName: "asset.zip", nodePlatform: "linux", platformTarget: "linux-x64" };
// The copied order: asset, manifest, c, s, l, v, p.
const ORDER = ["asset.zip", "manifest/portable-manifest.json", "c", "s", "l", "v", "p"];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(behaviour) {
  const root = mkdtempSync(join(tmpdir(), "bundle-order-"));
  roots.push(root);
  const seen = [];
  const copyFile = (_source, _final, _target, relativePath) => {
    seen.push(relativePath);
    return behaviour[relativePath]?.() ?? Promise.resolve();
  };
  const outcome = copyPortableBundleFiles(
    root,
    join(root, "final"),
    manifest,
    target,
    undefined,
    copyFile,
  );
  return { outcome, seen };
}

const later = (message, ms) => () =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms));
const sync = (message) => () => {
  throw new Error(message);
};

describe("copyPortableBundleFiles failure order", () => {
  it("throws the earlier digest mismatch over a later synchronous failure", async () => {
    const { outcome, seen } = run({ c: later("digest c", 5), p: sync("sync p") });
    await expect(outcome).rejects.toThrow("digest c");
    expect(seen).toEqual(ORDER);
  });

  it("throws a lone synchronous failure and copies nothing after it", async () => {
    const { outcome, seen } = run({ s: sync("sync s") });
    await expect(outcome).rejects.toThrow("sync s");
    expect(seen).toEqual(ORDER.slice(0, 4));
  });

  it("throws the first digest mismatch in path order, whatever finishes first", async () => {
    const { outcome } = run({ c: later("digest c", 20), v: later("digest v", 1) });
    await expect(outcome).rejects.toThrow("digest c");
  });

  it("resolves when every file verifies", async () => {
    await expect(run({}).outcome).resolves.toBeUndefined();
  });
});

describe("settledInOrder", () => {
  it("returns the values in order", async () => {
    await expect(settledInOrder([Promise.resolve(1), Promise.resolve(2)])).resolves.toEqual([1, 2]);
  });
});
