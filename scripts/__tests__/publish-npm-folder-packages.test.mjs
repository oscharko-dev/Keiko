import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../lib/digest.mjs";
import { FOLDER_RELEASE_TARGETS, folderChecksumText } from "../lib/folder-package-release.mjs";
import {
  NpmFolderPublishRefusal,
  companionTag,
  expectedFileNames,
  parsePublishArgs,
  preflight,
  publish,
  releaseNotes,
  verifyNpmFolderAssets,
} from "../publish-npm-folder-packages.mjs";
import { CHECK_NAMES } from "../lib/npm-folder-qualification.mjs";
import { buildEvidence } from "../testing/qualify-npm-folder-package.mjs";

const VERSION = "1.5.3";
const COMMIT = "a".repeat(40);
const RUNNER = { os: "darwin", arch: "arm64", osRelease: "25.0.0" };
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function evidenceFor(target, zipSha256, overrides = {}) {
  return {
    ...buildEvidence({
      target,
      version: VERSION,
      archiveSha256: "c".repeat(64),
      zipSha256,
      runner: RUNNER,
      results: CHECK_NAMES.map((name) => ({ name, ok: true, durationMs: 1000 })),
    }),
    ...overrides,
  };
}

function artifactDir(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "keiko-npm-folder-publish-test-"));
  temporary.push(dir);
  for (const target of FOLDER_RELEASE_TARGETS) {
    const zip = `keiko-${target}.npm.zip`;
    const bytes = `zip bytes of ${target}`;
    writeFileSync(join(dir, zip), bytes);
    writeFileSync(join(dir, `${zip}.sha256`), folderChecksumText(sha256(bytes), zip));
    const evidence = evidenceFor(target, sha256(bytes));
    writeFileSync(join(dir, `keiko-${target}.npm.evidence.json`), JSON.stringify(evidence));
  }
  mutate?.(dir);
  return dir;
}

describe("companionTag", () => {
  it("names the prerelease after the version and refuses anything else", () => {
    expect(companionTag("1.5.3")).toBe("npm-folder-1.5.3");
    expect(() => companionTag("v1.5.3")).toThrow(NpmFolderPublishRefusal);
    expect(() => companionTag("1.5")).toThrow(/x\.y\.z/u);
  });
});

describe("verifyNpmFolderAssets", () => {
  it("accepts exactly the tested ZIPs of the three targets", () => {
    const packages = verifyNpmFolderAssets({ dir: artifactDir(), version: VERSION });
    expect(packages.map((p) => p.zip)).toEqual(
      FOLDER_RELEASE_TARGETS.map((target) => `keiko-${target}.npm.zip`),
    );
    expect(packages[0].zipSha256).toBe(sha256("zip bytes of macos-arm64"));
  });

  it("holds exactly the expected files", () => {
    expect(expectedFileNames()).toHaveLength(9);
    const dir = artifactDir((d) => writeFileSync(join(d, "extra.txt"), "x"));
    expect(() => verifyNpmFolderAssets({ dir, version: VERSION })).toThrow(/expected/u);
  });

  it("refuses a ZIP whose bytes are not the ones the leg tested", () => {
    const dir = artifactDir((d) => writeFileSync(join(d, "keiko-macos-x64.npm.zip"), "swapped"));
    expect(() => verifyNpmFolderAssets({ dir, version: VERSION })).toThrow(
      /does not describe the bytes/u,
    );
  });

  it("refuses evidence of other bytes even when the checksum file matches", () => {
    const dir = artifactDir((d) => {
      const zip = "keiko-windows-x64.npm.zip";
      writeFileSync(join(d, zip), "swapped");
      writeFileSync(join(d, `${zip}.sha256`), folderChecksumText(sha256("swapped"), zip));
    });
    expect(() => verifyNpmFolderAssets({ dir, version: VERSION })).toThrow(
      /tested bytes differ from uploaded bytes/u,
    );
  });

  it("refuses a failed leg, a missing check, another version and another target", () => {
    const rewrite = (target, change) => (d) => {
      const path = join(d, `keiko-${target}.npm.evidence.json`);
      const zipSha256 = sha256(`zip bytes of ${target}`);
      writeFileSync(path, JSON.stringify(evidenceFor(target, zipSha256, change)));
    };
    const cases = [
      [rewrite("macos-arm64", { passed: false }), /passed/u],
      [rewrite("macos-arm64", { checks: [] }), /did not pass/u],
      [rewrite("macos-arm64", { version: "1.5.2" }), /version/u],
      [rewrite("macos-arm64", { target: "macos-x64" }), /target/u],
    ];
    for (const [mutate, message] of cases) {
      expect(() => verifyNpmFolderAssets({ dir: artifactDir(mutate), version: VERSION })).toThrow(
        message,
      );
    }
  });
});

describe("releaseNotes", () => {
  it("states the form, the verification, the download mark and that it grants no update trust", () => {
    const packages = verifyNpmFolderAssets({ dir: artifactDir(), version: VERSION });
    const notes = releaseNotes({ version: VERSION, packages });
    expect(notes).toContain("npm folder packages for Keiko 1.5.3");
    expect(notes).toContain("docs/release/standalone-npm-package.md");
    expect(notes).toContain("gh attestation verify");
    expect(notes).toContain("download mark");
    expect(notes).toContain("grants no update trust");
    for (const target of FOLDER_RELEASE_TARGETS) expect(notes).toContain(`\`${target}\``);
    expect(notes).toContain(sha256("zip bytes of macos-arm64"));
  });
});

describe("parsePublishArgs", () => {
  it("parses a mode and flags and refuses the rest", () => {
    expect(parsePublishArgs(["verify", "--version", "1.5.3", "--dir", "d"]).dir).toBe("d");
    expect(() => parsePublishArgs(["upload", "--version", "1.5.3"])).toThrow(/first argument/u);
    expect(() => parsePublishArgs(["verify"])).toThrow(/--version is required/u);
    expect(() => parsePublishArgs(["verify", "--bogus", "x"])).toThrow(/unknown argument/u);
  });
});

// `draftState` answers the one question asked after a failure, whether the release is still a
// draft: a JSON text, or `null` for a view that fails. `editStatus` is the exit of the publishing
// edit.
function fakeGh({
  listed = [],
  gitRef = 1,
  productDraft = false,
  uploaded,
  draftState = JSON.stringify({ isDraft: true }),
  editStatus = 0,
} = {}) {
  const calls = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const failed = { status: 1, stdout: "", stderr: "HTTP 502" };
  const routes = [
    [(a) => a[1] === "list", () => ok(JSON.stringify(listed))],
    [(a) => a[1] === "edit", () => (editStatus === 0 ? ok() : failed)],
    [
      (a) => a[1] === "view" && a.at(-1) === "isDraft",
      () => (draftState === null ? failed : ok(draftState)),
    ],
    [
      (a) => a[0] === "api" && a[1].includes("/git/ref/tags/"),
      () => ({ status: gitRef, stdout: "", stderr: "" }),
    ],
    [(a) => a[0] === "api", () => ok(`${COMMIT}\n`)],
    [
      (a) => a[1] === "view" && a.includes("assets"),
      () => ok(JSON.stringify({ assets: uploaded?.() ?? [] })),
    ],
    [
      (a) => a[1] === "view" && a.includes("isDraft,tagName"),
      () => ok(JSON.stringify({ isDraft: productDraft, tagName: "v1.5.3" })),
    ],
    [
      (a) => a[1] === "view",
      () => ok(JSON.stringify({ isDraft: false, isPrerelease: true, tagName: "npm-folder-1.5.3" })),
    ],
  ];
  const runner = (args) => {
    calls.push(args);
    const route = routes.find(([matches]) => matches(args));
    return route === undefined ? ok() : route[1]();
  };
  return { runner, calls };
}

describe("preflight", () => {
  it("returns the product release's commit when the companion is free", () => {
    const { runner } = fakeGh();
    expect(preflight({ version: VERSION, repository: "o/r", runner })).toEqual({
      tag: "npm-folder-1.5.3",
      commit: COMMIT,
    });
  });

  it("refuses an existing companion release or tag, and an unpublished product release", () => {
    const listed = [{ tagName: "npm-folder-1.5.3" }];
    expect(() =>
      preflight({ version: VERSION, repository: "o/r", runner: fakeGh({ listed }).runner }),
    ).toThrow(/already exists/u);
    expect(() =>
      preflight({ version: VERSION, repository: "o/r", runner: fakeGh({ gitRef: 0 }).runner }),
    ).toThrow(/already exists/u);
    expect(() =>
      preflight({
        version: VERSION,
        repository: "o/r",
        runner: fakeGh({ productDraft: true }).runner,
      }),
    ).toThrow(/not published/u);
  });
});

describe("publish", () => {
  function inputs(extra = {}) {
    const dir = artifactDir();
    const packages = verifyNpmFolderAssets({ dir, version: VERSION });
    const assets = packages.flatMap((p) => [
      { name: p.zip, size: p.sizeBytes, digest: `sha256:${p.zipSha256}` },
      { name: p.sha, size: 99 },
    ]);
    return { dir, assets, ...extra };
  }

  it("creates a draft prerelease on the commit, uploads, checks and publishes it, never latest", () => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets });
    const result = publish({
      version: VERSION,
      commit: COMMIT,
      dir,
      notesPath: "notes.md",
      repository: "o/r",
      runner,
    });
    expect(result.tag).toBe("npm-folder-1.5.3");
    const create = calls.find((c) => c[1] === "create");
    expect(create).toEqual(
      expect.arrayContaining(["--draft", "--prerelease", "--latest=false", "--target", COMMIT]),
    );
    const edit = calls.find((c) => c[1] === "edit");
    expect(edit).toEqual(
      expect.arrayContaining(["--draft=false", "--prerelease", "--latest=false"]),
    );
    expect(calls.findIndex((c) => c[1] === "upload")).toBeLessThan(
      calls.findIndex((c) => c[1] === "edit"),
    );
  });

  it("removes the draft and never publishes when GitHub holds other bytes", () => {
    const { dir, assets } = inputs();
    const wrong = assets.map((a) =>
      a.digest === undefined ? a : { ...a, digest: `sha256:${"0".repeat(64)}` },
    );
    const { runner, calls } = fakeGh({ uploaded: () => wrong });
    expect(() =>
      publish({
        version: VERSION,
        commit: COMMIT,
        dir,
        notesPath: "n.md",
        repository: "o/r",
        runner,
      }),
    ).toThrow(/another digest/u);
    expect(calls.some((c) => c[1] === "edit")).toBe(false);
    expect(calls.some((c) => c[1] === "delete")).toBe(true);
  });

  // A failed call does not prove the release is still a draft: GitHub may have published it before
  // the answer was lost. Only a release GitHub itself reports as a draft is removed.
  it.each([
    [
      "GitHub published it although the edit reported a failure",
      JSON.stringify({ isDraft: false }),
    ],
    ["its state cannot be read", null],
    ["its state is not JSON", "not json"],
  ])("never deletes a release when %s", (_title, draftState) => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, editStatus: 1, draftState });
    expect(() =>
      publish({
        version: VERSION,
        commit: COMMIT,
        dir,
        notesPath: "n.md",
        repository: "o/r",
        runner,
      }),
    ).toThrow(/gh release edit failed/u);
    expect(calls.some((c) => c[1] === "delete")).toBe(false);
  });

  it("removes the draft when the publishing edit failed and GitHub still reports a draft", () => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, editStatus: 1 });
    expect(() =>
      publish({
        version: VERSION,
        commit: COMMIT,
        dir,
        notesPath: "n.md",
        repository: "o/r",
        runner,
      }),
    ).toThrow(/gh release edit failed/u);
    expect(calls.some((c) => c[1] === "delete")).toBe(true);
  });

  it("refuses an existing release and a commit that is not a full sha", () => {
    const { dir } = inputs();
    const listed = [{ tagName: "npm-folder-1.5.3" }];
    const base = { version: VERSION, dir, notesPath: "n.md", repository: "o/r" };
    expect(() => publish({ ...base, commit: COMMIT, runner: fakeGh({ listed }).runner })).toThrow(
      /already exists/u,
    );
    expect(() => publish({ ...base, commit: "abc", runner: fakeGh().runner })).toThrow(
      /full commit/u,
    );
  });
});
