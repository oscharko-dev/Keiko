import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { portableTargetByName } from "../portable-runtime.mjs";
import { stageUsearchAddon } from "../stage-portable-runtime.mjs";

const roots = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-portable-usearch-"));
  roots.push(root);
  return root;
}

function hostPortableTarget() {
  const name =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "macos-arm64"
        : "macos-x64"
      : "windows-x64";
  const target = portableTargetByName(name);
  if (target === undefined) throw new Error("expected a supported portable target");
  return target;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function provisionedRuntimeFixture() {
  const root = temporaryRoot();
  const sourceBinary = join(root, "usearch.node");
  const sourceLicense = join(root, "LICENSE");
  writeFileSync(sourceBinary, "fixture USearch runtime");
  writeFileSync(sourceLicense, "fixture USearch license");
  return {
    approved: { binarySha256: sha256(sourceBinary) },
    sourceBinary,
    sourceLicense,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("portable USearch staging", () => {
  it("binds shippedSha256 to the bytes copied into the staged payload", () => {
    const resourceRoot = temporaryRoot();
    const runtime = provisionedRuntimeFixture();
    const [addon] = stageUsearchAddon(hostPortableTarget(), resourceRoot, {
      resolveRuntime: () => runtime,
    });
    if (addon === undefined) throw new Error("expected staged USearch manifest entry");
    const destination = join(resourceRoot, "runtime", "native", "usearch.node");

    expect(addon.shippedSha256).toBe(sha256(destination));
  });

  it("fails closed when copied payload bytes differ from the approved runtime", () => {
    const resourceRoot = temporaryRoot();
    const runtime = provisionedRuntimeFixture();
    expect(() =>
      stageUsearchAddon(hostPortableTarget(), resourceRoot, {
        copyFile: (source, destination) => {
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(source, destination);
          if (basename(destination) === "usearch.node") {
            writeFileSync(
              destination,
              Buffer.concat([readFileSync(destination), Buffer.from("drift")]),
            );
          }
        },
        onFailure: (message) => {
          throw new Error(message);
        },
        resolveRuntime: () => runtime,
      }),
    ).toThrow("platform-pinned digest");
  });
});
