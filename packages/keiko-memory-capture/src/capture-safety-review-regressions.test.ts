import { describe, expect, it } from "vitest";

import { memoryTextEgressRejectionReason, memoryTextSecretEgressRejectionReason } from "./index.js";
import { scanForSecrets } from "./secret-patterns.js";

describe("memory credential grammar review regressions", () => {
  it.each([
    ["password value after newline", "password=\nopaque-secret-value"],
    ["multiline Bearer", "Bearer\nopaque-token-value"],
    ["multiline Basic", "Basic\ndXNlcjpwYXNz"],
    ["embedded quoted assignment", 'Safe prefix "password=opaque-secret-value" safe suffix'],
  ])("rejects %s before every memory egress path", (_label, input) => {
    expect(memoryTextSecretEgressRejectionReason(input)).toBe("credential-shape");
    expect(memoryTextEgressRejectionReason(input)).toBe("credential-shape");
  });

  it.each(["password", "api_key", "token"])(
    "rejects a prose-prefixed %s colon assignment before memory egress",
    (key) => {
      const input = `remember the ${key}: hunter2 today`;

      expect(scanForSecrets(input)).toBe("credential-shape");
      expect(memoryTextSecretEgressRejectionReason(input)).toBe("credential-shape");
      expect(memoryTextEgressRejectionReason(input)).toBe("credential-shape");
    },
  );
});
