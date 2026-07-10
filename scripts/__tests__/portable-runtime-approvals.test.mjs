import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPROVED_SIDECAR_ARCHIVE_HOSTS,
  loadPortableRuntimeApprovals,
  validatePortableRuntimeApprovals,
} from "../portable-runtime-approvals.mjs";
import { checkPortableRuntimeApprovals } from "../check-portable-runtime-approvals.mjs";
import {
  extractApprovedExecutable,
  sidecarSbomDocument,
  sidecarSpecDocument,
} from "../prepare-approved-sidecar-payloads.mjs";
import { updatePortableRuntimeApprovals } from "../update-portable-runtime-approvals.mjs";
import { hashDirectoryTree } from "../portable-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-approvals-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storeOnlyZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function approvedFixture(overrides = {}) {
  const base = JSON.parse(readFileSync(join(repoRoot, "portable-runtime-approvals.json"), "utf8"));
  return { ...base, ...overrides };
}

function fixtureRepoRoot(approvals) {
  const root = tempRoot();
  writeFileSync(
    join(root, "portable-runtime-approvals.json"),
    `${JSON.stringify(approvals, null, 2)}\n`,
  );
  return root;
}

describe("approved sidecar archive redirect hosts", () => {
  it("allows the GitHub release-asset content host so real downloads (which 302-redirect) pass", () => {
    // Regression: GitHub release-asset downloads redirect from github.com to
    // release-assets.githubusercontent.com; the download validates the FINAL response host, so
    // omitting it makes every CI sidecar download fail with "redirect target host is not approved".
    expect(APPROVED_SIDECAR_ARCHIVE_HOSTS).toContain("release-assets.githubusercontent.com");
    expect(APPROVED_SIDECAR_ARCHIVE_HOSTS).toContain("github.com");
    expect(APPROVED_SIDECAR_ARCHIVE_HOSTS).toContain("raw.githubusercontent.com");
  });
});

describe("portable runtime approvals validation", () => {
  it("accepts the committed approvals file", () => {
    const approvals = loadPortableRuntimeApprovals(repoRoot);
    expect(approvals.node.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(approvals.sidecarRuntimes.map((runtime) => runtime.name)).toContain(
      "opencode-compatible",
    );
    const summary = checkPortableRuntimeApprovals(repoRoot);
    expect(summary.sidecarRuntimes).toContain("opencode-compatible");
  });

  it("rejects non-https and unapproved hosts", () => {
    const approvals = approvedFixture();
    approvals.node.archives["windows-x64"].url =
      "http://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip";
    expect(() => validatePortableRuntimeApprovals(approvals)).toThrow(/must use https/u);
    const hostile = approvedFixture();
    hostile.sidecarRuntimes[0].archives["windows-x64"].url =
      "https://evil.example.com/opencode-windows-x64.zip";
    expect(() => validatePortableRuntimeApprovals(hostile)).toThrow(/not an approved host/u);
  });

  it("rejects missing targets, bad digests, and embedded credentials", () => {
    const missing = approvedFixture();
    delete missing.node.archives["macos-arm64"];
    expect(() => validatePortableRuntimeApprovals(missing)).toThrow(/missing target macos-arm64/u);
    const badDigest = approvedFixture();
    badDigest.sidecarRuntimes[0].archives["macos-x64"].sha256 = "not-hex";
    expect(() => validatePortableRuntimeApprovals(badDigest)).toThrow(/sha256/u);
    const credentials = approvedFixture();
    credentials.node.archives["macos-x64"].url =
      "https://user:pass@nodejs.org/dist/v22.23.1/node-v22.23.1-darwin-x64.tar.gz";
    expect(() => validatePortableRuntimeApprovals(credentials)).toThrow(/embed credentials/u);
  });

  it("rejects mismatched node version, unknown targets, and unsafe executable names", () => {
    const drift = approvedFixture();
    drift.node.version = "22.99.0";
    expect(() => validatePortableRuntimeApprovals(drift)).toThrow(/reference version v22.99.0/u);
    const unknown = approvedFixture();
    unknown.node.archives["linux-x64"] = unknown.node.archives["windows-x64"];
    expect(() => validatePortableRuntimeApprovals(unknown)).toThrow(/unknown target linux-x64/u);
    const traversal = approvedFixture();
    traversal.sidecarRuntimes[0].archives["windows-x64"].executableName = "../opencode.exe";
    expect(() => validatePortableRuntimeApprovals(traversal)).toThrow(/plain file name/u);
  });
});

describe("prepare approved sidecar payloads", () => {
  function localInputs(binaryContent = "#!/bin/sh\nexit 0\n") {
    const inputRoot = tempRoot();
    const binary = Buffer.from(binaryContent, "utf8");
    const zip = storeOnlyZip([["opencode", binary]]);
    const archivePath = join(inputRoot, "opencode-darwin-arm64.zip");
    writeFileSync(archivePath, zip);
    const license = Buffer.from("MIT License\n", "utf8");
    const licensePath = join(inputRoot, "LICENSE");
    writeFileSync(licensePath, license);
    return { archivePath, licensePath, zip, license };
  }

  function approvalsForLocal(zip, license) {
    const approvals = approvedFixture();
    const runtime = approvals.sidecarRuntimes[0];
    runtime.archives["macos-arm64"] = {
      ...runtime.archives["macos-arm64"],
      sha256: sha256Hex(zip),
      sizeBytes: zip.length,
    };
    runtime.license = { ...runtime.license, sha256: sha256Hex(license) };
    return approvals;
  }

  it("stages payload, license, sbom, and spec from verified local inputs", async () => {
    const { archivePath, licensePath, zip, license } = localInputs();
    const approvals = approvalsForLocal(zip, license);
    const fakeRepoRoot = fixtureRepoRoot(approvals);
    const outputRoot = join(tempRoot(), "out");
    const summary = await prepareApprovedSidecarPayloadsForTest(
      ["--target", "macos-arm64", "--output-root", outputRoot],
      { archivePath, licensePath },
      fakeRepoRoot,
    );
    expect(summary.results).toHaveLength(1);
    const payloadRoot = join(outputRoot, "macos-arm64", "opencode-compatible", "payload");
    expect(existsSync(join(payloadRoot, "bin", "opencode"))).toBe(true);
    expect(readFileSync(join(payloadRoot, "evidence", "LICENSE"), "utf8")).toContain("MIT");
    const sbom = JSON.parse(readFileSync(join(payloadRoot, "evidence", "sbom.cdx.json"), "utf8"));
    expect(sbom.bomFormat).toBe("CycloneDX");
    const spec = JSON.parse(
      readFileSync(
        join(outputRoot, "macos-arm64", "opencode-compatible", "opencode-compatible.spec.json"),
        "utf8",
      ),
    );
    expect(spec.platformTarget).toBe("macos-arm64");
    expect(spec.executablePath).toBe("bin/opencode");
    expect(spec.expectedPayloadSha256).toBe(hashDirectoryTree(payloadRoot));
  });

  it("fails closed on digest mismatch and multi-entry archives", async () => {
    const { archivePath, licensePath, zip, license } = localInputs();
    const approvals = approvalsForLocal(zip, license);
    approvals.sidecarRuntimes[0].archives["macos-arm64"].sha256 = "0".repeat(64);
    const fakeRepoRoot = fixtureRepoRoot(approvals);
    await expect(
      prepareApprovedSidecarPayloadsForTest(
        ["--target", "macos-arm64", "--output-root", join(tempRoot(), "out")],
        { archivePath, licensePath },
        fakeRepoRoot,
      ),
    ).rejects.toThrow(/digest mismatch/u);

    const multi = storeOnlyZip([
      ["opencode", Buffer.from("a")],
      ["extra", Buffer.from("b")],
    ]);
    const destination = join(tempRoot(), "bin", "opencode");
    const multiPath = join(tempRoot(), "multi.zip");
    writeFileSync(multiPath, multi);
    expect(() => extractApprovedExecutable(multiPath, "opencode", destination)).toThrow(
      /exactly one entry/u,
    );
  });

  it("produces deterministic sbom and spec documents", () => {
    const approvals = loadPortableRuntimeApprovals(repoRoot);
    const runtime = approvals.sidecarRuntimes[0];
    const sbom = sidecarSbomDocument(runtime, "windows-x64", "a".repeat(64));
    expect(JSON.stringify(sbom)).not.toMatch(/timestamp|serialNumber/u);
    expect(sbom.components[0].purl).toContain(runtime.upstream.version);
    const spec = sidecarSpecDocument(runtime, "windows-x64", "/tmp/does-not-matter", "bin/x.exe");
    expect(spec.adapterCompatibility.adapterName).toBe("keiko-coding-sidecar");
  });
});

async function prepareApprovedSidecarPayloadsForTest(argv, inputs, fakeRepoRoot) {
  const module = await import("../prepare-approved-sidecar-payloads.mjs");
  return module.prepareApprovedSidecarPayloads(
    [
      ...argv,
      "--archive",
      `opencode-compatible=${inputs.archivePath}`,
      "--license",
      inputs.licensePath,
    ],
    { fetchFn: () => Promise.reject(new Error("network is forbidden in tests")) },
    fakeRepoRoot,
  );
}

describe("portable assets stage helper", () => {
  it("collects sidecar specs and derives approved stage arguments", async () => {
    const { collectSidecarSpecPaths, stageArgumentsForTarget } =
      await import("../run-portable-assets-stage.mjs");
    const payloadRoot = tempRoot();
    const runtimeRoot = join(payloadRoot, "windows-x64", "opencode-compatible");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, "opencode-compatible.spec.json"), "{}\n");
    mkdirSync(join(payloadRoot, "windows-x64", "not-a-runtime"), { recursive: true });
    const specs = collectSidecarSpecPaths(payloadRoot, "windows-x64");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toContain("opencode-compatible.spec.json");
    expect(collectSidecarSpecPaths(payloadRoot, "macos-arm64")).toHaveLength(0);

    const approvals = loadPortableRuntimeApprovals(repoRoot);
    const args = stageArgumentsForTarget(
      { outDir: "/tmp/out", payloadRoot, target: "windows-x64" },
      approvals,
      "a".repeat(40),
      "0.2.14",
    );
    expect(args).toContain("--node-version");
    expect(args[args.indexOf("--node-version") + 1]).toBe(approvals.node.version);
    expect(args[args.indexOf("--node-sha256") + 1]).toBe(
      approvals.node.archives["windows-x64"].sha256,
    );
    expect(args[args.indexOf("--release-tag") + 1]).toBe("v0.2.14");
    expect(args[args.indexOf("--release-id") + 1]).toBe("0");
    expect(args.filter((arg) => arg === "--sidecar-runtime-spec")).toHaveLength(1);
  });
});

describe("assemble portable release assets", () => {
  it("fails closed when a staged target artifact is missing", async () => {
    const { assemblePortableReleaseAssets } =
      await import("../assemble-portable-release-assets.mjs");
    const bundleRoot = tempRoot();
    mkdirSync(join(bundleRoot, "artifacts", "portable-stage-windows-x64"), { recursive: true });
    await expect(assemblePortableReleaseAssets(["--bundle-root", bundleRoot])).rejects.toThrow(
      /missing windows-x64 archive/u,
    );
  });
});

describe("update portable runtime approvals", () => {
  it("updates node and opencode pins from fake verified sources", async () => {
    const approvals = approvedFixture();
    const fakeRepoRoot = fixtureRepoRoot(approvals);
    const zipByName = new Map([
      ["opencode-darwin-arm64.zip", storeOnlyZip([["opencode", Buffer.from("m1")]])],
      ["opencode-darwin-x64.zip", storeOnlyZip([["opencode", Buffer.from("m2")]])],
      ["opencode-windows-x64.zip", storeOnlyZip([["opencode.exe", Buffer.from("w1")]])],
    ]);
    const license = Buffer.from("MIT License\n");
    const shasums = [
      `${"1".repeat(64)}  node-v23.1.0-win-x64.zip`,
      `${"2".repeat(64)}  node-v23.1.0-darwin-arm64.tar.gz`,
      `${"3".repeat(64)}  node-v23.1.0-darwin-x64.tar.gz`,
    ].join("\n");
    const fetchFn = (url) => {
      const name = String(url).split("/").pop() ?? "";
      const body = String(url).includes("SHASUMS256")
        ? Buffer.from(shasums)
        : String(url).endsWith("LICENSE")
          ? license
          : zipByName.get(name);
      if (body === undefined) return Promise.reject(new Error(`unexpected url ${String(url)}`));
      return Promise.resolve({
        ok: true,
        status: 200,
        url: String(url),
        arrayBuffer: () => Promise.resolve(body),
      });
    };
    const summary = await updatePortableRuntimeApprovals(
      ["--node-version", "23.1.0", "--opencode-version", "9.9.9"],
      { fetchFn },
      fakeRepoRoot,
    );
    expect(summary.nodeVersion).toBe("23.1.0");
    expect(summary.opencodeVersion).toBe("9.9.9");
    const updated = loadPortableRuntimeApprovals(fakeRepoRoot);
    expect(updated.node.archives["windows-x64"].sha256).toBe("1".repeat(64));
    expect(updated.sidecarRuntimes[0].archives["windows-x64"].sha256).toBe(
      sha256Hex(zipByName.get("opencode-windows-x64.zip")),
    );
  });
});
