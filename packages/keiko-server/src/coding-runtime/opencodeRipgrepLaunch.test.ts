import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { nativeToolchainReadRoots } from "@oscharko-dev/keiko-sandbox";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  OPENCODE_RIPGREP_UNVERIFIED_REASONS,
  recordOpenCodeRipgrepResolution,
  resolveOpenCodeRipgrep,
  ripgrepLaunchEnvironment,
  ripgrepMappedInheritedEnvNames,
  ripgrepNativePath,
  type OpenCodeRipgrepRequest,
  type OpenCodeRipgrepResolution,
} from "./opencodeRipgrepLaunch.js";
import {
  RIPGREP_OVERRIDE_ENV,
  RIPGREP_VERIFICATION_REASONS,
  type RipgrepRuntimeManifest,
} from "./ripgrepRuntime.js";

const POSIX = process.platform !== "win32";
const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-opencode-ripgrep-")));
  chmodSync(root, 0o755);
  roots.push(root);
  return root;
}

// `darwin-arm64` is the key of the `macos-arm64` portable target; the digests bind the fixture bytes.
function fixtureManifest(binary: string): RipgrepRuntimeManifest {
  return {
    version: "0.0.0-test",
    sourceCommit: "a".repeat(40),
    licenseExpression: "MIT",
    licenseFileName: "LICENSE-MIT",
    targets: {
      "darwin-arm64": {
        archiveKind: "tar.gz",
        archiveUrl: "https://example.test/ripgrep.tar.gz",
        archiveSha256: "b".repeat(64),
        archiveSizeBytes: 10,
        binaryMember: "ripgrep/rg",
        binarySha256: sha256(binary),
        binarySizeBytes: binary.length,
        licenseMember: "ripgrep/LICENSE-MIT",
        licenseSha256: "c".repeat(64),
      },
    },
  };
}

function writeExecutable(path: string, content: string): string {
  for (let directory = dirname(path); !roots.includes(directory); directory = dirname(directory)) {
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o755);
  }
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

const BINARY = "fixture ripgrep";

interface Fixture {
  readonly root: string;
  readonly manifest: RipgrepRuntimeManifest;
  readonly portableDirectory: string;
  readonly provisionedDirectory: string;
}

function fixture(): Fixture {
  const root = temporaryRoot();
  const manifest = fixtureManifest(BINARY);
  writeExecutable(join(root, "runtime", "native", "rg"), BINARY);
  writeExecutable(join(root, ".ripgrep", manifest.version, "darwin-arm64", "rg"), BINARY);
  return {
    root,
    manifest,
    portableDirectory: join(root, "runtime", "native"),
    provisionedDirectory: join(root, ".ripgrep", manifest.version, "darwin-arm64"),
  };
}

function request(
  value: Fixture,
  location: OpenCodeRipgrepRequest["location"],
  env?: NodeJS.ProcessEnv,
): OpenCodeRipgrepRequest {
  return { target: "macos-arm64", location, env, manifest: value.manifest };
}

const packaged = (
  value: Fixture,
  activation: unknown = {},
): OpenCodeRipgrepRequest["location"] => ({
  kind: "packaged",
  resourceRoot: value.root,
  activation,
});

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

describe("resolveOpenCodeRipgrep", () => {
  it("verifies the staged portable executable of a packaged runtime", () => {
    const value = fixture();
    expect(resolveOpenCodeRipgrep(request(value, packaged(value)))).toEqual({
      outcome: "verified",
      targetKey: "darwin-arm64",
      layout: "portable",
      version: "0.0.0-test",
      digestSource: "pinned",
      directory: value.portableDirectory,
    });
  });

  it("accepts the platform-signed bytes only through the activation-bound digest", () => {
    const value = fixture();
    writeFileSync(join(value.portableDirectory, "rg"), "platform signed ripgrep");
    const activation = {
      nativeTools: [
        {
          name: "ripgrep",
          executablePath: "runtime/native/rg",
          unsignedSha256: sha256(BINARY),
          shippedSha256: sha256("platform signed ripgrep"),
        },
      ],
    };

    expect(resolveOpenCodeRipgrep(request(value, packaged(value, activation)))).toMatchObject({
      outcome: "verified",
      digestSource: "activation-bound",
    });
    expect(resolveOpenCodeRipgrep(request(value, packaged(value)))).toMatchObject({
      outcome: "unverified",
      layout: "portable",
      reason: "digest-mismatch",
    });
  });

  it("verifies the provisioned executable of a development checkout", () => {
    const value = fixture();
    expect(
      resolveOpenCodeRipgrep(request(value, { kind: "checkout", checkoutRoot: value.root })),
    ).toMatchObject({
      outcome: "verified",
      layout: "provisioned",
      directory: value.provisionedDirectory,
    });
  });

  it("refuses a tampered, missing or linked executable with a closed reason", () => {
    const value = fixture();
    const location = packaged(value);
    writeFileSync(join(value.portableDirectory, "rg"), "tampered");
    expect(resolveOpenCodeRipgrep(request(value, location))).toMatchObject({
      outcome: "unverified",
      reason: "digest-mismatch",
    });
    rmSync(join(value.portableDirectory, "rg"));
    expect(resolveOpenCodeRipgrep(request(value, location))).toMatchObject({
      outcome: "unverified",
      reason: "missing",
    });
    if (POSIX) {
      const elsewhere = writeExecutable(join(temporaryRoot(), "real-rg"), BINARY);
      symlinkSync(elsewhere, join(value.portableDirectory, "rg"));
      expect(resolveOpenCodeRipgrep(request(value, location))).toMatchObject({
        outcome: "unverified",
        reason: "not-regular-file",
      });
    }
  });

  it("has nothing to verify without a location or an override", () => {
    const value = fixture();
    expect(resolveOpenCodeRipgrep(request(value, { kind: "override-only" }))).toEqual({
      outcome: "unverified",
      targetKey: "darwin-arm64",
      layout: "none",
      reason: "no-location",
    });
  });

  it("never reads the inherited PATH to find an executable", () => {
    const value = fixture();
    const env = { PATH: `${value.portableDirectory}${delimiter}/usr/bin` };
    expect(resolveOpenCodeRipgrep(request(value, { kind: "override-only" }, env))).toMatchObject({
      outcome: "unverified",
      reason: "no-location",
    });
  });

  describe("explicit override", () => {
    it("verifies the named file and prefers it over the lane's own location", () => {
      const value = fixture();
      const named = writeExecutable(join(temporaryRoot(), "chosen", "rg"), BINARY);
      expect(
        resolveOpenCodeRipgrep(
          request(
            value,
            { kind: "checkout", checkoutRoot: value.root },
            { [RIPGREP_OVERRIDE_ENV]: named },
          ),
        ),
      ).toMatchObject({ outcome: "verified", layout: "override", directory: dirname(named) });
    });

    it("never trusts the named file: it must carry the pinned bytes", () => {
      const value = fixture();
      const named = writeExecutable(join(temporaryRoot(), "chosen", "rg"), "some other rg");
      expect(
        resolveOpenCodeRipgrep(
          request(value, { kind: "override-only" }, { [RIPGREP_OVERRIDE_ENV]: named }),
        ),
      ).toMatchObject({ outcome: "unverified", layout: "override", reason: "digest-mismatch" });
    });

    it("falls back to the lane's location and reports the rejected override", () => {
      const value = fixture();
      const bad = writeExecutable(join(temporaryRoot(), "chosen", "rg"), "some other rg");
      expect(
        resolveOpenCodeRipgrep(
          request(
            value,
            { kind: "checkout", checkoutRoot: value.root },
            { [RIPGREP_OVERRIDE_ENV]: bad },
          ),
        ),
      ).toMatchObject({
        outcome: "verified",
        layout: "provisioned",
        overrideReason: "digest-mismatch",
      });
    });

    it("refuses a relative or empty override", () => {
      const value = fixture();
      expect(
        resolveOpenCodeRipgrep(
          request(value, { kind: "override-only" }, { [RIPGREP_OVERRIDE_ENV]: "bin/rg" }),
        ),
      ).toMatchObject({ outcome: "unverified", layout: "override", reason: "missing" });
      expect(
        resolveOpenCodeRipgrep(
          request(value, { kind: "override-only" }, { [RIPGREP_OVERRIDE_ENV]: "" }),
        ),
      ).toMatchObject({ outcome: "unverified", reason: "no-location" });
    });

    it("is ignored by a packaged runtime, which runs only its attested payload", () => {
      const value = fixture();
      const named = writeExecutable(join(temporaryRoot(), "chosen", "rg"), BINARY);
      rmSync(join(value.portableDirectory, "rg"));
      expect(
        resolveOpenCodeRipgrep(request(value, packaged(value), { [RIPGREP_OVERRIDE_ENV]: named })),
      ).toMatchObject({ outcome: "unverified", layout: "portable", reason: "missing" });
    });

    it.skipIf(!POSIX)("refuses a directory that cannot be named on a PATH", () => {
      const value = fixture();
      const named = writeExecutable(join(temporaryRoot(), `a${delimiter}b`, "rg"), BINARY);
      expect(
        resolveOpenCodeRipgrep(
          request(value, { kind: "override-only" }, { [RIPGREP_OVERRIDE_ENV]: named }),
        ),
      ).toMatchObject({ outcome: "unverified", reason: "unsafe-directory" });
    });
  });

  it("keeps the reportable vocabulary a superset of what the verifier can say", () => {
    for (const reason of RIPGREP_VERIFICATION_REASONS) {
      expect(OPENCODE_RIPGREP_UNVERIFIED_REASONS).toContain(reason);
    }
  });
});

describe("the child environment", () => {
  const verified = (directory: string): OpenCodeRipgrepResolution => ({
    outcome: "verified",
    targetKey: "darwin-arm64",
    layout: "portable",
    version: "15.1.0",
    digestSource: "pinned",
    directory,
  });
  const unverified: OpenCodeRipgrepResolution = {
    outcome: "unverified",
    targetKey: "darwin-arm64",
    layout: "none",
    reason: "no-location",
  };
  const directory = join(tmpdir(), "verified-rg");
  const NATIVE_ALLOWLIST = ["PATH", "LANG"];

  it("starts the native PATH with the verified directory, ahead of the inherited entries", () => {
    const processEnv = { PATH: `/usr/bin${delimiter}/opt/tools`, LANG: "en_US.UTF-8", TOKEN: "s" };
    const derived = ripgrepLaunchEnvironment(processEnv, verified(directory), true);
    expect(derived?.PATH).toBe(`${directory}${delimiter}/usr/bin${delimiter}/opt/tools`);
    expect(buildSandboxEnv(derived ?? {}, NATIVE_ALLOWLIST)).toEqual({
      PATH: `${directory}${delimiter}/usr/bin${delimiter}/opt/tools`,
      LANG: "en_US.UTF-8",
    });
    // The secret-named entries the manager scrubs against stay where it can see them.
    expect(derived?.TOKEN).toBe("s");
    expect(processEnv.PATH).toBe(`/usr/bin${delimiter}/opt/tools`);
  });

  it("does not repeat the verified directory when the launcher already had it", () => {
    const processEnv = { PATH: `/usr/bin${delimiter}${directory}${delimiter}/bin` };
    expect(ripgrepLaunchEnvironment(processEnv, verified(directory), true)?.PATH).toBe(
      `${directory}${delimiter}/usr/bin${delimiter}/bin`,
    );
  });

  it("gives the native child only the verified directory when the launcher had no PATH", () => {
    expect(ripgrepLaunchEnvironment({}, verified(directory), true)?.PATH).toBe(directory);
    expect(ripgrepLaunchEnvironment(undefined, verified(directory), true)?.PATH).toBe(directory);
  });

  it("gives a mapped child the verified directory alone and no inherited entry", () => {
    const processEnv = { PATH: `/usr/bin${delimiter}/opt/tools` };
    const derived = ripgrepLaunchEnvironment(processEnv, verified(directory), false);
    expect(derived?.PATH).toBe(directory);
    expect(ripgrepMappedInheritedEnvNames(verified(directory))).toEqual(["PATH"]);
    expect(
      buildSandboxEnv(derived ?? {}, ripgrepMappedInheritedEnvNames(verified(directory))),
    ).toEqual({
      PATH: directory,
    });
  });

  it("changes nothing for an unverified ripgrep, so the run starts and search degrades", () => {
    const processEnv = { PATH: "/usr/bin" };
    expect(ripgrepLaunchEnvironment(processEnv, unverified, true)).toBe(processEnv);
    expect(ripgrepLaunchEnvironment(processEnv, unverified, false)).toBe(processEnv);
    expect(ripgrepLaunchEnvironment(undefined, unverified, true)).toBeUndefined();
    expect(ripgrepMappedInheritedEnvNames(unverified)).toEqual([]);
    expect(ripgrepNativePath("/usr/bin", unverified)).toBeUndefined();
  });

  it("shares one PATH between the child and the kernel read allowlist", () => {
    expect(ripgrepNativePath("/usr/bin", verified(directory))).toBe(
      `${directory}${delimiter}/usr/bin`,
    );
  });
});

describe("the kernel read allowlist the verified directory produces", () => {
  // The native profile's toolchain roots come from the child's PATH (keiko-sandbox, read-only
  // here). Exactly the verified directory must become a root: not its parent, not a sibling.
  it.each([
    ["portable", (value: Fixture): string => value.portableDirectory],
    ["provisioned", (value: Fixture): string => value.provisionedDirectory],
  ] as const)("admits exactly the %s ripgrep directory and nothing broader", (_layout, pick) => {
    const value = fixture();
    const directory = pick(value);
    const path = ripgrepNativePath("/usr/bin:/bin", {
      outcome: "verified",
      targetKey: "darwin-arm64",
      layout: "portable",
      version: "x",
      digestSource: "pinned",
      directory,
    });
    expect(homedir().startsWith(value.root)).toBe(false);
    expect(nativeToolchainReadRoots(path, homedir())).toEqual([realpathSync(directory)]);
  });
});

describe("recordOpenCodeRipgrepResolution", () => {
  function recorded(
    resolution: OpenCodeRipgrepResolution,
    native = true,
  ): readonly ServerLogEvent[] {
    const events: ServerLogEvent[] = [];
    recordOpenCodeRipgrepResolution(
      { write: (event) => events.push(event) },
      "run-ripgrep-0001",
      native,
      resolution,
    );
    return events;
  }

  it("records one body-free line for a verified launch and never the path", () => {
    const value = fixture();
    const resolution = resolveOpenCodeRipgrep(request(value, packaged(value)));
    const [event, ...rest] = recorded(resolution);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      op: "coding-runtime.ripgrep.resolved",
      category: "process",
      level: "info",
      correlationId: "run-ripgrep-0001",
      extra: {
        targetKey: "darwin-arm64",
        outcome: "verified",
        layout: "portable",
        toolProfile: "native",
        digestSource: "pinned",
        version: "0.0.0-test",
      },
    });
    expect(JSON.stringify(event)).not.toContain(value.root);
    expect(JSON.stringify(event)).not.toContain("runtime/native");
  });

  it("records an unverified launch at warn with the closed reason", () => {
    const value = fixture();
    rmSync(join(value.portableDirectory, "rg"));
    const [event] = recorded(resolveOpenCodeRipgrep(request(value, packaged(value))), false);
    expect(event).toMatchObject({
      level: "warn",
      correlationId: "run-ripgrep-0001",
      extra: {
        outcome: "unverified",
        layout: "portable",
        toolProfile: "mapped",
        reason: "missing",
      },
    });
    expect(JSON.stringify(event)).not.toContain(value.root);
  });

  it("records a rejected override beside the outcome", () => {
    const value = fixture();
    const bad = writeExecutable(join(temporaryRoot(), "chosen", "rg"), "other");
    const [event] = recorded(
      resolveOpenCodeRipgrep(
        request(
          value,
          { kind: "checkout", checkoutRoot: value.root },
          { [RIPGREP_OVERRIDE_ENV]: bad },
        ),
      ),
    );
    expect(event?.extra).toMatchObject({
      outcome: "verified",
      layout: "provisioned",
      overrideReason: "digest-mismatch",
    });
    expect(JSON.stringify(event)).not.toContain(bad);
  });

  // The generated registry learns the operation when `npm run generate:op-catalog` runs; until then
  // the production sink cannot persist the line, so this proof starts running the moment it can.
  it.skipIf(activityLogOperationSchema("coding-runtime.ripgrep.resolved") === undefined)(
    "persists through the registered production sink with closed, bounded fields",
    () => {
      const value = fixture();
      const [event] = recorded(resolveOpenCodeRipgrep(request(value, packaged(value))));
      const line = expectActivityLogProof(
        "coding-runtime.ripgrep.resolved.emitted-line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(line).toMatchObject({
        correlationId: "run-ripgrep-0001",
        outcome: "verified",
        layout: "portable",
        version: "0.0.0-test",
      });
      expect(JSON.stringify(line)).not.toContain(value.root);
    },
  );
});
