import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareCodeUnits,
  devLaneManifestDocument,
  hashHelperSourceTree,
  hostDevLaneTarget,
  isDirectInvocation,
  listFilesSorted,
  resolveStageDeps,
  stageDevCodingRuntime,
} from "../stage-dev-coding-runtime.mjs";

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-stage-dev-lane-"));
  roots.push(root);
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hostDevLaneTarget", () => {
  it("maps only the two supported macOS architectures", () => {
    expect(hostDevLaneTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(hostDevLaneTarget("darwin", "x64")).toBe("macos-x64");
    expect(hostDevLaneTarget("darwin", "ppc64")).toBeUndefined();
    expect(hostDevLaneTarget("linux", "x64")).toBeUndefined();
    expect(hostDevLaneTarget("win32", "x64")).toBeUndefined();
  });
});

describe("compareCodeUnits", () => {
  it("orders by code unit, locale-independent, and is total", () => {
    // Under ICU collation "a" < "B"; by code unit "B" (0x42) < "a" (0x61).
    expect(compareCodeUnits("B.c", "a.c")).toBe(-1);
    expect(compareCodeUnits("a.c", "B.c")).toBe(1);
    expect(compareCodeUnits("x", "x")).toBe(0);
  });
});

describe("listFilesSorted / hashHelperSourceTree", () => {
  it("walks nested files in locale-independent order and digests them deterministically", () => {
    const root = tempRoot();
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "B.c"), "/* B */\n");
    writeFileSync(join(root, "a.c"), "/* a */\n");
    writeFileSync(join(root, "sub", "c.c"), "/* c */\n");

    const files = listFilesSorted(root).map((path) => path.slice(root.length + 1));
    expect(files).toEqual(["B.c", "a.c", join("sub", "c.c")]);

    const expected = createHash("sha256");
    for (const [rel, body] of [
      ["B.c", "/* B */\n"],
      ["a.c", "/* a */\n"],
      ["sub/c.c", "/* c */\n"],
    ]) {
      expected.update(`${rel}\0${sha256(body)}\0`);
    }
    expect(hashHelperSourceTree(root)).toBe(expected.digest("hex"));
  });
});

describe("devLaneManifestDocument", () => {
  it("binds the helper facts and the source-tree digest under the given root", () => {
    const root = tempRoot();
    mkdirSync(join(root, "native", "secure-workspace-read"), { recursive: true });
    writeFileSync(join(root, "native", "secure-workspace-read", "src.c"), "/* fixture */\n");

    const manifest = devLaneManifestDocument(
      {
        target: "macos-arm64",
        helperSha256: "a".repeat(64),
        helperSizeBytes: 42,
        sourceCommit: "b".repeat(40),
      },
      root,
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      target: "macos-arm64",
      helper: { sha256: "a".repeat(64), sizeBytes: 42, sourceCommit: "b".repeat(40) },
    });
    expect(manifest.helper.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("isDirectInvocation", () => {
  it("is true only when argv[1] resolves to the module URL", () => {
    const moduleUrl = "file:///repo/scripts/stage-dev-coding-runtime.mjs";
    expect(isDirectInvocation("/repo/scripts/stage-dev-coding-runtime.mjs", moduleUrl)).toBe(true);
    expect(isDirectInvocation("/repo/scripts/other.mjs", moduleUrl)).toBe(false);
    expect(isDirectInvocation(undefined, moduleUrl)).toBe(false);
  });
});

describe("resolveStageDeps", () => {
  it("fills every dependency with a real default when none is injected", () => {
    const resolved = resolveStageDeps({});
    expect(typeof resolved.prepareSidecars).toBe("function");
    expect(typeof resolved.runBuild).toBe("function");
    expect(typeof resolved.resolveGit).toBe("function");
    expect(typeof resolved.exec).toBe("function");
    expect(typeof resolved.log).toBe("function");
    expect(typeof resolved.root).toBe("string");
    // Target derives from the injected host identity, not the real process, so this is host-stable.
    expect(resolveStageDeps({ platform: "linux", arch: "x64" }).target).toBeUndefined();
    expect(resolveStageDeps({ platform: "darwin", arch: "arm64" }).target).toBe("macos-arm64");
  });

  it("prefers every injected dependency over the default", () => {
    const injected = {
      root: "/inject",
      prepareSidecars: () => undefined,
      runBuild: () => 0,
      resolveGit: () => "/g",
      exec: () => "",
      log: () => undefined,
      target: "macos-x64",
    };
    expect(resolveStageDeps(injected)).toMatchObject({ root: "/inject", target: "macos-x64" });
  });
});

describe("stageDevCodingRuntime", () => {
  it("refuses a non-macOS host before touching any I/O", async () => {
    const prepareSidecars = vi.fn();
    // The refusal message must report the identity that drove the decision (the injected host),
    // not the real process platform/arch (Gitar review on #2487).
    await expect(
      stageDevCodingRuntime([], { platform: "linux", arch: "x64", prepareSidecars }),
    ).rejects.toThrow("this host is linux/x64");
    expect(prepareSidecars).not.toHaveBeenCalled();
  });

  it("propagates a non-zero native build status as a failure", async () => {
    const root = tempRoot();
    await expect(
      stageDevCodingRuntime([], {
        target: "macos-arm64",
        root,
        prepareSidecars: vi.fn().mockResolvedValue(undefined),
        runBuild: vi.fn().mockResolvedValue(3),
        log: vi.fn(),
      }),
    ).rejects.toThrow("secure-workspace-read build failed with status 3");
  });

  it("prepares the payload, builds the helper, and writes a bound manifest", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "native", "secure-workspace-read"), { recursive: true });
    writeFileSync(join(root, "native", "secure-workspace-read", "src.c"), "/* fixture */\n");
    const helperBody = "#!/bin/sh\nexit 0\n";
    const prepareSidecars = vi.fn().mockResolvedValue(undefined);
    const runBuild = vi.fn().mockImplementation(({ argv }) => {
      const helperPath = argv[3];
      mkdirSync(join(helperPath, ".."), { recursive: true });
      writeFileSync(helperPath, helperBody);
      return Promise.resolve(0);
    });
    const exec = vi.fn().mockReturnValue(`${"c".repeat(40)}\n`);
    const resolveGit = vi.fn().mockReturnValue("/usr/bin/git");
    const log = vi.fn();

    const manifestPath = await stageDevCodingRuntime(["--output-root", "x"], {
      target: "macos-arm64",
      root,
      prepareSidecars,
      runBuild,
      exec,
      resolveGit,
      log,
    });

    expect(prepareSidecars).toHaveBeenCalledWith(["--target", "macos-arm64", "--output-root", "x"]);
    expect(runBuild).toHaveBeenCalledOnce();
    expect(resolveGit).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({ cwd: root }),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      target: "macos-arm64",
      helper: {
        sha256: sha256(helperBody),
        sizeBytes: helperBody.length,
        sourceCommit: "c".repeat(40),
      },
    });
    expect(manifest.helper.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
