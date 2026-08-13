import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computePortableSidecarPayloadTreeDigest,
  discoverDevLaneOpenCode,
  devLaneEnvEnabled,
  KEIKO_CODING_RUNTIME_DEV_LANE_ENV,
  type DevLaneOpenCodeDiscovery,
} from "./devLanePortableCodingRuntime.js";
import { OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256 } from "./opencodeProtocolSurface.js";
import { stageDevLaneFixture, type DevLaneFixture } from "./devLaneFixture/_support.js";

const roots: string[] = [];

function fixture(): DevLaneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-dev-lane-")));
  roots.push(root);
  return stageDevLaneFixture(root);
}

function discover(
  staged: DevLaneFixture,
  overrides: Partial<{ env: NodeJS.ProcessEnv; platform: NodeJS.Platform; arch: string }> = {},
): DevLaneOpenCodeDiscovery {
  return discoverDevLaneOpenCode({
    env: overrides.env ?? staged.env,
    platform: overrides.platform ?? "darwin",
    arch: overrides.arch ?? "arm64",
  });
}

function expectRefusal(discovery: DevLaneOpenCodeDiscovery, reason: string): void {
  expect(discovery).toEqual({ outcome: "refused", reason });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dev-lane OpenCode discovery", () => {
  it("stays inactive unless the lane flag carries an explicit enable token", () => {
    const staged = fixture();
    const withoutFlag: NodeJS.ProcessEnv = { KEIKO_CLI_BIN_PATH: staged.env.KEIKO_CLI_BIN_PATH };
    expect(discover(staged, { env: withoutFlag })).toEqual({ outcome: "inactive" });
    for (const value of ["", "0", "false", "maybe", "TRUE_ISH"]) {
      const env = { ...staged.env, [KEIKO_CODING_RUNTIME_DEV_LANE_ENV]: value };
      expect(discover(staged, { env })).toEqual({ outcome: "inactive" });
    }
    expect(devLaneEnvEnabled("1")).toBe(true);
    expect(devLaneEnvEnabled(" true ")).toBe(true);
  });

  it("activates a fully staged, catalog-verified payload on a dev checkout", () => {
    const staged = fixture();
    const discovery = discover(staged);
    expect(discovery.outcome).toBe("activated");
    if (discovery.outcome !== "activated") return;
    const runtime = discovery.runtime;
    expect(runtime.evidenceClass).toBe("functional-not-platform-qualified");
    expect(runtime.lane).toBe("dev-checkout");
    expect(runtime.target).toBe("macos-arm64");
    expect(runtime.installRoot).toBe(join(staged.paths.stagedTargetRoot, "opencode-compatible"));
    expect(runtime.sidecar.summary).toMatchObject({
      name: "opencode-compatible",
      upstreamVersion: "1.17.17",
      platformTarget: "macos-arm64",
      status: "verified",
    });
    // Honest availability: only checks the lane actually performs are recorded as verified.
    expect(runtime.sidecar.availability).toMatchObject({
      signatureVerified: false,
      qualificationVerified: false,
      executableTreeDigestVerified: true,
    });
    expect(runtime.sidecar.protocolHandshakeDigest).toBe(OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256);
    expect(runtime.qualification).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      backend: "macos-app-sandbox",
    });
    expect(runtime.qualification.releaseReceipt).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(runtime.secureRead.artifact).toMatchObject({
      target: "darwin-arm64",
      installRelativePath: "runtime/native/keiko-secure-workspace-read",
      protocol: "KSR1/KSS1",
      signed: true,
    });
  });

  it("refuses every non-macOS platform and unknown architecture", () => {
    const staged = fixture();
    expectRefusal(discover(staged, { platform: "linux" }), "platform-unsupported");
    expectRefusal(discover(staged, { platform: "win32", arch: "x64" }), "platform-unsupported");
    expectRefusal(discover(staged, { arch: "ppc64" }), "platform-unsupported");
    expect(discover(staged, { arch: "x64" })).toMatchObject({ outcome: "refused" });
  });

  it("refuses when a packaged-install manifest is present, before any payload trust", () => {
    for (const manifest of ["update-portable-manifest.json", "setup-manifest.json"]) {
      const staged = fixture();
      const manifestPath = join(staged.root, ".portable", manifest);
      mkdirSync(join(staged.root, ".portable"), { recursive: true });
      writeFileSync(manifestPath, "{}");
      expectRefusal(discover(staged), "packaged-install-present");
    }
  });

  it("refuses outside a repository checkout", () => {
    const staged = fixture();
    unlinkSync(join(staged.root, "tsconfig.packages.json"));
    expectRefusal(discover(staged), "not-a-dev-checkout");
    expectRefusal(
      discover(staged, { env: { ...staged.env, KEIKO_CLI_BIN_PATH: "/nonexistent/entry.js" } }),
      "not-a-dev-checkout",
    );
  });

  it("refuses an absent, tampered, or unapproved payload with the precise reason", () => {
    const missing = fixture();
    unlinkSync(missing.paths.executable);
    expectRefusal(discover(missing), "payload-missing");

    const tampered = fixture();
    writeFileSync(tampered.paths.executable, "#!/bin/sh\nexit 1\n");
    expectRefusal(discover(tampered), "payload-tampered");

    const licenseTampered = fixture();
    writeFileSync(licenseTampered.paths.license, "forged license\n");
    expectRefusal(discover(licenseTampered), "payload-tampered");

    const unapproved = fixture();
    unlinkSync(unapproved.paths.catalog);
    expectRefusal(discover(unapproved), "payload-unapproved");

    const revoked = fixture();
    const catalog = JSON.parse(readFileSync(revoked.paths.catalog, "utf8")) as {
      sidecarRuntimes: { releaseApproval: unknown }[];
    };
    const runtime = catalog.sidecarRuntimes[0];
    if (runtime === undefined) throw new Error("fixture-catalog-missing-runtime");
    runtime.releaseApproval = { redistribution: { status: "revoked" } };
    writeFileSync(revoked.paths.catalog, JSON.stringify(catalog));
    expectRefusal(discover(revoked), "payload-unapproved");
  });

  // Gitar finding (#2475 review): the helper source-tree digest crosses a process boundary
  // (staging writes it, discovery re-derives it), so its file ordering must be plain code-unit
  // comparison — never locale collation. "B.c" and "a.c" order differently under ICU collation
  // ("a.c" < "B.c") than by code units ("B.c" < "a.c"), so a locale-ordered digest is refused.
  it("derives the helper source digest with locale-independent ordering", () => {
    const staged = fixture();
    const first = join(staged.paths.helperSourceDir, "B.c");
    const second = join(staged.paths.helperSourceDir, "a.c");
    writeFileSync(first, "/* B */\n");
    writeFileSync(second, "/* a */\n");
    const entries = ["B.c", "a.c", "secure_workspace_read.c"].map(
      (name) =>
        [
          name,
          createHash("sha256")
            .update(readFileSync(join(staged.paths.helperSourceDir, name)))
            .digest("hex"),
        ] as const,
    );
    const digestFor = (order: readonly string[]): string => {
      const hash = createHash("sha256");
      for (const name of order) {
        const digest = entries.find(([entry]) => entry === name)?.[1] ?? "";
        hash.update(`${name}\0${digest}\0`);
      }
      return hash.digest("hex");
    };
    const manifest = JSON.parse(readFileSync(staged.paths.helperManifest, "utf8")) as {
      helper: { sourceTreeSha256: string };
    };
    manifest.helper.sourceTreeSha256 = digestFor(["B.c", "a.c", "secure_workspace_read.c"]);
    writeFileSync(staged.paths.helperManifest, JSON.stringify(manifest));
    expect(discover(staged).outcome).toBe("activated");

    manifest.helper.sourceTreeSha256 = digestFor(["a.c", "B.c", "secure_workspace_read.c"]);
    writeFileSync(staged.paths.helperManifest, JSON.stringify(manifest));
    expectRefusal(discover(staged), "secure-read-helper-stale");
  });

  it("refuses a missing or stale secure-read helper with the precise reason", () => {
    const missingHelper = fixture();
    unlinkSync(missingHelper.paths.helper);
    expectRefusal(discover(missingHelper), "secure-read-helper-missing");

    const missingManifest = fixture();
    unlinkSync(missingManifest.paths.helperManifest);
    expectRefusal(discover(missingManifest), "secure-read-helper-missing");

    const swapped = fixture();
    writeFileSync(swapped.paths.helper, "#!/bin/sh\nexit 9\n");
    expectRefusal(discover(swapped), "secure-read-helper-stale");

    const drifted = fixture();
    writeFileSync(
      join(drifted.paths.helperSourceDir, "secure_workspace_read.c"),
      "/* drifted source */\n",
    );
    expectRefusal(discover(drifted), "secure-read-helper-stale");
  });
});

// PR #3099 follow-up (KfQ Major + Codex P2): the manager test fixture derives its expected
// values from this very function, so a bug HERE would move both the production hash and the
// fixture in lockstep and no downstream test would catch it. This standalone pin computes the
// tree digest for a hand-hashed pair with a known relative path and asserts the exact 64-char
// hex string — a formula change (order, separator, digest algorithm, sort collation) fails this
// pin loudly.
describe("computePortableSidecarPayloadTreeDigest (KEIKO-0180)", () => {
  it("produces a stable hex digest for a known single-entry input", () => {
    const contentSha = createHash("sha256").update("payload\n", "utf8").digest("hex");
    const expected = createHash("sha256")
      .update(`bin/opencode\0${contentSha}\0`, "utf8")
      .digest("hex");
    expect(
      computePortableSidecarPayloadTreeDigest([
        { relativePath: "bin/opencode", sha256: contentSha },
      ]),
    ).toBe(expected);
  });

  it("locale-sorts entries by relativePath before hashing (order-independent input, deterministic digest)", () => {
    const bin = createHash("sha256").update("x", "utf8").digest("hex");
    const lic = createHash("sha256").update("y", "utf8").digest("hex");
    const forward = computePortableSidecarPayloadTreeDigest([
      { relativePath: "LICENSE", sha256: lic },
      { relativePath: "bin/opencode", sha256: bin },
    ]);
    const reversed = computePortableSidecarPayloadTreeDigest([
      { relativePath: "bin/opencode", sha256: bin },
      { relativePath: "LICENSE", sha256: lic },
    ]);
    expect(forward).toBe(reversed);
    const sortedKeys = ["LICENSE", "bin/opencode"].sort((a, b) => a.localeCompare(b));
    const shas: Record<string, string> = { LICENSE: lic, "bin/opencode": bin };
    const hash = createHash("sha256");
    for (const key of sortedKeys) hash.update(`${key}\0${shas[key] ?? ""}\0`, "utf8");
    expect(forward).toBe(hash.digest("hex"));
  });

  it("empty entry set produces the sha256 of the empty string", () => {
    expect(computePortableSidecarPayloadTreeDigest([])).toBe(
      createHash("sha256").update("", "utf8").digest("hex"),
    );
  });
});
