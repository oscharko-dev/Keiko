import { generateKeyPairSync } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGithubAppConfig } from "./github-app-config.js";

const roots: string[] = [];
const now = new Date("2026-07-12T00:00:00Z");
const validPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const weakPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const nonRsaPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function secureFile(name: string, value: string): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-github-config-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, name);
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function target(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetKey: "public-feedback",
    installationId: "123",
    repositoryId: "456",
    owner: "oscharko-dev",
    repository: "keiko",
    labels: ["user-finding", "source:keiko"],
    labelPolicyVersion: "labels-v1",
    targetPolicyVersion: "target-v1",
    ...overrides,
  };
}

function input(targets: readonly unknown[]): {
  readonly appId: string;
  readonly privateKeyFile: string;
  readonly targetsPolicyFile: string;
  readonly privateKeyRotatedAt: string;
} {
  return {
    appId: "42",
    privateKeyFile: secureFile("key.pem", validPrivateKey),
    targetsPolicyFile: secureFile("targets.json", JSON.stringify({ version: 1, targets })),
    privateKeyRotatedAt: "2026-07-01T00:00:00Z",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub App configuration", () => {
  it("separates disabled, partial invalid, and ready configuration", () => {
    expect(loadGithubAppConfig({}, now)).toEqual({ status: "disabled" });
    expect(loadGithubAppConfig({ appId: "42" }, now)).toEqual({
      status: "invalid",
      reason: "configuration-invalid",
    });
    const result = loadGithubAppConfig(input([target()]), now);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.config.apiOrigin).toBe("https://api.github.com");
      expect(result.config.targets.get("public-feedback")?.digest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("rejects duplicate targets, broader fields, controls, and stale rotation", () => {
    expect(loadGithubAppConfig(input([target(), target()]), now).status).toBe("invalid");
    expect(loadGithubAppConfig(input([target({ contents: "write" })]), now).status).toBe("invalid");
    expect(loadGithubAppConfig(input([target({ labels: ["safe\u0000bad"] })]), now).status).toBe(
      "invalid",
    );
    expect(
      loadGithubAppConfig(
        { ...input([target()]), privateKeyRotatedAt: "2026-01-01T00:00:00Z" },
        now,
      ).status,
    ).toBe("invalid");
  });

  it("requires a bounded RFC 3339 key-rotation timestamp", () => {
    const valid = input([target()]);
    expect(
      loadGithubAppConfig({ ...valid, privateKeyRotatedAt: "2026-07-01T02:00:00+02:00" }, now)
        .status,
    ).toBe("ready");

    for (const privateKeyRotatedAt of [
      "2026-07-01T00:00:00",
      "2026-07-01 00:00:00Z",
      "July 1, 2026 00:00:00 UTC",
      "2026-07-01T00:00:00+0000",
      "2026-07-01T00:00:00.1234Z",
      "2026-02-30T00:00:00Z",
    ]) {
      expect(loadGithubAppConfig({ ...valid, privateKeyRotatedAt }, now).status).toBe("invalid");
    }
  });

  it("requires an absolute, existing, hardened private-key file for ready state", () => {
    const valid = input([target()]);
    expect(loadGithubAppConfig({ ...valid, privateKeyFile: "relative-key.pem" }, now).status).toBe(
      "invalid",
    );
    expect(
      loadGithubAppConfig({ ...valid, privateKeyFile: join(tmpdir(), "missing-key.pem") }, now)
        .status,
    ).toBe("invalid");
    chmodSync(valid.privateKeyFile, 0o644);
    expect(loadGithubAppConfig(valid, now).status).toBe("invalid");
  });

  it("rejects malformed, non-RSA, and undersized RSA private keys", () => {
    const valid = input([target()]);
    for (const material of ["not-a-private-key", nonRsaPrivateKey, weakPrivateKey]) {
      expect(
        loadGithubAppConfig(
          { ...valid, privateKeyFile: secureFile("invalid-key.pem", material) },
          now,
        ).status,
      ).toBe("invalid");
    }
  });

  it("rejects duplicate JSON keys and hardened-file violations", () => {
    const duplicate = secureFile(
      "duplicate.json",
      `{"version":1,"version":1,"targets":[${JSON.stringify(target())}]}`,
    );
    expect(
      loadGithubAppConfig({ ...input([target()]), targetsPolicyFile: duplicate }, now).status,
    ).toBe("invalid");
    chmodSync(duplicate, 0o644);
    expect(
      loadGithubAppConfig({ ...input([target()]), targetsPolicyFile: duplicate }, now).status,
    ).toBe("invalid");
  });

  it.runIf(process.platform !== "win32")("rejects symlinks and multiple hard links", () => {
    const original = input([target()]);
    const symlink = secureFile("link-holder", "x");
    rmSync(symlink);
    symlinkSync(original.targetsPolicyFile, symlink);
    expect(loadGithubAppConfig({ ...original, targetsPolicyFile: symlink }, now).status).toBe(
      "invalid",
    );
    const hardlink = secureFile("hardlink-holder", "x");
    rmSync(hardlink);
    linkSync(original.targetsPolicyFile, hardlink);
    expect(loadGithubAppConfig({ ...original, targetsPolicyFile: hardlink }, now).status).toBe(
      "invalid",
    );
  });
});
