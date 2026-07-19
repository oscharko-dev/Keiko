import { describe, expect, it } from "vitest";

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

  it("never accepts a mode parameter, so a denial cannot be relaxed by mode", () => {
    const policy = {
      deniedCategoryMatchers: [{ category: "third-party", matchers: [/\bmy colleague is\b/iu] }],
    };
    // memoryTextSecretEgressRejectionReason's signature is (text, policy) with no third "mode"
    // argument anywhere, so no caller — at any layer, in any of the CODING_WORKBENCH_MODES — can
    // pass a mode that special-cases this denial; calling it in a loop over modes would only call
    // the identical (text, policy) pair repeatedly and prove nothing beyond this arity check. The
    // full end-to-end mode-independence property (every product mode routes through this same
    // unmodified call) is proven by memory-capture-autonomy.test.ts's server-side clamp test and
    // by tests/e2e/memoriaviva-m1-certification.spec.ts's live certifyModeIndependentDenials.
    expect(memoryTextSecretEgressRejectionReason.length).toBe(1);
    expect(memoryTextSecretEgressRejectionReason("My colleague is moving teams.", policy)).toBe(
      "denied-category",
    );
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
