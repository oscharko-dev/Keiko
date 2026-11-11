import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PATH_DENY_PATTERNS,
  ENV_EXAMPLE_BASENAME,
  TOOL_STATE_PATH_DENY_PATTERNS,
} from "@oscharko-dev/keiko-contracts/sensitive-path-patterns";
import {
  CREDENTIAL_PATH_SEATBELT_RULE,
  credentialPathSeatbeltRule,
} from "./seatbelt-credential-paths.js";

// The Seatbelt regex dialect used here is a strict subset of JavaScript's, so the generated
// arguments can be exercised directly. Real kernel behaviour is proven in runtime-gateway.test.ts.
function compile(rule: string): RegExp[] {
  return [...rule.matchAll(/\(regex ((?:"[^"]*" ?)+)\)/gu)]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]*)"/gu)])
    .map((argument) => new RegExp(argument[1] ?? "", "u"));
}

interface RuleRegexes {
  readonly plain: RegExp[];
  readonly exemptable: RegExp[];
  readonly trustDirectories: RegExp[];
  readonly trustLeaves: RegExp[];
  readonly trustExempt: RegExp[];
}

function ruleRegexes(rule: string = CREDENTIAL_PATH_SEATBELT_RULE): RuleRegexes {
  const denies = rule.split("(deny file-read* file-write* ").slice(1);
  const trustLeaf = denies[3] ?? "";
  const [leafPart, exemptPart] = trustLeaf.split("(require-not ");
  return {
    plain: compile(denies[0] ?? ""),
    exemptable: compile(denies[1] ?? ""),
    trustDirectories: compile(denies[2] ?? ""),
    trustLeaves: compile(leafPart ?? ""),
    trustExempt: compile(exemptPart ?? ""),
  };
}

function sampleName(pattern: string): string {
  return pattern.replaceAll("*", "x");
}

describe("native credential path rule", () => {
  const { plain, exemptable, trustDirectories, trustLeaves, trustExempt } = ruleRegexes();
  const trustDenied = (path: string): boolean =>
    trustDirectories.some((r) => r.test(path)) ||
    (trustLeaves.some((r) => r.test(path)) && !trustExempt.some((r) => r.test(path)));
  const denied = (path: string): boolean =>
    [...plain, ...exemptable].some((r) => r.test(path)) || trustDenied(path);

  it("keeps every Seatbelt string literal below the 1,023 character limit", () => {
    for (const literal of CREDENTIAL_PATH_SEATBELT_RULE.matchAll(/"([^"]*)"/gu))
      expect((literal[1] ?? "").length).toBeLessThan(1_023);
    expect(plain.length + exemptable.length).toBeGreaterThan(1);
    expect(trustDirectories.length * trustLeaves.length * trustExempt.length).toBeGreaterThan(0);
  });

  it.each(CREDENTIAL_PATH_DENY_PATTERNS.filter((pattern) => pattern !== ".env.*"))(
    "denies %s as a file, as a directory prefix and in any letter case",
    (pattern) => {
      const name = sampleName(pattern);
      expect(denied(`/work/ws/${name}`)).toBe(true);
      expect(denied(`/work/ws/${name}/child.txt`)).toBe(true);
      expect(denied(`/work/ws/nested/${name.toUpperCase()}`)).toBe(true);
      expect(denied(`/work/ws/not${name}`)).toBe(pattern.startsWith("*"));
    },
  );

  it("denies .env.* except the documented .env.example leaf", () => {
    const envPattern = exemptable;
    expect(envPattern.some((r) => r.test("/work/ws/.env.local"))).toBe(true);
    expect(envPattern.some((r) => r.test(`/work/ws/${ENV_EXAMPLE_BASENAME}`))).toBe(true);
    const exempt = new RegExp(
      /\(require-not \(regex "([^"]*)"\)\)/u.exec(CREDENTIAL_PATH_SEATBELT_RULE)?.[1] ?? "(?!)",
      "u",
    );
    expect(exempt.test(`/work/ws/${ENV_EXAMPLE_BASENAME}`)).toBe(true);
    expect(exempt.test("/work/ws/.env.local")).toBe(false);
    // A child of an `.env.example` directory is not the exempt leaf, and a denied directory above
    // the exempt name still denies it through its own pattern.
    expect(exempt.test(`/work/ws/${ENV_EXAMPLE_BASENAME}/secret`)).toBe(false);
    expect(denied("/work/ws/.ssh/.env.example")).toBe(true);
  });

  it("never denies the tool state the toolchain itself needs", () => {
    for (const pattern of TOOL_STATE_PATH_DENY_PATTERNS)
      expect(denied(`/work/ws/${sampleName(pattern)}/file`)).toBe(false);
    expect(denied("/work/ws/src/app.js")).toBe(false);
  });

  // #4271 lab: curl, Git, Python, Node's system store and pip read these public bundles, and the
  // `*.pem` rule denied every one of them, so no HTTPS client of a native shell verified a server.
  it.each([
    "/private/etc/ssl/cert.pem",
    "/opt/homebrew/etc/ca-certificates/cert.pem",
    "/opt/homebrew/etc/openssl@3/cert.pem",
    "/opt/homebrew/etc/openssl@4/cert.pem",
    "/usr/local/etc/openssl/cert.pem",
    "/usr/local/etc/openssl@1.1/cert.pem",
    "/opt/homebrew/lib/python3.13/site-packages/pip/_vendor/certifi/cacert.pem",
    "/work/ws/.venv/lib/python3.12/site-packages/certifi/cacert.pem",
  ])("leaves the public trust bundle %s to the earlier rules", (path) => {
    expect(trustLeaves.some((r) => r.test(path))).toBe(true);
    expect(denied(path)).toBe(false);
  });

  it.each([
    "/work/ws/cert.pem",
    "/work/ws/cacert.pem",
    "/private/etc/ssl/private/cert.pem",
    "/private/etc/ssl/server.pem",
    "/opt/homebrew/etc/openssl@3/private/cert.pem",
    "/opt/homebrew/etc/nginx/cert.pem",
    "/work/ws/notcertifi/cacert.pem",
    "/work/ws/certifi/cacert.pem",
    "/work/ws/site-packages/other/certifi/cacert.pem",
    "/work/ws/site-packages/certifi/cert.pem",
    // A credential-named directory above a bundle still denies it through its own pattern.
    "/work/ws/bad.pem/certifi/cacert.pem",
    "/work/ws/.ssh/certifi/cacert.pem",
    "/private/etc/ssl/cert.pem/child",
  ])("keeps denying %s", (path) => {
    expect(denied(path)).toBe(true);
  });

  it("leaves exactly the operator-named certificate files to the earlier rules, read-only", () => {
    expect(credentialPathSeatbeltRule()).toBe(CREDENTIAL_PATH_SEATBELT_RULE);
    expect(credentialPathSeatbeltRule([])).toBe(CREDENTIAL_PATH_SEATBELT_RULE);
    const files = ["/opt/corp/ca/corporate-ca.pem", "/opt/corp/ca/link.pem"];
    const rule = credentialPathSeatbeltRule(files);
    const literals = files.map((file) => `(literal ${JSON.stringify(file)})`).join(" ");
    const leaf = rule.split("(deny file-read* file-write* ")[4] ?? "";
    expect(leaf).toContain(`(require-not (require-any (regex `);
    expect(leaf.split("(require-not ")[1]).toContain(literals);
    expect(rule.endsWith(`(deny file-write* ${literals})`)).toBe(true);
    // Every other credential name, and every other `*.pem` file, keeps its rule.
    const { plain: otherPlain } = ruleRegexes(rule);
    expect(otherPlain.map((pattern) => String(pattern))).toEqual(
      plain.map((pattern) => String(pattern)),
    );
    expect(rule.replace(` ${literals}`, "").replace(`(deny file-write* ${literals})`, "")).toBe(
      CREDENTIAL_PATH_SEATBELT_RULE,
    );
  });
});
