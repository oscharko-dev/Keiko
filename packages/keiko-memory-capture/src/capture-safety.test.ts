import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts";

import {
  memoryTextEgressRejectionReason,
  memoryTextSecretEgressRejectionReason,
} from "./capture-safety.js";

describe("memoryTextEgressRejectionReason", () => {
  it("returns null for public memory-safe text", () => {
    expect(memoryTextEgressRejectionReason("The user prefers vitest for tests.")).toBeNull();
  });

  it("blocks credential-shaped text before secondary model egress", () => {
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    expect(memoryTextEgressRejectionReason(`remember api_key=${apiKey}`)).toBe("credential-shape");
  });

  it("blocks configured customer identifiers before secondary model egress", () => {
    expect(
      memoryTextEgressRejectionReason("CustomerOmega requires SSO.", {
        customerIdentifierMatchers: [/CustomerOmega/],
      }),
    ).toBe("customer-identifier");
  });

  it("blocks configured categories after secrets and before sensitivity", () => {
    const policy = {
      deniedCategoryMatchers: [{ category: "health-data", matchers: [/\bmedical record\b/iu] }],
    };
    expect(memoryTextEgressRejectionReason("The medical record changed.", policy)).toBe(
      "denied-category",
    );
    expect(memoryTextSecretEgressRejectionReason("The medical record changed.", policy)).toBe(
      "denied-category",
    );
  });

  it("keeps secret precedence when secret and denied-category matchers both fire", () => {
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    const body = `The medical record contains api_key=${apiKey}`;
    expect(
      memoryTextEgressRejectionReason(body, {
        deniedCategoryMatchers: [{ category: "health-data", matchers: [/medical record/iu] }],
      }),
    ).toBe("credential-shape");
  });

  it("returns the same category denial for every product mode", () => {
    const policy = {
      deniedCategoryMatchers: [{ category: "third-party", matchers: [/\bmy colleague is\b/iu] }],
    };
    const outcomes = CODING_WORKBENCH_MODES.map(() =>
      memoryTextSecretEgressRejectionReason("My colleague is moving teams.", policy),
    );
    expect(outcomes).toEqual(CODING_WORKBENCH_MODES.map(() => "denied-category"));
  });

  it("blocks non-public sensitivity before secondary model egress", () => {
    expect(memoryTextEgressRejectionReason("my private support email is dev@example.com")).toBe(
      "sensitive-memory-requires-approval",
    );
  });

  it("exposes a hard-denial guard that leaves reviewable PII to candidate policy", () => {
    expect(
      memoryTextSecretEgressRejectionReason("my private support email is dev@example.com"),
    ).toBeNull();
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    expect(memoryTextSecretEgressRejectionReason(`remember api_key=${apiKey}`)).toBe(
      "credential-shape",
    );
  });
});
