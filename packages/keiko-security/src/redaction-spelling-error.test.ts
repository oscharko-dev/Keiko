import { describe, expect, it } from "vitest";
import { createSecretSpellingStreamRedactor } from "./redaction-spelling.js";

describe("unsupported secret spelling error identity", () => {
  it.each(["caf\u00e9-private", "private\nvalue", "\u0000private"])(
    "distinguishes unsupported secrets from programming TypeErrors (%j)",
    (secret) => {
      let observed: unknown;
      try {
        createSecretSpellingStreamRedactor([secret]);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(TypeError);
      expect(observed).toMatchObject({
        name: "UnsupportedSecretSpellingError",
        message: "secret-not-printable-ascii",
      });
      expect(String(observed)).not.toContain(secret);
    },
  );
  it("continues accepting printable ASCII credentials", () => {
    const stream = createSecretSpellingStreamRedactor(["ordinary-credential"]);
    expect(stream.push("ordinary-credential") + stream.finish()).toBe("[REDACTED]");
  });
});
