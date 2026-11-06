import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeBuildInheritedEnvNames,
  nativeBuildToolReadRoots,
} from "./native-toolchain-roots.js";

describe("native build-tool environment and roots (#4271)", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function tree(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-build-roots-")));
    created.push(root);
    return root;
  }

  function jdk(root: string, name: string): string {
    const home = join(root, "sdk", "candidates", name);
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "java"), "");
    return home;
  }

  it("admits a JAVA_HOME that is not on PATH, and nothing that is not a JDK", () => {
    const root = tree();
    const java = jdk(root, "java-21");
    const bogus = join(root, "elsewhere", "notajdk");
    mkdirSync(bogus, { recursive: true });
    const home = join(root, "home");
    expect(nativeBuildToolReadRoots({ JAVA_HOME: java, PATH: "" }, home)).toEqual([java]);
    expect(nativeBuildToolReadRoots({ JAVA_HOME: bogus, PATH: "" }, home)).toEqual([]);
    expect(nativeBuildToolReadRoots({ JAVA_HOME: "relative/jdk", PATH: "" }, home)).toEqual([]);
  });

  it("derives the JDK of the first java on PATH and never opens the user's home", () => {
    const root = tree();
    const java = jdk(root, "java-17");
    expect(nativeBuildToolReadRoots({ PATH: join(java, "bin") }, join(root, "home"))).toEqual([
      java,
    ]);
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "java"), "");
    expect(nativeBuildToolReadRoots({ JAVA_HOME: home, PATH: "" }, home)).toEqual([]);
  });

  it("admits the directory of an explicit certificate bundle", () => {
    const root = tree();
    mkdirSync(join(root, "certs"), { recursive: true });
    writeFileSync(join(root, "certs", "ca.pem"), "");
    expect(
      nativeBuildToolReadRoots(
        { SSL_CERT_FILE: join(root, "certs", "ca.pem") },
        join(root, "home"),
      ),
    ).toEqual([join(root, "certs")]);
  });

  it("passes the build names but withholds a value that carries a credential", () => {
    const names = nativeBuildInheritedEnvNames({
      JAVA_HOME: "/jdk",
      MAVEN_OPTS: "-Xmx2g",
      MAVEN_ARGS: "-B -ntp",
      GRADLE_OPTS: "-Dorg.gradle.daemon=false",
      HTTPS_PROXY: "http://proxy.corp:3128",
      https_proxy: "http://user:secret@proxy.corp:3128",
      NO_PROXY: "localhost,.corp",
      npm_config_registry: "https://registry.corp/npm/",
      NPM_CONFIG_REGISTRY: "https://tok:x@registry.corp/npm/",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      SSL_CERT_FILE: "/etc/ssl/ca.pem",
      HTTP_PROXY: "not a url ::::",
      PATH: "/usr/bin",
    });
    expect(names).toEqual(
      expect.arrayContaining([
        "JAVA_HOME",
        "MAVEN_OPTS",
        "MAVEN_ARGS",
        "GRADLE_OPTS",
        "HTTPS_PROXY",
        "NO_PROXY",
        "npm_config_registry",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
      ]),
    );
    expect(names).not.toContain("https_proxy");
    expect(names).not.toContain("NPM_CONFIG_REGISTRY");
    expect(names).not.toContain("HTTP_PROXY");
    expect(names).not.toContain("PATH");
    expect(nativeBuildInheritedEnvNames({ MAVEN_OPTS: "-Dpassword=hunter2" })).toEqual([]);
  });
});
