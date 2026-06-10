import { describe, expect, it } from "vitest";

import { scanForSecrets } from "./secret-patterns.js";

// Literal credential shapes are assembled by string concatenation so push-protection scanners
// never see a real-looking secret in source. Each fragment is meaningless in isolation; the
// concatenated string is a SHAPE for the regex to match on, not a real secret.

describe("scanForSecrets — credential-shape patterns (looksLikeSecretShape parity + extensions)", () => {
  it("rejects an OpenAI-style key shape", () => {
    const shape = "sk" + "-" + "abcdef0123456789abcdef0123";
    expect(scanForSecrets(`api key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects an AWS access-key id shape", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(scanForSecrets(`access key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a GitHub personal-access-token shape", () => {
    const shape = "gh" + "p_" + "abcdef0123456789abcdef0123456789ABCD";
    expect(scanForSecrets(shape)).toBe("credential-shape");
  });

  it("rejects a Slack-style token shape", () => {
    const shape = "xox" + "b-" + "1234567890-abcdefghij";
    expect(scanForSecrets(shape)).toBe("credential-shape");
  });

  it("rejects a three-part JWT shape", () => {
    const shape = "eyJ" + "abcdef12.abcdef1234.abcdef9876";
    expect(scanForSecrets(`token: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a PEM private-key header", () => {
    const shape = "-----BEGIN RSA PRIVATE KEY-----";
    expect(scanForSecrets(`my key: ${shape}`)).toBe("credential-shape");
  });

  it("rejects a long contiguous digit run (PAN/IBAN shape)", () => {
    const shape = "4111111111111111";
    expect(scanForSecrets(`card: ${shape}`)).toBe("credential-shape");
  });

  it("rejects an opaque Bearer authorization header", () => {
    const value = ["Bearer", " ", "opaque-token-1234567890"].join("");
    expect(scanForSecrets(value)).toBe("credential-shape");
  });

  it("rejects a lowercase bearer authorization header", () => {
    const value = "bearer opaque-token-1234567890";
    expect(scanForSecrets(value)).toBe("credential-shape");
  });

  it("rejects a URL with embedded basic-auth credentials", () => {
    const url = "https://alice:p4ssw0rd@example.com/repo.git";
    expect(scanForSecrets(`clone ${url}`)).toBe("credential-shape");
  });

  it("rejects a form-encoded password assignment", () => {
    expect(scanForSecrets("logged in with password=hunter2 today")).toBe("credential-shape");
  });

  it("rejects a form-encoded secret assignment", () => {
    expect(scanForSecrets("export secret=abc123")).toBe("credential-shape");
  });

  it("rejects a form-encoded api_key assignment", () => {
    expect(scanForSecrets("api_key=ZZZ-yyy")).toBe("credential-shape");
  });

  it("rejects a form-encoded token assignment", () => {
    expect(scanForSecrets("token=abcdefgh")).toBe("credential-shape");
  });
});

describe("scanForSecrets — private-credential-path patterns", () => {
  it("rejects a path to an SSH private key", () => {
    expect(scanForSecrets("see ~/.ssh/id_rsa for the key")).toBe("private-credential-path");
  });

  it("rejects a path to an SSH ed25519 key under any prefix", () => {
    expect(scanForSecrets("/home/me/.ssh/id_ed25519 is mine")).toBe("private-credential-path");
  });

  it("rejects a path to ~/.aws/credentials", () => {
    expect(scanForSecrets("look at ~/.aws/credentials")).toBe("private-credential-path");
  });

  it("rejects a path to .npmrc", () => {
    expect(scanForSecrets("config in ./.npmrc")).toBe("private-credential-path");
  });

  it("rejects a path to .env", () => {
    expect(scanForSecrets("see ./.env for vars")).toBe("private-credential-path");
  });

  it("rejects a path to a .env.<environment> file", () => {
    expect(scanForSecrets("see ./.env.production for vars")).toBe("private-credential-path");
  });
});

describe("scanForSecrets — provider base URLs", () => {
  it("rejects provider base URLs called out explicitly in natural language", () => {
    expect(
      scanForSecrets(
        "remember that our provider base URL is https://llm.internal.example.com/v1",
      ),
    ).toBe("provider-base-url");
  });

  it("rejects an OpenAI-compatible endpoint URL even without nearby provider wording", () => {
    expect(scanForSecrets("https://gateway.example.invalid/openai/v1")).toBe(
      "provider-base-url",
    );
  });

  it("does not reject an ordinary documentation URL", () => {
    expect(scanForSecrets("remember that docs live at https://docs.example.com/setup")).toBeNull();
  });
});

describe("scanForSecrets — raw log content", () => {
  it("rejects severity plus ISO timestamp log lines", () => {
    expect(
      scanForSecrets("ERROR 2026-06-08T06:00:00Z worker failed while processing module X"),
    ).toBe("raw-log-content");
  });

  it("rejects stack-trace style content with repeated frames", () => {
    expect(scanForSecrets("stack trace line 1 at foo() line 2 at bar()")).toBe(
      "raw-log-content",
    );
  });

  it("does not reject plain prose that mentions a module failure", () => {
    expect(scanForSecrets("remember that module X failed during a deploy rehearsal")).toBeNull();
  });
});

describe("scanForSecrets — customer-identifier matchers (caller-injected)", () => {
  it("returns customer-identifier when a caller matcher fires", () => {
    const matchers = [/\bAcmeCorp\b/];
    expect(scanForSecrets("remember that AcmeCorp uses postgres", matchers)).toBe(
      "customer-identifier",
    );
  });

  it("returns null when no caller matchers and no built-in match", () => {
    expect(scanForSecrets("remember that I prefer dark mode")).toBeNull();
  });

  it("returns null when matchers list is empty and no built-in match", () => {
    expect(scanForSecrets("benign text here", [])).toBeNull();
  });

  it("prefers credential-shape over a customer matcher when both could fire", () => {
    const matchers = [/\bAcmeCorp\b/];
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(scanForSecrets(`AcmeCorp uses ${shape}`, matchers)).toBe("credential-shape");
  });
});

describe("scanForSecrets — benign content", () => {
  it("returns null for natural-language preferences", () => {
    expect(scanForSecrets("I prefer two-space indentation in TypeScript")).toBeNull();
  });

  it("returns null for short digit runs (under PAN length)", () => {
    expect(scanForSecrets("we have 12 open issues")).toBeNull();
  });

  it("returns null for a path that is not a credential store", () => {
    expect(scanForSecrets("see src/utils/parser.ts for the helper")).toBeNull();
  });

  it("returns null for a general-purpose API docs note without a provider endpoint shape", () => {
    expect(scanForSecrets("The API docs are at https://docs.example.com/reference")).toBeNull();
  });
});
