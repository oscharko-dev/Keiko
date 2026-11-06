import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  nativeBuildCacheAdmitted,
  prepareNativeBuildSettings,
  sanitizeGradleProperties,
  sanitizeMavenSettings,
  sanitizeNpmrc,
} from "./nativeBuildSettings.js";

const SETTINGS = `<?xml version="1.0"?>
<!-- corp settings -->
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <localRepository>/somewhere/else</localRepository>
  <servers>
    <server><id>corp</id><username>alice</username><password>hunter2-PLANTED</password></server>
  </servers>
  <mirrors>
    <mirror><id>corp</id><mirrorOf>*</mirrorOf><url>https://bob:s3cret-PLANTED@nexus.corp/repo</url></mirror>
  </mirrors>
  <proxies>
    <proxy><id>p</id><active>true</active><host>proxy.corp</host><port>3128</port><username>carol</username><password>pw-PLANTED</password></proxy>
  </proxies>
  <profiles>
    <profile><id>x</id><properties><deploy.token>tok-PLANTED</deploy.token><keep.me>yes</keep.me></properties></profile>
  </profiles>
  <interactiveMode>false</interactiveMode>
</settings>
`;

describe("sanitizeMavenSettings (#4271)", () => {
  it("keeps mirrors, proxies and profiles and removes every credential", () => {
    const result = sanitizeMavenSettings(SETTINGS, { offline: false });
    expect(result).toBeDefined();
    const xml = result?.xml ?? "";
    for (const planted of ["PLANTED", "alice", "carol", "bob", "<servers", "somewhere/else"]) {
      expect(xml).not.toContain(planted);
    }
    expect(xml).toContain("<url>https://nexus.corp/repo</url>");
    expect(xml).toContain("<host>proxy.corp</host>");
    expect(xml).toContain("<keep.me>yes</keep.me>");
    expect(xml).toContain("<offline>false</offline>");
    expect(xml).not.toContain("interactiveMode");
    expect(result?.strippedCount).toBeGreaterThanOrEqual(4);
  });

  it("binds the run's cache and offline state, not the user's", () => {
    const xml =
      sanitizeMavenSettings(SETTINGS, { offline: true, localRepository: "/home/u/.m2/repository" })
        ?.xml ?? "";
    expect(xml).toContain("<offline>true</offline>");
    expect(xml).toContain("<localRepository>/home/u/.m2/repository</localRepository>");
    expect(xml.match(/<localRepository>/gu)).toHaveLength(1);
  });

  it("admits nothing from a document it does not model", () => {
    for (const hostile of [
      "<!DOCTYPE settings><settings></settings>",
      "<settings><![CDATA[<password>x</password>]]></settings>",
      "<settings><mirrors>",
      "<settings><!-- open",
      "not xml",
    ]) {
      expect(sanitizeMavenSettings(hostile, { offline: false })).toBeUndefined();
    }
  });
});

describe("sanitizeNpmrc and sanitizeGradleProperties (#4271)", () => {
  it("keeps registry routing and drops tokens, passwords and interpolation", () => {
    const result = sanitizeNpmrc(
      [
        "registry=https://registry.corp/npm/",
        "@corp:registry=https://registry.corp/corp/",
        "//registry.corp/:_authToken=npm_PLANTED",
        "_auth=PLANTED",
        "_password=PLANTED",
        "strict-ssl=false",
        "proxy=http://user:pw-PLANTED@proxy.corp:3128",
        "cafile=${HOME}/ca.pem",
        "; comment",
      ].join("\n"),
    );
    expect(result.text).not.toContain("PLANTED");
    expect(result.text).toBe(
      "registry=https://registry.corp/npm/\n@corp:registry=https://registry.corp/corp/\nstrict-ssl=false\n",
    );
    expect(result.dropped).toBe(5);
  });

  it("keeps only proxy and daemon settings of gradle.properties", () => {
    const result = sanitizeGradleProperties(
      [
        "systemProp.https.proxyHost=proxy.corp",
        "systemProp.https.proxyPassword=PLANTED",
        "myRegistryPassword=PLANTED",
        "org.gradle.daemon=false",
        "org.gradle.java.home=/somewhere",
      ].join("\n"),
    );
    expect(result.text).toBe("systemProp.https.proxyHost=proxy.corp\norg.gradle.daemon=false\n");
  });
});

describe("prepareNativeBuildSettings (#4271)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(): { readonly realHome: string; readonly stateRoot: string } {
    const root = mkdtempSync(join(tmpdir(), "keiko-build-settings-"));
    created.push(root);
    const realHome = join(root, "real");
    mkdirSync(join(realHome, ".m2"), { recursive: true });
    mkdirSync(join(realHome, ".gradle"), { recursive: true });
    writeFileSync(join(realHome, ".m2", "settings.xml"), SETTINGS);
    writeFileSync(
      join(realHome, ".npmrc"),
      "registry=https://registry.corp/\n_authToken=PLANTED\n",
    );
    writeFileSync(join(realHome, ".gradle", "gradle.properties"), "org.gradle.daemon=false\n");
    return { realHome, stateRoot: join(root, "run") };
  }

  function sink(): { readonly sink: ServerLogSink; readonly events: ServerLogEvent[] } {
    const events: ServerLogEvent[] = [];
    return { sink: { write: (event) => void events.push(event) }, events };
  }

  it("writes sanitized copies into the private state and logs counts only", () => {
    const { realHome, stateRoot } = fixture();
    const log = sink();
    const result = prepareNativeBuildSettings({
      runId: "run-0001",
      mode: "supervised-coding",
      realHome,
      stateRoot,
      readOnlyMavenRepository: join(realHome, ".m2", "repository"),
      activityLog: log.sink,
    });
    const settings = readFileSync(join(stateRoot, "home", ".m2", "settings.xml"), "utf8");
    expect(settings).toContain("<offline>true</offline>");
    expect(settings).not.toContain("PLANTED");
    const userConfig = result.env.NPM_CONFIG_USERCONFIG ?? "";
    expect(userConfig.endsWith(".npmrc")).toBe(false);
    expect(readFileSync(userConfig, "utf8")).toBe("registry=https://registry.corp/\n");
    expect(readFileSync(join(stateRoot, "home", ".gradle", "gradle.properties"), "utf8")).toBe(
      "org.gradle.daemon=false\n",
    );
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      op: "coding-runtime.native-build-settings.admitted",
      correlationId: "run-0001",
    });
    expect(JSON.stringify(log.events[0])).not.toContain("PLANTED");
    expectActivityLogProof(
      "coding-runtime.native-build-settings.admitted.emitted-line",
      formatActivityLogProofLine(log.events[0] ?? {}),
    );
  });

  it("runs online with a private cache at Full access and tolerates absent files", () => {
    const { stateRoot } = fixture();
    const empty = join(stateRoot, "..", "nohome");
    mkdirSync(empty, { recursive: true });
    const result = prepareNativeBuildSettings({
      runId: "run-0002",
      mode: "autonomous-delivery",
      realHome: empty,
      stateRoot,
      activityLog: sink().sink,
    });
    expect(result.env).toEqual({});
    expect(result.mavenSettings).toBe("absent");
    expect(readFileSync(join(stateRoot, "home", ".m2", "settings.xml"), "utf8")).toContain(
      "<offline>false</offline>",
    );
    expect(nativeBuildCacheAdmitted("autonomous-delivery")).toBe(false);
    expect(nativeBuildCacheAdmitted("governed-assist")).toBe(true);
  });

  it("links the Maven wrapper's read-only distributions into the private home below Full access", () => {
    const { realHome, stateRoot } = fixture();
    const dists = join(realHome, ".m2", "wrapper", "dists");
    mkdirSync(join(dists, "apache-maven-3.9.9", "bin"), { recursive: true });
    writeFileSync(join(dists, "apache-maven-3.9.9", "bin", "mvn"), "");
    const log = sink();
    prepareNativeBuildSettings({
      runId: "run-0004",
      mode: "supervised-coding",
      realHome,
      stateRoot,
      readOnlyMavenWrapperDists: dists,
      activityLog: log.sink,
    });
    const link = join(stateRoot, "home", ".m2", "wrapper", "dists");
    expect(realpathSync(link)).toBe(realpathSync(dists));
    expect(existsSync(join(link, "apache-maven-3.9.9", "bin", "mvn"))).toBe(true);
    expect(log.events[0]?.extra).toMatchObject({ mavenCache: "none", mavenWrapper: "read-only" });
  });

  it("leaves the wrapper's distributions private at Full access", () => {
    const { realHome, stateRoot } = fixture();
    const log = sink();
    prepareNativeBuildSettings({
      runId: "run-0005",
      mode: "autonomous-delivery",
      realHome,
      stateRoot,
      activityLog: log.sink,
    });
    expect(existsSync(join(stateRoot, "home", ".m2", "wrapper"))).toBe(false);
    expect(log.events[0]?.extra).toMatchObject({ mavenCache: "private", mavenWrapper: "private" });
  });

  it("refuses an oversized or non-file settings source without throwing", () => {
    const { realHome, stateRoot } = fixture();
    writeFileSync(join(realHome, ".m2", "settings.xml"), "x".repeat(300_000));
    const result = prepareNativeBuildSettings({
      runId: "run-0003",
      mode: "supervised-coding",
      realHome,
      stateRoot,
      activityLog: sink().sink,
    });
    expect(result.mavenSettings).toBe("refused");
  });
});
