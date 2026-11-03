import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RIPGREP_OVERRIDE_ENV,
  ripgrepProvisionedBinaryPath,
} from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import { customerShapeRipgrepEnvironment } from "../lib/customer-shape-ripgrep.mjs";

const roots = [];
const POSIX = process.platform !== "win32";

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "keiko-customer-shape-ripgrep-"));
  chmodSync(root, 0o755);
  roots.push(root);
  return root;
}

function stageAt(root, key, content) {
  const path = ripgrepProvisionedBinaryPath(root, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  chmodSync(dirname(path), 0o755);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

describe("customer-shape ripgrep hand-off", () => {
  it("names an unsupported qualification host instead of guessing", () => {
    expect(() =>
      customerShapeRipgrepEnvironment({
        repoRoot: checkout(),
        hostPlatform: "freebsd",
        hostArchitecture: "x64",
      }),
    ).toThrow("no pinned ripgrep for freebsd-x64");
  });

  it("fails the qualification up front when the pinned ripgrep is not provisioned", () => {
    expect(() =>
      customerShapeRipgrepEnvironment({
        repoRoot: checkout(),
        hostPlatform: "darwin",
        hostArchitecture: "arm64",
      }),
    ).toThrow("not provisioned (missing); run npm run provision:ripgrep");
  });

  it.skipIf(!POSIX)("refuses an executable that is not the pinned release", () => {
    const root = checkout();
    stageAt(root, "darwin-arm64", "some other ripgrep");
    expect(() =>
      customerShapeRipgrepEnvironment({
        repoRoot: root,
        hostPlatform: "darwin",
        hostArchitecture: "arm64",
      }),
    ).toThrow("not provisioned (digest-mismatch)");
  });

  it("hands the runtime the provisioned path through the verified override and nothing else", () => {
    const root = checkout();
    const verified = [];
    const environment = customerShapeRipgrepEnvironment({
      repoRoot: root,
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      verify: (path, key) => {
        verified.push([path, key]);
        return { ok: true, path, sha256: "0".repeat(64), version: "15.1.0" };
      },
    });

    const expected = ripgrepProvisionedBinaryPath(root, "darwin-arm64");
    expect(environment).toEqual({ [RIPGREP_OVERRIDE_ENV]: expected });
    expect(verified).toEqual([[expected, "darwin-arm64"]]);
  });

  it("verifies with the product verifier by default, so a stand-in file never passes", () => {
    const root = checkout();
    const path = stageAt(root, "linux-x64", "a stand-in that is not ripgrep");
    expect(path).toContain(".ripgrep");
    expect(() =>
      customerShapeRipgrepEnvironment({
        repoRoot: root,
        hostPlatform: "linux",
        hostArchitecture: "x64",
      }),
    ).toThrow(POSIX ? "digest-mismatch" : "not provisioned");
  });
});
