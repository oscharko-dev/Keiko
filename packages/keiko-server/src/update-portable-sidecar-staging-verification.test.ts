import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePortableSidecarPayloadTreeDigest } from "./coding-runtime/devLanePortableCodingRuntime.js";
import {
  OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
  OPEN_CODE_V2_PROTOCOL_SURFACE_ALGORITHM,
} from "./coding-runtime/opencodeProtocolSurface.js";
import type { PortableSidecarRuntimeVerification } from "./update-portable-sidecar-verification.js";
import {
  inspectStagedSidecarPayload,
  inspectStagedSidecarPayloadAsync,
} from "./update-portable-sidecar-staging-verification.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  resourceRoot: string;
  payloadRoot: string;
  sidecar: PortableSidecarRuntimeVerification;
} {
  const resourceRoot = mkdtempSync(join(tmpdir(), "keiko-sidecar-async-"));
  roots.push(resourceRoot);
  const payloadRootPath = "runtime/sidecars/opencode-compatible";
  const payloadRoot = join(resourceRoot, payloadRootPath);
  mkdirSync(join(payloadRoot, "bin"), { recursive: true });
  const files = [
    ["bin/opencode", "executable"],
    ["LICENSE", "license"],
    ["sbom.json", "sbom"],
  ] as const;
  const entries = files.map(([relativePath, body]) => {
    writeFileSync(join(payloadRoot, relativePath), body);
    return { relativePath, sha256: createHash("sha256").update(body).digest("hex") };
  });
  const executable = entries[0];
  if (executable === undefined) throw new Error("expected executable fixture");
  const payloadSha256 = computePortableSidecarPayloadTreeDigest(entries);
  return {
    resourceRoot,
    payloadRoot,
    sidecar: {
      payloadRootPath,
      executablePath: `${payloadRootPath}/bin/opencode`,
      shippedExecutableSha256: executable.sha256,
      executableTreeSha256: computePortableSidecarPayloadTreeDigest([executable]),
      licenseEvidencePath: `${payloadRootPath}/LICENSE`,
      licenseEvidenceSha256: entries[1]?.sha256 ?? "",
      sbomEvidencePath: `${payloadRootPath}/sbom.json`,
      sbomEvidenceSha256: entries[2]?.sha256 ?? "",
      protocolSchemaRawSha256: "1".repeat(64),
      protocolHandshakeDigest: OPEN_CODE_V2_PINNED_PROTOCOL_SURFACE_SHA256,
      protocolHandshakeAlgorithm: OPEN_CODE_V2_PROTOCOL_SURFACE_ALGORITHM,
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: "2.0.10",
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "2",
        protocolVersion: "http-sse",
        platformTarget: "macos-arm64",
        payloadSha256,
        payloadSha256Prefix: payloadSha256.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
      availability: {
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      },
    },
  };
}

function options(): { deadline: number } {
  return { deadline: Date.now() + 5_000 };
}

describe("async staged sidecar point-of-use evidence", () => {
  it("agrees with the existing approved digest projection and services the event loop", async () => {
    const { resourceRoot, sidecar } = fixture();
    let serviced = false;
    setImmediate(() => {
      serviced = true;
    });
    const evidence = await inspectStagedSidecarPayloadAsync(resourceRoot, sidecar, options());
    expect(evidence).toEqual(inspectStagedSidecarPayload(resourceRoot, sidecar));
    expect(evidence).toEqual({
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
    });
    expect(serviced).toBe(true);
  });

  it.each(["payload", "executable"] as const)(
    "recomputes a changed %s rather than retaining discovery evidence",
    async (kind) => {
      const { resourceRoot, sidecar } = fixture();
      expect(inspectStagedSidecarPayload(resourceRoot, sidecar).archiveDigestVerified).toBe(true);
      writeFileSync(
        join(
          resourceRoot,
          kind === "payload" ? sidecar.licenseEvidencePath : sidecar.executablePath,
        ),
        "changed after discovery",
      );
      const evidence = await inspectStagedSidecarPayloadAsync(resourceRoot, sidecar, options());
      expect(evidence).toEqual(inspectStagedSidecarPayload(resourceRoot, sidecar));
      expect(evidence.archiveDigestVerified).toBe(false);
      expect(evidence.executableTreeDigestVerified).toBe(kind === "payload");
    },
  );

  it("does not read an executable selected outside the attested payload", async () => {
    const { resourceRoot, sidecar } = fixture();
    writeFileSync(join(resourceRoot, "outside"), "outside body");
    const evidence = await inspectStagedSidecarPayloadAsync(
      resourceRoot,
      { ...sidecar, executablePath: "outside" },
      options(),
    );
    expect(evidence).toEqual({
      payloadPresent: false,
      archiveDigestVerified: true,
      executableTreeDigestVerified: false,
    });
  });

  it("rejects a root escape and a symbolic payload root", async () => {
    const { resourceRoot, payloadRoot, sidecar } = fixture();
    await expect(
      inspectStagedSidecarPayloadAsync(
        resourceRoot,
        { ...sidecar, payloadRootPath: "../outside" },
        options(),
      ),
    ).rejects.toThrow(/escaped/u);
    const alias = join(resourceRoot, "alias");
    symlinkSync(payloadRoot, alias);
    await expect(
      inspectStagedSidecarPayloadAsync(
        resourceRoot,
        { ...sidecar, payloadRootPath: "alias" },
        options(),
      ),
    ).rejects.toThrow(/root is unsafe/u);
  });

  it("propagates cancellation and deadline as failures, never as missing or successful evidence", async () => {
    const { resourceRoot, sidecar } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectStagedSidecarPayloadAsync(resourceRoot, sidecar, {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    await expect(
      inspectStagedSidecarPayloadAsync(resourceRoot, sidecar, { deadline: 1 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
