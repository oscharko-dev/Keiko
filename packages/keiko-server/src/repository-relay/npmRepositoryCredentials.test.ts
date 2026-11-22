import { describe, expect, it } from "vitest";
import { resolveNpmRegistries } from "./npmRepositoryCredentials.js";

// Assembled at runtime so the secret scan of this tree sees no token-shaped literal.
const FIXTURE_TOKEN = ["tok", "0123456789"].join("-");

const NO_ENV = {};
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("resolveNpmRegistries", () => {
  it("resolves the registry and the bearer token scoped to its path", () => {
    const resolved = resolveNpmRegistries(
      [
        "registry=https://npm.example.test/repository/npm/",
        "//npm.example.test/repository/npm/:_authToken=npm-token-0123456789",
      ].join("\n"),
      NO_ENV,
    );
    expect(resolved.refusals).toEqual({});
    expect(resolved.repositories).toEqual([
      {
        ecosystem: "npm",
        source: "registry",
        url: "https://npm.example.test/repository/npm/",
        credential: { kind: "bearer", token: "npm-token-0123456789" },
      },
    ]);
  });

  it("resolves scoped registries and walks up to the nearest parent path for the auth key", () => {
    const resolved = resolveNpmRegistries(
      [
        "@acme:registry=https://npm.example.test/repository/acme/",
        "//npm.example.test/:_authToken=parent-token-0123456",
      ].join("\n"),
      NO_ENV,
    );
    expect(resolved.repositories).toEqual([
      {
        ecosystem: "npm",
        source: "scoped-registry",
        scope: "@acme",
        url: "https://npm.example.test/repository/acme/",
        credential: { kind: "bearer", token: "parent-token-0123456" },
      },
    ]);
  });

  it("prefers the auth key of the registry's own path over a parent path", () => {
    const resolved = resolveNpmRegistries(
      [
        "registry=https://npm.example.test/a/b/",
        "//npm.example.test/:_authToken=parent-token-0123456",
        "//npm.example.test/a/b/:_authToken=own-path-token-0123",
      ].join("\n"),
      NO_ENV,
    );
    expect(resolved.repositories[0]?.credential).toEqual({
      kind: "bearer",
      token: "own-path-token-0123",
    });
  });

  it("resolves _auth and username with _password as Basic credentials", () => {
    const viaAuth = resolveNpmRegistries(
      [
        "registry=https://npm.example.test/",
        `//npm.example.test/:_auth=${b64("builder:basic-password-1")}`,
      ].join("\n"),
      NO_ENV,
    );
    expect(viaAuth.repositories[0]?.credential).toEqual({
      kind: "basic",
      username: "builder",
      password: "basic-password-1",
    });
    const viaPassword = resolveNpmRegistries(
      [
        "registry=https://npm.example.test/",
        "//npm.example.test/:username=builder",
        `//npm.example.test/:_password=${b64("split-password-1")}`,
      ].join("\n"),
      NO_ENV,
    );
    expect(viaPassword.repositories[0]?.credential).toEqual({
      kind: "basic",
      username: "builder",
      password: "split-password-1",
    });
  });

  it("interpolates ${NAME} from the environment, as npm does", () => {
    const resolved = resolveNpmRegistries(
      [
        "registry=https://npm.example.test/",
        "//npm.example.test/:_authToken=${NPM_TOKEN}",
        "; a comment",
        "# another comment",
      ].join("\n"),
      { NPM_TOKEN: "token-from-env-0123" },
    );
    expect(resolved.repositories[0]).toMatchObject({
      url: "https://npm.example.test/",
      credential: { kind: "bearer", token: "token-from-env-0123" },
    });
  });

  it("never interpolates a registry URL: its host is where the credential goes (B2)", () => {
    const resolved = resolveNpmRegistries(
      `registry=\${NPM_REGISTRY}\n@a:registry=https://\${HOST_NAME}/x/\n//evil.example/:_authToken=${FIXTURE_TOKEN}`,
      { NPM_REGISTRY: "https://evil.example/", HOST_NAME: "evil.example" },
    );
    expect(resolved.repositories).toEqual([]);
    expect(resolved.refusals).toEqual({ "url-interpolated": 2 });
  });

  it("does not read Keiko's own or a provider's environment into a credential (B2)", () => {
    const rc = (name: string): string =>
      `registry=https://evil.example/\n//evil.example/:_authToken=\${${name}}`;
    for (const name of [
      "KEIKO_GATEWAY_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "AZURE_OPENAI_KEY",
      "LITELLM_MASTER_KEY",
    ]) {
      const resolved = resolveNpmRegistries(rc(name), { [name]: "gateway-key-0123456789" });
      expect(resolved.repositories, name).toEqual([]);
      expect(resolved.refusals, name).toEqual({ "env-unavailable": 1 });
    }
    const own = resolveNpmRegistries(rc("NEXUS_TOKEN"), { NEXUS_TOKEN: "nexus-token-0123456789" });
    expect(own.repositories[0]?.credential).toEqual({
      kind: "bearer",
      token: "nexus-token-0123456789",
    });
  });

  it("leaves a registry out, by closed reason, for a missing variable or an unsupported form", () => {
    const missing = resolveNpmRegistries(
      "registry=https://npm.example.test/\n//npm.example.test/:_authToken=${NOPE}",
      NO_ENV,
    );
    expect(missing.repositories).toEqual([]);
    expect(missing.refusals).toEqual({ "env-unavailable": 1 });
    const unsupported = resolveNpmRegistries(
      "registry=https://npm.example.test/\n//npm.example.test/:_authToken=${NOPE?}",
      NO_ENV,
    );
    expect(unsupported.refusals).toEqual({ "interpolation-unsupported": 1 });
  });

  it("refuses incomplete or too short credentials", () => {
    const incomplete = resolveNpmRegistries(
      "registry=https://npm.example.test/\n//npm.example.test/:username=builder",
      NO_ENV,
    );
    expect(incomplete.refusals).toEqual({ "credential-incomplete": 1 });
    const short = resolveNpmRegistries(
      "registry=https://npm.example.test/\n//npm.example.test/:_authToken=short",
      NO_ENV,
    );
    expect(short.refusals).toEqual({ "credential-too-short": 1 });
  });

  it("serves an anonymous registry without a credential", () => {
    const resolved = resolveNpmRegistries("registry=https://npm.example.test/", NO_ENV);
    expect(resolved.repositories).toHaveLength(1);
    expect(resolved.repositories[0]?.credential).toBeUndefined();
  });

  it("refuses non-http targets, user info and Keiko's own origin", () => {
    const resolved = resolveNpmRegistries(
      [
        "registry=file:///tmp/registry",
        "@a:registry=https://u:p@npm.example.test/",
        "@b:registry=http://localhost:1983/",
        "@c:registry=http://127.0.0.1:4873/",
      ].join("\n"),
      NO_ENV,
      "http://127.0.0.1:1983",
    );
    expect(resolved.repositories.map((repository) => repository.scope)).toEqual(["@c"]);
    expect(resolved.refusals).toEqual({
      "url-unsupported": 1,
      "url-userinfo": 1,
      "url-own-origin": 1,
    });
  });
});
