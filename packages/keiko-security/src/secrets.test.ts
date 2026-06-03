import { describe, expect, it } from "vitest";
import { isKeikoApiKeyEnvName, keikoApiKeySecretValues } from "./secrets.js";

describe("isKeikoApiKeyEnvName", () => {
  it.each(["KEIKO_DEFAULT_API_KEY", "KEIKO_MODEL_opus_API_KEY", "KEIKO_MODEL_a_API_KEY"])(
    "accepts %s",
    (name) => {
      expect(isKeikoApiKeyEnvName(name)).toBe(true);
    },
  );

  it.each(["", "DEFAULT_API_KEY", "KEIKO_API_KEY_NOTE", "KEIKO_DEFAULT_API_KEY_EXTRA", "PATH"])(
    "rejects %s",
    (name) => {
      expect(isKeikoApiKeyEnvName(name)).toBe(false);
    },
  );

  // Guard against the prefix-only false positive: a name that starts with KEIKO_MODEL_ but does
  // not end with _API_KEY must NOT be treated as a secret env var.
  it("rejects KEIKO_MODEL_<id>_BASE_URL", () => {
    expect(isKeikoApiKeyEnvName("KEIKO_MODEL_opus_BASE_URL")).toBe(false);
  });
});

describe("keikoApiKeySecretValues", () => {
  it("returns the values of matching env entries only", () => {
    const env = {
      KEIKO_DEFAULT_API_KEY: "default-secret",
      KEIKO_MODEL_a_API_KEY: "model-a-secret",
      KEIKO_MODEL_a_BASE_URL: "https://example/v1",
      OTHER: "unrelated",
    };
    const values = keikoApiKeySecretValues(env);
    expect([...values].sort()).toEqual(["default-secret", "model-a-secret"]);
  });

  it("never returns the env-var name, only the value", () => {
    const env = { KEIKO_DEFAULT_API_KEY: "the-value" };
    expect(keikoApiKeySecretValues(env)).toEqual(["the-value"]);
  });

  it("skips undefined and empty-string values", () => {
    const env = { KEIKO_DEFAULT_API_KEY: "", KEIKO_MODEL_x_API_KEY: undefined };
    expect(keikoApiKeySecretValues(env)).toEqual([]);
  });

  it("returns an empty list when the env has no matching keys", () => {
    expect(keikoApiKeySecretValues({ PATH: "/usr/bin" })).toEqual([]);
  });
});
