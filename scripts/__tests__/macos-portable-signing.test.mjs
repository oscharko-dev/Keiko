import { Buffer } from "node:buffer";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  inventoryMacPortableCode,
  main,
  validateAppleSigningConfig,
} from "../macos-portable-signing.mjs";

const roots = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-macos-signing-"));
  roots.push(path);
  return path;
}
function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
function macho(magic = 0xfeedfacf, marker = 0) {
  const bytes = Buffer.alloc(64, marker);
  bytes.writeUInt32BE(magic, 0);
  return bytes;
}
function payload() {
  const path = root();
  write(join(path, "Keiko.app", "Contents", "MacOS", "Keiko"), macho());
  write(
    join(path, "Keiko.app", "Contents", "Resources", "runtime", "node", "bin", "node"),
    macho(0xcafebabf, 1),
  );
  write(
    join(
      path,
      "Keiko.app",
      "Contents",
      "Resources",
      "runtime",
      "sidecars",
      "opencode",
      "bin",
      "opencode",
    ),
    macho(0xcafebabe, 2),
  );
  write(
    join(path, "Keiko.app", "Contents", "Resources", "app", "addon.node"),
    macho(0xfeedface, 3),
  );
  write(join(path, "support", "keiko-support.sh"), Buffer.from("#!/bin/sh\n"));
  return path;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("macOS portable signing inventory", () => {
  it("detects thin/fat Mach-O content and assigns only Node the JIT role", () => {
    const inventory = inventoryMacPortableCode(payload(), "macos-arm64");
    expect(inventory.codeObjects.map((entry) => [entry.relativePath, entry.role])).toEqual([
      ["Keiko.app/Contents/MacOS/Keiko", "default"],
      ["Keiko.app/Contents/Resources/app/addon.node", "default"],
      ["Keiko.app/Contents/Resources/runtime/node/bin/node", "node-runtime"],
      ["Keiko.app/Contents/Resources/runtime/sidecars/opencode/bin/opencode", "sidecar-runtime"],
    ]);
  });

  it("includes nested bundles and malformed Mach-O candidates in the native verification set", () => {
    const path = payload();
    write(
      join(path, "Keiko.app", "Contents", "PlugIns", "Bank.bundle", "Contents", "MacOS", "Bank"),
      Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
    );
    const inventory = inventoryMacPortableCode(path, "macos-arm64");
    expect(inventory.nestedBundles).toEqual(["Keiko.app/Contents/PlugIns/Bank.bundle"]);
    expect(inventory.codeObjects.map((entry) => entry.relativePath)).toContain(
      "Keiko.app/Contents/PlugIns/Bank.bundle/Contents/MacOS/Bank",
    );
  });

  it("fails closed for missing required code and aliased payload entries", () => {
    const missing = root();
    write(join(missing, "Keiko.app", "Contents", "MacOS", "Keiko"), macho());
    expect(() => inventoryMacPortableCode(missing, "macos-x64")).toThrow(
      /Node executable is missing/u,
    );
    const linked = payload();
    symlinkSync(join(linked, "Keiko.app", "Contents", "MacOS", "Keiko"), join(linked, "alias"));
    expect(() => inventoryMacPortableCode(linked, "macos-arm64")).toThrow(/contains a link/u);
    const hardlinked = payload();
    linkSync(
      join(hardlinked, "Keiko.app", "Contents", "MacOS", "Keiko"),
      join(hardlinked, "alias"),
    );
    expect(() => inventoryMacPortableCode(hardlinked, "macos-arm64")).toThrow(/hard-linked/u);
  });

  it("rejects mutated inventory authority before comparison", async () => {
    const stage = root();
    const original = inventoryMacPortableCode(payload(), "macos-arm64");
    const expected = join(stage, "expected.json");
    writeFileSync(expected, JSON.stringify(original));
    const mutate = (change) => {
      const value = JSON.parse(JSON.stringify(original));
      change(value);
      return value;
    };
    const mutations = [
      mutate((value) => {
        value.target = "macos-x64";
      }),
      mutate((value) => {
        value.codeObjects.reverse();
      }),
      mutate((value) => {
        value.codeObjects[0].role = "node-runtime";
      }),
      mutate((value) => {
        value.codeObjects = value.codeObjects.filter(
          (entry) => !entry.relativePath.endsWith("/node/bin/node"),
        );
      }),
      mutate((value) => {
        value.unreviewed = true;
      }),
      mutate((value) => {
        value.nestedBundles = ["Keiko.app/Contents/PlugIns/not-a-bundle"];
      }),
      mutate((value) => {
        value.nestedBundles = [
          "Keiko.app/Contents/A.bundle",
          "Keiko.app/Contents/A.bundle/Contents/B.framework",
        ];
      }),
    ];
    for (const [index, mutation] of mutations.entries()) {
      const actual = join(stage, `actual-${String(index)}.json`);
      writeFileSync(actual, JSON.stringify(mutation));
      await expect(
        main(["compare-paths", "--expected-inventory", expected, "--actual-inventory", actual]),
      ).rejects.toThrow(/inventory|changed unexpectedly|executable is missing/u);
    }
  });
});

describe("macOS protected configuration and native result", () => {
  function config() {
    return {
      APPLE_DEVELOPER_ID_IDENTITY: "Developer ID Application: Keiko Bank (AB12CD34EF)",
      APPLE_TEAM_ID: "AB12CD34EF",
      APPLE_NOTARY_KEY_ID: "ZX98YU76TR",
      APPLE_NOTARY_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
      APPLE_DEVELOPER_ID_CERT_P12_BASE64: Buffer.concat([
        Buffer.from([0x30]),
        Buffer.alloc(255, 1),
      ]).toString("base64"),
      APPLE_DEVELOPER_ID_CERT_PASSWORD: "protected",
      APPLE_NOTARY_KEY_P8_BASE64: Buffer.from(
        `-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----\n`,
      ).toString("base64"),
    };
  }
  it("accepts the exact team-bound identity and rejects missing or mismatched values", () => {
    expect(() => validateAppleSigningConfig(config())).not.toThrow();
    expect(() => validateAppleSigningConfig({ ...config(), APPLE_TEAM_ID: "WRONG" })).toThrow();
    expect(() =>
      validateAppleSigningConfig({ ...config(), APPLE_NOTARY_KEY_P8_BASE64: "" }),
    ).toThrow();
  });

  it("rejects unbounded, malformed, or control-bearing credential references", () => {
    expect(() =>
      validateAppleSigningConfig({
        ...config(),
        APPLE_DEVELOPER_ID_CERT_PASSWORD: "bad\npassword",
      }),
    ).toThrow(/configuration is invalid/u);
    expect(() =>
      validateAppleSigningConfig({ ...config(), APPLE_DEVELOPER_ID_CERT_P12_BASE64: "AAAA" }),
    ).toThrow(/credential size/u);
    expect(() =>
      validateAppleSigningConfig({
        ...config(),
        APPLE_NOTARY_KEY_P8_BASE64: Buffer.alloc(65, 1).toString("base64"),
      }),
    ).toThrow(/notary key encoding/u);
  });

  it("keeps key material non-extractable, sign-only, and scoped to one identity", () => {
    const helper = readFileSync(
      new URL("../../native/portable-launcher/macos-keychain-helper.c", import.meta.url),
      "utf8",
    );
    expect(helper).toContain("kSecAttrCanSign");
    expect(helper).toContain("kSecAttrIsPermanent, kSecAttrIsSensitive");
    expect(helper).not.toContain("kSecAttrIsExtractable");
    expect(helper).toContain("identity_count != 1");
    expect(helper).toContain("/usr/bin/codesign");
    const cleanup = readFileSync(
      new URL("../cleanup-macos-portable-signing.sh", import.meta.url),
      "utf8",
    );
    expect(cleanup).toContain("KEIKO_KEYCHAIN_PASSWORD=\\n");
    expect(cleanup).toContain('rm -rf "$root"');
  });

  it("cannot produce a verified input unless every native observation is true", async () => {
    const stage = root();
    mkdirSync(join(stage, "manifest"), { recursive: true });
    writeFileSync(
      join(stage, "manifest", "portable-manifest.json"),
      JSON.stringify({ sidecarRuntimes: [] }),
    );
    const output = join(stage, "input.json");
    const nativeEnv = {
      KEIKO_NATIVE_ASSESSMENT_VERIFIED: "true",
      KEIKO_NATIVE_DEVELOPER_ID_VERIFIED: "true",
      KEIKO_NATIVE_NOTARIZATION_VERIFIED: "true",
      KEIKO_NATIVE_STAPLE_VERIFIED: "true",
    };
    const previous = Object.fromEntries(
      Object.keys(nativeEnv).map((name) => [name, process.env[name]]),
    );
    try {
      for (const name of Object.keys(nativeEnv)) {
        Object.assign(process.env, nativeEnv, { [name]: "false" });
        await expect(
          main(["verification-input", "--stage-root", stage, "--output", output]),
        ).rejects.toThrow(/did not succeed/u);
      }
      Object.assign(process.env, nativeEnv);
      await expect(
        main(["verification-input", "--stage-root", stage, "--output", output]),
      ).resolves.toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });
});
