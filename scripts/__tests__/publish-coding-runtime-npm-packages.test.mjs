import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODING_RUNTIME_RELEASES_FILE,
  publishCodingRuntimePackages,
  publishRuntime,
  receiptAssetName,
  registryIntegrity,
  reviewedRelease,
  verifyDownloadedRuntime,
} from "../publish-coding-runtime-npm-packages.mjs";

const VERSION = "1.1.4";
const OIDC = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
};
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "keiko-runtime-publish-test-"));
  roots.push(root);
  return root;
}

// A tarball stand-in and the pin a reviewed change would record for it.
function pinned(assetDir, target, bytes) {
  const name = `@oscharko-dev/keiko-coding-runtime-darwin-${target.slice("macos-".length)}`;
  const tarball = `${name.slice(1).replace("/", "-")}-${VERSION}.tgz`;
  writeFileSync(join(assetDir, tarball), bytes);
  writeFileSync(join(assetDir, receiptAssetName(tarball)), "{}\n");
  return {
    name,
    tarball,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function reviewedRoot(entries) {
  const root = scratch();
  mkdirSync(join(root, "docs", "release"), { recursive: true });
  writeFileSync(
    join(root, CODING_RUNTIME_RELEASES_FILE),
    JSON.stringify({ schemaVersion: 1, releases: { [VERSION]: entries } }),
  );
  return root;
}

function notFound() {
  return Object.assign(new Error("npm view failed"), {
    stdout: JSON.stringify({ error: { code: "E404" } }),
  });
}

// #3898 AC8: the runtime packages publish through npm Trusted Publishing, only the reviewed bytes.
describe("coding-runtime package publisher", () => {
  it("reads the reviewed pins of a version and refuses any other version or shape", () => {
    const assetDir = scratch();
    const entry = pinned(assetDir, "macos-arm64", Buffer.from("arm64"));
    const document = { schemaVersion: 1, releases: { [VERSION]: { "macos-arm64": entry } } };

    expect(reviewedRelease(document, VERSION)).toEqual([{ target: "macos-arm64", ...entry }]);
    expect(() => reviewedRelease(document, "1.1.5")).toThrow("never reviewed");
    expect(() => reviewedRelease(document, "latest")).toThrow("x.y.z");
    expect(() => reviewedRelease({ ...document, schemaVersion: 2 }, VERSION)).toThrow();
    for (const broken of [
      { ...entry, sha256: "0".repeat(63) },
      { ...entry, integrity: "sha256-abc" },
      { ...entry, tarball: "other.tgz" },
      { ...entry, sizeBytes: 0 },
    ]) {
      const releases = { [VERSION]: { "macos-arm64": broken } };
      expect(() => reviewedRelease({ schemaVersion: 1, releases }, VERSION)).toThrow("malformed");
    }
  });

  it("refuses a downloaded tarball that is not the pinned one before extracting it", async () => {
    const assetDir = scratch();
    const entry = pinned(assetDir, "macos-arm64", Buffer.from("arm64"));
    writeFileSync(join(assetDir, entry.tarball), "swapped");
    const run = vi.fn();
    const verifyCandidate = vi.fn();

    await expect(
      verifyDownloadedRuntime({ target: "macos-arm64", ...entry }, VERSION, assetDir, {
        run,
        verifyCandidate,
      }),
    ).rejects.toThrow("is not pinned");
    expect(run).not.toHaveBeenCalled();
    expect(verifyCandidate).not.toHaveBeenCalled();
  });

  it("verifies the extracted pinned tarball with the builder's verifier and its receipt", async () => {
    const assetDir = scratch();
    const entry = pinned(assetDir, "macos-x64", Buffer.from("x64"));
    const run = vi.fn();
    const verifyCandidate = vi.fn((input) => {
      expect(readFileSync(join(input.artifactDir, "receipt.json"), "utf8")).toBe("{}\n");
      expect(readFileSync(join(input.artifactDir, entry.tarball), "utf8")).toBe("x64");
      return Promise.resolve();
    });

    await expect(
      verifyDownloadedRuntime({ target: "macos-x64", ...entry }, VERSION, assetDir, {
        run,
        verifyCandidate,
      }),
    ).resolves.toBe(join(assetDir, entry.tarball));
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/tar$/u), [
      "-xzf",
      join(assetDir, entry.tarball),
      "-C",
      expect.any(String),
    ]);
    expect(verifyCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ target: "macos-x64", version: VERSION }),
    );
  });

  it("answers what npm holds, nothing for an unpublished version, and fails on anything else", () => {
    expect(registryIntegrity("pkg", VERSION, () => '"sha512-held"')).toBe("sha512-held");
    expect(
      registryIntegrity("pkg", VERSION, () => {
        throw notFound();
      }),
    ).toBeUndefined();
    expect(() =>
      registryIntegrity("pkg", VERSION, () => {
        throw new Error("network down");
      }),
    ).toThrow("could not answer");
  });

  it("publishes an unpublished version with provenance and waits until npm serves the pin", async () => {
    const entry = { name: "pkg", integrity: "sha512-pinned" };
    const answers = [notFound(), notFound(), '"sha512-pinned"'];
    const calls = [];
    const npm = vi.fn((args) => {
      calls.push(args[0]);
      if (args[0] === "publish") return "";
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const wait = vi.fn(() => Promise.resolve());

    await expect(
      publishRuntime(entry, VERSION, "/tmp/pkg.tgz", { npm, wait, log: vi.fn() }),
    ).resolves.toBe("published");
    expect(npm).toHaveBeenCalledWith([
      "publish",
      "/tmp/pkg.tgz",
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
    expect(calls).toEqual(["view", "publish", "view", "view"]);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("accepts a version npm already holds only with the pinned integrity", async () => {
    const entry = { name: "pkg", integrity: "sha512-pinned" };
    const same = vi.fn(() => '"sha512-pinned"');
    await expect(
      publishRuntime(entry, VERSION, "x.tgz", { npm: same, log: vi.fn() }),
    ).resolves.toBe("already-published");
    expect(same).toHaveBeenCalledOnce();

    const foreign = vi.fn(() => '"sha512-foreign"');
    await expect(
      publishRuntime(entry, VERSION, "x.tgz", { npm: foreign, log: vi.fn() }),
    ).rejects.toThrow("different");
    expect(foreign).toHaveBeenCalledOnce();
  });

  it("fails when npm never serves the pin after publishing", async () => {
    const npm = vi.fn((args) => {
      if (args[0] === "publish") return "";
      throw notFound();
    });
    await expect(
      publishRuntime({ name: "pkg", integrity: "sha512-pinned" }, VERSION, "x.tgz", {
        npm,
        wait: () => Promise.resolve(),
        verifyAttempts: 3,
        log: vi.fn(),
      }),
    ).rejects.toThrow("does not serve");
  });

  it("publishes only under OIDC, and nothing unless every target verifies", async () => {
    const assetDir = scratch();
    const arm64 = pinned(assetDir, "macos-arm64", Buffer.from("arm64"));
    const x64 = pinned(assetDir, "macos-x64", Buffer.from("x64"));
    const root = reviewedRoot({ "macos-arm64": arm64, "macos-x64": x64 });
    const npm = vi.fn();
    const deps = { npm, run: vi.fn(), verifyCandidate: () => Promise.resolve(), log: vi.fn() };

    await expect(
      publishCodingRuntimePackages({ root, version: VERSION, assetDir, env: {}, deps }),
    ).rejects.toThrow("OIDC");
    writeFileSync(join(assetDir, x64.tarball), "swapped");
    await expect(
      publishCodingRuntimePackages({ root, version: VERSION, assetDir, env: OIDC, deps }),
    ).rejects.toThrow("is not pinned");
    expect(npm).not.toHaveBeenCalled();
  });

  it("publishes every verified target", async () => {
    const assetDir = scratch();
    const arm64 = pinned(assetDir, "macos-arm64", Buffer.from("arm64"));
    const x64 = pinned(assetDir, "macos-x64", Buffer.from("x64"));
    const root = reviewedRoot({ "macos-arm64": arm64, "macos-x64": x64 });
    const held = new Map();
    const npm = vi.fn((args) => {
      if (args[0] === "publish") {
        const entry = [arm64, x64].find((candidate) => args[1].endsWith(candidate.tarball));
        held.set(entry.name, entry.integrity);
        return "";
      }
      const name = args[1].slice(0, args[1].lastIndexOf("@"));
      if (!held.has(name)) throw notFound();
      return JSON.stringify(held.get(name));
    });
    const deps = { npm, run: vi.fn(), verifyCandidate: () => Promise.resolve(), log: vi.fn() };

    await expect(
      publishCodingRuntimePackages({ root, version: VERSION, assetDir, env: OIDC, deps }),
    ).resolves.toEqual(["published", "published"]);
    expect(held).toEqual(
      new Map([
        [arm64.name, arm64.integrity],
        [x64.name, x64.integrity],
      ]),
    );
  });
});
