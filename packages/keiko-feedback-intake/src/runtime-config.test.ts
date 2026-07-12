import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHostedRuntimeConfig } from "./runtime-config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://intake.invalid/database",
    KEIKO_FEEDBACK_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_PORT: "8080",
    KEIKO_FEEDBACK_MANAGEMENT_HOST: "127.0.0.1",
    KEIKO_FEEDBACK_MANAGEMENT_PORT: "8081",
    KEIKO_FEEDBACK_PER_IDENTITY_LIMIT: "10",
    KEIKO_FEEDBACK_GLOBAL_LIMIT: "100",
    KEIKO_FEEDBACK_CONCURRENCY_LIMIT: "4",
    KEIKO_FEEDBACK_RECEIPT_CONCURRENCY_LIMIT: "2",
    KEIKO_FEEDBACK_OPEN_COUNT_LIMIT: "100",
    KEIKO_FEEDBACK_OPEN_BYTES_LIMIT: "1000000",
    KEIKO_FEEDBACK_PROXY_HOPS_LIMIT: "2",
    KEIKO_FEEDBACK_BODY_BYTES_LIMIT: "262144",
    KEIKO_FEEDBACK_HEADER_BYTES_LIMIT: "16384",
    KEIKO_FEEDBACK_BODY_DEADLINE_MS: "2000",
    KEIKO_FEEDBACK_STORAGE_DEADLINE_MS: "2000",
    KEIKO_FEEDBACK_DRAIN_DEADLINE_MS: "1000",
    KEIKO_FEEDBACK_RETENTION_INTERVAL_MS: "60000",
    KEIKO_FEEDBACK_PROXY_FAMILY: "forwarded",
    KEIKO_FEEDBACK_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    KEIKO_FEEDBACK_SECRET_DIR: "/run/secrets/keiko-feedback",
  };
}

describe("hosted runtime configuration", () => {
  it("freezes the validated configuration, limits, and trusted proxy set", () => {
    const config = loadHostedRuntimeConfig(environment());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(Object.isFrozen(config.trustedProxyCidrs)).toBe(true);
    expect(config.publication).toEqual({ enabled: false });
  });

  it("rejects partial publication configuration", () => {
    expect(() =>
      loadHostedRuntimeConfig({ ...environment(), KEIKO_FEEDBACK_GITHUB_APP_ID: "42" }),
    ).toThrow("Invalid GitHub publication configuration");
    expect(() =>
      loadHostedRuntimeConfig({
        ...environment(),
        KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES: "2",
      }),
    ).toThrow("Invalid GitHub publication configuration");
  });

  it("loads secure ready configuration and bounded worker settings", () => {
    const root = mkdtempSync(join(tmpdir(), "publication-config-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const keyFile = join(root, "app.pem");
    const policyFile = join(root, "targets.json");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        targets: [
          {
            targetKey: "public",
            installationId: "123",
            repositoryId: "456",
            owner: "owner",
            repository: "repository",
            labels: ["feedback"],
            labelPolicyVersion: "labels-v1",
            targetPolicyVersion: "target-v1",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const config = loadHostedRuntimeConfig(
      {
        ...environment(),
        KEIKO_FEEDBACK_GITHUB_APP_ID: "42",
        KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_FILE: keyFile,
        KEIKO_FEEDBACK_GITHUB_TARGETS_POLICY_FILE: policyFile,
        KEIKO_FEEDBACK_GITHUB_PRIVATE_KEY_ROTATED_AT: "2026-07-01T00:00:00Z",
        KEIKO_FEEDBACK_GITHUB_MAX_CONCURRENT_DELIVERIES: "3",
      },
      new Date("2026-07-12T00:00:00Z"),
    );
    expect(config.publication).toMatchObject({
      enabled: true,
      maxConcurrentDeliveries: 3,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
    });
  });
});
