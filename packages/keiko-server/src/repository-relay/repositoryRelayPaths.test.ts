import { describe, expect, it } from "vitest";
import {
  admitRepositoryPath,
  REPOSITORY_PATH_MAX_CHARS,
  REPOSITORY_PATH_MAX_SEGMENTS,
} from "./repositoryRelayPaths.js";

describe("admitRepositoryPath (maven)", () => {
  it.each([
    ["org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar", "maven-binary"],
    ["org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom", "maven-text"],
    ["org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar.sha1", "maven-text"],
    ["org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.pom.asc", "maven-text"],
    ["org/apache/commons/commons-lang3/maven-metadata.xml", "maven-text"],
    ["com/example/lib/1.0-SNAPSHOT/lib-1.0-20240101.123456-1-sources.jar", "maven-binary"],
    ["com/example/lib/1.0.0+build.5/lib-1.0.0+build.5.module", "maven-text"],
    [".meta/prefixes.txt", "maven-text"],
  ] as const)("admits %s as %s", (path, kind) => {
    expect(admitRepositoryPath("maven", path)).toEqual({ ok: true, kind, upstreamPath: path });
  });

  it.each([
    ["a/../b/x.jar", "path-invalid"],
    ["a/./b/x.jar", "path-invalid"],
    ["../x.jar", "path-invalid"],
    ["a//b/x.jar", "path-invalid"],
    ["/a/b/x.jar", "path-invalid"],
    ["a/b/", "path-invalid"],
    ["", "path-invalid"],
    ["a%2Fb/x.jar", "path-invalid"],
    ["a/%2e%2e/x.jar", "path-invalid"],
    ["a/b/x%2ejar", "path-invalid"],
    ["a\\b\\x.jar", "path-invalid"],
    ["http://evil.example/x.jar", "path-invalid"],
    ["a/b:c/x.jar", "path-invalid"],
    ["a/b c/x.jar", "path-invalid"],
    ["a/b/x.jar?x=1", "path-invalid"],
    ["a/b/directory", "path-unsupported"],
    ["onlyfile.jar", "path-unsupported"],
  ] as const)("refuses %s as %s", (path, reason) => {
    expect(admitRepositoryPath("maven", path)).toEqual({ ok: false, reason });
  });

  it("bounds the length and the depth of a path", () => {
    const long = `${"a".repeat(REPOSITORY_PATH_MAX_CHARS)}.jar`;
    expect(admitRepositoryPath("maven", long)).toEqual({ ok: false, reason: "path-too-long" });
    const deep = `${Array.from({ length: REPOSITORY_PATH_MAX_SEGMENTS }, () => "a").join("/")}/x.jar`;
    expect(admitRepositoryPath("maven", deep)).toEqual({ ok: false, reason: "path-too-long" });
  });
});

describe("admitRepositoryPath (npm)", () => {
  it.each([
    ["left-pad", "left-pad"],
    ["@scope/name", "@scope%2Fname"],
    ["@scope%2fname", "@scope%2Fname"],
    ["@scope%2Fname", "@scope%2Fname"],
  ] as const)("admits the packument %s", (path, upstreamPath) => {
    expect(admitRepositoryPath("npm", path)).toEqual({
      ok: true,
      kind: "npm-packument",
      upstreamPath,
    });
  });

  it.each([
    "left-pad/-/left-pad-1.3.0.tgz",
    "@scope/name/-/name-1.0.0.tgz",
    "@scope/name/-/@scope/name-1.0.0.tgz",
  ])("admits the tarball %s", (path) => {
    expect(admitRepositoryPath("npm", path)).toEqual({
      ok: true,
      kind: "npm-tarball",
      upstreamPath: path,
    });
  });

  it.each([
    ["../left-pad", "path-invalid"],
    ["left-pad/../x", "path-invalid"],
    ["@scope%2f..%2fname", "path-unsupported"],
    ["@scope%2fname%2fmore", "path-unsupported"],
    ["%2e%2e", "path-invalid"],
    ["left-pad/%2e%2e/x", "path-invalid"],
    ["left-pad/extra", "path-unsupported"],
    ["-/ping", "path-unsupported"],
    ["-/v1/search", "path-unsupported"],
    ["left-pad/-/left-pad-1.3.0.zip", "path-unsupported"],
    ["left-pad/-/sub/left-pad-1.3.0.tgz", "path-unsupported"],
    ["left-pad/-/@x/y/left-pad-1.3.0.tgz", "path-unsupported"],
    ["@scope", "path-unsupported"],
    ["left_pad:x", "path-unsupported"],
    ["https://evil.example/left-pad", "path-invalid"],
    ["left-pad/extra/-/left-pad-1.3.0.tgz", "path-unsupported"],
  ] as const)("refuses %s as %s", (path, reason) => {
    expect(admitRepositoryPath("npm", path)).toEqual({ ok: false, reason });
  });

  // #4491: npm keeps a lockfile URL's path when it moves the URL onto the relay, so a tarball pinned
  // on a registry at `.../repository/npm-group/` arrives with that base path in front.
  describe("under the registry's own base path", () => {
    const base = "repository/npm-group/";

    it.each([
      ["repository/npm-group/left-pad/-/left-pad-1.3.0.tgz", "left-pad/-/left-pad-1.3.0.tgz"],
      ["repository/npm-group/@scope/name/-/name-1.0.0.tgz", "@scope/name/-/name-1.0.0.tgz"],
      [
        "repository/npm-group/@scope/name/-/@scope/name-1.0.0.tgz",
        "@scope/name/-/@scope/name-1.0.0.tgz",
      ],
    ])("admits the pinned tarball %s as %s", (path, upstreamPath) => {
      expect(admitRepositoryPath("npm", path, base)).toEqual({
        ok: true,
        kind: "npm-tarball",
        upstreamPath,
      });
      expect(admitRepositoryPath("npm", path)).toEqual({ ok: false, reason: "path-unsupported" });
    });

    it("still admits a path relative to the base, and nothing but a tarball under it", () => {
      expect(admitRepositoryPath("npm", "left-pad/-/left-pad-1.3.0.tgz", base)).toMatchObject({
        ok: true,
        upstreamPath: "left-pad/-/left-pad-1.3.0.tgz",
      });
      expect(admitRepositoryPath("npm", "left-pad", base)).toMatchObject({
        kind: "npm-packument",
      });
      for (const path of [
        "repository/npm-group/left-pad",
        "repository/npm-group/@scope%2fname",
        "repository/npm-group/left-pad/-/sub/left-pad-1.3.0.tgz",
        "repository/npm-other/left-pad/-/left-pad-1.3.0.tgz",
        "repository/npm-group/../left-pad/-/left-pad-1.3.0.tgz",
      ]) {
        expect(admitRepositoryPath("npm", path, base).ok).toBe(false);
      }
    });

    it("strips the base path once, for a package named like its first segment too", () => {
      expect(admitRepositoryPath("npm", "foo/foo/-/foo-1.0.0.tgz", "foo/")).toEqual({
        ok: true,
        kind: "npm-tarball",
        upstreamPath: "foo/-/foo-1.0.0.tgz",
      });
    });

    it("leaves a Maven path as it is", () => {
      expect(
        admitRepositoryPath("maven", "repository/maven/org/acme/a/1/a-1.pom", "repository/maven/"),
      ).toMatchObject({ ok: true, upstreamPath: "repository/maven/org/acme/a/1/a-1.pom" });
    });
  });
});
