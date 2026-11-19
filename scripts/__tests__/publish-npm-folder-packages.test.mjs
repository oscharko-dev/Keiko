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

const RELEASE_ID = 4242;
const TAG = "npm-folder-1.5.3";

// A stateful stand-in for `gh`. The release is a draft until the PATCH succeeds. `draftState` answers
// the read after a failed publishing edit (a JSON text, or `null` for a read that fails);
// `finalRead` shapes the read after publication ("ok", "fail" or "wrong").
const FAKE_GH_DEFAULTS = Object.freeze({
  listed: [],
  gitRef: { status: 1, stderr: "gh: Not Found (HTTP 404)" },
  productDraft: false,
  uploaded: undefined,
  createStatus: 0,
  createBody: undefined,
  draftState: JSON.stringify({ draft: true }),
  editStatus: 0,
  uploadStatus: 0,
  uploadMisses: 0,
  deleteStatus: 0,
  finalRead: "ok",
});

function fakeGh(options = {}) {
  const { listed, gitRef, productDraft, uploaded, createStatus, createBody } = {
    ...FAKE_GH_DEFAULTS,
    ...options,
  };
  const { draftState, editStatus, uploadStatus, uploadMisses, deleteStatus, finalRead } = {
    ...FAKE_GH_DEFAULTS,
    ...options,
  };
  const calls = [];
  const state = { published: false, editFailed: false, uploadAttempts: 0 };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const failed = { status: 1, stdout: "", stderr: "HTTP 502" };
  const has = (args, word) => args.includes(word);
  // `uploadMisses` attempts fail first (the listing has not caught up), then `uploadStatus` decides.
  const upload = () => {
    state.uploadAttempts += 1;
    return state.uploadAttempts > uploadMisses && uploadStatus === 0 ? ok() : failed;
  };
  const created = () =>
    createStatus === 0
      ? ok(createBody ?? JSON.stringify({ id: RELEASE_ID, tag_name: TAG, draft: true }))
      : failed;
  const read = () => {
    if (state.published) {
      if (finalRead === "fail") return failed;
      const wrong = finalRead === "wrong";
      return ok(JSON.stringify({ draft: false, prerelease: !wrong, tag_name: TAG }));
    }
    if (state.editFailed) return draftState === null ? failed : ok(draftState);
    return ok(JSON.stringify({ draft: true, assets: uploaded?.() ?? [] }));
  };
  const patch = () => {
    state.editFailed = editStatus !== 0;
    state.published = editStatus === 0;
    return editStatus === 0 ? ok() : failed;
  };
  const routes = [
    [(a) => a[1] === "list", () => ok(JSON.stringify(listed))],
    [
      (a) => a[0] === "release" && a[1] === "view",
      () => ok(JSON.stringify({ isDraft: productDraft })),
    ],
    [(a) => a[0] === "api" && a[1].includes("/commits/"), () => ok(`${COMMIT}\n`)],
    [(a) => a[0] === "api" && a[1].includes("/git/ref/tags/"), () => ({ stdout: "", ...gitRef })],
    [(a) => a[0] === "release" && a[1] === "upload", upload],
    [(a) => has(a, "POST"), created],
    [(a) => has(a, "PATCH"), patch],
    [(a) => has(a, "DELETE"), () => (deleteStatus === 0 ? ok() : failed)],
    [(a) => a[0] === "api", read],
  ];
  const runner = (args) => {
    calls.push(args);
    const route = routes.find(([matches]) => matches(args));
    return route === undefined ? ok() : route[1]();
  };
  return { runner, calls };
}

const isCall = (word) => (call) => call.includes(word);
const isUpload = (call) => call[0] === "release" && call[1] === "upload";

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
      preflight({
        version: VERSION,
        repository: "o/r",
        runner: fakeGh({ gitRef: { status: 0, stderr: "" } }).runner,
      }),
    ).toThrow(/already exists/u);
    expect(() =>
      preflight({
        version: VERSION,
        repository: "o/r",
        runner: fakeGh({ productDraft: true }).runner,
      }),
    ).toThrow(/not published/u);
  });

  it("reads an API error as unknown, never as an absent tag", () => {
    const gitRef = { status: 1, stderr: "gh: Bad Gateway (HTTP 502)" };
    expect(() =>
      preflight({ version: VERSION, repository: "o/r", runner: fakeGh({ gitRef }).runner }),
    ).toThrow(/could not be checked/u);
  });

  it("tells a leftover draft of an earlier failed run from a published release", () => {
    const listed = [{ tagName: TAG, isDraft: true }];
    const attempt = () =>
      preflight({ version: VERSION, repository: "o/r", runner: fakeGh({ listed }).runner });
    expect(attempt).toThrow(/unpublished DRAFT/u);
    expect(attempt).toThrow(/gh release delete npm-folder-1\.5\.3 --repo o\/r --yes/u);
    expect(attempt).not.toThrow(/immutable/u);
  });
});

describe("publish", () => {
  function inputs(extra = {}) {
    const dir = artifactDir();
    const packages = verifyNpmFolderAssets({ dir, version: VERSION });
    const assets = packages.flatMap((p) => [
      { name: p.zip, size: p.sizeBytes, digest: `sha256:${p.zipSha256}` },
      { name: p.sha, size: p.shaSizeBytes, digest: `sha256:${p.shaSha256}` },
    ]);
    return { dir, assets, ...extra };
  }

  const run = (dir, runner, sleep = () => undefined) =>
    publish({
      version: VERSION,
      commit: COMMIT,
      dir,
      notesPath: "n.md",
      repository: "o/r",
      runner,
      sleep,
    });

  it("creates a draft prerelease on the commit, uploads, checks and publishes it, never latest", () => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets });
    expect(run(dir, runner).tag).toBe(TAG);
    const create = calls.find((c) => isCall("tag_name=npm-folder-1.5.3")(c));
    expect(create).toEqual(
      expect.arrayContaining(["draft=true", "prerelease=true", "make_latest=false"]),
    );
    expect(create).toEqual(expect.arrayContaining([`target_commitish=${COMMIT}`]));
    const edit = calls.find(isCall("PATCH"));
    expect(edit).toEqual(
      expect.arrayContaining([
        `repos/o/r/releases/${RELEASE_ID}`,
        "draft=false",
        "prerelease=true",
        "make_latest=false",
      ]),
    );
    // One upload with gh's own command, as the product release uploads into its draft: the tag, the
    // six files, and --clobber so that a repeated attempt replaces instead of duplicating.
    const uploads = calls.filter(isUpload);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].slice(0, 6)).toEqual([
      "release",
      "upload",
      TAG,
      "--repo",
      "o/r",
      "--clobber",
    ]);
    expect(uploads[0].slice(6).map((file) => file.slice(dir.length + 1))).toEqual(
      assets.map((asset) => asset.name),
    );
    expect(calls.findLastIndex(isUpload)).toBeLessThan(calls.findIndex(isCall("PATCH")));
  });

  // gh finds a draft through the release listing, which lagged behind a create once. A first miss
  // is retried within a fixed bound instead of failing a publication that would have worked.
  it("retries an upload that missed the new draft, within a fixed bound", () => {
    const { dir, assets } = inputs();
    const waits = [];
    const { runner, calls } = fakeGh({ uploaded: () => assets, uploadMisses: 2 });
    expect(run(dir, runner, (milliseconds) => waits.push(milliseconds)).tag).toBe(TAG);
    expect(calls.filter(isUpload)).toHaveLength(3);
    expect(waits).toEqual([5_000, 15_000]);
    expect(calls.some(isCall("DELETE"))).toBe(false);
  });

  it("verifies and publishes by the id from the create answer, with no second listing", () => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, listed: [] });
    run(dir, runner);
    const listings = calls.filter((c) => c[1] === "list");
    expect(listings).toHaveLength(1);
    expect(calls.some((c) => c[1] === `repos/o/r/releases/${RELEASE_ID}`)).toBe(true);
  });

  it("removes the draft and never publishes when GitHub holds other bytes", () => {
    const { dir, assets } = inputs();
    const wrong = assets.map((a) => ({ ...a, digest: `sha256:${"0".repeat(64)}` }));
    const { runner, calls } = fakeGh({ uploaded: () => wrong });
    expect(() => run(dir, runner)).toThrow(/does not carry the bytes/u);
    expect(calls.some(isCall("PATCH"))).toBe(false);
    expect(calls.some(isCall("DELETE"))).toBe(true);
  });

  it("refuses a ZIP whose digest GitHub does not report", () => {
    const { dir, assets } = inputs();
    const bare = assets.map((a, i) => (i === 0 ? { name: a.name, size: a.size } : a));
    const { runner, calls } = fakeGh({ uploaded: () => bare });
    expect(() => run(dir, runner)).toThrow(/has no SHA-256 digest on GitHub/u);
    expect(calls.some(isCall("PATCH"))).toBe(false);
  });

  it.each([
    ["has no digest", (a) => ({ name: a.name, size: a.size }), /has no SHA-256 digest/u],
    [
      "has another digest",
      (a) => ({ ...a, digest: `sha256:${"1".repeat(64)}` }),
      /does not carry/u,
    ],
    ["has another size", (a) => ({ ...a, size: a.size + 1 }), /another size/u],
  ])("compares every .sha256 asset by size and digest: %s", (_title, change, message) => {
    const { dir, assets } = inputs();
    const changed = assets.map((a) => (a.name.endsWith(".sha256") ? change(a) : a));
    const { runner, calls } = fakeGh({ uploaded: () => changed });
    expect(() => run(dir, runner)).toThrow(message);
    expect(calls.some(isCall("PATCH"))).toBe(false);
  });

  // A failed call does not prove the release is still a draft: GitHub may have published it before
  // the answer was lost. Only a release GitHub itself reports as a draft is removed.
  it.each([
    ["GitHub published it although the edit reported a failure", JSON.stringify({ draft: false })],
    ["its state cannot be read", null],
    ["its state is not JSON", "not json"],
  ])("never deletes a release when %s", (_title, draftState) => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, editStatus: 1, draftState });
    expect(() => run(dir, runner)).toThrow(/gh release edit failed/u);
    expect(calls.some(isCall("DELETE"))).toBe(false);
    expect(() =>
      run(dir, fakeGh({ uploaded: () => assets, editStatus: 1, draftState }).runner),
    ).toThrow(/kept because GitHub does not report it as a draft/u);
  });

  it("removes the draft when the publishing edit failed and GitHub still reports a draft", () => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, editStatus: 1 });
    expect(() => run(dir, runner)).toThrow(/gh release edit failed.*the draft was removed/u);
    expect(calls.some(isCall("DELETE"))).toBe(true);
  });

  it("removes the draft when the upload fails every attempt, and says so", () => {
    const { dir } = inputs();
    const { runner, calls } = fakeGh({ uploadStatus: 1 });
    expect(() => run(dir, runner)).toThrow(/release upload failed.*the draft was removed/u);
    expect(calls.filter(isUpload)).toHaveLength(3);
    expect(calls.some(isCall("PATCH"))).toBe(false);
    expect(calls.some(isCall("DELETE"))).toBe(true);
  });

  it("reports a delete that failed", () => {
    const { dir } = inputs();
    const { runner } = fakeGh({ uploadStatus: 1, deleteStatus: 1 });
    expect(() => run(dir, runner)).toThrow(/could not be removed.*delete it by hand/u);
  });

  it("names a failed create call and does not guess an id", () => {
    const { dir } = inputs();
    const { runner, calls } = fakeGh({ createStatus: 1 });
    expect(() => run(dir, runner)).toThrow(/gh release create failed.*may exist/u);
    expect(calls.some(isCall("DELETE"))).toBe(false);
    expect(calls.some(isUpload)).toBe(false);
  });

  it("refuses a create answer that is not this tag's draft, removing it only while a draft", () => {
    const { dir } = inputs();
    const createBody = JSON.stringify({ id: RELEASE_ID, tag_name: "other", draft: true });
    const { runner, calls } = fakeGh({ createBody });
    expect(() => run(dir, runner)).toThrow(/did not answer the draft release create/u);
    expect(calls.some(isUpload)).toBe(false);
    expect(calls.some(isCall("DELETE"))).toBe(true);
  });

  it.each([
    ["cannot be read", "fail"],
    ["disagrees", "wrong"],
  ])("says a published prerelease stays when the final check %s", (_title, finalRead) => {
    const { dir, assets } = inputs();
    const { runner, calls } = fakeGh({ uploaded: () => assets, finalRead });
    expect(() => run(dir, runner)).toThrow(/IS PUBLISHED.*nothing was removed.*immutable/u);
    expect(calls.some(isCall("DELETE"))).toBe(false);
  });

  it("refuses an existing release, a leftover draft and a commit that is not a full sha", () => {
    const { dir } = inputs();
    const base = { version: VERSION, dir, notesPath: "n.md", repository: "o/r" };
    const listed = [{ tagName: TAG }];
    expect(() => publish({ ...base, commit: COMMIT, runner: fakeGh({ listed }).runner })).toThrow(
      /already exists/u,
    );
    const draft = [{ tagName: TAG, isDraft: true }];
    expect(() =>
      publish({ ...base, commit: COMMIT, runner: fakeGh({ listed: draft }).runner }),
    ).toThrow(/unpublished DRAFT/u);
    expect(() => publish({ ...base, commit: "abc", runner: fakeGh().runner })).toThrow(
      /full commit/u,
    );
  });
});
