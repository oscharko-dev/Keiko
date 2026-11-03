import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { portableTargetByName, ripgrepApprovalForPortableTarget } from "../portable-runtime.mjs";
import {
  containedDigest,
  governedStageRoot,
  requiredStageRoot,
  runPortableRipgrepSmokeCli,
  smokePortableRipgrep,
  startAndSearch,
} from "../smoke-portable-ripgrep.mjs";
import { stageRipgrepTool } from "../stage-portable-runtime.mjs";

const roots = [];
const POSIX = process.platform !== "win32";
const SOURCE_REVISION = "af60c2de9d";

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-ripgrep-smoke-test-"));
  roots.push(root);
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function resourceRootFor(stageRoot, target) {
  return target.nodePlatform === "darwin"
    ? join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources")
    : join(stageRoot, "payload", "Keiko");
}

// A conforming ripgrep, in the runner seam: the same four invocations the smoke makes.
function conformingRun(calls = []) {
  return (_binary, args) => {
    calls.push(args);
    if (args.includes("--version")) {
      return { status: 0, stdout: `ripgrep 15.1.0 (rev ${SOURCE_REVISION})\n`, error: undefined };
    }
    if (args.includes("needle")) {
      return { status: 0, stdout: "src/a.txt:2:needle beta\n", error: undefined };
    }
    if (args.includes("--files")) {
      return { status: 0, stdout: "b.txt\nsrc/a.txt\n", error: undefined };
    }
    return { status: 1, stdout: "", error: undefined };
  };
}

function stagedTree(platformTarget = "macos-arm64", { binary = "fixture ripgrep bytes" } = {}) {
  const target = portableTargetByName(platformTarget);
  const stageRoot = temporaryRoot();
  const resourceRoot = resourceRootFor(stageRoot, target);
  const license = "fixture MIT license";
  const real = ripgrepApprovalForPortableTarget(target);
  const approval = { ...real, binarySha256: sha256(binary), licenseSha256: sha256(license) };
  const sourceRoot = temporaryRoot();
  const [tool] = stageRipgrepTool(target, resourceRoot, {
    resolveRuntime: () => ({
      approved: approval,
      sourceBinary: writeFixture(join(sourceRoot, "rg"), binary),
      sourceLicense: writeFixture(join(sourceRoot, "LICENSE-MIT"), license),
    }),
  });
  const manifest = {
    artifact: { platformTarget },
    nativeTools: [tool],
    security: { verificationStatus: "unverified-staging", signatureVerified: false },
  };
  writeFixture(
    join(stageRoot, "manifest", "portable-manifest.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  const sbom = (hash) =>
    writeFixture(
      join(stageRoot, "evidence", "sbom.cdx.json"),
      `${JSON.stringify({
        components: [{ "bom-ref": tool.sbomBomRef, hashes: [{ alg: "SHA-256", content: hash }] }],
      })}\n`,
    );
  sbom(tool.shippedSha256);
  writeFixture(
    join(stageRoot, "evidence", "third-party-notices.txt"),
    "USearch 2.26.0\nripgrep 15.1.0\n",
  );
  const rewriteManifest = (change) => {
    change(manifest);
    writeFixture(
      join(stageRoot, "manifest", "portable-manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
  };
  return { approval, manifest, resourceRoot, rewriteManifest, sbom, stageRoot, target, tool };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("portable ripgrep smoke", () => {
  it.each(["macos-arm64", "macos-x64", "linux-x64", "windows-x64"])(
    "passes a complete staged payload for %s and runs the four invocations",
    (platformTarget) => {
      const tree = stagedTree(platformTarget);
      const calls = [];
      smokePortableRipgrep(tree.stageRoot, platformTarget, {
        approval: tree.approval,
        run: conformingRun(calls),
      });

      expect(calls).toHaveLength(4);
      expect(calls.every((args) => args.includes("--no-config"))).toBe(true);
      expect(calls[0]).toEqual(["--no-config", "--version"]);
    },
  );

  it.skipIf(!POSIX)(
    "executes the shipped file for real, outside PATH and user configuration",
    () => {
      const script = [
        "#!/bin/sh",
        'case "$*" in',
        `  *--version*) echo "ripgrep 15.1.0 (rev ${SOURCE_REVISION})"; echo; echo "features:fixture";;`,
        '  *needle*) echo "src/a.txt:2:needle beta";;',
        '  *--files*) echo "b.txt"; echo "src/a.txt";;',
        "  *) exit 1;;",
        "esac",
        "",
      ].join("\n");
      const tree = stagedTree("linux-x64", { binary: script });
      chmodSync(join(tree.resourceRoot, "runtime", "native", "rg"), 0o755);

      expect(() =>
        smokePortableRipgrep(tree.stageRoot, "linux-x64", { approval: tree.approval }),
      ).not.toThrow();
    },
  );

  it.skipIf(!POSIX)("refuses approved bytes that start but are not the approved release", () => {
    const tree = stagedTree("linux-x64", { binary: "#!/bin/sh\nexit 3\n" });
    chmodSync(join(tree.resourceRoot, "runtime", "native", "rg"), 0o755);

    expect(() =>
      smokePortableRipgrep(tree.stageRoot, "linux-x64", { approval: tree.approval }),
    ).toThrow("executable does not report the approved ripgrep release");
  });

  it("accepts the platform-signed bytes only once the manifest declares a verified production signature", () => {
    const tree = stagedTree("macos-arm64");
    const signed = "fixture ripgrep bytes + platform signature";
    writeFileSync(join(tree.resourceRoot, "runtime", "native", "rg"), signed);
    tree.rewriteManifest((manifest) => {
      manifest.nativeTools[0].shippedSha256 = sha256(signed);
    });
    tree.sbom(sha256(signed));

    expect(() =>
      smokePortableRipgrep(tree.stageRoot, "macos-arm64", {
        approval: tree.approval,
        run: conformingRun(),
      }),
    ).toThrow("staged ripgrep executable digest is not approved");

    tree.rewriteManifest((manifest) => {
      manifest.security = { verificationStatus: "verified-production", signatureVerified: true };
      manifest.nativeTools[0].signing = {
        verificationStatus: "verified-production",
        signatureVerified: true,
      };
    });
    expect(() =>
      smokePortableRipgrep(tree.stageRoot, "macos-arm64", {
        approval: tree.approval,
        run: conformingRun(),
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "a manifest without a tool",
      (tree) =>
        tree.rewriteManifest((manifest) => {
          delete manifest.nativeTools;
        }),
      "manifest must bind exactly one native tool",
    ],
    [
      "a manifest with two tools",
      (tree) =>
        tree.rewriteManifest((manifest) => {
          manifest.nativeTools.push(manifest.nativeTools[0]);
        }),
      "manifest must bind exactly one native tool",
    ],
    [
      "a foreign tool identity",
      (tree) =>
        tree.rewriteManifest((manifest) => {
          manifest.nativeTools[0].executablePath = "runtime/native/other";
        }),
      "manifest native tool identity is invalid",
    ],
    [
      "a relabelled upstream digest",
      (tree) =>
        tree.rewriteManifest((manifest) => {
          manifest.nativeTools[0].unsignedSha256 = "0".repeat(64);
        }),
      "manifest native tool identity is invalid",
    ],
    [
      "a manifest for another target",
      (tree) =>
        tree.rewriteManifest((manifest) => {
          manifest.artifact.platformTarget = "linux-x64";
        }),
      "manifest target mismatch",
    ],
    [
      "an executable that differs from the manifest binding",
      (tree) => writeFixture(join(tree.resourceRoot, "runtime", "native", "rg"), "swapped"),
      "shipped ripgrep executable digest mismatch",
    ],
    [
      "a tampered license",
      (tree) =>
        writeFixture(
          join(tree.resourceRoot, "runtime", "licenses", "ripgrep", "LICENSE-MIT"),
          "swapped license",
        ),
      "shipped ripgrep license digest mismatch",
    ],
    [
      "a missing executable",
      (tree) => rmSync(join(tree.resourceRoot, "runtime", "native", "rg")),
      "missing shipped ripgrep executable",
    ],
    [
      "an SBOM that binds other bytes",
      (tree) => tree.sbom("1".repeat(64)),
      "SBOM does not bind the shipped native tool",
    ],
    [
      "notices that do not name the tool",
      (tree) =>
        writeFixture(join(tree.stageRoot, "evidence", "third-party-notices.txt"), "USearch only\n"),
      "third-party notice does not identify ripgrep",
    ],
  ])("refuses %s", (_label, damage, message) => {
    const tree = stagedTree("macos-arm64");
    damage(tree);
    expect(() =>
      smokePortableRipgrep(tree.stageRoot, "macos-arm64", {
        approval: tree.approval,
        run: conformingRun(),
      }),
    ).toThrow(message);
  });

  it("refuses an unsupported target and a stage root that is not a directory", () => {
    const tree = stagedTree("macos-arm64");
    expect(() => smokePortableRipgrep(tree.stageRoot, "macos-ppc")).toThrow(
      "platform target is unsupported",
    );
    expect(() => requiredStageRoot(join(tree.stageRoot, "absent"))).toThrow(
      "stage root is missing",
    );
    expect(() =>
      requiredStageRoot(join(tree.stageRoot, "manifest", "portable-manifest.json")),
    ).toThrow("stage root is unsafe");
  });

  it("derives the governed stage root from the declared portable targets only", () => {
    expect(governedStageRoot("linux-x64").replaceAll("\\", "/")).toMatch(
      /\.portable-runtime\/staging\/linux-x64$/u,
    );
    expect(() => governedStageRoot("../escape")).toThrow("platform target is unsupported");
  });

  it.skipIf(!POSIX)("refuses a symlinked executable and a path outside the stage root", () => {
    const tree = stagedTree("linux-x64");
    const outside = writeFixture(join(temporaryRoot(), "outside"), "fixture ripgrep bytes");
    const executable = join(tree.resourceRoot, "runtime", "native", "rg");
    rmSync(executable);
    symlinkSync(outside, executable);
    expect(() =>
      smokePortableRipgrep(tree.stageRoot, "linux-x64", {
        approval: tree.approval,
        run: conformingRun(),
      }),
    ).toThrow("unsafe shipped ripgrep executable");
    expect(() => containedDigest(tree.stageRoot, outside, "outside file", 1024)).toThrow(
      "unsafe outside file",
    );
  });
});

describe("ripgrep start and search", () => {
  const approval = ripgrepApprovalForPortableTarget(portableTargetByName("linux-x64"));

  it.each([
    [
      "a binary that does not start",
      () => ({ status: null, stdout: "", error: { code: "ENOENT" } }),
      "executable did not run: ENOENT",
    ],
    [
      "another release",
      (args) =>
        args.includes("--version")
          ? { status: 0, stdout: `ripgrep 14.1.1 (rev ${SOURCE_REVISION})\n`, error: undefined }
          : conformingRun()("", args),
      "executable does not report the approved ripgrep release",
    ],
    [
      "another revision",
      (args) =>
        args.includes("--version")
          ? { status: 0, stdout: "ripgrep 15.1.0 (rev 0000000000)\n", error: undefined }
          : conformingRun()("", args),
      "executable does not report the approved ripgrep release",
    ],
    [
      "a search that finds nothing",
      (args) =>
        args.includes("needle")
          ? { status: 1, stdout: "", error: undefined }
          : conformingRun()("", args),
      "search did not find text",
    ],
    [
      "an incomplete file listing",
      (args) =>
        args.includes("--files")
          ? { status: 0, stdout: "b.txt\n", error: undefined }
          : conformingRun()("", args),
      "file listing is incomplete",
    ],
    [
      "a miss that does not exit 1",
      (args) =>
        args.includes("absent-pattern")
          ? { status: 0, stdout: "", error: undefined }
          : conformingRun()("", args),
      "a search without a match must exit 1",
    ],
  ])("fails closed for %s", (_label, runner, message) => {
    expect(() => startAndSearch("rg", approval, (_binary, args) => runner(args))).toThrow(message);
  });

  it("runs every invocation inside a private fixture tree it removes afterwards", () => {
    const directories = [];
    startAndSearch("rg", approval, (_binary, args, cwd) => {
      directories.push(cwd);
      return conformingRun()("", args);
    });
    expect(new Set(directories).size).toBe(1);
    expect(() => readFileSync(join(directories[0], "b.txt"))).toThrow();
  });
});

describe("ripgrep smoke command line", () => {
  const governed = (target) => governedStageRoot(target);

  it("smokes the governed stage root of a declared target and reports a pass", () => {
    const calls = [];
    const logs = [];
    const relative = join(".portable-runtime", "staging", "linux-x64");
    for (const stageRoot of [relative, governed("linux-x64")]) {
      runPortableRipgrepSmokeCli(["node", "smoke", stageRoot, "linux-x64"], {
        log: (message) => logs.push(message),
        smoke: (...args) => calls.push(args),
      });
    }
    expect(calls).toEqual([
      [governed("linux-x64"), "linux-x64"],
      [governed("linux-x64"), "linux-x64"],
    ]);
    expect(logs).toEqual([
      "portable-ripgrep-smoke: PASS linux-x64",
      "portable-ripgrep-smoke: PASS linux-x64",
    ]);
  });

  it.each([
    ["a missing target", ["node", "smoke", "stage"], "platform target is required"],
    ["a missing stage root", ["node", "smoke", "", "linux-x64"], "stage root is required"],
    [
      "an unsupported target",
      ["node", "smoke", "stage", "linux-ppc"],
      "platform target is unsupported",
    ],
    [
      "a stage root that is not the governed one",
      ["node", "smoke", "/tmp/elsewhere", "linux-x64"],
      "stage root argument does not match the governed target",
    ],
  ])("refuses %s before running anything", (_label, argv, message) => {
    let ran = false;
    expect(() =>
      runPortableRipgrepSmokeCli(argv, {
        smoke: () => {
          ran = true;
        },
      }),
    ).toThrow(message);
    expect(ran).toBe(false);
  });
});
