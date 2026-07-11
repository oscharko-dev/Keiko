import { describe, expect, it } from "vitest";
import { loadHostedRuntimeConfig } from "./runtime-config.js";

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
  });
});
