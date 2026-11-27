import { describe, expect, it } from "vitest";
import { redactCommandLineCredentials } from "./commandLineRedaction.js";

const mask = redactCommandLineCredentials;

describe("redactCommandLineCredentials", () => {
  it.each([
    ['mvn test "--password=p@ss word"', "p@ss word"],
    ['mvn test "-Dpassword=pa$$"', "pa$$"],
    ['mvn test --password="a b"', "a b"],
    ['mvn test "--token=x y"', "x y"],
    ["mvn test -Dpassword=p$$", "p$$"],
    ["PASSWORD=x npm test", "=x "],
    ["NPM_TOKEN=abc123 npm test", "abc123"],
    ["API_KEY=k1 CERT_FILE=c.pem make", "k1"],
    ["tool --passphrase swordfish", "swordfish"],
    ["tool --pwd=1234", "1234"],
    ["tool --client-key=abcd", "abcd"],
    ["tool --tls-cert=cert-body", "cert-body"],
    ["curl -u admin:hunter2 https://example.test", "hunter2"],
    ["curl --user admin:hunter2 https://example.test", "hunter2"],
    ["git clone https://admin:hunter2@example.test/repo.git", "hunter2"],
    ['git clone "https://admin:hunter2@example.test/repo.git"', "hunter2"],
  ])("masks the credential in %s", (line, secret) => {
    const out = mask(line);
    expect(out).not.toContain(secret.trim());
    expect(out).toContain("[REDACTED]");
  });

  it("does not let an unterminated quote swallow the rest or hide a later credential", () => {
    const out = mask('echo "oops --password=hunter2 && npm test');
    expect(out).not.toContain("hunter2");
    expect(out).toContain("&& npm test");
    expect(mask("run 'unclosed --token=abc123 next")).not.toContain("abc123");
  });

  it("keeps everything else byte for byte", () => {
    for (const line of [
      "npm run test",
      'mvn -B test "-Dtest=My Test"',
      "tool --auth --verbose",
      "FOO=bar npm test",
      "git clone https://example.test/repo.git",
    ]) {
      expect(mask(line)).toBe(line);
    }
  });

  it("keeps the quotes around a masked whole argument balanced", () => {
    expect(mask('mvn "--password=p@ss word" test')).toBe('mvn "--password=[REDACTED]" test');
  });
});
