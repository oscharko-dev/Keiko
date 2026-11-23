// #4492: the internal Maven repository the acceptance task plays on loopback. It must answer 401
// without the right login, serve the private fixture repository and a verified cache behind it, and
// refuse a cache that does not match its lock by naming the command that provisions it.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FUNCTIONAL_MAVEN_PASSWORD,
  FUNCTIONAL_MAVEN_USERNAME,
  mavenSettingsXml,
  startFunctionalMavenRepository,
  verifiedMavenCache,
  withPersonHome,
  type FunctionalMavenRepository,
} from "../test-support/functional-maven-repository.js";

const PARENT = "/com/example/acceptance/acceptance-parent/1.0.0/acceptance-parent-1.0.0.pom";
const CACHED = "/org/example/library/2.0/library-2.0.jar";
const RIGHT = `Basic ${Buffer.from(`${FUNCTIONAL_MAVEN_USERNAME}:${FUNCTIONAL_MAVEN_PASSWORD}`).toString("base64")}`;

const scratch: string[] = [];
const repositories: FunctionalMavenRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockOf(files: Readonly<Record<string, string>>): string {
  return JSON.stringify({ schemaVersion: 1, files });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A verified cache holding one jar, and the lock that matches it. */
function fixtureCache(): { readonly cache: string; readonly lock: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-maven-repository-"));
  scratch.push(root);
  const cache = join(root, "repository");
  mkdirSync(dirname(join(cache, CACHED)), { recursive: true });
  writeFileSync(join(cache, CACHED), "jar bytes");
  const lock = join(root, "lock.json");
  writeFileSync(lock, lockOf({ [CACHED.slice(1)]: sha256("jar bytes") }));
  return { cache, lock };
}

async function started(): Promise<{
  readonly repository: FunctionalMavenRepository;
  readonly cache: string;
}> {
  const { cache, lock } = fixtureCache();
  const repository = await startFunctionalMavenRepository(verifiedMavenCache(cache, lock));
  repositories.push(repository);
  return { repository, cache };
}

/** The status of a request whose path is sent exactly as given, which `fetch` would normalize. */
function rawStatus(url: string, path: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((settled, failed) => {
    get({ hostname, port, path, headers: { Authorization: RIGHT } }, (response) => {
      response.resume();
      settled(response.statusCode ?? 0);
    }).on("error", failed);
  });
}

describe("acceptance Maven repository (#4492)", () => {
  it("answers 401 with a Basic challenge to a request without or with a wrong login", async () => {
    const { repository } = await started();
    const anonymous = await fetch(`${repository.url}${PARENT}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Basic /u);
    const wrong = await fetch(`${repository.url}${PARENT}`, {
      headers: {
        Authorization: `Basic ${Buffer.from("acceptance-reader:nope").toString("base64")}`,
      },
    });
    expect(wrong.status).toBe(401);
    expect(repository.statusCounts()).toEqual({ "401": 2 });
  });

  it("serves the private parent POM and the cache with the right login, and counts by status", async () => {
    const { repository } = await started();
    const headers = { Authorization: RIGHT };
    const pom = await fetch(`${repository.url}${PARENT}`, { headers });
    expect(pom.status).toBe(200);
    expect(await pom.text()).toContain("<artifactId>acceptance-parent</artifactId>");
    const jar = await fetch(`${repository.url}${CACHED}`, { headers });
    expect(await jar.text()).toBe("jar bytes");
    const head = await fetch(`${repository.url}${CACHED}`, { method: "HEAD", headers });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const sha1 = await fetch(`${repository.url}${CACHED}.sha1`, { headers });
    expect(await sha1.text()).toBe(createHash("sha1").update("jar bytes").digest("hex"));
    expect(repository.statusCounts()).toEqual({ "200": 4 });
  });

  it("answers 404 for a missing file, a directory and a cache file the lock does not list", async () => {
    const { repository, cache } = await started();
    writeFileSync(join(cache, "unlisted.txt"), "not in the lock");
    const headers = { Authorization: RIGHT };
    for (const path of ["/missing.pom", "/org/example/", "/unlisted.txt"]) {
      const response = await fetch(`${repository.url}${path}`, { headers });
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  it("never serves a file outside its roots, however the path reaches it", async () => {
    const { repository, cache } = await started();
    // The repository's own package.json lies four levels above the private fixture root; the
    // fixture cache's lock lies one level above the cache. Both exist, so only the guard stops them.
    const outside = ["/../../../../package.json", "/../../../../../../../../package.json"];
    const encoded = [
      "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/package.json",
      "/..%2f..%2f..%2f..%2fpackage.json",
    ];
    const cacheEscape = ["/../lock.json", "/org/../../lock.json", "/%2e%2e/lock.json"];
    for (const path of [...outside, ...encoded, ...cacheEscape]) {
      expect([path, await rawStatus(repository.url, path)]).toEqual([path, 404]);
    }
    // Positive controls: the same helper reaches a legitimate file of each root.
    expect(await rawStatus(repository.url, PARENT)).toBe(200);
    expect(await rawStatus(repository.url, CACHED)).toBe(200);
    // A symbolic link in the cache never leads out of it.
    const lockOutside = join(cache, "..", "lock.json");
    symlinkSync(lockOutside, join(cache, "link.txt"));
    expect(await rawStatus(repository.url, "/link.txt")).toBe(404);
  });

  it("refuses a missing cache and a cache that differs from its lock, naming the command", () => {
    const { cache, lock } = fixtureCache();
    const command = "npm run provision:acceptance-maven";
    expect(() => verifiedMavenCache(join(cache, "absent"), lock)).toThrow(command);
    writeFileSync(join(cache, CACHED), "altered");
    expect(() => verifiedMavenCache(cache, lock)).toThrow(/acceptance-maven-cache-mismatch/u);
    writeFileSync(join(cache, CACHED), "jar bytes");
    writeFileSync(join(cache, "extra.jar"), "unlisted");
    expect(() => verifiedMavenCache(cache, lock)).toThrow(command);
    writeFileSync(lock, lockOf({ [CACHED.slice(1)]: sha256("jar bytes"), "gone.jar": "00" }));
    rmSync(join(cache, "extra.jar"));
    expect(() => verifiedMavenCache(cache, lock)).toThrow(command);
  });

  it("writes the login into the person's settings as a mirror with its server entry", () => {
    const xml = mavenSettingsXml({ url: "http://127.0.0.1:1", password: "a<b" });
    expect(xml).toContain("<mirrorOf>*</mirrorOf>");
    expect(xml).toContain("<password>a&lt;b</password>");
    expect(xml.match(/<id>acceptance-internal<\/id>/gu)).toHaveLength(2);
  });

  it("holds the person's home around the work only, and puts the real one back after a failure", async () => {
    const real = process.env.HOME;
    await expect(
      withPersonHome("/person/home", () => {
        expect(process.env.HOME).toBe("/person/home");
        return Promise.reject(new Error("work failed"));
      }),
    ).rejects.toThrow("work failed");
    expect(process.env.HOME).toBe(real);
  });
});
