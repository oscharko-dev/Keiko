import { generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GithubAppPrivateKeyProvider } from "./github-app-key.js";
import { createGithubAppJwt } from "./github-app-jwt.js";

const roots: string[] = [];

function keyFile(modulusLength = 2048): { readonly path: string; readonly publicKey: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-github-key-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const pair = generateKeyPairSync("rsa", {
    modulusLength,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const path = join(root, "app.pem");
  writeFileSync(path, pair.privateKey, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, publicKey: pair.publicKey };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub App signing custody", () => {
  it("creates a bounded RS256 JWT with trusted time", () => {
    const key = keyFile();
    const now = new Date("2026-07-12T00:00:00Z");
    const signer = new GithubAppPrivateKeyProvider(
      key.path,
      new Date("2026-07-01T00:00:00Z"),
    ).snapshot(now);
    const jwt = createGithubAppJwt("42", signer, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: 1_783_814_370,
      exp: 1_783_814_940,
      iss: "42",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from([header, payload].join(".")),
        key.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects undersized RSA, insecure files, stale rotation, and excessive JWT lifetime", () => {
    const weak = keyFile(1024);
    const now = new Date("2026-07-12T00:00:00Z");
    expect(() =>
      new GithubAppPrivateKeyProvider(weak.path, new Date("2026-07-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
    const secure = keyFile();
    chmodSync(secure.path, 0o644);
    expect(() =>
      new GithubAppPrivateKeyProvider(secure.path, new Date("2026-07-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
    expect(() =>
      new GithubAppPrivateKeyProvider(weak.path, new Date("2026-01-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
  });

  it("observes atomic key replacement without exposing key material", () => {
    const first = keyFile();
    const second = keyFile();
    const now = new Date("2026-07-12T00:00:00Z");
    const provider = new GithubAppPrivateKeyProvider(first.path, new Date("2026-07-01T00:00:00Z"));
    const before = provider.snapshot(now);
    renameSync(second.path, first.path);
    const after = provider.snapshot(now);
    expect(after.keyId).not.toBe(before.keyId);
    expect(JSON.stringify(after)).not.toContain("PRIVATE KEY");
  });

  it.runIf(process.platform !== "win32")("rejects symlinks, directories, and oversized PEM", () => {
    const key = keyFile();
    const now = new Date("2026-07-12T00:00:00Z");
    const link = `${key.path}.link`;
    symlinkSync(key.path, link);
    expect(() =>
      new GithubAppPrivateKeyProvider(link, new Date("2026-07-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
    const directory = `${key.path}.directory`;
    mkdirSync(directory, { mode: 0o700 });
    expect(() =>
      new GithubAppPrivateKeyProvider(directory, new Date("2026-07-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
    const oversized = `${key.path}.oversized`;
    writeFileSync(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(() =>
      new GithubAppPrivateKeyProvider(oversized, new Date("2026-07-01T00:00:00Z")).snapshot(now),
    ).toThrow("unavailable");
  });
});
