import { describe, expect, it } from "vitest";
import {
  everyMavenRepositoryElement,
  resolveMavenRepositories,
} from "./mavenRepositoryCredentials.js";
import { parseXmlElements } from "./repositoryRelayXml.js";

// Values produced by the real Maven 3.10.0 on the development machine (mvn -emp / mvn -ep, run with a
// temporary HOME and -Dsettings.security pointing at a settings-security.xml holding the master
// below, the encryption of the test master password "test-master-pw"). Test-only passwords; each
// encryption carries its own random salt, so they differ. The vectors below decrypt only if the
// master was recovered from its own encryption.
const MASTER_ENCRYPTED = "{DeDtLcBk30UHo4dtOsLMX6PCV5BnMiVvgBASPsuo2+k=}";
const MAVEN_VECTORS: readonly { readonly plain: string; readonly encrypted: string }[] = [
  { plain: "repo-secret-1", encrypted: "{trqUC93rWTgH4tA1QYcjcalUwW591YAp6a+LwtFwMBw=}" },
  {
    plain: "abcdefghijklmnop",
    encrypted: "{toGl3rURlccHPWY1RClIaGGdFRz5owWRzsTEgA4fp+5fNJMn+l9zj3bwnC3Hnl7u}",
  },
  {
    plain: "p@ss{w}rd:é-ünï",
    encrypted: "{yemcQTfJra4HUrdD+AZrFpLhBurVmtcqDzKSh18a4eeADTZeUTNRfpQS8avu2jwO}",
  },
];
// Maven's own encryption of a one-character password; too short to be relayed.
const SHORT_ENCRYPTED = "{dsfqoL0iWAwHLeY7FhFoRYbyLIMrhuPCQN7arUlx9XE=}";
const SECURITY_XML = `<settingsSecurity><master>${MASTER_ENCRYPTED}</master></settingsSecurity>`;

function settings(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">${body}</settings>`;
}

function mirror(id = "internal", url = "https://repo.example.test/maven/", of = "*"): string {
  return `<mirrors><mirror><id>${id}</id><url>${url}</url><mirrorOf>${of}</mirrorOf></mirror></mirrors>`;
}

function server(id: string, username: string, password: string): string {
  return `<servers><server><id>${id}</id><username>${username}</username><password>${password}</password></server></servers>`;
}

const NO_ENV = {};

describe("resolveMavenRepositories environment boundary (B2)", () => {
  it("never interpolates a repository URL: its host is where the credential goes", () => {
    for (const url of ["${env.REPO_URL}", "https://${env.REPO_HOST}/m/", "${REPO_URL}"]) {
      const resolved = resolveMavenRepositories(
        settings(mirror("m", url) + server("m", "u", "password-0123456789")),
        undefined,
        { REPO_URL: "https://evil.example/", REPO_HOST: "evil.example" },
      );
      expect(resolved.repositories, url).toEqual([]);
      expect(resolved.refusals, url).toEqual({ "url-interpolated": 1 });
    }
  });

  it("does not read Keiko's own or a provider's environment into a credential", () => {
    for (const name of ["KEIKO_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      const resolved = resolveMavenRepositories(
        settings(mirror("m", "https://evil.example/") + server("m", "u", `\${env.${name}}`)),
        undefined,
        { [name]: "gateway-key-0123456789" },
      );
      expect(resolved.repositories, name).toEqual([]);
      expect(resolved.refusals, name).toEqual({ "env-unavailable": 1 });
    }
  });

  it("still reads a repository's own variables into its credential", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror("m") + server("m", "${env.NEXUS_USER}", "${env.NEXUS_PASSWORD}")),
      undefined,
      { NEXUS_USER: "builder", NEXUS_PASSWORD: "nexus-password-0123" },
    );
    expect(resolved.repositories[0]?.credential).toEqual({
      kind: "basic",
      username: "builder",
      password: "nexus-password-0123",
    });
  });
});

describe("resolveMavenRepositories", () => {
  it("resolves a mirror with the plain credential of the server with its id", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "builder", "plain-password-1")),
      undefined,
      NO_ENV,
    );
    expect(resolved.refusals).toEqual({});
    expect(resolved.repositories).toEqual([
      {
        ecosystem: "maven",
        source: "mirror",
        id: "internal",
        mirrorOf: "*",
        url: "https://repo.example.test/maven/",
        credential: { kind: "basic", username: "builder", password: "plain-password-1" },
      },
    ]);
  });

  it("matches credentials by id only and leaves a repository without a server anonymous", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror("internal") + server("another", "builder", "plain-password-1")),
      undefined,
      NO_ENV,
    );
    expect(resolved.repositories).toHaveLength(1);
    expect(resolved.repositories[0]?.credential).toBeUndefined();
  });

  it("resolves ${env.NAME} for the user name and the password", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "${env.REPO_USER}", "${env.REPO_PASS}")),
      undefined,
      { REPO_USER: "ci-user", REPO_PASS: "env-password-1" },
    );
    expect(resolved.repositories[0]?.credential).toEqual({
      kind: "basic",
      username: "ci-user",
      password: "env-password-1",
    });
  });

  it("leaves a repository out, by closed reason, when its variable is unset or another form", () => {
    const missing = resolveMavenRepositories(
      settings(mirror() + server("internal", "u", "${env.MISSING_VAR}")),
      undefined,
      NO_ENV,
    );
    expect(missing.repositories).toEqual([]);
    expect(missing.refusals).toEqual({ "env-unavailable": 1 });
    const other = resolveMavenRepositories(
      settings(mirror() + server("internal", "u", "${user.home}/secret")),
      undefined,
      { HOME: "x" },
    );
    expect(other.refusals).toEqual({ "interpolation-unsupported": 1 });
  });

  it.each(MAVEN_VECTORS)("decrypts a password the real Maven encrypted ($plain)", (vector) => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "builder", vector.encrypted)),
      SECURITY_XML,
      NO_ENV,
    );
    expect(resolved.refusals).toEqual({});
    expect(resolved.repositories[0]?.credential).toEqual({
      kind: "basic",
      username: "builder",
      password: vector.plain,
    });
  });

  it("refuses an encrypted password without a master, with a wrong master, or damaged", () => {
    const body = settings(mirror() + server("internal", "u", MAVEN_VECTORS[0]?.encrypted ?? ""));
    expect(resolveMavenRepositories(body, undefined, NO_ENV).refusals).toEqual({
      "encrypted-master-missing": 1,
    });
    const otherMaster =
      "<settingsSecurity><master>{w5rGGZ/3PlUHMXq62sqbjABx89tImtwPv6V9DhSo1VY=}</master></settingsSecurity>";
    expect(resolveMavenRepositories(body, otherMaster, NO_ENV).refusals).toEqual({
      "encrypted-decrypt-failed": 1,
    });
    const damaged = settings(
      mirror() + server("internal", "u", "{trqUC93rWTgH4tB1QYcjcalUwW591YAp6a+LwtFwMBw=}"),
    );
    expect(resolveMavenRepositories(damaged, SECURITY_XML, NO_ENV).refusals).toEqual({
      "encrypted-decrypt-failed": 1,
    });
  });

  it("does not relay a credential too short to be recognised in a response", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "u", SHORT_ENCRYPTED)),
      SECURITY_XML,
      NO_ENV,
    );
    expect(resolved.repositories).toEqual([]);
    expect(resolved.refusals).toEqual({ "credential-too-short": 1 });
  });

  it("refuses a server with a user name and no password", () => {
    const body = `<servers><server><id>internal</id><username>u</username></server></servers>`;
    expect(resolveMavenRepositories(settings(mirror() + body), undefined, NO_ENV).refusals).toEqual(
      {
        "credential-incomplete": 1,
      },
    );
  });

  it("reads the repositories of active profiles and activeByDefault profiles only", () => {
    const profiles = `<profiles>
      <profile><id>named</id><repositories><repository><id>r1</id><url>https://r1.example.test/m</url></repository></repositories></profile>
      <profile><id>default</id><activation><activeByDefault>true</activeByDefault></activation>
        <pluginRepositories><pluginRepository><id>p1</id><url>https://p1.example.test/m</url></pluginRepository></pluginRepositories></profile>
      <profile><id>idle</id><repositories><repository><id>r2</id><url>https://r2.example.test/m</url></repository></repositories></profile>
    </profiles><activeProfiles><activeProfile>named</activeProfile></activeProfiles>`;
    const resolved = resolveMavenRepositories(
      settings(profiles + server("r1", "u1", "password-for-r1")),
      undefined,
      NO_ENV,
    );
    expect(resolved.repositories.map((repository) => [repository.source, repository.id])).toEqual([
      ["repository", "r1"],
      ["plugin-repository", "p1"],
    ]);
    expect(resolved.repositories[0]?.credential).toMatchObject({ username: "u1" });
    expect(resolved.repositories[1]?.url).toBe("https://p1.example.test/m/");
  });

  it("refuses a document with a DOCTYPE or an entity, resolving nothing", () => {
    const doctype = `<!DOCTYPE settings [<!ENTITY x "y">]>${settings(mirror() + server("internal", "u", "plain-password-1"))}`;
    expect(resolveMavenRepositories(doctype, undefined, NO_ENV)).toEqual({
      repositories: [],
      refusals: { "document-refused": 1 },
    });
    const entity = settings(mirror() + server("internal", "u", "pass&custom;word"));
    expect(resolveMavenRepositories(entity, undefined, NO_ENV).repositories).toEqual([]);
    expect(resolveMavenRepositories("<not-settings/>", undefined, NO_ENV).refusals).toEqual({
      "document-refused": 1,
    });
    expect(resolveMavenRepositories("<settings><mirrors>", undefined, NO_ENV).refusals).toEqual({
      "document-refused": 1,
    });
  });

  it("decodes the predefined entities, numeric references and CDATA of a password", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "u", "<![CDATA[a<b]]>&amp;&#65;&#x42;-pass")),
      undefined,
      NO_ENV,
    );
    expect(resolved.repositories[0]?.credential).toMatchObject({ password: "a<b&AB-pass" });
  });

  it("refuses targets that are unsupported, carry user info, or are Keiko's own server", () => {
    const body = settings(
      mirror("a", "ftp://repo.example.test/m") +
        mirror("b", "https://user:pw@repo.example.test/m") +
        mirror("c", "http://127.0.0.1:1983/m") +
        mirror("d", "http://localhost:1983/m") +
        mirror("e", "https://repo.example.test/m?x=1") +
        mirror("f", "http://127.0.0.1:9999/m"),
    );
    const resolved = resolveMavenRepositories(body, undefined, NO_ENV, "http://127.0.0.1:1983");
    expect(resolved.repositories.map((repository) => repository.id)).toEqual(["f"]);
    expect(resolved.refusals).toEqual({
      "url-unsupported": 2,
      "url-userinfo": 1,
      "url-own-origin": 2,
    });
  });

  it("never puts a credential into its refusal counts", () => {
    const resolved = resolveMavenRepositories(
      settings(mirror() + server("internal", "u", "${env.SECRET_NAME_CANARY}")),
      undefined,
      NO_ENV,
    );
    expect(JSON.stringify(resolved)).not.toContain("SECRET_NAME_CANARY");
  });
});

describe("repositories of profiles that are not active (#4522)", () => {
  const PROFILES = `<profiles>
<profile><id>on</id><repositories><repository><id>a</id><url>https://a.example.test/</url></repository></repositories></profile>
<profile><id>default</id><activation><activeByDefault>true</activeByDefault></activation><repositories><repository><id>b</id><url>https://b.example.test/</url></repository></repositories></profile>
<profile><id>off</id><activation><activeByDefault>false</activeByDefault></activation>
<repositories><repository><id>c</id><url>https://c.example.test/</url></repository></repositories>
<pluginRepositories><pluginRepository><id>d</id><url>https://d.example.test/</url></pluginRepository></pluginRepositories></profile>
</profiles><activeProfiles><activeProfile>on</activeProfile></activeProfiles>`;

  it("relays the active ones and counts every repository of the others as profile-inactive", () => {
    const resolved = resolveMavenRepositories(settings(PROFILES), undefined, NO_ENV);
    expect(resolved.repositories.map((repository) => repository.id)).toEqual(["a", "b"]);
    expect(resolved.refusals).toEqual({ "profile-inactive": 2 });
  });

  it("names every mirror and profile repository, active or not, for the run binding", () => {
    const root = parseXmlElements(settings(mirror("m", "https://m.example.test/") + PROFILES));
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(everyMavenRepositoryElement(root).map((element) => element.id)).toEqual([
      "m",
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
