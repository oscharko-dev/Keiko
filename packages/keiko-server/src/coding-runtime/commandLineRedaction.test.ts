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
    ["DB_PASSWORD=hunter2 make", "hunter2"],
    ["tool --passphrase swordfish", "swordfish"],
    ["tool --pwd=1234", "1234"],
    ["tool --pw=1234", "1234"],
    ["tool --pw 1234", "1234"],
    ["tool --client-key=abcd", "abcd"],
    ["tool --tls-cert=cert-body", "cert-body"],
    ["tool --db-password=hunter2", "hunter2"],
    ["tool --api-key hunter2", "hunter2"],
    ["tool --auth-token=hunter2", "hunter2"],
    ["curl -u admin:hunter2 https://example.test", "hunter2"],
    ["curl -uadmin:hunter2 https://example.test", "hunter2"],
    ["curl --user admin:hunter2 https://example.test", "hunter2"],
    ["git clone https://admin:hunter2@example.test/repo.git", "hunter2"],
    ['git clone "https://admin:hunter2@example.test/repo.git"', "hunter2"],
    // Shell quoting: a backslash escapes inside double quotes only.
    ['cmd "--password=a\\" b c"', "b c"],
    ['cmd --password="a\\" b c" next', "b c"],
    ["tool --password 'a\\' b", " b"],
    // PowerShell environment assignments.
    ['$env:PASSWORD="hunter2"; npm test', "hunter2"],
    ["$env:DB_PASSWORD='hunt er2'; npm test", "hunt er2"],
    ["$env:NPM_TOKEN=hunter2; npm test", "hunter2"],
    // Environment values passed through a container flag.
    ["docker run --env=DB_PASSWORD=hunter2 img", "hunter2"],
    ["docker run --env DB_PASSWORD=hunter2 img", "hunter2"],
    ["docker run --env API_TOKEN=hunter2 --env X=1 img", "hunter2"],
  ])("masks the credential in %s", (line, secret) => {
    const out = mask(line);
    expect(out).not.toContain(secret.trim());
    expect(out).toContain("[REDACTED]");
  });

  it("masks to the end of the token run when a quote is unsure, and stops at a separator", () => {
    const out = mask("tool --password 'a\\' b c && npm test");
    expect(out).not.toMatch(/\bb\b/u);
    expect(out).toContain("&& npm test");
    expect(mask("tool --password='a b").endsWith("[REDACTED]")).toBe(true);
  });

  it("does not let an unterminated quote swallow the rest or hide a later credential", () => {
    const out = mask('echo "oops --password=hunter2 && npm test');
    expect(out).not.toContain("hunter2");
    expect(out).toContain("&& npm test");
    expect(mask("run 'unclosed --token=abc123 next")).not.toContain("abc123");
  });

  it.each([
    "tool --pass-through=x",
    "tool --keyword=x",
    "tool --key-file=a.pem",
    "tool --monkey-patch=on",
    "tool --password-file=secrets.txt",
    "tool --author=me",
    "FOO=bar npm test",
    "docker run --env=PATH=/bin img",
    "docker run --env FOO=1 img",
    "tool -p 8080",
    "tool -p secret-looking-value",
    "$env:PATH=C:\\bin; npm test",
    "npm run test",
    'mvn -B test "-Dtest=My Test"',
    "tool --auth --verbose",
    "git clone https://example.test/repo.git",
  ])("keeps %s byte for byte", (line) => {
    expect(mask(line)).toBe(line);
  });

  it("keeps the quotes around a masked whole argument balanced and clean", () => {
    expect(mask('mvn "--password=p@ss word" test')).toBe('mvn "--password=[REDACTED]" test');
    expect(mask('tool "--password"="abc" next')).toBe('tool "--password"=[REDACTED] next');
  });
});
