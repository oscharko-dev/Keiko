import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertSigningCredentialsCleared,
  MAC_NATIVE_FIELDS,
  macNativeControlFlow,
  main,
  readMacNativeResult,
  verificationChecksForNativeResult,
} from "../macos-native-policy.mjs";

const roots = [];

function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-macos-native-policy-"));
  roots.push(path);
  return path;
}

function resultFor(target, overrides = {}) {
  return Object.fromEntries([
    ...MAC_NATIVE_FIELDS.map((name) => [name, true]),
    ["cleanupSucceeded", true],
    ["finalizerSucceeded", true],
    ["schemaVersion", 1],
    ["target", target],
    ...Object.entries(overrides),
  ]);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { force: true, recursive: true });
});

describe("macOS production native control flow", () => {
  it("uses the exact production observations for both architectures and every failure class", () => {
    const failures = [
      ["config-failure", "configValidated"],
      ["setup-failure", "setupSucceeded"],
      ["import-failure", "importSucceeded"],
      ["wrong-architecture", "architectureVerified"],
      ["unsigned-or-partial-macho", "signScopeVerified"],
      ["invalid-identity", "identityVerified"],
      ["invalid-team", "teamVerified"],
      ["missing-hardened-runtime", "hardenedRuntimeVerified"],
      ["missing-timestamp", "timestampVerified"],
      ["wrong-entitlements", "entitlementsVerified"],
      ["notary-nonzero", "notarizationAccepted"],
      ["notary-rejection", "notarizationAccepted"],
      ["notary-timeout", "notarizationAccepted"],
      ["notary-malformed", "notarizationAccepted"],
      ["missing-staple", "stapleVerified"],
      ["gatekeeper-rejection", "gatekeeperAccepted"],
      ["inventory-drift", "inventoryVerified"],
      ["archive-mismatch", "archiveVerified"],
    ];
    for (const target of ["macos-arm64", "macos-x64"]) {
      for (const [failure, field] of failures) {
        const result = resultFor(target, { [field]: false });
        expect(macNativeControlFlow(result), `${target}:${failure}`).toEqual({
          assembleRuns: false,
          cleanupRuns: true,
          finalizeRuns: false,
          isolatedSmokeRuns: false,
          uploadRuns: false,
        });
      }
    }
  });

  it("independently gates protected finalization/upload and isolated smoke assembly", () => {
    const target = "macos-arm64";
    expect(macNativeControlFlow(resultFor(target, { cleanupSucceeded: false }))).toEqual({
      assembleRuns: false,
      cleanupRuns: true,
      finalizeRuns: false,
      isolatedSmokeRuns: false,
      uploadRuns: false,
    });
    expect(macNativeControlFlow(resultFor(target, { finalizerSucceeded: false }))).toEqual({
      assembleRuns: false,
      cleanupRuns: true,
      finalizeRuns: true,
      isolatedSmokeRuns: false,
      uploadRuns: false,
    });
    expect(macNativeControlFlow(resultFor(target))).toEqual({
      assembleRuns: false,
      cleanupRuns: true,
      finalizeRuns: true,
      isolatedSmokeRuns: true,
      uploadRuns: true,
    });
    expect(macNativeControlFlow(resultFor(target), { isolatedSmokeSucceeded: true })).toEqual({
      assembleRuns: true,
      cleanupRuns: true,
      finalizeRuns: true,
      isolatedSmokeRuns: true,
      uploadRuns: true,
    });
    expect(macNativeControlFlow(resultFor(target), { production: false })).toEqual({
      assembleRuns: false,
      cleanupRuns: false,
      finalizeRuns: false,
      isolatedSmokeRuns: false,
      uploadRuns: false,
    });
  });

  it("derives canonical verifier booleans only from the exact native observations", () => {
    const result = resultFor("macos-x64");
    expect(verificationChecksForNativeResult(result)).toEqual({
      assessmentVerified: true,
      developerIdVerified: true,
      notarizationVerified: true,
      stapleVerified: true,
    });
    for (const field of [
      "architectureVerified",
      "entitlementsVerified",
      "hardenedRuntimeVerified",
      "identityVerified",
      "signScopeVerified",
      "teamVerified",
      "timestampVerified",
    ]) {
      expect(
        verificationChecksForNativeResult({ ...result, [field]: false }).developerIdVerified,
        field,
      ).toBe(false);
    }
  });
});

describe("macOS production result and credential lifecycle", () => {
  it("advances the exact bounded result through credential, static, and cleanup phases", async () => {
    for (const target of ["macos-arm64", "macos-x64"]) {
      const dir = root();
      const path = join(dir, "native.json");
      await main(["credentials-success", "--target", target, "--output", path]);
      expect(readMacNativeResult(path, target)).toMatchObject({
        configValidated: true,
        importSucceeded: true,
        setupSucceeded: true,
        signScopeVerified: false,
      });
      await main(["static-success", "--target", target, "--input", path, "--output", path]);
      expect(MAC_NATIVE_FIELDS.every((name) => readMacNativeResult(path, target)[name])).toBe(true);
      await main(["cleanup-success", "--target", target, "--input", path, "--output", path]);
      expect(readMacNativeResult(path, target).cleanupSucceeded).toBe(true);
      const stage = join(dir, "stage");
      const verification = join(dir, "verification.json");
      mkdirSync(join(stage, "manifest"), { recursive: true });
      writeFileSync(
        join(stage, "manifest", "portable-manifest.json"),
        JSON.stringify({ artifact: { platformTarget: target }, sidecarRuntimes: [] }),
      );
      await main([
        "verification-input",
        "--stage-root",
        stage,
        "--target",
        target,
        "--input",
        path,
        "--output",
        verification,
      ]);
      await main(["finalizer-success", "--target", target, "--input", path]);
      expect(readMacNativeResult(path, target).finalizerSucceeded).toBe(true);
      const extra = { ...readMacNativeResult(path, target), providerLog: "token=secret" };
      writeFileSync(path, JSON.stringify(extra));
      expect(() => readMacNativeResult(path, target)).toThrow(/native result is invalid/u);
    }
  });

  it("refuses verification-input derivation while any signing credential remains", () => {
    expect(() => assertSigningCredentialsCleared({ KEIKO_KEYCHAIN_PASSWORD: "secret" })).toThrow(
      /credentials were not cleared/u,
    );
  });

  it("suppresses malformed Mach-O tool output and private paths", () => {
    const dir = root();
    const bin = join(dir, "bin");
    const fakeLipo = join(bin, "lipo");
    mkdirSync(bin);
    writeFileSync(fakeLipo, "#!/bin/sh\nprintf 'token=secret %s\\n' \"$2\" >&2\nexit 9\n");
    chmodSync(fakeLipo, 0o700);
    const privatePath = join(dir, "private-malformed-macho");
    writeFileSync(privatePath, "malformed");
    const result = spawnSync(
      "bash",
      ["scripts/check-macos-macho-architecture.sh", privatePath, "arm64"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("runs a valid isolated payload terminally with credential and file channels scrubbed", () => {
    const runnerTemp = root();
    const disposable = join(runnerTemp, "keiko-isolated-macos-smoke-valid");
    const resources = join(disposable, "Keiko", "Keiko.app", "Contents", "Resources");
    const executable = `#!/bin/sh
test -z "\${GITHUB_ENV:-}"
test -z "\${GITHUB_TOKEN:-}"
test -z "\${ACTIONS_RUNTIME_TOKEN:-}"
test -z "\${APPLE_TEAM_ID:-}"
exit 0
`;
    const node = join(resources, "runtime", "node", "bin", "node");
    const sidecar = join(resources, "runtime", "sidecars", "worker", "bin", "worker");
    mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
    mkdirSync(join(resources, "runtime", "sidecars", "worker", "bin"), { recursive: true });
    writeFileSync(node, executable);
    writeFileSync(sidecar, executable);
    chmodSync(node, 0o700);
    chmodSync(sidecar, 0o700);
    writeFileSync(
      join(disposable, "smoke-plan.json"),
      JSON.stringify({
        schemaVersion: 1,
        sidecarExecutables: ["runtime/sidecars/worker/bin/worker"],
        target: "macos-arm64",
      }),
    );
    const result = spawnSync(
      "bash",
      ["scripts/run-isolated-macos-payload-smoke.sh", "macos-arm64", disposable],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ACTIONS_RUNTIME_TOKEN: "runtime-secret",
          GITHUB_ENV: join(runnerTemp, "github-env"),
          GITHUB_TOKEN: "github-secret",
          RUNNER_TEMP: runnerTemp,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(disposable)).toBe(false);
  });

  it("best-effort cleanup removes material and clears env even when keychain deletion fails", async () => {
    for (const shouldFail of [false, true]) {
      const runnerTemp = root();
      const signingRoot = join(runnerTemp, `keiko-macos-signing-${shouldFail ? "fail" : "ok"}`);
      const nativeResult = join(runnerTemp, "native-result.json");
      await main(["credentials-success", "--target", "macos-arm64", "--output", nativeResult]);
      mkdirSync(signingRoot);
      const helper = join(signingRoot, "keychain-helper");
      writeFileSync(helper, `#!/bin/sh\n${shouldFail ? "exit 7" : "exit 0"}\n`);
      chmodSync(helper, 0o700);
      writeFileSync(join(signingRoot, "notary-key.p8"), "private material");
      const githubEnv = join(runnerTemp, "github-env");
      const result = spawnSync(
        "bash",
        ["scripts/cleanup-macos-portable-signing.sh", "macos-arm64", nativeResult],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ENV: githubEnv,
            KEIKO_SIGNING_TEMP_ROOT: signingRoot,
            RUNNER_TEMP: runnerTemp,
          },
        },
      );
      expect(result.status === 0).toBe(!shouldFail);
      expect(() => readFileSync(signingRoot)).toThrow();
      expect(readFileSync(githubEnv, "utf8")).toContain("KEIKO_KEYCHAIN_PASSWORD=\n");
      expect(readMacNativeResult(nativeResult, "macos-arm64").cleanupSucceeded).toBe(!shouldFail);
    }
  });

  it("refuses cleanup attestation after import when the safe root or helper is absent", async () => {
    for (const missing of ["root", "helper"]) {
      const runnerTemp = root();
      const nativeResult = join(runnerTemp, `native-${missing}.json`);
      const githubEnv = join(runnerTemp, `github-env-${missing}`);
      await main(["credentials-success", "--target", "macos-arm64", "--output", nativeResult]);
      const signingRoot = join(runnerTemp, `keiko-macos-signing-missing-${missing}`);
      if (missing === "helper") {
        mkdirSync(signingRoot);
        writeFileSync(join(signingRoot, "notary-key.p8"), "private material");
      }
      const result = spawnSync(
        "bash",
        ["scripts/cleanup-macos-portable-signing.sh", "macos-arm64", nativeResult],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ENV: githubEnv,
            KEIKO_SIGNING_TEMP_ROOT: missing === "root" ? "" : signingRoot,
            RUNNER_TEMP: runnerTemp,
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(githubEnv, "utf8")).toContain("KEIKO_KEYCHAIN_PASSWORD=\n");
      expect(readMacNativeResult(nativeResult, "macos-arm64").cleanupSucceeded).toBe(false);
      if (missing === "helper") expect(existsSync(signingRoot)).toBe(false);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "runs the real Security.framework helper through import, cleanup, and malformed import",
    () => {
      const dir = root();
      const helper = join(dir, "keychain-helper");
      const key = join(dir, "key.pem");
      const certificate = join(dir, "certificate.pem");
      const p12 = join(dir, "identity.p12");
      const run = (command, args, env = process.env) =>
        spawnSync(command, args, { env, stdio: "ignore" });
      const exportPkcs12 = (extraArgs) =>
        run("openssl", [
          "pkcs12",
          "-export",
          ...extraArgs,
          "-inkey",
          key,
          "-in",
          certificate,
          "-name",
          "Keiko Provider-Free Test",
          "-out",
          p12,
          "-passout",
          "pass:fixture-password",
        ]);
      expect(
        run("clang", [
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wno-deprecated-declarations",
          "-framework",
          "Security",
          "-framework",
          "CoreFoundation",
          "native/portable-launcher/macos-keychain-helper.c",
          "-o",
          helper,
        ]).status,
      ).toBe(0);
      expect(
        run("openssl", [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          certificate,
          "-days",
          "1",
          "-subj",
          "/CN=Keiko Provider-Free Test",
          "-addext",
          "extendedKeyUsage=codeSigning",
        ]).status,
      ).toBe(0);
      const legacyExport = exportPkcs12(["-legacy"]);
      expect((legacyExport.status === 0 ? legacyExport : exportPkcs12([])).status).toBe(0);
      const keychain = join(dir, "valid.keychain-db");
      const env = {
        ...process.env,
        APPLE_DEVELOPER_ID_CERT_PASSWORD: "fixture-password",
        KEIKO_KEYCHAIN_PASSWORD: "ephemeral-keychain-password",
        KEIKO_KEYCHAIN_PATH: keychain,
        KEIKO_P12_PATH: p12,
      };
      expect(run(helper, ["setup"], env).status).toBe(0);
      expect(existsSync(keychain)).toBe(true);
      expect(run(helper, ["cleanup"], env).status).toBe(0);
      expect(existsSync(keychain)).toBe(false);

      const malformedP12 = join(dir, "malformed.p12");
      const failedKeychain = join(dir, "failed.keychain-db");
      writeFileSync(malformedP12, "not a p12");
      const failedEnv = {
        ...env,
        KEIKO_KEYCHAIN_PATH: failedKeychain,
        KEIKO_P12_PATH: malformedP12,
      };
      expect(run(helper, ["setup"], failedEnv).status).not.toBe(0);
      expect(existsSync(failedKeychain)).toBe(false);
    },
  );
});
